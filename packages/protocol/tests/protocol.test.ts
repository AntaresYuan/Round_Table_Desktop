import { describe, expect, it } from 'vitest';

import {
  commandEnvelopeSchema,
  desktopSystemInfoSchema,
  executionGetInputSchema,
  eventEnvelopeSchema,
  missionApprovalPreviewSchema,
  missionApproveInputSchema,
  missionPrepareInputSchema,
  PROTOCOL_VERSION,
  runtimeArtifactSchema,
  reviewBundleSchema,
  reviewExecutionInputSchema,
  applyChallengeSchema,
  runtimeCatalogSchema,
  runtimeExecutionEventSchema,
  runtimeExecutionSnapshotSchema,
  systemGetInfoQuerySchema,
  systemGetInfoResultSchema,
  workspaceEntriesSchema,
  workspaceIdSchema,
  workspaceListEntriesInputSchema,
  workspaceSelectionSchema,
} from '../src/index.js';

const base = {
  protocolVersion: PROTOCOL_VERSION,
  messageId: 'message_01',
  correlationId: 'correlation_01',
  occurredAt: '2026-08-23T08:30:00.000Z',
};

function expectRoundTrip<T>(schema: { parse(value: unknown): T }, value: unknown): void {
  const parsed = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
}

describe('protocol boundary', () => {
  it('validates review bundles and one-time apply challenges', () => {
    const bundle = {
      version: 1,
      bundleId: `review_${'a'.repeat(32)}`,
      executionId: 'execution_01',
      workspaceId: 'workspace_01',
      workspace: { root: '/private/tmp/workspace', device: '1', inode: '2' },
      staging: { root: '/private/tmp/staging', device: '1', inode: '3' },
      protectedDirectoryNames: ['.git'],
      protectedPaths: ['.git'],
      baselineHash: 'b'.repeat(64),
      resultHash: 'c'.repeat(64),
      changes: [],
      contentHash: 'd'.repeat(64),
    };
    expectRoundTrip(reviewBundleSchema, bundle);
    expectRoundTrip(reviewExecutionInputSchema, {
      executionId: bundle.executionId,
      workspaceId: bundle.workspaceId,
    });
    expect(applyChallengeSchema.parse({
      applyId: 'apply_01',
      bundleId: bundle.bundleId,
      executionId: bundle.executionId,
      workspaceId: bundle.workspaceId,
      baselineHash: bundle.baselineHash,
      contentHash: bundle.contentHash,
      expiresAt: '2026-08-23T09:00:00.000Z',
    })).toMatchObject({ applyId: 'apply_01' });
    expect(reviewBundleSchema.safeParse({ ...bundle, bundleId: 'review_bad' }).success).toBe(false);
    expect(reviewBundleSchema.safeParse({
      ...bundle,
      changes: [{
        relativePath: 'README.md',
        change: 'created',
        before: null,
        after: { kind: 'file', mode: 0o644, size: 4, sha256: 'e'.repeat(64), extra: true },
      }],
    }).success).toBe(false);
    expect(reviewBundleSchema.safeParse({
      ...bundle,
      changes: [{
        relativePath: 'README.md',
        change: 'deleted',
        before: null,
        after: null,
      }],
    }).success).toBe(false);
  });
  it('validates opaque IDs', () => {
    expect(workspaceIdSchema.parse('workspace_01')).toBe('workspace_01');
    expect(workspaceIdSchema.safeParse('../escape').success).toBe(false);
  });

  it('round-trips commands and rejects unsupported versions', () => {
    const command = {
      ...base,
      kind: 'command',
      name: 'mission.create',
      source: 'renderer',
      scope: { workspaceId: 'workspace_01' },
      idempotencyKey: 'key_01',
      payload: { prompt: 'Build desktop shell' },
    };
    expectRoundTrip(commandEnvelopeSchema, command);
    expect(commandEnvelopeSchema.safeParse({ ...command, protocolVersion: 2 }).success)
      .toBe(false);
  });

  it('round-trips events and rejects invalid sequences', () => {
    const event = {
      ...base,
      kind: 'event',
      name: 'task.completed',
      source: 'orchestrator',
      scope: { taskId: 'task_01' },
      aggregate: { kind: 'task', id: 'task_01', sequence: 1 },
      durability: 'durable',
      payload: { evidence: ['artifact_01'] },
    };
    expectRoundTrip(eventEnvelopeSchema, event);
    expect(eventEnvelopeSchema.safeParse({
      ...event,
      aggregate: { ...event.aggregate, sequence: 0 },
    }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({
      ...event,
      aggregate: { ...event.aggregate, id: 'task_other' },
    }).success).toBe(false);
  });

  it('round-trips system.getInfo query and result', () => {
    expectRoundTrip(systemGetInfoQuerySchema, {
      ...base,
      kind: 'query',
      name: 'system.getInfo',
      source: 'renderer',
      payload: {},
    });
    expectRoundTrip(systemGetInfoResultSchema, {
      ...base,
      kind: 'result',
      name: 'system.getInfo',
      requestId: 'message_01',
      source: 'main',
      payload: {
        product: 'roundtable',
        applicationVersion: '0.1.0',
        runtime: 'desktop-main',
        capabilities: ['mission.create'],
      },
    });
  });

  it('validates the narrow desktop IPC payloads', () => {
    expect(desktopSystemInfoSchema.parse({
      product: 'roundtable',
      applicationVersion: '0.1.0',
      protocolVersion: PROTOCOL_VERSION,
      platform: 'darwin',
      architecture: 'arm64',
      electronVersion: '43.4.1',
      capabilities: ['system.getinfo', 'workspace.select'],
    })).toMatchObject({ product: 'roundtable', protocolVersion: PROTOCOL_VERSION });

    expect(workspaceSelectionSchema.parse({
      selected: true,
      workspace: { id: 'workspace_01', name: 'demo' },
    })).toMatchObject({ selected: true });

    expect(workspaceEntriesSchema.parse({
      workspace: { id: 'workspace_01', name: 'demo' },
      relativePath: '',
      entries: [{ name: 'src', relativePath: 'src', kind: 'directory' }],
      truncated: false,
    }).entries).toHaveLength(1);
  });

  it('accepts canonical POSIX paths and rejects platform-dependent path syntax', () => {
    for (const relativePath of ['', 'src', 'src/components']) {
      expect(workspaceListEntriesInputSchema.safeParse({
        workspaceId: 'workspace_01',
        relativePath,
      }).success).toBe(true);
    }

    for (const relativePath of [
      '/etc',
      '../escape',
      'src/../escape',
      'src//file',
      'src\\file',
      '\\\\server\\share',
      'C:/Windows',
      'D:relative',
      'file.txt:stream',
      'src/\u0000secret',
      'src/\nsecret',
    ]) {
      expect(workspaceListEntriesInputSchema.safeParse({
        workspaceId: 'workspace_01',
        relativePath,
      }).success).toBe(false);
    }
  });

  it('requires entry names to be portable direct children of the listing', () => {
    const validListing = {
      workspace: { id: 'workspace_01', name: 'demo' },
      relativePath: 'src',
      entries: [{ name: 'index.ts', relativePath: 'src/index.ts', kind: 'file' }],
      truncated: false,
    };
    expect(workspaceEntriesSchema.safeParse(validListing).success).toBe(true);

    for (const entry of [
      { name: '../secret', relativePath: 'src/secret', kind: 'file' },
      { name: 'index.ts', relativePath: 'other/index.ts', kind: 'file' },
      { name: 'index.ts', relativePath: 'src/nested/index.ts', kind: 'file' },
      { name: 'file.txt:stream', relativePath: 'src/file.txt:stream', kind: 'file' },
    ]) {
      expect(workspaceEntriesSchema.safeParse({
        ...validListing,
        entries: [entry],
      }).success).toBe(false);
    }
  });

  it('keeps mission preparation separate from the single-use approval intent', () => {
    expect(missionPrepareInputSchema.parse({
      workspaceId: 'workspace_01',
      provider: 'codex',
      prompt: '  Build the approved feature.  ',
    })).toEqual({
      workspaceId: 'workspace_01',
      provider: 'codex',
      prompt: 'Build the approved feature.',
    });
    expect(missionApproveInputSchema.parse({ approvalId: 'approval_01' }))
      .toEqual({ approvalId: 'approval_01' });

    for (const value of [
      { workspaceId: 'workspace_01', provider: 'shell', prompt: 'run' },
      { workspaceId: 'workspace_01', provider: 'codex', prompt: '' },
      { workspaceId: 'workspace_01', provider: 'codex', prompt: 'run', command: 'sh' },
      { approvalId: 'approval_01', prompt: 'replace the approved prompt' },
    ]) {
      const schema = 'approvalId' in value ? missionApproveInputSchema : missionPrepareInputSchema;
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it('round-trips the bounded provider catalog and approval preview', () => {
    const policy = {
      adapterVersion: 'codex-v1',
      sandbox: 'workspace-os-sandbox',
      workspaceWrite: true,
      externalFileAccess: 'os-denied',
      projectCustomizations: 'disabled',
      network: 'provider-required',
      secrets: 'provider-scoped',
      timeoutMs: 1_800_000,
    } as const;
    expectRoundTrip(runtimeCatalogSchema, {
      providers: [
        {
          provider: 'codex',
          label: 'Codex',
          available: true,
          version: 'codex-cli 1.0',
          installHint: 'Install Codex CLI.',
          policy,
          warnings: [],
        },
        {
          provider: 'claude-code',
          label: 'Claude Code',
          available: false,
          version: null,
          installHint: 'Install Claude Code.',
          policy: { ...policy, adapterVersion: 'claude-v1' },
          warnings: ['Sandbox support is required.'],
        },
        {
          provider: 'opencode',
          label: 'OpenCode',
          available: false,
          version: null,
          installHint: 'Install OpenCode.',
          policy: {
            ...policy,
            adapterVersion: 'opencode-v1',
            sandbox: 'provider-permissions',
            externalFileAccess: 'provider-denied',
          },
          warnings: ['Shell tools are disabled.'],
        },
      ],
    });
    expectRoundTrip(missionApprovalPreviewSchema, {
      approvalId: 'approval_01',
      missionId: 'mission_01',
      workspace: { id: 'workspace_01', name: 'demo' },
      provider: 'codex',
      prompt: 'Build the approved feature.',
      policy,
      warnings: [],
      expiresAt: '2026-08-23T09:00:00.000Z',
    });
  });

  it('validates ordered runtime facts without exposing process authority', () => {
    const stateEvent = {
      missionId: 'mission_01',
      executionId: 'execution_01',
      sequence: 1,
      occurredAt: '2026-08-23T08:30:00.000Z',
      type: 'state',
      state: 'running',
      error: null,
      treeTermination: 'not-required',
    };
    expectRoundTrip(runtimeExecutionEventSchema, stateEvent);
    expect(runtimeExecutionEventSchema.safeParse({ ...stateEvent, pid: 42 }).success).toBe(false);
    expect(runtimeExecutionEventSchema.safeParse({
      ...stateEvent,
      type: 'output',
      stream: 'stdout',
      text: 'hello',
      truncated: false,
      env: { SECRET: 'leak' },
    }).success).toBe(false);
    expect(executionGetInputSchema.safeParse({
      executionId: 'execution_01',
      cwd: '/tmp/escape',
    }).success).toBe(false);
  });

  it('only accepts scanned workspace-relative artifacts and coherent snapshots', () => {
    const artifact = {
      relativePath: 'src/result.ts',
      change: 'modified',
      size: 42,
      sha256: 'a'.repeat(64),
      scanStatus: 'scanned',
      provenance: 'runtime-workspace-scan',
    };
    expectRoundTrip(runtimeArtifactSchema, artifact);
    expect(runtimeArtifactSchema.safeParse({
      ...artifact,
      relativePath: '/tmp/result.ts',
    }).success).toBe(false);
    expect(runtimeArtifactSchema.safeParse({
      ...artifact,
      change: 'deleted',
    }).success).toBe(false);
    expect(runtimeArtifactSchema.safeParse({
      ...artifact,
      sha256: null,
    }).success).toBe(false);

    const snapshot = {
      missionId: 'mission_01',
      executionId: 'execution_01',
      workspace: { id: 'workspace_01', name: 'demo' },
      provider: 'codex',
      state: 'stopped',
      sequence: 3,
      startedAt: '2026-08-23T08:30:00.000Z',
      finishedAt: '2026-08-23T08:31:00.000Z',
      error: null,
      summary: '',
      treeTermination: 'confirmed',
      logs: [{
        sequence: 2,
        occurredAt: '2026-08-23T08:30:30.000Z',
        stream: 'stdout',
        text: 'working',
      }],
      artifacts: [artifact],
    };
    expectRoundTrip(runtimeExecutionSnapshotSchema, snapshot);
    expect(runtimeExecutionSnapshotSchema.safeParse({
      ...snapshot,
      state: 'running',
    }).success).toBe(false);
    expect(runtimeExecutionSnapshotSchema.safeParse({
      ...snapshot,
      logs: [{ ...snapshot.logs[0], sequence: 4 }],
    }).success).toBe(false);
  });
});
