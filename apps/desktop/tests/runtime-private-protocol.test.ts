import { describe, expect, it } from 'vitest';

import {
  PRIVATE_RUNTIME_PROTOCOL_VERSION,
  parseRuntimeChildMessage,
  parseRuntimeChildRequest,
} from '../src/runtime-private-protocol.js';

const base = {
  protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
  bootEpoch: 'epoch_12345678901234567890',
  requestId: 'request_12345678901234567890',
};

describe('desktop private Runtime protocol', () => {
  it('accepts only fixed provider intent and grant-bound launch fields', () => {
    const prepare = parseRuntimeChildRequest({
      ...base,
      type: 'prepare',
      provider: 'codex',
      missionId: 'mission_12345678901234567890',
      promptDigest: 'a'.repeat(64),
      hostHomeDirectory: '/Users/roundtable-test',
      workspaceId: 'workspace_12345678901234567890',
      workspace: { root: '/private/tmp/workspace', device: '1', inode: '2' },
      grantRevision: 4,
      searchDirectories: ['/usr/local/bin'],
    });
    expect(prepare).toMatchObject({
      type: 'prepare',
      provider: 'codex',
      grantRevision: 4,
    });

    const launch = parseRuntimeChildRequest({
      ...base,
      type: 'launch',
      preparationToken: 'preparation_12345678901234567890',
      missionId: 'mission_12345678901234567890',
      executionId: 'execution_12345678901234567890',
      workspaceId: 'workspace_12345678901234567890',
      workspace: { root: '/private/tmp/workspace', device: '1', inode: '2' },
      grantRevision: 4,
      provider: 'codex',
      prompt: 'Make the approved edit.',
      timeoutMs: 60_000,
      environment: {
        homeDirectory: '/private/tmp/runtime/home',
        temporaryDirectory: '/private/tmp/runtime/tmp',
        hostHomeDirectory: '/Users/roundtable-test',
        credential: {
          provider: 'codex',
          kind: 'openai-api-key',
          value: 'test-provider-secret',
        },
      },
    });
    expect(launch).toMatchObject({ type: 'launch', provider: 'codex', grantRevision: 4 });
    expect(launch).not.toHaveProperty('command');
    expect(launch).not.toHaveProperty('args');
    expect(launch).not.toHaveProperty('cwd');
    expect(launch).not.toHaveProperty('env');
  });

  it('rejects arbitrary execution fields, mismatched credential shapes, and stale revisions', () => {
    const valid = {
      ...base,
      type: 'launch',
      preparationToken: 'preparation_12345678901234567890',
      missionId: 'mission_12345678901234567890',
      executionId: 'execution_12345678901234567890',
      workspaceId: 'workspace_12345678901234567890',
      workspace: { root: '/private/tmp/workspace', device: '1', inode: '2' },
      grantRevision: 1,
      provider: 'codex',
      prompt: 'Approved prompt',
      timeoutMs: 60_000,
      environment: {
        homeDirectory: '/private/tmp/runtime/home',
        temporaryDirectory: '/private/tmp/runtime/tmp',
        hostHomeDirectory: '/Users/roundtable-test',
      },
    };
    expect(() => parseRuntimeChildRequest({ ...valid, command: '/bin/sh' })).toThrow();
    expect(() => parseRuntimeChildRequest({ ...valid, grantRevision: 0 })).toThrow();
    expect(() => parseRuntimeChildRequest({
      ...valid,
      environment: {
        ...valid.environment,
        credential: {
          provider: 'claude-code',
          kind: 'openai-api-key',
          value: 'test-provider-secret',
        },
      },
    })).toThrow();
  });

  it('strictly validates epoch-scoped responses and public execution events', () => {
    const event = {
      missionId: 'mission_12345678901234567890',
      executionId: 'execution_12345678901234567890',
      sequence: 1,
      occurredAt: '2026-08-23T00:00:00.000Z',
      type: 'state',
      state: 'running',
      error: null,
      treeTermination: 'not-required',
    };
    expect(parseRuntimeChildMessage({
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: base.bootEpoch,
      type: 'event',
      event,
    })).toMatchObject({ type: 'event', event });
    expect(() => parseRuntimeChildMessage({
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: base.bootEpoch,
      type: 'event',
      event: { ...event, pid: 42 },
    })).toThrow();
    expect(() => parseRuntimeChildMessage({
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch: base.bootEpoch,
      type: 'response',
      requestId: base.requestId,
      ok: true,
      result: { operation: 'launch', accepted: true, argv: ['unsafe'] },
    })).toThrow();
  });
});
