import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SupervisedProcess,
  SupervisedProcessResult,
} from '../src/process-supervisor.js';
import { LocalAgentRuntime } from '../src/runtime.js';
import type {
  RuntimeExecutionInput,
  TreeTermination,
} from '../src/types.js';

const runtimeMocks = vi.hoisted(() => ({
  startSupervisedProcess: vi.fn(),
}));

vi.mock('../src/containment.js', () => ({
  prepareContainedProviderLaunch: vi.fn(async (input: { providerExecutable: string }) => ({
    command: input.providerExecutable,
    args: [],
    policy: 'macos-seatbelt-workspace-write-user-data-keychain-job-escape-signal-ipc-procinfo-deny-v7',
  })),
}));

vi.mock('../src/environment.js', () => ({
  prepareRuntimeEnvironment: vi.fn(async () => ({
    env: {},
    secrets: [],
    hostHomeDirectory: '/host-home',
    homeDirectory: '/runtime-home',
    temporaryDirectory: '/runtime-temporary',
  })),
}));

vi.mock('../src/executable.js', () => ({
  assertExecutableUnchanged: vi.fn(async () => undefined),
}));

vi.mock('../src/process-supervisor.js', () => ({
  startSupervisedProcess: runtimeMocks.startSupervisedProcess,
}));

vi.mock('../src/macos-coalition-supervisor.js', () => ({
  startMacOsCoalitionSupervisedProcess: runtimeMocks.startSupervisedProcess,
}));

vi.mock('../src/providers.js', () => ({
  buildProviderLaunchPlan: vi.fn(async () => ({ args: [], stdin: '' })),
  providerFixedEnvironment: vi.fn(() => ({})),
}));

vi.mock('../src/workspace.js', () => ({
  assertWorkspaceIdentity: vi.fn(async () => undefined),
  diffWorkspaceSnapshots: vi.fn(() => []),
  isPathWithinWorkspace: vi.fn(() => false),
  scanWorkspace: vi.fn(async () => ({ entries: new Map(), truncated: false })),
}));

beforeEach(() => {
  runtimeMocks.startSupervisedProcess.mockReset();
});

