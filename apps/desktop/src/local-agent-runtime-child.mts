import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LocalAgentRuntime,
  RUNTIME_PROVIDERS,
  RuntimeError,
  assertWorkspaceIdentity,
  probeProviderCapability,
  probeRuntimeContainmentCapability,
  resolveProviderExecutable,
  type ExecutableFingerprint,
  type ProviderCapability,
  type ProviderDisclosure,
  type RuntimeEvent,
  type RuntimeProvider,
  type WorkspaceIdentity,
} from '@roundtable/runtime';
import {
  runtimeCatalogEntrySchema,
  runtimeCatalogSchema,
  runtimeArtifactSchema,
  runtimeExecutionEventSchema,
  type RuntimeArtifact,
  type RuntimeCatalogEntry,
  type RuntimeExecutionEvent,
} from '@roundtable/protocol';

import {
  PRIVATE_RUNTIME_PROTOCOL_VERSION,
  parseRuntimeChildRequest,
  type RuntimeChildMessage,
  type RuntimeChildRequest,
  type RuntimeChildResult,
} from './runtime-private-protocol.js';

const PREPARATION_TTL_MS = 5 * 60 * 1_000;
const MAX_PREPARATIONS = 32;
// Phase 4 has one service UID. Admission may queue, but overlapping provider
// processes would recreate the same-UID credential and control-plane leak.
const MAX_ACTIVE_EXECUTIONS = 1;
const MAX_PENDING_REQUESTS = 32;
const MAX_EXECUTION_PROJECTIONS = 256;
const HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_OUTPUT_EVENT_CHARS = 8_192;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
// The development runtime resolves workspace packages and the root node_modules
// through symlinks, so the whole monorepo is one executable trust boundary.
// Phase 7 replaces this with the signed .app Resources root.
const DESKTOP_CODE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ADAPTER_VERSIONS: Readonly<Record<RuntimeProvider, string>> = Object.freeze({
  codex: 'codex-contained-v2',
  'claude-code': 'claude-contained-v2',
  opencode: 'opencode-edit-v1',
});

type Preparation = {
  token: string;
  provider: RuntimeProvider;
  missionId: string;
  promptDigest: string;
  hostHomeDirectory: string;
  workspaceId: string;
  workspace: WorkspaceIdentity;
  grantRevision: number;
  executable: ExecutableFingerprint;
  catalogEntry: RuntimeCatalogEntry;
  expiresAt: number;
  consumed: boolean;
};

type CatalogCapability = ProviderCapability | {
  provider: RuntimeProvider;
  available: false;
  version: null;
  reason: 'executable_not_found';
  disclosures: readonly ProviderDisclosure[];
};

type ExecutionProjection = {
  missionId: string;
  executionId: string;
  sequence: number;
  terminal: RuntimeExecutionEvent | null;
  artifactScanFailed: boolean;
};

export class RuntimeChildService {
  readonly #runtime = new LocalAgentRuntime({ trustedCodeRoots: [DESKTOP_CODE_ROOT] });
  readonly #preparations = new Map<string, Preparation>();
  readonly #executions = new Map<string, ExecutionProjection>();
  #requestQueue: Promise<void> = Promise.resolve();
  #pendingRequests = 0;
  #shuttingDown = false;
  readonly #executionBackend: 'service-uid' | 'legacy-fixture';

  constructor(
    private readonly bootEpoch: string,
    private readonly stateRoot: string,
    private readonly send: (message: RuntimeChildMessage) => void,
    options: { executionBackend?: 'service-uid' | 'legacy-fixture' } = {},
  ) {
    this.#executionBackend = options.executionBackend ?? 'service-uid';
  }

