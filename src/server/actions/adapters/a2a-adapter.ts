import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  SendMessageRequest,
  StreamResponse,
  Task,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type RequestOptions,
  type ServiceParameters,
} from '@a2a-js/sdk/client';
import type { A2ATaskBinding, HandoffCardV2, PlanTask } from '../../types.js';
import type { AgentRunResult } from '../agent-runner.js';
import { assertAllowedA2AUrl, type ResolvedA2ARemoteAgentConfig } from '../a2a/config.js';
import { A2ARequestError, A2AUnavailableError } from '../a2a/errors.js';

export { A2ARequestError, A2AUnavailableError };
import {
  applyA2AStreamResponse,
  a2aStateName,
  buildA2ASendRequest,
  createA2AOutputAccumulator,
  isTerminalA2AState,
  materializableA2AParts,
  baseMediaType,
  type A2ACollectedPart,
} from '../a2a/message-mapper.js';
import { finishA2ATaskBinding, upsertA2ATaskBinding } from '../a2a/task-store.js';
import { artifactKindForFile, type ChangedWorkspaceFile } from '../turns/workspace-scan.js';

const MAX_ARTIFACT_BYTES = 512 * 1024;

export interface A2AClientLike {
  readonly protocolVersion?: string;
  getAgentCard?(options?: RequestOptions): Promise<AgentCard>;
  sendMessageStream(
    request: SendMessageRequest,
    options?: RequestOptions,
  ): AsyncGenerator<StreamResponse, void, undefined>;
  getTask?(request: GetTaskRequest, options?: RequestOptions): Promise<Task>;
  cancelTask?(request: CancelTaskRequest, options?: RequestOptions): Promise<Task>;
}

export type CreatedA2AClient = {
  client: A2AClientLike;
  protocolVersion: string;
  tenant: string;
  // Origin the card actually pointed at, and the origin the operator
  // configured. The bearer token is only sent when they match.
  interfaceOrigin?: string | undefined;
  trustedOrigin?: string | undefined;
  tokenWithheld?: boolean | undefined;
};



