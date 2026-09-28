import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ForkOptions, UtilityProcess } from 'electron';
import {
  runtimeExecutionEventSchema,
  type RuntimeCatalog,
  type RuntimeCatalogEntry,
  type RuntimeExecutionEvent,
} from '@roundtable/protocol';
import type { TrackedProcessTree } from '@roundtable/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PRIVATE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeChildRequest,
  type RuntimeChildResult,
} from '../src/runtime-private-protocol.js';
import { DesktopExecutionAuthority } from '../src/execution-authority.js';
import { UtilityAgentRuntime } from '../src/utility-agent-runtime.js';
import { WorkspaceGrantRegistry } from '../src/workspace-grants.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined;
  readonly requests: RuntimeChildRequest[] = [];
  readonly postMessage = vi.fn((request: RuntimeChildRequest) => {
    this.requests.push(request);
    queueMicrotask(() => this.#respond(request));
  });

  constructor(readonly bootEpoch: string) {
    super();
    queueMicrotask(() => {
      this.pid = 41_001;
      this.emit('spawn');
      queueMicrotask(() => this.emit('message', {
        protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
        bootEpoch,
        type: 'ready',
      }));
    });
  }

  kill(): boolean {
    if (this.pid === undefined) return false;
    this.pid = undefined;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }

  crash(): void {
    if (this.pid === undefined) return;
    this.pid = undefined;
    this.emit('exit', 1);
  }

  #respond(request: RuntimeChildRequest): void {
    if (this.pid === undefined) return;
    let result: RuntimeChildResult;
    if (request.type === 'catalog') {
      result = { operation: 'catalog', catalog: catalog() };
    } else if (request.type === 'prepare') {
      result = {
        operation: 'prepare',
        preparationToken: 'preparation_fake_runtime_01',
        missionId: request.missionId,
        promptDigest: request.promptDigest,
        provider: request.provider,
        catalogEntry: catalog().providers.find((entry) => entry.provider === request.provider)!,
      };
    } else if (request.type === 'launch') {
      this.emit('message', {
        protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
        bootEpoch: this.bootEpoch,
        type: 'event',
        event: {
          missionId: request.missionId,
          executionId: request.executionId,
          sequence: 1,
          occurredAt: '2026-08-23T00:00:00.000Z',
          type: 'state',
          state: 'starting',
          error: null,
          treeTermination: 'not-required',
        },
      });
      result = {
        operation: 'launch',
        accepted: true,
        missionId: request.missionId,
        executionId: request.executionId,
      };
    } else if (request.type === 'stop') {
      throw new Error('unexpected_fake_stop');
    } else {
      result = { operation: 'shutdown', shutdown: true };
    }
    this.emit('message', {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: this.bootEpoch,
      type: 'response',
      requestId: request.requestId,
      ok: true,
      result,
    });
  }
}

type ControlledRequestHandler = (
  request: RuntimeChildRequest,
  child: ControlledUtilityProcess,
) => void;

class ControlledUtilityProcess extends EventEmitter {
  pid: number | undefined;
  readonly requests: RuntimeChildRequest[] = [];
  readonly postMessage = vi.fn((request: RuntimeChildRequest) => {
    this.requests.push(request);
    queueMicrotask(() => this.requestHandler(request, this));
  });

  constructor(
    readonly bootEpoch: string,
    private readonly requestHandler: ControlledRequestHandler,
    autoReady = true,
  ) {
    super();
    queueMicrotask(() => {
      this.pid = 41_101;
      this.emit('spawn');
      if (autoReady) queueMicrotask(() => this.ready());
    });
  }

  ready(): void {
    if (this.pid === undefined) return;
    this.emit('message', {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: this.bootEpoch,
      type: 'ready',
    });
  }

  respond(request: RuntimeChildRequest, result: RuntimeChildResult): void {
    if (this.pid === undefined) return;
    this.emit('message', {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: this.bootEpoch,
      type: 'response',
      requestId: request.requestId,
      ok: true,
      result,
    });
  }

  publishProcess(executionId: string, pid: number): void {
    if (this.pid === undefined) return;
    this.emit('message', {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: this.bootEpoch,
      type: 'process',
      executionId,
      pid,
    });
  }

  publishEvent(event: RuntimeExecutionEvent): void {
    if (this.pid === undefined) return;
    this.emit('message', {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: this.bootEpoch,
      type: 'event',
      event,
    });
  }