  async receive(rawRequest: unknown): Promise<void> {
    let request: RuntimeChildRequest;
    try {
      request = parseRuntimeChildRequest(rawRequest);
    } catch {
      return;
    }
    if (request.bootEpoch !== this.bootEpoch) {
      this.#respondError(request.requestId, 'runtime_epoch_invalid');
      return;
    }
    if (this.#pendingRequests >= MAX_PENDING_REQUESTS) {
      this.#respondError(request.requestId, 'runtime_busy');
      return;
    }
    this.#pendingRequests += 1;
    const operation = this.#requestQueue.then(async () => {
      try {
        const result = await this.#dispatch(request);
        this.#respond(request.requestId, result);
      } catch (error) {
        this.#respondError(request.requestId, stableErrorCode(error));
      } finally {
        this.#pendingRequests -= 1;
      }
    });
    this.#requestQueue = operation.catch(() => undefined);
    await operation;
  }

  async #dispatch(request: RuntimeChildRequest): Promise<RuntimeChildResult> {
    if (request.type === 'catalog') {
      return {
        operation: 'catalog',
        catalog: await this.#catalog(request.searchDirectories, request.hostHomeDirectory),
      };
    }
    if (request.type === 'prepare') return this.#prepare(request);
    if (request.type === 'launch') return this.#launch(request);
    if (request.type === 'stop') return this.#stop(request.executionId);
    this.#shuttingDown = true;
    await this.#runtime.shutdown();
    return { operation: 'shutdown', shutdown: true };
  }

  async #catalog(searchDirectories: string[], hostHomeDirectory: string) {
    const providers = await Promise.all(RUNTIME_PROVIDERS.map(async (provider) => (
      this.#probeCatalogEntry(provider, searchDirectories, hostHomeDirectory)
    )));
    return runtimeCatalogSchema.parse({ providers });
  }

  async #prepare(
    request: Extract<RuntimeChildRequest, { type: 'prepare' }>,
  ): Promise<RuntimeChildResult> {
    if (this.#shuttingDown) throw new RuntimeError('runtime_shutting_down');
    // The local process runtime is a test fixture only. Production service-UID
    // requests must be routed through the native broker once that adapter
    // exists; never silently fall back to same-UID execution.
    if (this.#executionBackend !== 'legacy-fixture') {
      throw new Error('runtime_service_uid_unavailable');
    }
    this.#prunePreparations();
    if (this.#preparations.size >= MAX_PREPARATIONS) throw new Error('runtime_busy');
    await assertWorkspaceIdentity(request.workspace);
    const capability = await this.#probe(
      request.provider,
      request.searchDirectories,
      request.hostHomeDirectory,
    );
    const entry = catalogEntry(request.provider, capability);
    if (!capability.available || !entry.available) {
      throw new Error('runtime_provider_unavailable');
    }
    await assertWorkspaceIdentity(request.workspace);
    const token = `preparation_${randomUUID()}`;
    this.#preparations.set(token, {
      token,
      provider: request.provider,
      missionId: request.missionId,
      promptDigest: request.promptDigest,
      hostHomeDirectory: request.hostHomeDirectory,
      workspaceId: request.workspaceId,
      workspace: request.workspace,
      grantRevision: request.grantRevision,
      executable: capability.executable,
      catalogEntry: entry,
      expiresAt: Date.now() + PREPARATION_TTL_MS,
      consumed: false,
    });
    return {
      operation: 'prepare',
      preparationToken: token,
      missionId: request.missionId,
      promptDigest: request.promptDigest,
      provider: request.provider,
      catalogEntry: entry,
    };
  }

  async #launch(
    request: Extract<RuntimeChildRequest, { type: 'launch' }>,
  ): Promise<RuntimeChildResult> {
    if (this.#shuttingDown) throw new RuntimeError('runtime_shutting_down');
    if (this.#executionBackend !== 'legacy-fixture') {
      throw new Error('runtime_service_uid_unavailable');
    }
    this.#prunePreparations();
    const preparation = this.#preparations.get(request.preparationToken);
    if (
      !preparation
      || preparation.consumed
      || preparation.expiresAt <= Date.now()
      || preparation.provider !== request.provider
      || preparation.missionId !== request.missionId
      || preparation.promptDigest !== digestPrompt(request.prompt)
      || preparation.hostHomeDirectory !== request.environment.hostHomeDirectory
      || preparation.workspaceId !== request.workspaceId
      || preparation.grantRevision !== request.grantRevision
      || !sameWorkspace(preparation.workspace, request.workspace)
    ) throw new Error('runtime_preparation_invalid');
    if (this.#executions.has(request.executionId)) throw new Error('execution_duplicate');
    // Authentication and replay detection must win over capacity. Otherwise a
    // consumed/forged preparation token becomes distinguishable as
    // `runtime_busy` whenever the single service-UID seat is occupied.
    if (this.#activeExecutionCount() >= MAX_ACTIVE_EXECUTIONS) throw new Error('runtime_busy');
    preparation.consumed = true;
    await assertWorkspaceIdentity(request.workspace);

    const projection: ExecutionProjection = {
      missionId: request.missionId,
      executionId: request.executionId,
      sequence: 0,
      terminal: null,
      artifactScanFailed: false,
    };
    this.#executions.set(request.executionId, projection);
    try {
      const execution = await this.#runtime.start({
        executionId: request.executionId,
        provider: request.provider,
        executable: preparation.executable,
        workspace: request.workspace,
        prompt: request.prompt,
        environment: request.environment,
        limits: {
          totalTimeoutMs: request.timeoutMs,
          idleTimeoutMs: Math.min(5 * 60 * 1_000, request.timeoutMs),
        },
        onEvent: (event) => this.#projectRuntimeEvent(projection, event),
      });
      void execution.completion.catch(() => {
        this.#emitState(projection, 'failed', 'runtime_completion_failed', 'failed');
      });
      return {
        operation: 'launch',
        accepted: true,
        missionId: request.missionId,
        executionId: request.executionId,
      };
    } catch (error) {
      if (!projection.terminal) {
        this.#emitState(projection, 'failed', stableErrorCode(error), 'not-required');
      }
      throw error;
    }
  }

  async #stop(executionId: string): Promise<RuntimeChildResult> {
    const projection = this.#executions.get(executionId);
    if (!projection) throw new Error('execution_not_active');
    if (!projection.terminal) {
      await this.#runtime.stop(executionId);
    }
    if (!projection.terminal) {
      this.#emitState(projection, 'failed', 'execution_stop_unconfirmed', 'failed');
    }
    return { operation: 'stop', event: projection.terminal! };
  }

  async #probeCatalogEntry(
    provider: RuntimeProvider,
    searchDirectories: string[],
    hostHomeDirectory: string,
  ): Promise<RuntimeCatalogEntry> {
    return catalogEntry(
      provider,
      await this.#probe(provider, searchDirectories, hostHomeDirectory),
    );
  }

  async #probe(
    provider: RuntimeProvider,
    searchDirectories: string[],
    hostHomeDirectory: string,
  ): Promise<CatalogCapability> {
    if (this.#executionBackend !== 'legacy-fixture') {
      return {
        provider,
        available: false,
        version: null,
        reason: 'security_capability_missing',
        disclosures: provider === 'opencode'
          ? ['prompt_visible_in_process_arguments']
          : [],
      };
    }
    try {
      const executable = await resolveProviderExecutable(provider, searchDirectories);
      const probeRoot = join(this.stateRoot, 'probe', provider);
      const homeDirectory = join(probeRoot, 'home');
      const temporaryDirectory = join(probeRoot, 'tmp');
      await Promise.all([
        mkdir(homeDirectory, { recursive: true, mode: 0o700 }),
        mkdir(temporaryDirectory, { recursive: true, mode: 0o700 }),
      ]);
      const [providerCapability, containment] = await Promise.all([
        probeProviderCapability({
          provider,
          executable,
          environment: { hostHomeDirectory, homeDirectory, temporaryDirectory },
        }),
        probeRuntimeContainmentCapability({ hostHomeDirectory }),
      ]);
      if (!providerCapability.available || containment.available) return providerCapability;
      return {
        provider,
        available: false,
        version: providerCapability.version,
        reason: 'security_capability_missing',
        disclosures: providerCapability.disclosures,
      };
    } catch {
      return {
        provider,
        available: false,
        version: null,
        reason: 'executable_not_found',
        disclosures: [],
      };
    }
  }

  #projectRuntimeEvent(projection: ExecutionProjection, event: RuntimeEvent): void {
    if (projection.terminal) return;
    if (event.kind === 'execution.starting') {
      this.#emitState(projection, 'starting', null, 'not-required');
      return;
    }
    if (event.kind === 'process.started') {
      this.send({
        protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
        bootEpoch: this.bootEpoch,
        type: 'process',
        executionId: projection.executionId,
        pid: event.pid,
      });
      this.#emitState(projection, 'running', null, 'not-required');
      return;
    }
    if (event.kind === 'process.output') {
      for (const text of splitOutput(event.text)) {
        this.#emit(projection, {
          type: 'output',
          stream: event.stream,
          text,
          truncated: false,
        });
      }
      return;
    }
    if (event.kind === 'process.output_truncated') {
      this.#emit(projection, {
        type: 'output',
        stream: event.stream,
        text: `${event.stream} output truncated after ${event.observedBytes} bytes.`,
        truncated: true,
      });
      return;
    }
    if (event.kind === 'process.stop_requested') {
      this.#emitState(projection, 'stopping', null, 'pending');
      return;
    }
    if (event.kind === 'artifact.changed') {
      const artifact = protocolArtifact(event.artifact);
      if (!artifact) {
        projection.artifactScanFailed = true;
        this.#emit(projection, {
          type: 'output',
          stream: 'status',
          text: 'runtime_artifact_scan_incomplete',
          truncated: false,
        });
        return;
      }
      this.#emit(projection, { type: 'artifact', artifact });
      return;
    }
    if (event.kind === 'execution.failed') {
      this.#emit(projection, {
        type: 'output',
        stream: 'status',
        text: stableErrorCode(event.code),
        truncated: false,
      });
      return;
    }

    const terminal = projection.artifactScanFailed
      ? { state: 'failed' as const, error: 'runtime_scan_failed' }
      : terminalProjection(event.status, event.exitCode, event.treeTermination);
    this.#emitState(projection, terminal.state, terminal.error, event.treeTermination);
  }

  #emitState(
    projection: ExecutionProjection,
    state: Extract<RuntimeExecutionEvent, { type: 'state' }>['state'],
    error: string | null,
    treeTermination: Extract<RuntimeExecutionEvent, { type: 'state' }>['treeTermination'],
  ): void {
    this.#emit(projection, { type: 'state', state, error, treeTermination });
  }

  #emit(
    projection: ExecutionProjection,
    update:
      | Omit<Extract<RuntimeExecutionEvent, { type: 'state' }>, 'missionId' | 'executionId' | 'sequence' | 'occurredAt'>
      | Omit<Extract<RuntimeExecutionEvent, { type: 'output' }>, 'missionId' | 'executionId' | 'sequence' | 'occurredAt'>
      | Omit<Extract<RuntimeExecutionEvent, { type: 'artifact' }>, 'missionId' | 'executionId' | 'sequence' | 'occurredAt'>,
  ): void {
    const event = runtimeExecutionEventSchema.parse({
      missionId: projection.missionId,
      executionId: projection.executionId,
      sequence: ++projection.sequence,
      occurredAt: new Date().toISOString(),
      ...update,
    });
    if (event.type === 'state' && ['succeeded', 'failed', 'stopped', 'timed_out'].includes(event.state)) {
      projection.terminal = event;
      this.#pruneExecutionProjections();
    }
    this.send({
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: this.bootEpoch,
      type: 'event',
      event,
    });
  }

  #activeExecutionCount(): number {
    let count = 0;
    for (const projection of this.#executions.values()) {
      if (!projection.terminal) count += 1;
    }
    return count;
  }

  #prunePreparations(): void {
    const now = Date.now();
    for (const [token, preparation] of this.#preparations) {
      if (preparation.consumed || preparation.expiresAt <= now) {
        this.#preparations.delete(token);
      }
    }
  }

  #pruneExecutionProjections(): void {
    if (this.#executions.size <= MAX_EXECUTION_PROJECTIONS) return;
    for (const [executionId, projection] of this.#executions) {
      if (!projection.terminal) continue;
      this.#executions.delete(executionId);
      if (this.#executions.size <= MAX_EXECUTION_PROJECTIONS) return;
    }
  }

  #respond(requestId: string, result: RuntimeChildResult): void {
    this.send({
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: this.bootEpoch,
      type: 'response',
      requestId,
      ok: true,
      result,
    });
  }

  #respondError(requestId: string, code: string): void {
    this.send({
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: this.bootEpoch,
      type: 'response',
      requestId,
      ok: false,
      code: stableErrorCode(code),
    });
  }
}

