import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MACOS_HOST_RUNTIME_V1_CORPUS,
  hostRuntimeSystemStatusSchema,
  workspaceEntriesSchema,
  runtimeCatalogSchema,
  missionApprovalPreviewSchema,
  applyChallengeSchema,
  reviewBundleSchema,
  runtimeExecutionSnapshotSchema,
  runtimeExecutionEventSchema,
} from '../src/index.js';

describe('macOS host runtime contract drift', () => {
  it('keeps every frozen operation and event variant represented', async () => {
    expect(Object.keys(MACOS_HOST_RUNTIME_V1_CORPUS.responsePayloadKeySets)).toEqual(
      expect.arrayContaining(MACOS_HOST_RUNTIME_V1_CORPUS.operations),
    );
    expect(Object.keys(MACOS_HOST_RUNTIME_V1_CORPUS.responsePayloadKeySets)).toHaveLength(13);
    expect(Object.keys(MACOS_HOST_RUNTIME_V1_CORPUS.eventPayloadKeySets)).toEqual([
      'execution.event.state', 'execution.event.output', 'execution.event.artifact',
    ]);
    const path = fileURLToPath(new URL('./fixtures/macos-host-runtime-v1-payloads.json', import.meta.url));
    const fixtures = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const fixtureSchemas = {
      'system.status': hostRuntimeSystemStatusSchema,
      'workspace.list': workspaceEntriesSchema,
      'runtime.catalog': runtimeCatalogSchema,
      'mission.prepare': missionApprovalPreviewSchema,
      'review.prepare': applyChallengeSchema,
      'execution.get': runtimeExecutionSnapshotSchema,
      'review.inspect': reviewBundleSchema,
    } as const;
    for (const [operation, schema] of Object.entries(fixtureSchemas)) {
      const payload = fixtures[operation];
      expect(schema.safeParse(payload).success, operation).toBe(true);
      expect(Object.keys(payload as Record<string, unknown>).sort(), operation).toEqual(
        [...MACOS_HOST_RUNTIME_V1_CORPUS.responsePayloadKeySets[operation as keyof typeof fixtureSchemas]].sort(),
      );
    }
    const eventFixtures = ['execution.event', 'execution.event.output', 'execution.event.artifact'] as const;
    for (const key of eventFixtures) {
      const payload = fixtures[key];
      expect(runtimeExecutionEventSchema.safeParse(payload).success, key).toBe(true);
      const variant = (payload as { type: string }).type;
      expect(Object.keys(payload as Record<string, unknown>).sort(), key).toEqual(
        [...MACOS_HOST_RUNTIME_V1_CORPUS.eventPayloadKeySets[`execution.event.${variant}` as keyof typeof MACOS_HOST_RUNTIME_V1_CORPUS.eventPayloadKeySets]].sort(),
      );
    }
  });
});
