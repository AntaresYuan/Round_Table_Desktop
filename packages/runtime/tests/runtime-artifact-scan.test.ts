import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SupervisedProcess,
  SupervisedProcessResult,
} from '../src/process-supervisor.js';
import { LocalAgentRuntime } from '../src/runtime.js';
import type {
  RuntimeArtifact,
  RuntimeEvent,
  RuntimeExecutionInput,
} from '../src/types.js';

const runtimeMocks = vi.hoisted(() => ({
  diffWorkspaceSnapshots: vi.fn(),
  scanWorkspace: vi.fn(),
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
  diffWorkspaceSnapshots: runtimeMocks.diffWorkspaceSnapshots,
  isPathWithinWorkspace: vi.fn(() => false),
  scanWorkspace: runtimeMocks.scanWorkspace,
}));

beforeEach(() => {
  runtimeMocks.diffWorkspaceSnapshots.mockReset().mockReturnValue([]);
  runtimeMocks.scanWorkspace.mockReset().mockResolvedValue(snapshot(false));
  runtimeMocks.startSupervisedProcess.mockReset().mockReturnValue(fakeProcess());
});

describe('LocalAgentRuntime artifact scan truth', () => {
  it('refuses to launch when the baseline workspace scan is truncated', async () => {
    runtimeMocks.scanWorkspace.mockResolvedValueOnce(snapshot(true));
    const events: RuntimeEvent[] = [];
    const runtime = new LocalAgentRuntime();

    await expect(runtime.start(executionInput('execution_baseline_truncated', events)))
      .rejects.toMatchObject({ code: 'workspace_scan_failed' });

    expect(runtimeMocks.startSupervisedProcess).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'execution.failed',
        code: 'workspace_scan_failed',
      }),
    ]);
  });

  it('fails closed and publishes no artifacts when the final scan is truncated', async () => {
    runtimeMocks.scanWorkspace
      .mockResolvedValueOnce(snapshot(false))
      .mockResolvedValueOnce(snapshot(true));
    runtimeMocks.diffWorkspaceSnapshots.mockReturnValue([
      completeArtifact('created-after-truncated-scan.txt'),
    ]);
    const events: RuntimeEvent[] = [];
    const runtime = new LocalAgentRuntime();

    const execution = await runtime.start(executionInput('execution_final_truncated', events));
    const result = await execution.completion;

    expect(result).toMatchObject({
      status: 'scan_failed',
      scanTruncated: true,
      artifacts: [],
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'execution.failed', code: 'workspace_scan_failed' }),
      expect.objectContaining({ kind: 'process.exited', status: 'scan_failed' }),
    ]));
    expect(events.some((event) => event.kind === 'artifact.changed')).toBe(false);
  });

  it.each([
    {
      label: 'missing content hash',
      artifact: { ...completeArtifact('missing-hash.txt'), hash: null },
    },
    {
      label: 'missing content size',
      artifact: { ...completeArtifact('missing-size.txt'), size: null },
    },
  ])('fails closed for a created artifact with $label', async ({ artifact }) => {
    runtimeMocks.scanWorkspace
      .mockResolvedValueOnce(snapshot(false))
      .mockResolvedValueOnce(snapshot(false));
    runtimeMocks.diffWorkspaceSnapshots.mockReturnValue([artifact]);
    const events: RuntimeEvent[] = [];
    const runtime = new LocalAgentRuntime();

    const execution = await runtime.start(executionInput(
      `execution_incomplete_${artifact.relativePath.replaceAll(/[^a-z]/gu, '_')}`,
      events,
    ));
    const result = await execution.completion;

    expect(result).toMatchObject({
      status: 'scan_failed',
      scanTruncated: true,
      artifacts: [],
    });
    expect(events.some((event) => event.kind === 'artifact.changed')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'execution.failed', code: 'workspace_scan_failed' }),
      expect.objectContaining({ kind: 'process.exited', status: 'scan_failed' }),
    ]));
  });

  it('publishes no artifacts and skips the final scan while process ownership is unconfirmed', async () => {
    runtimeMocks.diffWorkspaceSnapshots.mockReturnValue([
      completeArtifact('unsafe-while-process-still-active.txt'),
    ]);
    runtimeMocks.startSupervisedProcess.mockReturnValue(fakeProcess({
      ...successfulProcessResult(),
      status: 'termination_failed',
      treeTermination: 'failed',
    }));
    const events: RuntimeEvent[] = [];
    const runtime = new LocalAgentRuntime();

    const execution = await runtime.start(executionInput('execution_unconfirmed_tree', events));
    const result = await execution.completion;

    expect(result).toMatchObject({
      status: 'termination_failed',
      treeTermination: 'failed',
      scanTruncated: true,
      artifacts: [],
    });
    expect(runtimeMocks.scanWorkspace).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.diffWorkspaceSnapshots).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === 'artifact.changed')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'execution.failed',
        code: 'process_tree_termination_failed',
      }),
    ]));
  });
});

function executionInput(executionId: string, events: RuntimeEvent[]): RuntimeExecutionInput {
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
    prompt: 'Produce one fully scanned artifact.',
    environment: {
      hostHomeDirectory: '/host-home',
      homeDirectory: '/runtime-home',
      temporaryDirectory: '/runtime-temporary',
    },
    onEvent: (event) => events.push(event),
  };
}

function snapshot(truncated: boolean) {
  return { entries: new Map(), truncated };
}

function completeArtifact(relativePath: string): RuntimeArtifact {
  return {
    relativePath,
    change: 'created',
    hash: 'b'.repeat(64),
    size: 12,
  };
}

function fakeProcess(
  result: SupervisedProcessResult = successfulProcessResult(),
): SupervisedProcess {
  return {
    pid: 42,
    completion: Promise.resolve(result),
    stop: vi.fn(async () => 'confirmed'),
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
