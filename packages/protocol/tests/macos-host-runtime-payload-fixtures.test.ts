import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MACOS_HOST_RUNTIME_V1_CORPUS, hostRuntimeSystemStatusSchema, workspaceEntriesSchema, missionApprovalPreviewSchema, applyChallengeSchema, runtimeExecutionEventSchema, runtimeCatalogSchema, runtimeArtifactSchema, runtimeExecutionSnapshotSchema, reviewBundleSchema } from '../src/index.js';

type JsonObject = Record<string, unknown>;

describe('macOS host runtime payload corpus', () => {
  it('validates the shared minimal payload fixtures with zod', async () => {
    const path = fileURLToPath(new URL('./fixtures/macos-host-runtime-v1-payloads.json', import.meta.url));
    const fixtures = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(hostRuntimeSystemStatusSchema.parse(fixtures['system.status']).runtimeAvailability.state).toBe('ready');
    expect(workspaceEntriesSchema.parse(fixtures['workspace.list'])).toBeTruthy();
    expect(runtimeCatalogSchema.parse(fixtures['runtime.catalog']).providers[0]?.provider).toBe('codex');
    expect(missionApprovalPreviewSchema.parse(fixtures['mission.prepare'])).toBeTruthy();
    expect(applyChallengeSchema.parse(fixtures['review.prepare'])).toBeTruthy();
    expect(runtimeExecutionSnapshotSchema.parse(fixtures['execution.get'])).toBeTruthy();
    expect(reviewBundleSchema.parse(fixtures['review.inspect'])).toBeTruthy();
    expect(runtimeExecutionEventSchema.parse(fixtures['execution.event'])).toBeTruthy();
    expect(runtimeExecutionEventSchema.parse(fixtures['execution.event.output'])).toBeTruthy();
    expect(runtimeExecutionEventSchema.parse(fixtures['execution.event.artifact'])).toBeTruthy();
  });

  it('rejects unsafe payload mutations', async () => {
    const path = fileURLToPath(new URL('./fixtures/macos-host-runtime-v1-payloads.json', import.meta.url));
    const fixtures = JSON.parse(await readFile(path, 'utf8')) as Record<string, JsonObject>;
    const catalog = fixtures['runtime.catalog']!;
    const providers = catalog.providers as JsonObject[];
    expect(runtimeCatalogSchema.safeParse({ ...catalog, providers: [providers[0], providers[0], providers[2]] }).success).toBe(false);
    expect(runtimeCatalogSchema.safeParse({ ...catalog, providers: providers.map((provider) => ({ ...provider, policy: { ...(provider.policy as JsonObject), timeoutMs: 999 } })) }).success).toBe(false);
    expect(applyChallengeSchema.safeParse({ ...fixtures['review.prepare'], baselineHash: 'bad' }).success).toBe(false);
    expect(runtimeArtifactSchema.safeParse({ relativePath: 'x', change: 'deleted', size: 1, sha256: null, scanStatus: 'scanned', provenance: 'runtime-workspace-scan' }).success).toBe(false);
    const event = fixtures['execution.event'];
    expect(runtimeExecutionEventSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false);
    expect(runtimeExecutionEventSchema.safeParse({ ...event, state: 'unknown' }).success).toBe(false);
  });

  it('rejects policy, portable-name, and execution metadata drift', async () => {
    const path = fileURLToPath(new URL('./fixtures/macos-host-runtime-v1-payloads.json', import.meta.url));
    const fixtures = JSON.parse(await readFile(path, 'utf8')) as Record<string, JsonObject>;
    const catalog = fixtures['runtime.catalog']!;
    const providers = catalog.providers as JsonObject[];
    expect(runtimeCatalogSchema.safeParse({ ...catalog, providers: providers.map((provider, index) => index === 0 ? { ...provider, policy: { ...(provider.policy as JsonObject), adapterVersion: 'Bad Version' } } : provider) }).success).toBe(false);
    const mission = fixtures['mission.prepare'];
    expect(missionApprovalPreviewSchema.safeParse({ ...mission, workspace: { name: 'Repo' } }).success).toBe(false);
    expect(missionApprovalPreviewSchema.safeParse({ ...mission, policy: { ...mission.policy, network: 'open' } }).success).toBe(false);
    const listing = fixtures['workspace.list'];
    for (const name of ['bad\\name', 'bad:name', 'bad\u0001name']) {
      expect(workspaceEntriesSchema.safeParse({ ...listing, entries: [{ name, relativePath: name, kind: 'file' }] }).success).toBe(false);
    }
    const review = fixtures['review.inspect'];
    for (const name of ['../escape', 'bad\\name', 'bad:name', 'bad\u0001name']) {
      expect(reviewBundleSchema.safeParse({ ...review, protectedDirectoryNames: [name] }).success).toBe(false);
    }
    const snapshot = fixtures['execution.get'];
    expect(runtimeExecutionSnapshotSchema.safeParse({ ...snapshot, startedAt: 'yesterday' }).success).toBe(false);
    expect(runtimeExecutionSnapshotSchema.safeParse({ ...snapshot, error: '' }).success).toBe(false);
    expect(runtimeExecutionSnapshotSchema.safeParse({ ...snapshot, summary: 'x'.repeat(16_001) }).success).toBe(false);
    expect(runtimeExecutionSnapshotSchema.safeParse({ ...snapshot, logs: [{ sequence: 1, occurredAt: 'yesterday', stream: 'status', text: 'ok' }] }).success).toBe(false);
    expect(runtimeArtifactSchema.safeParse({ relativePath: 'x', change: 'created', size: 1_000_000_001, sha256: 'a'.repeat(64), scanStatus: 'scanned', provenance: 'runtime-workspace-scan' }).success).toBe(false);
  });

  it('rejects non-canonical runtime availability tuples', async () => {
    const path = fileURLToPath(new URL('./fixtures/macos-host-runtime-v1-payloads.json', import.meta.url));
    const fixtures = JSON.parse(await readFile(path, 'utf8')) as Record<string, JsonObject>;
    const status = fixtures['system.status']!;
    const availability = status.runtimeAvailability as JsonObject;
    expect(hostRuntimeSystemStatusSchema.safeParse({
      ...status,
      runtimeAvailability: { ...availability, state: 'ready', reason: 'broker_unavailable' },
    }).success).toBe(false);
    expect(hostRuntimeSystemStatusSchema.safeParse({
      ...status,
      runtimeAvailability: { ...availability, state: 'quarantined', reason: 'state_quarantined', admission: 'open' },
    }).success).toBe(false);
    expect(hostRuntimeSystemStatusSchema.safeParse({
      ...status,
      runtimeAvailability: { ...availability, supportedStateVersion: 2 },
    }).success).toBe(false);
    expect(hostRuntimeSystemStatusSchema.safeParse({
      ...status,
      runtimeAvailability: { ...availability, extra: true },
    }).success).toBe(false);
  });

  it('accepts every runtime availability tuple from the canonical contract', async () => {
    const path = fileURLToPath(new URL('./fixtures/macos-host-runtime-v1-payloads.json', import.meta.url));
    const fixtures = JSON.parse(await readFile(path, 'utf8')) as Record<string, JsonObject>;
    const status = fixtures['system.status']!;
    const availability = status.runtimeAvailability as JsonObject;
    for (const tuple of MACOS_HOST_RUNTIME_V1_CORPUS.runtimeAvailabilityTupleKeys) {
      const [state, reason, admission] = tuple.split('|');
      expect(hostRuntimeSystemStatusSchema.safeParse({
        ...status,
        runtimeAvailability: { ...availability, state, reason, admission },
      }).success, tuple).toBe(true);
    }
  });
});
