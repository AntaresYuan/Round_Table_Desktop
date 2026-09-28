import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { utilityProcess, type ForkOptions, type UtilityProcess } from 'electron';

import {
  trackProcessTree,
  type TrackedProcessTree,
  type TreeTermination,
} from '@roundtable/runtime';

import {
  runtimeCatalogSchema,
  runtimeExecutionEventSchema,
  type RuntimeCatalog,
  type RuntimeExecutionEvent,
} from '@roundtable/protocol';

import type {
  DesktopRuntimePort,
  PreparedRuntimeProvider,
  RuntimeLaunchRequest,
} from './execution-authority.js';
import {
  PRIVATE_RUNTIME_PROTOCOL_VERSION,
  parseRuntimeChildMessage,
  type RuntimeChildRequest,
  type RuntimeChildResult,
} from './runtime-private-protocol.js';
import { RuntimeSecretBroker, type RuntimeSecretProvision } from './secret-broker.js';

const RUNTIME_READY_TIMEOUT_MS = 8_000;
const RUNTIME_REQUEST_TIMEOUT_MS = 30_000;
const RUNTIME_STOP_TIMEOUT_MS = 15_000;
const RUNTIME_HEARTBEAT_TIMEOUT_MS = 15_000;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'stopped', 'timed_out']);

type UtilityFork = (
  modulePath: string,
  args?: string[],
  options?: ForkOptions,
) => UtilityProcess;

type UtilityAgentRuntimeOptions = {
  modulePath: string;
  stateRoot: string;
  sourceHome?: string | undefined;
  searchDirectories?: readonly string[] | undefined;
  fork?: UtilityFork | undefined;
  trackProcess?: ((pid: number) => TrackedProcessTree) | undefined;
  environment?: Readonly<Record<string, string | undefined>> | undefined;
};

