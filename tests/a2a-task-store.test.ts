import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readData, resetData } from '../src/server/store.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-a2a-binding-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

describe('A2A task binding storage', () => {
  it('initializes a durable binding collection', async () => {
    expect((await readData()).a2aTaskBindings).toEqual([]);
  });

  it('persists and completes a remote task binding', async () => {
    const module = await import('../src/server/actions/a2a/task-store.js').catch(() => null);

    expect(module).not.toBeNull();
    if (!module) return;
    await module.upsertA2ATaskBinding({
      id: 'a2a_turn-1_task-1',
      missionId: 'mission-1',
      turnId: 'turn-1',
      planTaskId: 'task-1',
      agentId: 'atlas',
      agentBaseUrl: 'https://atlas.example',
      agentCardPath: '/.well-known/agent-card.json',
      remoteTaskId: 'remote-1',
      remoteContextId: 'context-1',
      remoteTenant: '',
      protocolVersion: '1.0',
      state: 'working',
      error: null,
    });
    await module.finishA2ATaskBinding('turn-1', 'task-1', 'completed', null);

    expect(await module.bindingsForTurn('turn-1')).toMatchObject([{
      remoteTaskId: 'remote-1',
      state: 'completed',
      error: null,
    }]);
  });
});
