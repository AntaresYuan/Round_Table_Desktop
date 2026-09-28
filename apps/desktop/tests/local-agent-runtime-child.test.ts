import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type {
  ExecutableFingerprint,
  RuntimeEvent,
  RuntimeExecution,
  RuntimeExecutionInput,
  RuntimeProvider,
} from '@roundtable/runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRIVATE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeChildMessage,
  type RuntimeChildRequest,
} from '../src/runtime-private-protocol.js';

const runtimeMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  assertWorkspaceIdentity: vi.fn(),
  probeProviderCapability: vi.fn(),
  probeRuntimeContainmentCapability: vi.fn(),
  resolveProviderExecutable: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('@roundtable/runtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roundtable/runtime')>();
  class FakeLocalAgentRuntime {
    constructor(options?: unknown) {
      runtimeMocks.construct(options);
    }

    readonly start = runtimeMocks.start;
    readonly stop = runtimeMocks.stop;
    readonly shutdown = runtimeMocks.shutdown;
  }
  return {
    ...original,
    LocalAgentRuntime: FakeLocalAgentRuntime,
    assertWorkspaceIdentity: runtimeMocks.assertWorkspaceIdentity,
    probeProviderCapability: runtimeMocks.probeProviderCapability,
    probeRuntimeContainmentCapability: runtimeMocks.probeRuntimeContainmentCapability,
    resolveProviderExecutable: runtimeMocks.resolveProviderExecutable,
  };
});

import { RuntimeChildService } from '../src/local-agent-runtime-child.mjs';

const bootEpoch = 'epoch_child_replay_1234567890';
const workspace = {
  root: '/private/tmp/roundtable-child-replay',
  device: '11',
  inode: '22',
};
const hostHomeDirectory = '/Users/roundtable-fixture';
const prompt = 'Apply the exact approved replay fixture.';

beforeEach(() => {
  vi.clearAllMocks();
  runtimeMocks.assertWorkspaceIdentity.mockResolvedValue(undefined);
  runtimeMocks.resolveProviderExecutable.mockImplementation(async (provider: RuntimeProvider) => (
    fingerprint(provider)
  ));
  runtimeMocks.probeProviderCapability.mockImplementation(async (input: {
    provider: RuntimeProvider;
    executable: ExecutableFingerprint;
  }) => ({
    provider: input.provider,
    available: true,
    version: 'fixture 1.0',
    executable: input.executable,
    disclosures: [],
  }));
  runtimeMocks.probeRuntimeContainmentCapability.mockResolvedValue({
    available: true,
    policy: 'macos-seatbelt-user-data-read-deny-v2',
  });
  runtimeMocks.start.mockImplementation(async (
    _input: RuntimeExecutionInput,
  ): Promise<RuntimeExecution> => ({
    executionId: 'execution_child_replay_first_01',
    completion: new Promise(() => undefined),
    stop: vi.fn(),
  }));
  runtimeMocks.stop.mockResolvedValue({
    executionId: 'execution_child_replay_first_01',
    disposition: 'already_terminal',
    treeTermination: 'confirmed',
  });
  runtimeMocks.shutdown.mockResolvedValue(undefined);
});