describe('LocalAgentRuntime termination ownership', () => {
  it('retains a failed tree and preserves a terminal protocol failure after cleanup succeeds', async () => {
    const firstTermination = deferred<TreeTermination>();
    const processCompletion = deferred<SupervisedProcessResult>();
    const stop = vi.fn()
      .mockImplementationOnce(async () => {
        const termination = await firstTermination.promise;
        processCompletion.resolve(failedProcessResult());
        return termination;
      })
      .mockResolvedValueOnce('confirmed');
    runtimeMocks.startSupervisedProcess.mockReturnValue(fakeProcess(processCompletion.promise, stop));
    const runtime = new LocalAgentRuntime();
    const execution = await runtime.start(executionInput('execution_stop_retry'));

    const firstStop = execution.stop();
    const concurrentStop = execution.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    firstTermination.resolve('failed');

    await expect(firstStop).resolves.toMatchObject({
      disposition: 'termination_failed',
      treeTermination: 'failed',
    });
    await expect(concurrentStop).resolves.toMatchObject({
      disposition: 'termination_failed',
      treeTermination: 'failed',
    });
    await expect(execution.completion).resolves.toMatchObject({
      status: 'termination_failed',
      treeTermination: 'failed',
    });

    const retry = execution.stop();
    const concurrentRetry = execution.stop();
    expect(stop).toHaveBeenCalledTimes(2);
    await expect(retry).resolves.toMatchObject({
      disposition: 'already_terminal',
      treeTermination: 'confirmed',
    });
    await expect(concurrentRetry).resolves.toMatchObject({
      disposition: 'already_terminal',
      treeTermination: 'confirmed',
    });
    await expect(execution.stop()).resolves.toMatchObject({
      disposition: 'already_terminal',
      treeTermination: 'confirmed',
    });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('uses a confirmed completion proof when the concurrent stop attempt reports failed', async () => {
    const processCompletion = deferred<SupervisedProcessResult>();
    const stop = vi.fn(async () => {
      processCompletion.resolve({
        ...successfulProcessResult(),
        status: 'stopped',
      });
      return 'failed' as const;
    });
    runtimeMocks.startSupervisedProcess.mockReturnValue(fakeProcess(processCompletion.promise, stop));
    const runtime = new LocalAgentRuntime();
    const execution = await runtime.start(executionInput('execution_completion_proof'));

    await expect(execution.stop()).resolves.toMatchObject({
      disposition: 'stopped',
      treeTermination: 'confirmed',
    });
    await expect(execution.completion).resolves.toMatchObject({
      status: 'stopped',
      treeTermination: 'confirmed',
    });
    await expect(execution.stop()).resolves.toMatchObject({
      disposition: 'already_terminal',
      treeTermination: 'confirmed',
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('returns a failed stop without waiting on a pending completion so cleanup can retry', async () => {
    const processCompletion = deferred<SupervisedProcessResult>();
    const stop = vi.fn()
      .mockResolvedValueOnce('failed')
      .mockImplementationOnce(async () => {
        processCompletion.resolve({
          ...successfulProcessResult(),
          status: 'stopped',
        });
        return 'confirmed' as const;
      });
    runtimeMocks.startSupervisedProcess.mockReturnValue(fakeProcess(processCompletion.promise, stop));
    const runtime = new LocalAgentRuntime();
    const execution = await runtime.start(executionInput('execution_pending_completion_retry'));

    await expect(execution.stop()).resolves.toMatchObject({
      disposition: 'termination_failed',
      treeTermination: 'failed',
    });
    expect(stop).toHaveBeenCalledTimes(1);

    await expect(execution.stop()).resolves.toMatchObject({
      disposition: 'stopped',
      treeTermination: 'confirmed',
    });
    await expect(execution.completion).resolves.toMatchObject({
      status: 'stopped',
      treeTermination: 'confirmed',
    });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('waits for an asynchronous Darwin start before taking the shutdown ownership snapshot', async () => {
    const supervisorStart = deferred<SupervisedProcess>();
    const processCompletion = deferred<SupervisedProcessResult>();
    const stop = vi.fn(async () => {
      processCompletion.resolve({
        ...successfulProcessResult(),
        status: 'stopped',
      });
      return 'confirmed' as const;
    });
    runtimeMocks.startSupervisedProcess.mockReturnValue(supervisorStart.promise);
    const runtime = new LocalAgentRuntime();

    const start = runtime.start(executionInput('execution_start_shutdown_barrier'));
    await vi.waitFor(() => expect(runtimeMocks.startSupervisedProcess).toHaveBeenCalledTimes(1));
    const shutdown = runtime.shutdown();
    let shutdownSettled = false;
    void shutdown.then(
      () => { shutdownSettled = true; },
      () => { shutdownSettled = true; },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    expect(stop).not.toHaveBeenCalled();

    supervisorStart.resolve(fakeProcess(processCompletion.promise, stop));
    const execution = await start;
    await expect(shutdown).resolves.toBeUndefined();
    await expect(execution.completion).resolves.toMatchObject({
      status: 'stopped',
      treeTermination: 'confirmed',
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('shutdown');
    await expect(runtime.start(executionInput('execution_after_barrier_shutdown')))
      .rejects.toMatchObject({ code: 'runtime_shutting_down' });
  });

  it('fails shutdown closed, retains every failed tree, and single-flights the retry', async () => {
    const firstTermination = deferred<TreeTermination>();
    const processCompletion = deferred<SupervisedProcessResult>();
    const stop = vi.fn()
      .mockImplementationOnce(async () => {
        const termination = await firstTermination.promise;
        processCompletion.resolve(failedProcessResult());
        return termination;
      })
      .mockResolvedValueOnce('confirmed');
    runtimeMocks.startSupervisedProcess.mockReturnValue(fakeProcess(processCompletion.promise, stop));
    const runtime = new LocalAgentRuntime();
    await runtime.start(executionInput('execution_shutdown_retry'));

    const firstShutdown = runtime.shutdown();
    const concurrentShutdown = runtime.shutdown();
    expect(concurrentShutdown).toBe(firstShutdown);
    expect(stop).toHaveBeenCalledTimes(1);
    firstTermination.resolve('failed');

    await expect(firstShutdown).rejects.toThrow('runtime_shutdown_unconfirmed');
    await expect(concurrentShutdown).rejects.toThrow('runtime_shutdown_unconfirmed');
    await expect(runtime.start(executionInput('execution_after_shutdown'))).rejects.toMatchObject({
      code: 'runtime_shutting_down',
    });

    const retry = runtime.shutdown();
    const concurrentRetry = runtime.shutdown();
    expect(concurrentRetry).toBe(retry);
    await expect(retry).resolves.toBeUndefined();
    await expect(concurrentRetry).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenNthCalledWith(1, 'shutdown');
    expect(stop).toHaveBeenNthCalledWith(2, 'shutdown');

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

function executionInput(executionId: string): RuntimeExecutionInput {
  return {
    executionId,
    provider: 'codex',
    executable: {
      provider: 'codex',
      path: '/provider/codex',
      device: '1',
      inode: '2',
      size: '3',
      modifiedNanoseconds: '4',
      sha256: 'a'.repeat(64),
    },
    workspace: {
      root: '/workspace',
      device: '5',
      inode: '6',
    },
    prompt: 'Exercise retryable tree termination.',
    environment: {
      hostHomeDirectory: '/host-home',
      homeDirectory: '/runtime-home',
      temporaryDirectory: '/runtime-temporary',
    },
  };
}

function fakeProcess(
  completion: Promise<SupervisedProcessResult>,
  stop: SupervisedProcess['stop'],
): SupervisedProcess {
  return { pid: 42, completion, stop };
}

function failedProcessResult(): SupervisedProcessResult {
  return {
    status: 'termination_failed',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    treeTermination: 'failed',
  };
}

function successfulProcessResult(): SupervisedProcessResult {
  return {
    status: 'exited',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    treeTermination: 'confirmed',
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