export async function runOnA2A(
  input: {
    workspace: string;
    turnId: string;
    missionId: string;
    task: PlanTask;
    handoff: HandoffCardV2;
    handoffText: string;
    config: ResolvedA2ARemoteAgentConfig;
    timeoutMs?: number;
  },
  dependencies: {
    createClient?: (config: ResolvedA2ARemoteAgentConfig, signal?: AbortSignal) => Promise<CreatedA2AClient>;
  } = {},
): Promise<AgentRunResult> {
  if (!input.config.enabled || !input.config.baseUrl) {
    throw new A2AUnavailableError(`a2a_remote_not_configured:${input.config.agentId}`);
  }
  const createClient = dependencies.createClient ?? createA2AClient;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? Number(process.env.ROUNDTABLE_AGENT_TIMEOUT_MS || 120_000),
  );
  const toolId = `tool_${input.task.id}`;
  // Hoisted so the catch can settle a binding the stream left mid-flight.
  let output = createA2AOutputAccumulator();
  try {
    const created = await createClient(input.config, controller.signal);
    if (created.protocolVersion !== '1.0') {
      throw new A2AUnavailableError('a2a_v1_interface_required');
    }
    const serviceParameters = created.tokenWithheld
      ? authParameters(null)
      : authParameters(input.config.authToken);
    if (created.tokenWithheld) {
      output.events.push({
        type: 'thinking_delta',
        delta: `A2A: ${input.config.agentId}'s agent card advertises its interface on `
          + `${created.interfaceOrigin}, but the configured endpoint is ${created.trustedOrigin}. `
          + 'Continuing without the bearer token.',
      });
    }
    const request = buildA2ASendRequest({ handoff: input.handoff, handoffText: input.handoffText });
    request.tenant = created.tenant;
    // `mutateData` is a read-modify-write of the whole store behind a
    // process-global lock, so persisting on every streamed chunk would
    // rewrite the store hundreds of times per task and serialize every
    // other agent in the same scheduler wave. Write only when the fields
    // the binding actually stores have changed.
    let persisted = '';
    const persistBinding = async (): Promise<void> => {
      if (!output.remoteTaskId) return;
      const state = output.state ?? 'working';
      const signature = `${output.remoteTaskId}|${output.remoteContextId ?? ''}|${state}|${output.error ?? ''}`;
      if (signature === persisted) return;
      persisted = signature;
      await upsertA2ATaskBinding({
        id: bindingId(input.turnId, input.task.id),
        missionId: input.missionId,
        turnId: input.turnId,
        planTaskId: input.task.id,
        agentId: input.config.agentId,
        agentBaseUrl: input.config.baseUrl,
        agentCardPath: input.config.cardPath,
        remoteTaskId: output.remoteTaskId,
        remoteContextId: output.remoteContextId,
        remoteTenant: created.tenant,
        protocolVersion: created.protocolVersion,
        state,
        error: output.error,
      });
    };
    for await (const event of created.client.sendMessageStream(request, {
      signal: controller.signal,
      serviceParameters,
    })) {
      output = applyA2AStreamResponse(output, event);
      await persistBinding();
    }
    if (!isTerminalA2AState(output.state) && output.remoteTaskId && created.client.getTask) {
      const task = await created.client.getTask(
        { tenant: created.tenant, id: output.remoteTaskId, historyLength: 0 },
        { signal: controller.signal, serviceParameters },
      );
      output = applyA2AStreamResponse(output, { payload: { $case: 'task', value: task } });
      await persistBinding();
    }
    if (output.remoteTaskId && output.state) {
      await finishA2ATaskBinding(input.turnId, input.task.id, output.state, output.error);
    }
    return materializeRunResult(input, output, created.protocolVersion, toolId);
  } catch (error) {
    const message = controller.signal.aborted
      ? 'a2a_request_timeout'
      : sanitizeError(error, input.config.authToken);
    // A binding recorded mid-stream would otherwise sit in `working`
    // forever: dispatch falls back to local-dispatch and the turn
    // completes, so nothing ever revisits this row, and a later interrupt
    // would try to cancel a task that already died.
    if (output.remoteTaskId) {
      await finishA2ATaskBinding(input.turnId, input.task.id, 'failed', message)
        .catch(() => undefined);
    }
    if (error instanceof A2AUnavailableError) throw error;
    throw new A2ARequestError(message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function createA2AClient(
  config: ResolvedA2ARemoteAgentConfig,
  signal?: AbortSignal,
): Promise<CreatedA2AClient> {
  // The bearer token is only ever attached to the origin the operator
  // configured. An Agent Card is remote-controlled data: it can name an
  // interface on any host, and without this scope the credential (and the
  // handoff card behind it) would follow the card wherever it points.
  const trustedOrigin = new URL(config.baseUrl).origin;
  const fetchImpl = scopedFetch(config.authToken, trustedOrigin, signal);
  const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    transports: [
      new JsonRpcTransportFactory({ fetchImpl }),
      new RestTransportFactory({ fetchImpl }),
    ],
    preferredTransports: ['JSONRPC', 'HTTP+JSON'],
  });
  const client = await new ClientFactory(options).createFromUrl(
    config.baseUrl,
    config.cardPath ?? undefined,
  );
  const card = await client.getAgentCard({
    serviceParameters: authParameters(config.authToken),
    ...(signal ? { signal } : {}),
  });
  const selected = card.supportedInterfaces.find((item) =>
    item.protocolVersion === client.protocolVersion
    && (item.protocolBinding.toUpperCase() === 'JSONRPC' || item.protocolBinding.toUpperCase() === 'HTTP+JSON'),
  );
  if (!selected || client.protocolVersion !== '1.0') {
    throw new A2AUnavailableError('a2a_v1_interface_required');
  }
  // The interface URL is attacker-controllable input. Hold it to the same
  // transport policy as the configured endpoint so a card cannot downgrade
  // the exchange to plain HTTP or aim it at an internal address.
  const interfaceOrigin = new URL(assertAllowedA2AUrl(selected.url, process.env.NODE_ENV)).origin;
  // Proceed unauthenticated rather than hand the token to a host the operator
  // never configured. Verifying signed Agent Cards is the real fix for
  // trusting a cross-origin interface; until then this is refused, and the
  // caller surfaces it as a visible event rather than a silent downgrade.
  const tokenWithheld = Boolean(config.authToken) && interfaceOrigin !== trustedOrigin;
  return {
    client,
    protocolVersion: client.protocolVersion,
    tenant: selected.tenant || '',
    interfaceOrigin,
    trustedOrigin,
    tokenWithheld,
  };
}

export async function cancelA2ABinding(
  binding: A2ATaskBinding,
  config: ResolvedA2ARemoteAgentConfig,
  dependencies: {
    createClient?: (config: ResolvedA2ARemoteAgentConfig, signal?: AbortSignal) => Promise<CreatedA2AClient>;
  } = {},
): Promise<void> {
  const createClient = dependencies.createClient ?? createA2AClient;
  const boundConfig = {
    ...config,
    baseUrl: binding.agentBaseUrl,
    cardPath: binding.agentCardPath,
  };
  const created = await createClient(boundConfig);
  if (!created.client.cancelTask) throw new A2ARequestError('a2a_cancel_not_supported');
  const task = await created.client.cancelTask({
    tenant: binding.remoteTenant,
    id: binding.remoteTaskId,
    metadata: { roundtableTurnId: binding.turnId },
  }, {
    serviceParameters: authParameters(config.authToken),
  });
  const state = a2aStateName(task.status?.state) ?? 'canceled';
  await finishA2ATaskBinding(binding.turnId, binding.planTaskId, state, null);
}