function catalogEntry(
  provider: RuntimeProvider,
  capability: CatalogCapability,
): RuntimeCatalogEntry {
  const warnings: string[] = [];
  if (!capability.available) warnings.push(`Provider unavailable: ${capability.reason}.`);
  if (capability.disclosures.includes('prompt_visible_in_process_arguments')) {
    warnings.push('This provider exposes the approved prompt in its local process arguments.');
  }
  if (provider === 'opencode') {
    warnings.push('OpenCode execution is disabled until project configuration cannot expand its permissions.');
  } else if (capability.available) {
    warnings.push(
      'macOS Seatbelt denies reads from host user-data roots outside the approved workspace; required system paths remain readable.',
    );
    warnings.push(provider === 'codex'
      ? 'The provider control plane requires network access; Codex tool network access is disabled by the fixed adapter.'
      : 'The provider and its tools may use the network; this phase does not guarantee tool egress isolation.');
  }
  if (provider === 'claude-code') {
    warnings.push('Claude Code is capped by turns and time, but this phase does not enforce a monetary spend cap.');
  }
  return runtimeCatalogEntrySchema.parse({
    provider,
    label: provider === 'codex' ? 'Codex' : provider === 'claude-code' ? 'Claude Code' : 'OpenCode',
    available: capability.available && provider !== 'opencode',
    version: capability.version,
    installHint: provider === 'codex'
      ? 'Install or update the Codex CLI and configure a scoped OPENAI_API_KEY for Desktop Runtime.'
      : provider === 'claude-code'
        ? 'Install or update Claude Code and authenticate locally, or configure a scoped Anthropic credential.'
        : 'Install or update OpenCode and configure one supported provider credential.',
    policy: {
      adapterVersion: ADAPTER_VERSIONS[provider],
      sandbox: provider === 'opencode' ? 'provider-permissions' : 'workspace-os-sandbox',
      workspaceWrite: true,
      externalFileAccess: 'not-guaranteed',
      projectCustomizations: 'disabled',
      network: provider === 'claude-code' ? 'provider-and-tools' : 'provider-required',
      secrets: 'provider-scoped',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    warnings,
  });
}

function protocolArtifact(artifact: {
  relativePath: string;
  change: 'created' | 'modified' | 'deleted';
  hash: string | null;
  size: number | null;
}): RuntimeArtifact | null {
  const parsed = runtimeArtifactSchema.safeParse({
    relativePath: artifact.relativePath,
    change: artifact.change,
    size: artifact.size,
    sha256: artifact.hash,
    scanStatus: 'scanned',
    provenance: 'runtime-workspace-scan',
  });
  return parsed.success ? parsed.data : null;
}

function terminalProjection(
  status: string,
  exitCode: number | null,
  treeTermination: 'confirmed' | 'failed',
): {
  state: 'succeeded' | 'failed' | 'stopped' | 'timed_out';
  error: string | null;
} {
  if (status === 'exited' && exitCode === 0 && treeTermination === 'confirmed') {
    return { state: 'succeeded', error: null };
  }
  if (status === 'stopped') {
    return {
      state: 'stopped',
      error: treeTermination === 'confirmed' ? null : 'termination_unconfirmed',
    };
  }
  if (status === 'timed_out' || status === 'idle_timed_out') {
    return { state: 'timed_out', error: stableErrorCode(`runtime_${status}`) };
  }
  return { state: 'failed', error: stableErrorCode(`runtime_${status}`) };
}

function splitOutput(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += MAX_OUTPUT_EVENT_CHARS) {
    const chunk = text.slice(offset, offset + MAX_OUTPUT_EVENT_CHARS);
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks.length > 0 ? chunks : [' '];
}

function sameWorkspace(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return left.root === right.root && left.device === right.device && left.inode === right.inode;
}

function digestPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

function stableErrorCode(error: unknown): string {
  const code = error instanceof RuntimeError
    ? error.code
    : error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'runtime_failed';
  return /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : 'runtime_failed';
}

const parentPort = process.parentPort;
const bootEpoch = process.argv.at(-1);
if (parentPort && typeof bootEpoch === 'string' && /^epoch_[A-Za-z0-9-]{20,80}$/u.test(bootEpoch)) {
  const send = (message: RuntimeChildMessage) => parentPort.postMessage(message);
  const service = new RuntimeChildService(bootEpoch, process.cwd(), send);
  parentPort.on('message', (event) => {
    void service.receive(event.data);
  });
  send({
    protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
    bootEpoch,
    type: 'ready',
  });
  const heartbeat = setInterval(() => {
    send({
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      type: 'heartbeat',
      occurredAt: new Date().toISOString(),
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
}