  kill(): boolean {
    if (this.pid === undefined) return false;
    this.pid = undefined;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }

  crash(): void {
    if (this.pid === undefined) return;
    this.pid = undefined;
    this.emit('exit', 1);
  }
}

describe('utility agent Runtime client', () => {
  it('coalesces catalog probes, uses a strict utility env, and recovers with a new epoch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-utility-runtime-'));
    temporaryDirectories.push(root);
    const children: FakeUtilityProcess[] = [];
    const forkOptions: ForkOptions[] = [];
    await mkdir(join(root, 'source-home'), { mode: 0o700 });
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      searchDirectories: [join(root, 'bin')],
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: (pid) => fakeProcessTracker(pid),
      fork: (_modulePath, args, options) => {
        const child = new FakeUtilityProcess(args?.[0] ?? 'missing_epoch');
        children.push(child);
        if (options) forkOptions.push(options);
        return child as unknown as UtilityProcess;
      },
    });

    const [firstCatalog, secondCatalog] = await Promise.all([
      runtime.getCatalog(),
      runtime.getCatalog(),
    ]);
    expect(firstCatalog).toEqual(secondCatalog);
    expect(children).toHaveLength(1);
    expect(children[0]?.requests.filter((request) => request.type === 'catalog')).toHaveLength(1);
    expect(forkOptions[0]?.env).toMatchObject({ LANG: 'C', LC_ALL: 'C', CI: '1' });
    expect(forkOptions[0]?.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(forkOptions[0]?.env).not.toHaveProperty('SSH_AUTH_SOCK');

    const events = vi.fn();
    runtime.onEvent(events);
    const prepared = await runtime.prepare({
      provider: 'codex',
      missionId: 'mission_fake_runtime_01',
      promptDigest: '5e7e8d7960b1d941cae5dd72f6c25ecff9b448621769f3e6b380dc71d7052a83',
      workspaceId: 'workspace_fake_runtime_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
    });
    await runtime.launch({
      preparationToken: prepared.preparationToken,
      missionId: 'mission_fake_runtime_01',
      executionId: 'execution_fake_runtime_01',
      workspaceId: 'workspace_fake_runtime_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
      provider: 'codex',
      prompt: 'Approved fixture prompt',
      timeoutMs: 60_000,
    });
    expect(events).toHaveBeenCalledWith(expect.objectContaining({
      sequence: 1,
      type: 'state',
      state: 'starting',
    }));

    children[0]?.crash();
    await vi.waitFor(() => {
      expect(events).toHaveBeenCalledWith(expect.objectContaining({
        sequence: 2,
        type: 'state',
        state: 'failed',
        treeTermination: 'confirmed',
      }));
    });
    await runtime.getCatalog();
    expect(children).toHaveLength(2);
    expect(children[1]?.bootEpoch).not.toBe(children[0]?.bootEpoch);

    const credentialRoots = join(root, 'state', 'credentials');
    await vi.waitFor(async () => {
      const entries = await lstat(credentialRoots);
      expect(entries.isDirectory()).toBe(true);
    });
    await runtime.shutdown();
  });

  it('publishes crash cleanup before a pending launch settles, so Authority never fabricates an unconfirmed terminal', async () => {
    const root = await runtimeRoot('pending-launch-crash');
    const workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot, { mode: 0o700 });
    const launchSeen = deferred<Extract<RuntimeChildRequest, { type: 'launch' }>>();
    const terminationStarted = deferred<void>();
    const termination = deferred<'confirmed'>();
    const sessionTracker: TrackedProcessTree = {
      pid: 41_101,
      ready: Promise.resolve(true),
      terminate: vi.fn(() => {
        terminationStarted.resolve();
        return termination.promise;
      }),
      dispose: vi.fn(),
    };
    let child!: ControlledUtilityProcess;
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: () => sessionTracker,
      fork: (_modulePath, args) => {
        child = new ControlledUtilityProcess(
          args?.[0] ?? 'missing_epoch',
          (request, controlled) => {
            if (request.type === 'prepare') {
              controlled.respond(request, preparedResult(request));
            } else if (request.type === 'launch') {
              launchSeen.resolve(request);
            } else if (request.type === 'shutdown') {
              controlled.respond(request, { operation: 'shutdown', shutdown: true });
            }
          },
        );
        return child as unknown as UtilityProcess;
      },
    });
    const grants = new WorkspaceGrantRegistry();
    const workspace = await grants.grant(workspaceRoot, 71);
    const authority = new DesktopExecutionAuthority({ grants, runtime });
    const preview = await authority.prepareMission({
      workspaceId: workspace.id,
      provider: 'codex',
      prompt: 'Apply the crash ordering fixture.',
    }, 71, 'window-session-pending-launch-01');
    const events = vi.fn();
    authority.onEvent(events);
    let approvalSettled = false;
    const approval = authority.approveMission(
      preview.approvalId,
      71,
      'window-session-pending-launch-01',
    ).finally(() => {
      approvalSettled = true;
    });

    const launch = await launchSeen.promise;
    child.crash();
    await terminationStarted.promise;
    expect(approvalSettled).toBe(false);
    expect(events).not.toHaveBeenCalled();

    termination.resolve('confirmed');
    const accepted = await approval;
    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        missionId: launch.missionId,
        executionId: accepted.executionId,
        sequence: 1,
        state: 'failed',
        treeTermination: 'confirmed',
      }),
    }));
    expect(authority.getExecution(
      accepted.executionId,
      71,
      'window-session-pending-launch-01',
    )).toMatchObject({
      state: 'failed',
      treeTermination: 'confirmed',
    });
    expect(JSON.stringify(events.mock.calls)).not.toContain('not-required');
    await runtime.shutdown();
  });

  it('coalesces concurrent failed-tree stops and keeps admission locked until one retry confirms', async () => {
    const root = await runtimeRoot('tree-retry');
    const workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot, { mode: 0o700 });
    const providerPid = 52_002;
    const providerTerminate = vi.fn(async (): Promise<'confirmed'> => 'confirmed');
    const trackers = new Map<number, TrackedProcessTree>();
    let child!: ControlledUtilityProcess;
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: (pid) => {
        const tracker: TrackedProcessTree = {
          pid,
          ready: Promise.resolve(true),
          terminate: pid === providerPid
            ? providerTerminate
            : vi.fn(async (): Promise<'confirmed'> => 'confirmed'),
          dispose: vi.fn(),
        };
        trackers.set(pid, tracker);
        return tracker;
      },
      fork: (_modulePath, args) => {
        child = new ControlledUtilityProcess(
          args?.[0] ?? 'missing_epoch',
          (request, controlled) => {
            if (request.type === 'prepare') {
              controlled.respond(request, preparedResult(request));
            } else if (request.type === 'launch') {
              controlled.publishProcess(request.executionId, providerPid);
              controlled.publishEvent(runtimeExecutionEventSchema.parse({
                missionId: request.missionId,
                executionId: request.executionId,
                sequence: 1,
                occurredAt: '2026-08-23T00:00:01.000Z',
                type: 'state',
                state: 'failed',
                error: 'termination_unconfirmed',
                treeTermination: 'failed',
              }));
              controlled.respond(request, launchedResult(request));
            } else if (request.type === 'shutdown') {
              controlled.respond(request, { operation: 'shutdown', shutdown: true });
            }
          },
        );
        return child as unknown as UtilityProcess;
      },
    });
    const grants = new WorkspaceGrantRegistry();
    const workspace = await grants.grant(workspaceRoot, 72);
    const authority = new DesktopExecutionAuthority({ grants, runtime });
    const preview = await authority.prepareMission({
      workspaceId: workspace.id,
      provider: 'codex',
      prompt: 'Exercise tree retry admission.',
    }, 72, 'window-session-tree-retry-0001');
    const accepted = await authority.approveMission(
      preview.approvalId,
      72,
      'window-session-tree-retry-0001',
    );

    expect(authority.hasActiveExecution(72)).toBe(true);
    expect(authority.getExecution(
      accepted.executionId,
      72,
      'window-session-tree-retry-0001',
    )).toMatchObject({ state: 'failed', sequence: 1, treeTermination: 'failed' });
    await expect(authority.prepareMission({
      workspaceId: workspace.id,
      provider: 'codex',
      prompt: 'Must remain blocked.',
    }, 72, 'window-session-tree-retry-0001')).rejects.toThrow('execution_already_active');

    const firstStop = runtime.stop(accepted.executionId);
    const concurrentStop = runtime.stop(accepted.executionId);
    expect(concurrentStop).toBe(firstStop);
    const [reconciled, duplicateResult] = await Promise.all([firstStop, concurrentStop]);
    expect(providerTerminate).toHaveBeenCalledTimes(1);
    expect(duplicateResult).toEqual(reconciled);
    expect(reconciled).toMatchObject({
      state: 'failed',
      sequence: 2,
      treeTermination: 'confirmed',
    });
    expect(authority.hasActiveExecution(72)).toBe(false);
    await expect(authority.prepareMission({
      workspaceId: workspace.id,
      provider: 'codex',
      prompt: 'Admission is released after confirmation.',
    }, 72, 'window-session-tree-retry-0001')).resolves.toMatchObject({ provider: 'codex' });
    expect(trackers.get(providerPid)?.dispose).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  it('does not fork after shutdown wins a concurrent session start', async () => {
    const root = await runtimeRoot('shutdown-start-race');
    const fork = vi.fn();
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: (pid) => fakeProcessTracker(pid),
      fork,
    });

    const catalogRequest = runtime.getCatalog();
    const shutdown = runtime.shutdown();
    await expect(catalogRequest).rejects.toThrow('runtime_unavailable');
    await expect(shutdown).resolves.toBeUndefined();
    expect(fork).not.toHaveBeenCalled();
    await expect(runtime.getCatalog()).rejects.toThrow('runtime_unavailable');
    expect(fork).not.toHaveBeenCalled();
  });

  it('settles an in-flight request during shutdown without posting a late launch or restarting', async () => {
    const root = await runtimeRoot('shutdown-request-race');
    const prepareSeen = deferred<void>();
    const children: ControlledUtilityProcess[] = [];
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: (pid) => fakeProcessTracker(pid),
      fork: (_modulePath, args) => {
        const child = new ControlledUtilityProcess(
          args?.[0] ?? 'missing_epoch',
          (request, controlled) => {
            if (request.type === 'catalog') {
              controlled.respond(request, { operation: 'catalog', catalog: catalog() });
            } else if (request.type === 'prepare') {
              prepareSeen.resolve();
            } else if (request.type === 'shutdown') {
              controlled.respond(request, { operation: 'shutdown', shutdown: true });
            }
          },
        );
        children.push(child);
        return child as unknown as UtilityProcess;
      },
    });
    await runtime.getCatalog();
    const preparation = runtime.prepare({
      provider: 'codex',
      missionId: 'mission_shutdown_request_race_01',
      promptDigest: 'a'.repeat(64),
      workspaceId: 'workspace_shutdown_request_race_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
    });
    await prepareSeen.promise;

    const shutdown = runtime.shutdown();
    await expect(preparation).rejects.toThrow('runtime_shutdown');
    await expect(shutdown).resolves.toBeUndefined();
    await expect(runtime.launch({
      preparationToken: 'preparation_shutdown_request_race_01',
      missionId: 'mission_shutdown_request_race_01',
      executionId: 'execution_shutdown_request_race_01',
      workspaceId: 'workspace_shutdown_request_race_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
      provider: 'codex',
      prompt: 'This launch must never cross shutdown.',
      timeoutMs: 60_000,
    })).rejects.toThrow('runtime_unavailable');
    expect(children).toHaveLength(1);
    expect(children[0]?.requests.filter((request) => request.type === 'launch')).toHaveLength(0);
  });

  it('keeps a failed Utility tree tracked and shutdown-locked until a later attempt confirms it', async () => {
    const root = await runtimeRoot('shutdown-utility-tree-retry');
    const children: ControlledUtilityProcess[] = [];
    const terminate = vi.fn()
      .mockResolvedValueOnce('failed' as const)
      .mockResolvedValueOnce('confirmed' as const);
    const tracker: TrackedProcessTree = {
      pid: 41_101,
      ready: Promise.resolve(true),
      terminate,
      dispose: vi.fn(),
    };
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: () => tracker,
      fork: (_modulePath, args) => {
        const child = new ControlledUtilityProcess(
          args?.[0] ?? 'missing_epoch',
          (request, controlled) => {
            if (request.type === 'catalog') {
              controlled.respond(request, { operation: 'catalog', catalog: catalog() });
            } else if (request.type === 'shutdown') {
              controlled.respond(request, { operation: 'shutdown', shutdown: true });
            }
          },
        );
        children.push(child);
        return child as unknown as UtilityProcess;
      },
    });
    await runtime.getCatalog();
    const directKill = vi.spyOn(children[0]!, 'kill').mockImplementationOnce(() => {
      throw new Error('fixture_direct_kill_failed');
    });

    const firstShutdown = runtime.shutdown();
    const concurrentShutdown = runtime.shutdown();
    expect(concurrentShutdown).toBe(firstShutdown);
    await expect(firstShutdown).rejects.toThrow('runtime_shutdown_unconfirmed');
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(directKill).toHaveBeenCalledTimes(1);
    expect(tracker.dispose).not.toHaveBeenCalled();
    await expect(runtime.getCatalog()).rejects.toThrow('runtime_unavailable');
    expect(children).toHaveLength(1);

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(1);
  });

  it('requires both Utility and active provider trees to confirm before shutdown resolves', async () => {
    const root = await runtimeRoot('shutdown-all-tree-retry');
    const providerPid = 52_003;
    const sessionTerminate = vi.fn(async (): Promise<'confirmed'> => 'confirmed');
    const providerTerminate = vi.fn()
      .mockResolvedValueOnce('failed' as const)
      .mockResolvedValueOnce('confirmed' as const);
    let child!: ControlledUtilityProcess;
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: (pid) => ({
        pid,
        ready: Promise.resolve(true),
        terminate: pid === providerPid ? providerTerminate : sessionTerminate,
        dispose: vi.fn(),
      }),
      fork: (_modulePath, args) => {
        child = new ControlledUtilityProcess(
          args?.[0] ?? 'missing_epoch',
          (request, controlled) => {
            if (request.type === 'prepare') {
              controlled.respond(request, preparedResult(request));
            } else if (request.type === 'launch') {
              controlled.publishProcess(request.executionId, providerPid);
              controlled.publishEvent(runtimeExecutionEventSchema.parse({
                missionId: request.missionId,
                executionId: request.executionId,
                sequence: 1,
                occurredAt: '2026-08-23T00:00:02.000Z',
                type: 'state',
                state: 'starting',
                error: null,
                treeTermination: 'not-required',
              }));
              controlled.respond(request, launchedResult(request));
            } else if (request.type === 'shutdown') {
              controlled.respond(request, { operation: 'shutdown', shutdown: true });
            }
          },
        );
        return child as unknown as UtilityProcess;
      },
    });
    const events = vi.fn();
    runtime.onEvent(events);
    const prepared = await runtime.prepare({
      provider: 'codex',
      missionId: 'mission_shutdown_all_tree_retry_01',
      promptDigest: 'b'.repeat(64),
      workspaceId: 'workspace_shutdown_all_tree_retry_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
    });
    await runtime.launch({
      preparationToken: prepared.preparationToken,
      missionId: 'mission_shutdown_all_tree_retry_01',
      executionId: 'execution_shutdown_all_tree_retry_01',
      workspaceId: 'workspace_shutdown_all_tree_retry_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
      provider: 'codex',
      prompt: 'Exercise shutdown tree confirmation.',
      timeoutMs: 60_000,
    });

    await expect(runtime.shutdown()).rejects.toThrow('runtime_shutdown_unconfirmed');
    expect(sessionTerminate).toHaveBeenCalledTimes(1);
    expect(providerTerminate).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({
      sequence: 2,
      state: 'failed',
      treeTermination: 'failed',
    }));

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(sessionTerminate).toHaveBeenCalledTimes(2);
    expect(providerTerminate).toHaveBeenCalledTimes(2);
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({
      sequence: 3,
      state: 'failed',
      treeTermination: 'confirmed',
    }));
  });

  it('binds a stop response to the projected terminal after intermediate ordered events', async () => {
    const root = await runtimeRoot('stop-response-ordered-events');
    let child!: ControlledUtilityProcess;
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: (pid) => fakeProcessTracker(pid),
      fork: (_modulePath, args) => {
        child = new ControlledUtilityProcess(
          args?.[0] ?? 'missing_epoch',
          (request, controlled) => {
            if (request.type === 'prepare') {
              controlled.respond(request, preparedResult(request));
            } else if (request.type === 'launch') {
              controlled.publishEvent(runtimeExecutionEventSchema.parse({
                missionId: request.missionId,
                executionId: request.executionId,
                sequence: 1,
                occurredAt: '2026-08-23T00:00:03.000Z',
                type: 'state',
                state: 'running',
                error: null,
                treeTermination: 'not-required',
              }));
              controlled.respond(request, launchedResult(request));
            } else if (request.type === 'stop') {
              controlled.publishEvent(runtimeExecutionEventSchema.parse({
                missionId: 'mission_stop_response_ordered_01',
                executionId: request.executionId,
                sequence: 2,
                occurredAt: '2026-08-23T00:00:04.000Z',
                type: 'state',
                state: 'stopping',
                error: null,
                treeTermination: 'pending',
              }));
              const terminal = runtimeExecutionEventSchema.parse({
                missionId: 'mission_stop_response_ordered_01',
                executionId: request.executionId,
                sequence: 3,
                occurredAt: '2026-08-23T00:00:05.000Z',
                type: 'state',
                state: 'stopped',
                error: null,
                treeTermination: 'confirmed',
              });
              controlled.publishEvent(terminal);
              controlled.respond(request, { operation: 'stop', event: terminal });
            } else if (request.type === 'shutdown') {
              controlled.respond(request, { operation: 'shutdown', shutdown: true });
            }
          },
        );
        return child as unknown as UtilityProcess;
      },
    });
    const prepared = await runtime.prepare({
      provider: 'codex',
      missionId: 'mission_stop_response_ordered_01',
      promptDigest: 'c'.repeat(64),
      workspaceId: 'workspace_stop_response_ordered_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
    });
    await runtime.launch({
      preparationToken: prepared.preparationToken,
      missionId: 'mission_stop_response_ordered_01',
      executionId: 'execution_stop_response_ordered_01',
      workspaceId: 'workspace_stop_response_ordered_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
      provider: 'codex',
      prompt: 'Stop after publishing an intermediate stopping event.',
      timeoutMs: 60_000,
    });

    await expect(runtime.stop('execution_stop_response_ordered_01')).resolves.toMatchObject({
      sequence: 3,
      state: 'stopped',
      treeTermination: 'confirmed',
    });
    await runtime.shutdown();
  });

  it('fails the session when a stop response is not bound to the requested execution', async () => {
    const root = await runtimeRoot('stop-response-binding');
    const children: ControlledUtilityProcess[] = [];
    const terminate = vi.fn(async (): Promise<'confirmed'> => 'confirmed');
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: (pid) => ({
        pid,
        ready: Promise.resolve(true),
        terminate,
        dispose: vi.fn(),
      }),
      fork: (_modulePath, args) => {
        const child = new ControlledUtilityProcess(
          args?.[0] ?? 'missing_epoch',
          (request, controlled) => {
            if (request.type === 'catalog') {
              controlled.respond(request, { operation: 'catalog', catalog: catalog() });
            } else if (request.type === 'prepare') {
              controlled.respond(request, preparedResult(request));
            } else if (request.type === 'launch') {
              controlled.publishEvent(runtimeExecutionEventSchema.parse({
                missionId: request.missionId,
                executionId: request.executionId,
                sequence: 1,
                occurredAt: '2026-08-23T00:00:03.000Z',
                type: 'state',
                state: 'starting',
                error: null,
                treeTermination: 'not-required',
              }));
              controlled.respond(request, launchedResult(request));
            } else if (request.type === 'stop') {
              controlled.publishEvent(runtimeExecutionEventSchema.parse({
                missionId: request.executionId.replace('execution_', 'mission_'),
                executionId: request.executionId,
                sequence: 2,
                occurredAt: '2026-08-23T00:00:04.000Z',
                type: 'state',
                state: 'stopped',
                error: null,
                treeTermination: 'confirmed',
              }));
              controlled.respond(request, {
                operation: 'stop',
                event: runtimeExecutionEventSchema.parse({
                  missionId: 'mission_wrong_stop_response_01',
                  executionId: 'execution_wrong_stop_response_01',
                  sequence: 2,
                  occurredAt: '2026-08-23T00:00:05.000Z',
                  type: 'state',
                  state: 'stopped',
                  error: null,
                  treeTermination: 'confirmed',
                }),
              });
            } else if (request.type === 'shutdown') {
              controlled.respond(request, { operation: 'shutdown', shutdown: true });
            }
          },
        );
        children.push(child);
        return child as unknown as UtilityProcess;
      },
    });
    const prepared = await runtime.prepare({
      provider: 'codex',
      missionId: 'mission_stop_response_binding_01',
      promptDigest: 'c'.repeat(64),
      workspaceId: 'workspace_stop_response_binding_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
    });
    await runtime.launch({
      preparationToken: prepared.preparationToken,
      missionId: 'mission_stop_response_binding_01',
      executionId: 'execution_stop_response_binding_01',
      workspaceId: 'workspace_stop_response_binding_01',
      workspaceRoot: root,
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
      provider: 'codex',
      prompt: 'Reject an unbound stop response.',
      timeoutMs: 60_000,
    });

    await expect(runtime.stop('execution_stop_response_binding_01'))
      .rejects.toThrow('runtime_protocol_failed');
    expect(terminate).toHaveBeenCalledTimes(1);
    await runtime.getCatalog();
    expect(children).toHaveLength(2);
    await runtime.shutdown();
  });

  it('fails closed on a duplicate response request id', async () => {
    const root = await runtimeRoot('duplicate-response');
    const children: ControlledUtilityProcess[] = [];
    const terminate = vi.fn(async (): Promise<'confirmed'> => 'confirmed');
    const runtime = new UtilityAgentRuntime({
      modulePath: join(root, 'fixed-runtime-child.mjs'),
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      trackProcess: (pid) => ({
        pid,
        ready: Promise.resolve(true),
        terminate,
        dispose: vi.fn(),
      }),
      fork: (_modulePath, args) => {
        const child = new ControlledUtilityProcess(
          args?.[0] ?? 'missing_epoch',
          (request, controlled) => {
            if (request.type === 'catalog') {
              controlled.respond(request, { operation: 'catalog', catalog: catalog() });
            } else if (request.type === 'shutdown') {
              controlled.respond(request, { operation: 'shutdown', shutdown: true });
            }
          },
        );
        children.push(child);
        return child as unknown as UtilityProcess;
      },
    });
    await runtime.getCatalog();
    const firstChild = children[0]!;
    const catalogRequest = firstChild.requests.find((request) => request.type === 'catalog')!;
    firstChild.emit('message', {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: firstChild.bootEpoch,
      type: 'response',
      requestId: catalogRequest.requestId,
      ok: true,
      result: { operation: 'catalog', catalog: catalog() },
    });

    await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1));
    await runtime.getCatalog();
    expect(children).toHaveLength(2);
    await runtime.shutdown();
  });
});