type PendingRequest = {
  operation: RuntimeChildResult['operation'];
  resolve(result: RuntimeChildResult): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

type ChildSession = {
  bootEpoch: string;
  child: UtilityProcess;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  readySettled: boolean;
  failed: boolean;
  failurePromise: Promise<TreeTermination> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  pending: Map<string, PendingRequest>;
  processTree: TrackedProcessTree | null;
};

type ActiveExecution = {
  bootEpoch: string;
  missionId: string;
  executionId: string;
  sequence: number;
  processId: number | null;
  processTree: TrackedProcessTree | null;
  stopPromise: Promise<RuntimeExecutionEvent> | null;
  secretProvision: RuntimeSecretProvision;
};

export type ManagedDesktopRuntime = DesktopRuntimePort & {
  shutdown(): Promise<void>;
};

export class UtilityAgentRuntime implements ManagedDesktopRuntime {
  readonly #listeners = new Set<(event: RuntimeExecutionEvent) => void>();
  readonly #active = new Map<string, ActiveExecution>();
  readonly #terminals = new Map<string, RuntimeExecutionEvent>();
  readonly #cleanupTasks = new Set<Promise<void>>();
  readonly #fork: UtilityFork;
  readonly #trackProcess: (pid: number) => TrackedProcessTree;
  readonly #secretBroker: RuntimeSecretBroker;
  readonly #searchDirectories: string[];
  readonly #sourceHome: string;
  #stateRoot: string | null = null;
  #hostHomeDirectory: string | null = null;
  #session: ChildSession | null = null;
  #starting: Promise<ChildSession> | null = null;
  #catalog: RuntimeCatalog | null = null;
  #catalogPending: Promise<RuntimeCatalog> | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #shuttingDown = false;
  #closed = false;

  constructor(private readonly options: UtilityAgentRuntimeOptions) {
    if (!isAbsolute(options.modulePath) || !isAbsolute(options.stateRoot)) {
      throw new Error('runtime_configuration_invalid');
    }
    this.#fork = options.fork ?? utilityProcess.fork;
    this.#trackProcess = options.trackProcess ?? trackProcessTree;
    const sourceHome = options.sourceHome ?? homedir();
    if (!isAbsolute(sourceHome)) throw new Error('runtime_configuration_invalid');
    this.#sourceHome = sourceHome;
    this.#secretBroker = new RuntimeSecretBroker({
      stateRoot: join(options.stateRoot, 'credentials'),
      sourceHome,
      ...(options.environment ? { environment: options.environment } : {}),
    });
    this.#searchDirectories = normalizeSearchDirectories(
      options.searchDirectories ?? [join(sourceHome, '.local', 'bin')],
    );
  }

  async getCatalog(): Promise<RuntimeCatalog> {
    if (this.#catalog) return structuredClone(this.#catalog);
    if (!this.#catalogPending) {
      this.#catalogPending = this.#prepareHostHome().then((hostHomeDirectory) => (
        this.#request('catalog', (base) => ({
          ...base,
          type: 'catalog',
          hostHomeDirectory,
          searchDirectories: this.#searchDirectories,
        }))
      )).then(async (result) => {
        if (result.operation !== 'catalog') throw new Error('runtime_protocol_failed');
        const parsed = runtimeCatalogSchema.parse(result.catalog);
        this.#catalog = runtimeCatalogSchema.parse({
          providers: await Promise.all(parsed.providers.map(async (entry) => {
            if (!entry.available || await this.#secretBroker.isConfigured(entry.provider)) {
              return entry;
            }
            return {
              ...entry,
              available: false,
              warnings: [
                ...entry.warnings,
                'No isolated credential is configured for this provider.',
              ],
            };
          })),
        });
        return this.#catalog;
      }).finally(() => {
        this.#catalogPending = null;
      });
    }
    return structuredClone(await this.#catalogPending);
  }

  async prepare(input: {
    provider: 'codex' | 'claude-code' | 'opencode';
    missionId: string;
    promptDigest: string;
    workspaceId: string;
    workspaceRoot: string;
    rootDevice: string;
    rootInode: string;
    grantRevision: number;
  }): Promise<PreparedRuntimeProvider> {
    const hostHomeDirectory = await this.#prepareHostHome();
    if (!(await this.#secretBroker.isConfigured(input.provider))) {
      throw new Error('runtime_provider_unavailable');
    }
    const result = await this.#request('prepare', (base) => ({
      ...base,
      type: 'prepare',
      provider: input.provider,
      missionId: input.missionId,
      promptDigest: input.promptDigest,
      hostHomeDirectory,
      workspaceId: input.workspaceId,
      workspace: {
        root: input.workspaceRoot,
        device: input.rootDevice,
        inode: input.rootInode,
      },
      grantRevision: input.grantRevision,
      searchDirectories: this.#searchDirectories,
    }));
    if (
      result.operation !== 'prepare'
      || result.provider !== input.provider
      || result.missionId !== input.missionId
      || result.promptDigest !== input.promptDigest
      || result.catalogEntry.provider !== input.provider
    ) throw new Error('runtime_protocol_failed');
    return {
      preparationToken: result.preparationToken,
      catalogEntry: result.catalogEntry,
    };
  }

  async launch(input: RuntimeLaunchRequest): Promise<void> {
    if (this.#active.has(input.executionId) || this.#terminals.has(input.executionId)) {
      throw new Error('execution_duplicate');
    }
    const session = await this.#ensureSession();
    const secretProvision = await this.#secretBroker.provision(input.provider, input.executionId);
    const active: ActiveExecution = {
      bootEpoch: session.bootEpoch,
      missionId: input.missionId,
      executionId: input.executionId,
      sequence: 0,
      processId: null,
      processTree: null,
      stopPromise: null,
      secretProvision,
    };
    this.#active.set(input.executionId, active);

    try {
      const result = await this.#requestWithSession(session, 'launch', (base) => ({
        ...base,
        type: 'launch',
        preparationToken: input.preparationToken,
        missionId: input.missionId,
        executionId: input.executionId,
        workspaceId: input.workspaceId,
        workspace: {
          root: input.workspaceRoot,
          device: input.rootDevice,
          inode: input.rootInode,
        },
        grantRevision: input.grantRevision,
        provider: input.provider,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        environment: {
          homeDirectory: secretProvision.homeDirectory,
          temporaryDirectory: secretProvision.temporaryDirectory,
          hostHomeDirectory: secretProvision.hostHomeDirectory,
          ...(secretProvision.credential ? { credential: secretProvision.credential } : {}),
          ...(secretProvision.redactionSecrets.length > 0
            ? { redactionSecrets: secretProvision.redactionSecrets }
            : {}),
        },
      }));
      if (
        result.operation !== 'launch'
        || result.accepted !== true
        || result.missionId !== input.missionId
        || result.executionId !== input.executionId
      ) {
        throw new Error('runtime_protocol_failed');
      }
    } catch (error) {
      if (this.#terminals.has(input.executionId)) return;
      if (this.#active.get(input.executionId) === active) {
        this.#active.delete(input.executionId);
        active.processTree?.dispose();
        await secretProvision.cleanup();
      }
      throw error;
    }
  }

  stop(executionId: string): Promise<RuntimeExecutionEvent> {
    const active = this.#active.get(executionId);
    if (active?.stopPromise) return active.stopPromise;
    const attempt = this.#performStop(executionId);
    if (active) {
      active.stopPromise = attempt;
      void attempt.then(
        () => {
          if (active.stopPromise === attempt) active.stopPromise = null;
        },
        () => {
          if (active.stopPromise === attempt) active.stopPromise = null;
        },
      );
    }
    return attempt;
  }

  async #performStop(executionId: string): Promise<RuntimeExecutionEvent> {
    const terminal = this.#terminals.get(executionId);
    const active = this.#active.get(executionId);
    if (terminal && terminal.type === 'state' && terminal.treeTermination !== 'failed') {
      return terminal;
    }
    if (terminal && terminal.type === 'state' && active) {
      const failedSession = this.#session;
      if (
        failedSession?.failed
        && failedSession.bootEpoch === active.bootEpoch
      ) {
        await this.#handleSessionFailure(failedSession, 'runtime_process_crashed');
        const recovered = this.#terminals.get(executionId);
        if (
          recovered?.type === 'state'
          && recovered.treeTermination === 'confirmed'
        ) return recovered;
        throw new Error('execution_stop_unconfirmed');
      }
      const treeTermination = active.processTree
        ? await terminateTrackedTree(active.processTree)
        : 'failed';
      if (treeTermination !== 'confirmed') throw new Error('execution_stop_unconfirmed');
      const reconciled = runtimeExecutionEventSchema.parse({
        ...terminal,
        sequence: active.sequence + 1,
        occurredAt: new Date().toISOString(),
        treeTermination,
      });
      active.sequence = reconciled.sequence;
      this.#active.delete(executionId);
      active.processTree?.dispose();
      this.#rememberTerminal(reconciled);
      this.#publish(reconciled);
      this.#scheduleSecretCleanup(active.secretProvision);
      return reconciled;
    }
    if (terminal) return terminal;
    if (!active) throw new Error('execution_not_active');
    const session = this.#session;
    if (!session || session.bootEpoch !== active.bootEpoch || session.failed) {
      if (session?.failed && session.bootEpoch === active.bootEpoch) {
        await this.#handleSessionFailure(session, 'runtime_process_crashed');
      } else {
        await this.#failExecutionsForEpoch(active.bootEpoch, 'runtime_process_crashed', 'failed');
      }
      const recovered = this.#terminals.get(executionId);
      if (recovered) return recovered;
      throw new Error('execution_stop_unconfirmed');
    }
    const sequenceBeforeStop = active.sequence;
    let result: RuntimeChildResult;
    try {
      result = await this.#requestWithSession(
        session,
        'stop',
        (base) => ({ ...base, type: 'stop', executionId }),
        RUNTIME_STOP_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'runtime_protocol_failed') {
        await this.#handleSessionFailure(session, 'runtime_protocol_failed');
        throw new Error('runtime_protocol_failed');
      }
      await this.#handleSessionFailure(session, 'runtime_stop_failed');
      const recovered = this.#terminals.get(executionId);
      if (recovered) return recovered;
      throw new Error('execution_stop_unconfirmed');
    }
    if (result.operation !== 'stop') {
      await this.#handleSessionFailure(session, 'runtime_protocol_failed');
      throw new Error('runtime_protocol_failed');
    }
    const event = runtimeExecutionEventSchema.parse(result.event);
    const projected = this.#terminals.get(executionId);
    if (
      event.missionId !== active.missionId
      || event.executionId !== active.executionId
      || event.sequence <= sequenceBeforeStop
      || active.sequence !== event.sequence
      || event.type !== 'state'
      || !TERMINAL_STATES.has(event.state)
      || projected?.type !== 'state'
      || projected.missionId !== event.missionId
      || projected.executionId !== event.executionId
      || projected.sequence !== event.sequence
      || projected.occurredAt !== event.occurredAt
      || projected.state !== event.state
      || projected.error !== event.error
      || projected.treeTermination !== event.treeTermination
    ) {
      await this.#handleSessionFailure(session, 'runtime_protocol_failed');
      throw new Error('runtime_protocol_failed');
    }
    return event;
  }

  onEvent(listener: (event: RuntimeExecutionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  shutdown(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (!this.#shutdownPromise) {
      const attempt = this.#performShutdown();
      this.#shutdownPromise = attempt;
      void attempt.then(
        () => {
          if (this.#shutdownPromise === attempt) this.#shutdownPromise = null;
        },
        () => {
          if (this.#shutdownPromise === attempt) this.#shutdownPromise = null;
        },
      );
    }
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    this.#shuttingDown = true;
    await this.#starting?.catch(() => undefined);
    const session = this.#session;
    if (session) {
      if (!session.failed) {
        try {
          await this.#requestWithSession(
            session,
            'shutdown',
            (base) => ({ ...base, type: 'shutdown' }),
            RUNTIME_STOP_TIMEOUT_MS,
          );
        } catch {
          // The shared failure path below owns process-tree confirmation.
        }
      }
      const treeTermination = await this.#handleSessionFailure(session, 'runtime_shutdown');
      if (treeTermination !== 'confirmed') {
        throw new Error('runtime_shutdown_unconfirmed');
      }
    } else {
      await this.#failAllExecutions('runtime_shutdown', 'failed');
    }
    if (this.#active.size > 0) throw new Error('runtime_shutdown_unconfirmed');
    await Promise.allSettled([...this.#cleanupTasks]);
    await this.#secretBroker.dispose();
    this.#listeners.clear();
    this.#session = null;
    this.#closed = true;
    this.#shuttingDown = false;
  }

  async #request(
    operation: RuntimeChildResult['operation'],
    build: (base: RuntimeRequestBase) => RuntimeChildRequest,
    timeoutMs = RUNTIME_REQUEST_TIMEOUT_MS,
  ): Promise<RuntimeChildResult> {
    return this.#requestWithSession(await this.#ensureSession(), operation, build, timeoutMs);
  }

  async #requestWithSession(
    session: ChildSession,
    operation: RuntimeChildResult['operation'],
    build: (base: RuntimeRequestBase) => RuntimeChildRequest,
    timeoutMs = RUNTIME_REQUEST_TIMEOUT_MS,
  ): Promise<RuntimeChildResult> {
    if (
      this.#closed
      || (this.#shuttingDown && operation !== 'shutdown')
      || session.failed
      || this.#session !== session
    ) {
      throw new Error('runtime_unavailable');
    }
    await session.ready;
    const requestId = `request_${randomUUID()}`;
    const request = build({
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: session.bootEpoch,
      requestId,
    });
    return new Promise<RuntimeChildResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.#handleSessionFailure(session, 'runtime_request_timeout');
      }, timeoutMs);
      timeout.unref();
      session.pending.set(requestId, { operation, resolve, reject, timeout });
      try {
        session.child.postMessage(request);
      } catch {
        void this.#handleSessionFailure(session, 'runtime_protocol_failed');
      }
    });
  }

  async #ensureSession(): Promise<ChildSession> {
    if (this.#closed || this.#shuttingDown) throw new Error('runtime_unavailable');
    if (this.#session && !this.#session.failed) return this.#session;
    if (this.#session?.failurePromise) {
      await this.#session.failurePromise;
      if (this.#closed || this.#shuttingDown) throw new Error('runtime_unavailable');
    }
    if (this.#session?.failed) throw new Error('runtime_unavailable');
    if (this.#starting) return this.#starting;
    this.#starting = this.#startSession();
    try {
      return await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  async #startSession(): Promise<ChildSession> {
    const stateRoot = await this.#prepareStateRoot();
    if (this.#closed || this.#shuttingDown) throw new Error('runtime_unavailable');
    const bootEpoch = `epoch_${randomUUID()}`;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise;
      rejectReady = rejectPromise;
    });
    const child = this.#fork(this.options.modulePath, [bootEpoch], {
      cwd: stateRoot,
      env: utilityEnvironment(stateRoot),
      serviceName: 'Roundtable Local Agent Runtime',
      stdio: 'ignore',
      allowLoadingUnsignedLibraries: false,
      disclaim: true,
    });
    const session: ChildSession = {
      bootEpoch,
      child,
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      failed: false,
      failurePromise: null,
      heartbeatTimer: null,
      pending: new Map(),
      processTree: null,
    };
    this.#session = session;

    const bindProcessTree = (): void => {
      if (session.failed || session.processTree || this.#session !== session) return;
      const pid = child.pid;
      if (pid === undefined) {
        void this.#handleSessionFailure(session, 'runtime_process_tracking_failed');
        return;
      }
      try {
        session.processTree = this.#trackProcess(pid);
      } catch {
        void this.#handleSessionFailure(session, 'runtime_process_tracking_failed');
      }
    };
    child.once('spawn', bindProcessTree);
    if (child.pid !== undefined) bindProcessTree();
    child.on('message', (message: unknown) => this.#handleMessage(session, message));
    child.once('error', () => {
      void this.#handleSessionFailure(session, 'runtime_process_crashed');
    });
    child.once('exit', () => {
      void this.#handleSessionFailure(session, 'runtime_process_crashed');
    });
    const readyTimeout = setTimeout(() => {
      void this.#handleSessionFailure(session, 'runtime_ready_timeout');
    }, RUNTIME_READY_TIMEOUT_MS);
    readyTimeout.unref();
    void ready.then(
      () => clearTimeout(readyTimeout),
      () => clearTimeout(readyTimeout),
    );
    await ready;
    const trackingReady = await (session.processTree?.ready ?? Promise.resolve(false))
      .catch(() => false);
    if (!trackingReady) {
      await this.#handleSessionFailure(session, 'runtime_process_tracking_failed');
      throw new Error('runtime_process_tracking_failed');
    }
    return session;
  }

  #handleMessage(session: ChildSession, rawMessage: unknown): void {
    if (session.failed || this.#session !== session) return;
    let message;
    try {
      message = parseRuntimeChildMessage(rawMessage);
    } catch {
      void this.#handleSessionFailure(session, 'runtime_protocol_failed');
      return;
    }
    if (message.bootEpoch !== session.bootEpoch) {
      void this.#handleSessionFailure(session, 'runtime_protocol_failed');
      return;
    }
    this.#armHeartbeat(session);

    if (message.type === 'ready') {
      if (session.readySettled) {
        void this.#handleSessionFailure(session, 'runtime_protocol_failed');
        return;
      }
      session.readySettled = true;
      session.resolveReady();
      return;
    }
    if (message.type === 'heartbeat') return;
    if (message.type === 'response') {
      const pending = session.pending.get(message.requestId);
      if (!pending) {
        void this.#handleSessionFailure(session, 'runtime_protocol_failed');
        return;
      }
      if (!message.ok) {
        session.pending.delete(message.requestId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(message.code));
      } else if (message.result.operation !== pending.operation) {
        void this.#handleSessionFailure(session, 'runtime_protocol_failed');
      } else {
        session.pending.delete(message.requestId);
        clearTimeout(pending.timeout);
        pending.resolve(message.result);
      }
      return;
    }
    if (message.type === 'process') {
      const active = this.#active.get(message.executionId);
      if (!active || active.bootEpoch !== session.bootEpoch || active.processId !== null) {
        void this.#handleSessionFailure(session, 'runtime_protocol_failed');
        return;
      }
      active.processId = message.pid;
      try {
        active.processTree = this.#trackProcess(message.pid);
        void active.processTree.ready.then(
          (ready) => {
            if (!ready) void this.#handleSessionFailure(session, 'runtime_process_tracking_failed');
          },
          () => this.#handleSessionFailure(session, 'runtime_process_tracking_failed'),
        );
      } catch {
        void this.#handleSessionFailure(session, 'runtime_process_tracking_failed');
      }
      return;
    }

    const event = message.event;
    const active = this.#active.get(event.executionId);
    if (
      !active
      || active.bootEpoch !== session.bootEpoch
      || active.missionId !== event.missionId
      || event.sequence !== active.sequence + 1
    ) {
      void this.#handleSessionFailure(session, 'runtime_protocol_failed');
      return;
    }
    active.sequence = event.sequence;
    this.#publish(event);
    if (event.type === 'state' && TERMINAL_STATES.has(event.state)) {
      this.#rememberTerminal(event);
      if (event.treeTermination !== 'failed') {
        this.#active.delete(event.executionId);
        active.processTree?.dispose();
        this.#scheduleSecretCleanup(active.secretProvision);
      }
    }
  }

  #armHeartbeat(session: ChildSession): void {
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
    session.heartbeatTimer = setTimeout(() => {
      void this.#handleSessionFailure(session, 'runtime_heartbeat_timeout');
    }, RUNTIME_HEARTBEAT_TIMEOUT_MS);
    session.heartbeatTimer.unref();
  }

  #handleSessionFailure(session: ChildSession, code: string): Promise<TreeTermination> {
    if (session.failurePromise) return session.failurePromise;
    session.failed = true;
    const attempt = this.#settleSessionFailure(session, code);
    session.failurePromise = attempt;
    void attempt.then(
      () => {
        if (session.failurePromise === attempt) session.failurePromise = null;
      },
      () => {
        if (session.failurePromise === attempt) session.failurePromise = null;
      },
    );
    return attempt;
  }

  async #settleSessionFailure(
    session: ChildSession,
    code: string,
  ): Promise<TreeTermination> {
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
    session.heartbeatTimer = null;
    this.#catalog = null;
    const sessionTreeTermination = await terminateChildSession(session);
    await this.#failExecutionsForEpoch(session.bootEpoch, code, sessionTreeTermination);
    if (!session.readySettled) {
      session.readySettled = true;
      session.rejectReady(new Error(code));
    }
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(code));
    }
    session.pending.clear();
    const unresolvedExecution = [...this.#active.values()]
      .some((entry) => entry.bootEpoch === session.bootEpoch);
    if (
      sessionTreeTermination === 'confirmed'
      && !unresolvedExecution
      && this.#session === session
    ) {
      this.#session = null;
      return 'confirmed';
    }
    return 'failed';
  }

  async #failExecutionsForEpoch(
    bootEpoch: string,
    code: string,
    sessionTreeTermination: TreeTermination,
  ): Promise<void> {
    const active = [...this.#active.values()].filter((entry) => entry.bootEpoch === bootEpoch);
    await Promise.all(active.map(async (entry) => {
      const treeTermination = entry.processTree
        ? await terminateTrackedTree(entry.processTree)
        : sessionTreeTermination;
      if (this.#active.get(entry.executionId) !== entry) return;
      const priorTerminal = this.#terminals.get(entry.executionId);
      if (priorTerminal?.type === 'state' && priorTerminal.treeTermination === 'failed') {
        if (treeTermination !== 'confirmed') return;
        const reconciled = runtimeExecutionEventSchema.parse({
          ...priorTerminal,
          sequence: entry.sequence + 1,
          occurredAt: new Date().toISOString(),
          treeTermination,
        });
        entry.sequence = reconciled.sequence;
        this.#active.delete(entry.executionId);
        entry.processTree?.dispose();
        this.#rememberTerminal(reconciled);
        this.#publish(reconciled);
        this.#scheduleSecretCleanup(entry.secretProvision);
        return;
      }
      const event = runtimeExecutionEventSchema.parse({
        missionId: entry.missionId,
        executionId: entry.executionId,
        sequence: entry.sequence + 1,
        occurredAt: new Date().toISOString(),
        type: 'state',
        state: 'failed',
        error: stableRuntimeCode(code),
        treeTermination,
      });
      entry.sequence = event.sequence;
      this.#rememberTerminal(event);
      this.#publish(event);
      if (treeTermination === 'confirmed') {
        this.#active.delete(entry.executionId);
        entry.processTree?.dispose();
        await entry.secretProvision.cleanup().catch(() => undefined);
      }
    }));
  }

  async #failAllExecutions(code: string, treeTermination: TreeTermination): Promise<void> {
    const epochs = new Set([...this.#active.values()].map((entry) => entry.bootEpoch));
    for (const epoch of epochs) {
      await this.#failExecutionsForEpoch(epoch, code, treeTermination);
    }
  }

  #scheduleSecretCleanup(provision: RuntimeSecretProvision): void {
    const cleanup = provision.cleanup();
    this.#cleanupTasks.add(cleanup);
    void cleanup.catch(() => undefined).finally(() => {
      this.#cleanupTasks.delete(cleanup);
    });
  }

  #publish(event: RuntimeExecutionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Runtime lifecycle is independent from individual projections.
      }
    }
  }

  #rememberTerminal(event: RuntimeExecutionEvent): void {
    this.#terminals.set(event.executionId, event);
    while (this.#terminals.size > 256) {
      const oldest = this.#terminals.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.#terminals.delete(oldest);
    }
  }

  async #prepareStateRoot(): Promise<string> {
    if (this.#stateRoot) return this.#stateRoot;
    await mkdir(this.options.stateRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.stateRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('runtime_configuration_invalid');
    }
    const canonical = await realpath(this.options.stateRoot);
    await chmod(canonical, 0o700);
    const verified = await lstat(canonical);
    if (
      !verified.isDirectory()
      || verified.isSymbolicLink()
      || verified.dev !== info.dev
      || verified.ino !== info.ino
      || (process.platform !== 'win32' && (verified.mode & 0o077) !== 0)
    ) {
      throw new Error('runtime_configuration_invalid');
    }
    const temporaryDirectory = join(canonical, 'tmp');
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const temporaryInfo = await lstat(temporaryDirectory);
    if (!temporaryInfo.isDirectory() || temporaryInfo.isSymbolicLink()) {
      throw new Error('runtime_configuration_invalid');
    }
    await chmod(temporaryDirectory, 0o700);
    this.#stateRoot = canonical;
    return canonical;
  }

  async #prepareHostHome(): Promise<string> {
    if (this.#hostHomeDirectory) return this.#hostHomeDirectory;
    const info = await lstat(this.#sourceHome);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('runtime_configuration_invalid');
    }
    const canonical = await realpath(this.#sourceHome);
    const verified = await lstat(canonical);
    if (
      !verified.isDirectory()
      || verified.isSymbolicLink()
      || verified.dev !== info.dev
      || verified.ino !== info.ino
    ) throw new Error('runtime_configuration_invalid');
    this.#hostHomeDirectory = canonical;
    return canonical;
  }
}