function materializeRunResult(
  input: {
    workspace: string;
    task: PlanTask;
    config: ResolvedA2ARemoteAgentConfig;
  },
  output: ReturnType<typeof createA2AOutputAccumulator>,
  protocolVersion: string,
  toolId: string,
): Promise<AgentRunResult> {
  return materialize();

  async function materialize(): Promise<AgentRunResult> {
    const parts = materializableA2AParts(output.parts).sort((a, b) => partPriority(a) - partPriority(b));
    const selected = parts[0] ?? {
      artifactId: null,
      filename: 'result.md',
      mediaType: 'text/markdown',
      kind: 'text' as const,
      value: output.error ? `# A2A task failed\n\n${output.error}` : '# A2A task returned no supported artifact',
    };
    const base = `.roundtable/runs/a2a/${safeSegment(input.task.id)}`;
    const files: ChangedWorkspaceFile[] = [];
    // Two parts can legitimately carry the same filename. Give each one its
    // own path instead of letting the later write clobber the earlier and
    // emitting duplicate entries that all claim the same path.
    const taken = new Set<string>();
    let selectedPath = '';
    const queue = parts.length > 0 ? parts : [selected];
    // Budget the whole run, not just each part in isolation.
    let budget = MAX_ARTIFACT_BYTES;
    for (const part of queue) {
      const text = partText(part);
      budget -= Buffer.byteLength(text, 'utf8');
      if (budget < 0) throw new A2ARequestError('a2a_artifact_too_large');
      const path = `${base}/${uniqueSegment(safeSegment(part.filename), taken)}`;
      await writeText(input.workspace, path, text);
      files.push({ path, text, kind: artifactKindForFile(path) });
      if (part === selected) selectedPath = path;
    }
    if (!selectedPath) selectedPath = files[0]?.path ?? `${base}/result.md`;
    const selectedText = partText(selected);
    const ok = output.state === 'completed';
    const events = [
      { type: 'thinking_delta' as const, delta: `Dispatching ${input.task.title} over A2A.` },
      {
        type: 'tool_use' as const,
        id: toolId,
        name: 'a2a_remote_agent',
        input: { agentId: input.config.agentId, baseUrl: input.config.baseUrl },
      },
      {
        type: 'tool_result' as const,
        id: toolId,
        output: { taskId: output.remoteTaskId, contextId: output.remoteContextId, state: output.state },
        isError: !ok,
      },
      ...output.events,
    ];
    return {
      text: selectedText,
      path: selectedPath,
      kind: artifactKindForFile(selectedPath),
      files: files.filter((file) => file.path !== selectedPath),
      events,
      ok,
      error: ok ? null : output.error ?? 'a2a_stream_ended_without_result',
      ...(output.remoteTaskId ? {
        remote: {
          protocol: 'a2a' as const,
          taskId: output.remoteTaskId,
          contextId: output.remoteContextId,
          protocolVersion,
          agentBaseUrl: input.config.baseUrl,
        },
      } : {}),
    };
  }
}

const PART_PRIORITY = ['text/html', 'text/markdown', 'application/json', 'text/plain'];

function partPriority(part: A2ACollectedPart): number {
  const index = PART_PRIORITY.indexOf(baseMediaType(part.mediaType));
  // Unknown types sort last, never first.
  return index < 0 ? PART_PRIORITY.length : index;
}

function partText(part: A2ACollectedPart): string {
  if (typeof part.value === 'string') return part.value;
  return JSON.stringify(part.value, null, 2);
}

// Disambiguates colliding filenames: result.md, result-2.md, result-3.md …
function uniqueSegment(name: string, taken: Set<string>): string {
  if (!taken.has(name)) { taken.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
}

function safeSegment(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'result';
}

async function writeText(workspace: string, relativePath: string, text: string): Promise<void> {
  const target = join(workspace, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

function authParameters(token: string | null): ServiceParameters {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Attaches the bearer token to the trusted origin only, and carries the
// caller's abort signal into every request the SDK makes — including agent
// card discovery, which otherwise runs with no timeout at all.
function scopedFetch(token: string | null, trustedOrigin: string, signal?: AbortSignal): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (token && requestOrigin(input) === trustedOrigin) {
      headers.set('Authorization', `Bearer ${token}`);
    } else {
      headers.delete('Authorization');
    }
    return fetch(input, { ...init, headers, ...(init?.signal ? {} : signal ? { signal } : {}) });
  };
}

function requestOrigin(input: RequestInfo | URL): string | null {
  try {
    if (typeof input === 'string') return new URL(input).origin;
    if (input instanceof URL) return input.origin;
    return new URL(input.url).origin;
  } catch {
    return null;
  }
}

function sanitizeError(error: unknown, token: string | null): string {
  const raw = error instanceof Error ? error.message : String(error);
  return token ? raw.replaceAll(token, '[redacted]') : raw;
}

function bindingId(turnId: string, taskId: string): string {
  return `a2a_${safeSegment(turnId)}_${safeSegment(taskId)}`;
}
