import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveTurn, createTurn } from '../src/server/actions/turn-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';
const actor: Actor = { id: 'a2a-user', email: 'a2a@roundtable.local', name: 'A2A User' };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-a2a-dispatch-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_WORKSPACE_ROOT = join(tempDir, 'workspaces');
  process.env.ROUNDTABLE_CLARIFY_ENABLED = 'false';
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_WORKSPACE_ROOT;
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  await rm(tempDir, { recursive: true, force: true });
});

describe('A2A workflow dispatch', () => {
  it('surfaces a missing remote and falls back to local dispatch', async () => {
    const turn = await createTurn({ actor, message: '@atlas build a small status page.' });
    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'a2a',
    });

    expect(result.dispatchStatus).toBe('completed');
    expect(result.dispatchAdapter).toBe('a2a');
    expect(result.records.some((record) => record.events.some((event) =>
      event.type === 'thinking_delta' && event.delta.includes('fell back to local-dispatch'),
    ))).toBe(true);
  });
});