type RuntimeRequestBase = Pick<
  RuntimeChildRequest,
  'protocolVersion' | 'bootEpoch' | 'requestId'
>;

function normalizeSearchDirectories(directories: readonly string[]): string[] {
  const result: string[] = [];
  for (const directory of directories) {
    if (
      !isAbsolute(directory)
      || directory.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(directory)
    ) throw new Error('runtime_configuration_invalid');
    if (!result.includes(directory)) result.push(directory);
  }
  if (result.length > 8) throw new Error('runtime_configuration_invalid');
  return result;
}

function utilityEnvironment(stateRoot: string): NodeJS.ProcessEnv {
  const temporaryDirectory = join(stateRoot, 'tmp');
  const environment: NodeJS.ProcessEnv = {
    HOME: stateRoot,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
  };
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('runtime_configuration_invalid');
    environment.SystemRoot = systemRoot;
    environment.WINDIR = systemRoot;
    environment.ComSpec = join(systemRoot, 'System32', 'cmd.exe');
    environment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    environment.USERPROFILE = stateRoot;
  }
  return environment;
}

async function terminateChildSession(session: ChildSession): Promise<TreeTermination> {
  if (!session.processTree) {
    bestEffortKillChild(session);
    return 'failed';
  }
  try {
    const termination = await session.processTree.terminate();
    if (termination === 'confirmed') return termination;
    bestEffortKillChild(session);
    return 'failed';
  } catch {
    bestEffortKillChild(session);
    return 'failed';
  }
}

function bestEffortKillChild(session: ChildSession): void {
  try {
    if (session.child.pid !== undefined) session.child.kill();
  } catch {
    // Direct child termination cannot confirm descendant cleanup.
  }
}

async function terminateTrackedTree(tree: TrackedProcessTree): Promise<TreeTermination> {
  try {
    return await tree.terminate();
  } catch {
    return 'failed';
  }
}

function stableRuntimeCode(code: string): string {
  return /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : 'runtime_failed';
}