describe('local agent Runtime child preparation commitments', () => {
  it('trusts the entire development monorepo when constructing the Runtime', () => {
    const expectedMonorepoRoot = fileURLToPath(new URL('../../../', import.meta.url));

    new RuntimeChildService(bootEpoch, '/private/tmp/runtime-state', vi.fn(), {
      executionBackend: 'legacy-fixture',
    });

    expect(runtimeMocks.construct).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.construct).toHaveBeenCalledWith({
      trustedCodeRoots: [expectedMonorepoRoot],
    });
  });

  it('fails the legacy same-UID provider catalog closed', async () => {
    runtimeMocks.probeRuntimeContainmentCapability.mockResolvedValue({
      available: false,
      policy: null,
      reason: 'same_uid_isolation_unsafe',
    });
    const messages: RuntimeChildMessage[] = [];
    const service = new RuntimeChildService(bootEpoch, '/private/tmp/runtime-state', (message) => {
      messages.push(message);
    }, { executionBackend: 'legacy-fixture' });
    const request: Extract<RuntimeChildRequest, { type: 'catalog' }> = {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      requestId: 'request_catalog_same_uid_unsafe_01',
      type: 'catalog',
      hostHomeDirectory,
      searchDirectories: ['/usr/local/bin'],
    };

    await service.receive(request);

    const result = successfulResponse(messages, request.requestId);
    if (result.operation !== 'catalog') throw new Error('missing_catalog');
    expect(result.catalog.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'codex',
        available: false,
      }),
      expect.objectContaining({
        provider: 'claude-code',
        available: false,
      }),
    ]));
    expect(runtimeMocks.start).not.toHaveBeenCalled();
  });

  it('never routes the default service-UID backend into the local runtime', async () => {
    const service = new RuntimeChildService(
      bootEpoch,
      '/private/tmp/runtime-state',
      vi.fn(),
    );
    const request: Extract<RuntimeChildRequest, { type: 'prepare' }> = {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      requestId: 'request_service_uid_prepare_blocked_01',
      type: 'prepare',
      provider: 'codex',
      missionId: 'mission_service_uid_blocked_01',
      promptDigest: createHash('sha256').update(prompt).digest('hex'),
      hostHomeDirectory,
      workspaceId: 'workspace_service_uid_blocked_01',
      workspace,
      grantRevision: 1,
      searchDirectories: ['/usr/local/bin'],
    };
    await service.receive(request);
    expect(runtimeMocks.start).not.toHaveBeenCalled();
  });

  it('keeps every real provider unavailable until the service-UID broker is live', async () => {
    const messages: RuntimeChildMessage[] = [];
    const service = new RuntimeChildService(
      bootEpoch,
      '/private/tmp/runtime-state',
      (message) => messages.push(message),
    );
    const request: Extract<RuntimeChildRequest, { type: 'catalog' }> = {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      requestId: 'request_service_uid_catalog_closed_01',
      type: 'catalog',
      hostHomeDirectory,
      searchDirectories: ['/usr/local/bin'],
    };

    await service.receive(request);

    const result = successfulResponse(messages, request.requestId);
    if (result.operation !== 'catalog') throw new Error('missing_catalog');
    expect(result.catalog.providers).toHaveLength(3);
    for (const provider of result.catalog.providers) {
      expect(provider.available).toBe(false);
      expect(provider.version).toBeNull();
      expect(provider.warnings.join(' ')).toContain('security_capability_missing');
    }
    expect(runtimeMocks.resolveProviderExecutable).not.toHaveBeenCalled();
  });

  it('serializes concurrent launch replays and consumes the bound preparation exactly once', async () => {
    const messages: RuntimeChildMessage[] = [];
    const service = new RuntimeChildService(bootEpoch, '/private/tmp/runtime-state', (message) => {
      messages.push(message);
    }, { executionBackend: 'legacy-fixture' });
    const prepareRequest: Extract<RuntimeChildRequest, { type: 'prepare' }> = {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      requestId: 'request_prepare_child_replay_01',
      type: 'prepare',
      provider: 'codex',
      missionId: 'mission_child_replay_1234567890',
      promptDigest: digest(prompt),
      hostHomeDirectory,
      workspaceId: 'workspace_child_replay_1234567890',
      workspace,
      grantRevision: 3,
      searchDirectories: ['/usr/local/bin'],
    };
    await service.receive(prepareRequest);
    const preparation = successfulResponse(messages, prepareRequest.requestId);
    expect(preparation).toMatchObject({
      operation: 'prepare',
      missionId: prepareRequest.missionId,
      promptDigest: prepareRequest.promptDigest,
      provider: prepareRequest.provider,
    });
    if (preparation.operation !== 'prepare') throw new Error('missing_preparation');

    const launchBase = {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      type: 'launch' as const,
      preparationToken: preparation.preparationToken,
      missionId: prepareRequest.missionId,
      workspaceId: prepareRequest.workspaceId,
      workspace,
      grantRevision: prepareRequest.grantRevision,
      provider: prepareRequest.provider,
      prompt,
      timeoutMs: 60_000,
      environment: {
        homeDirectory: '/private/tmp/runtime-state/execution/home',
        temporaryDirectory: '/private/tmp/runtime-state/execution/tmp',
        hostHomeDirectory,
        credential: {
          provider: 'codex' as const,
          kind: 'openai-api-key' as const,
          value: 'fixture-provider-secret',
        },
      },
    };
    const first: Extract<RuntimeChildRequest, { type: 'launch' }> = {
      ...launchBase,
      requestId: 'request_launch_child_replay_first_01',
      executionId: 'execution_child_replay_first_01',
    };
    const replay: Extract<RuntimeChildRequest, { type: 'launch' }> = {
      ...launchBase,
      requestId: 'request_launch_child_replay_second_01',
      executionId: 'execution_child_replay_second_01',
    };

    await Promise.all([service.receive(first), service.receive(replay)]);

    expect(successfulResponse(messages, first.requestId)).toMatchObject({
      operation: 'launch',
      accepted: true,
      missionId: first.missionId,
      executionId: first.executionId,
    });
    expect(errorResponse(messages, replay.requestId)).toBe('runtime_preparation_invalid');
    expect(runtimeMocks.start).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.start).toHaveBeenCalledWith(expect.objectContaining({
      executionId: first.executionId,
      provider: first.provider,
      prompt: first.prompt,
      workspace: first.workspace,
    }));
  });

  it.each([
    {
      label: 'missing hash',
      artifact: {
        relativePath: 'result.txt',
        change: 'created' as const,
        hash: null,
        size: 6,
      },
    },
    {
      label: 'missing size',
      artifact: {
        relativePath: 'result.txt',
        change: 'modified' as const,
        hash: 'a'.repeat(64),
        size: null,
      },
    },
  ])('does not project an incomplete artifact as scanned ($label)', async ({ artifact }) => {
    const messages: RuntimeChildMessage[] = [];
    const service = new RuntimeChildService(bootEpoch, '/private/tmp/runtime-state', (message) => {
      messages.push(message);
    }, { executionBackend: 'legacy-fixture' });
    const prepareRequest: Extract<RuntimeChildRequest, { type: 'prepare' }> = {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      requestId: 'request_prepare_scan_truth_01',
      type: 'prepare',
      provider: 'codex',
      missionId: 'mission_scan_truth_1234567890',
      promptDigest: digest(prompt),
      hostHomeDirectory,
      workspaceId: 'workspace_scan_truth_1234567890',
      workspace,
      grantRevision: 4,
      searchDirectories: ['/usr/local/bin'],
    };
    await service.receive(prepareRequest);
    const preparation = successfulResponse(messages, prepareRequest.requestId);
    if (preparation.operation !== 'prepare') throw new Error('missing_preparation');

    const launchRequest: Extract<RuntimeChildRequest, { type: 'launch' }> = {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      requestId: 'request_launch_scan_truth_01',
      type: 'launch',
      preparationToken: preparation.preparationToken,
      missionId: prepareRequest.missionId,
      executionId: 'execution_scan_truth_1234567890',
      workspaceId: prepareRequest.workspaceId,
      workspace,
      grantRevision: prepareRequest.grantRevision,
      provider: prepareRequest.provider,
      prompt,
      timeoutMs: 60_000,
      environment: {
        homeDirectory: '/private/tmp/runtime-state/execution/home',
        temporaryDirectory: '/private/tmp/runtime-state/execution/tmp',
        hostHomeDirectory,
      },
    };
    runtimeMocks.start.mockImplementationOnce(async (): Promise<RuntimeExecution> => ({
      executionId: launchRequest.executionId,
      completion: new Promise(() => undefined),
      stop: vi.fn(),
    }));
    await service.receive(launchRequest);
    const startInput = runtimeMocks.start.mock.calls[0]?.[0] as RuntimeExecutionInput | undefined;
    if (!startInput?.onEvent) throw new Error('missing_runtime_observer');

    startInput.onEvent(runtimeEvent(launchRequest.executionId, 1, {
      kind: 'artifact.changed',
      artifact,
    }));
    startInput.onEvent(runtimeEvent(launchRequest.executionId, 2, {
      kind: 'process.exited',
      exitCode: 0,
      signal: null,
      status: 'exited',
      treeTermination: 'confirmed',
    }));

    const projectedEvents = messages.flatMap((message) => (
      message.type === 'event' ? [message.event] : []
    ));
    expect(projectedEvents.some((event) => event.type === 'artifact')).toBe(false);
    expect(projectedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'output',
        stream: 'status',
        text: 'runtime_artifact_scan_incomplete',
      }),
      expect.objectContaining({
        type: 'state',
        state: 'failed',
        error: 'runtime_scan_failed',
        treeTermination: 'confirmed',
      }),
    ]));
  });
});