function fakeProcessTracker(pid: number): TrackedProcessTree {
  return {
    pid,
    ready: Promise.resolve(true),
    terminate: vi.fn(async (): Promise<'confirmed'> => 'confirmed'),
    dispose: vi.fn(),
  };
}

function preparedResult(
  request: Extract<RuntimeChildRequest, { type: 'prepare' }>,
): Extract<RuntimeChildResult, { operation: 'prepare' }> {
  return {
    operation: 'prepare',
    preparationToken: `preparation_${request.missionId.slice('mission_'.length)}`,
    missionId: request.missionId,
    promptDigest: request.promptDigest,
    provider: request.provider,
    catalogEntry: catalog().providers.find((entry) => entry.provider === request.provider)!,
  };
}

function launchedResult(
  request: Extract<RuntimeChildRequest, { type: 'launch' }>,
): Extract<RuntimeChildResult, { operation: 'launch' }> {
  return {
    operation: 'launch',
    accepted: true,
    missionId: request.missionId,
    executionId: request.executionId,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function runtimeRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `roundtable-utility-${label}-`));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'source-home'), { mode: 0o700 });
  return root;
}

function catalog(): RuntimeCatalog {
  return {
    providers: [
      entry('codex', 'Codex', 'codex-safe-v1', 'workspace-os-sandbox', 'os-denied'),
      entry('claude-code', 'Claude Code', 'claude-safe-v1', 'workspace-os-sandbox', 'os-denied'),
      entry('opencode', 'OpenCode', 'opencode-edit-v1', 'provider-permissions', 'not-guaranteed'),
    ],
  };
}

function entry(
  provider: 'codex' | 'claude-code' | 'opencode',
  label: string,
  adapterVersion: string,
  sandbox: 'workspace-os-sandbox' | 'provider-permissions',
  externalFileAccess: 'os-denied' | 'not-guaranteed',
): RuntimeCatalogEntry {
  return {
    provider,
    label,
    available: provider !== 'opencode',
    version: 'fixture 1.0',
    installHint: `Install ${label}.`,
    policy: {
      adapterVersion,
      sandbox,
      workspaceWrite: true,
      externalFileAccess,
      projectCustomizations: 'disabled',
      network: 'provider-required',
      secrets: 'provider-scoped',
      timeoutMs: 60_000,
    },
    warnings: provider === 'opencode' ? ['Execution disabled.'] : [],
  };
}