function runtimeEvent(
  executionId: string,
  sequence: number,
  update: TestRuntimeEventUpdate,
): RuntimeEvent {
  return {
    executionId,
    sequence,
    occurredAt: '2026-08-23T08:30:00.000Z',
    ...update,
  } as RuntimeEvent;
}

type TestRuntimeEventUpdate = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent
    ? Omit<Event, 'executionId' | 'sequence' | 'occurredAt'>
    : never
  : never;

function successfulResponse(messages: RuntimeChildMessage[], requestId: string) {
  const response = messages.find((message) => (
    message.type === 'response' && message.requestId === requestId && message.ok
  ));
  if (!response || response.type !== 'response' || !response.ok) {
    throw new Error(`missing_success_${requestId}`);
  }
  return response.result;
}

function errorResponse(messages: RuntimeChildMessage[], requestId: string): string | null {
  const response = messages.find((message) => (
    message.type === 'response' && message.requestId === requestId && !message.ok
  ));
  return response?.type === 'response' && !response.ok ? response.code : null;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fingerprint(provider: RuntimeProvider): ExecutableFingerprint {
  return {
    provider,
    path: `/usr/local/bin/${provider}`,
    device: '1',
    inode: '2',
    size: '3',
    modifiedNanoseconds: '4',
    sha256: 'a'.repeat(64),
  };
}
