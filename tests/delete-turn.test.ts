import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveTurn, createTurn, deleteTurn, getTurn } from '../src/server/actions/turn-actions.js';
import { readData, resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';
const actor: Actor = { id: 'test-user', email: 'test@roundtable.local', name: 'Test User' };
const otherActor: Actor = { id: 'other-user', email: 'other@roundtable.local', name: 'Other User' };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-del-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_WORKSPACE_ROOT = join(tempDir, 'workspaces');
  process.env.ROUNDTABLE_AGENT_ADAPTER = 'local-dispatch';
  process.env.ROUNDTABLE_CLARIFY_ENABLED = 'false';
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_WORKSPACE_ROOT;
  delete process.env.ROUNDTABLE_AGENT_ADAPTER;
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  await rm(tempDir, { recursive: true, force: true });
});

describe('deleteTurn — session + workspace cleanup', () => {
  it('removes the turn, its mission, and its managed workspace directory', async () => {
    const turn = await createTurn({ actor, message: 'Build a small page and review it.' });
    await approveTurn({ turnId: turn.id, decision: 'approve', autoDispatch: true, agentAdapter: 'local-dispatch' });

    const dispatched = await getTurn(turn.id);
    const workspace = dispatched?.dispatchWorkspacePath;
    expect(workspace).toBeTruthy();
    expect(await exists(workspace!)).toBe(true);

    const result = await deleteTurn(turn.id, { actor });
    expect(result.id).toBe(turn.id);

    expect(await getTurn(turn.id)).toBeNull();
    const data = await readData();
    expect(data.missions.some((mission) => mission.sourceTurnId === turn.id)).toBe(false);
    // The managed workspace (under ROUNDTABLE_WORKSPACE_ROOT) is gone.
    expect(await exists(workspace!)).toBe(false);
  });

  it('rejects deletion by a different owner', async () => {
    const turn = await createTurn({ actor, message: 'Build a page.' });
    await expect(deleteTurn(turn.id, { actor: otherActor })).rejects.toThrow('turn_not_found');
    expect(await getTurn(turn.id)).not.toBeNull();
  });

  it('never deletes a workspace outside the managed root — only its runs output', async () => {
    // Simulate a workbench-linked REAL project directory (outside the managed
    // root): deleting the session must clear only .roundtable/runs, not the
    // user's project files.
    const projectDir = join(tempDir, 'real-project');
    await mkdir(join(projectDir, '.roundtable', 'runs'), { recursive: true });
    await writeFile(join(projectDir, 'index.ts'), 'export {};\n', 'utf8');
    await writeFile(join(projectDir, '.roundtable', 'runs', 'out.md'), 'run output\n', 'utf8');

    const turn = await createTurn({ actor, message: 'Build a page.' });
    // Point the turn at the external workspace, as a workbench-linked dispatch would.
    const { mutateData } = await import('../src/server/store.js');
    await mutateData((data) => {
      const target = data.turns.find((item) => item.id === turn.id);
      if (target) target.dispatchWorkspacePath = projectDir;
    });

    await deleteTurn(turn.id, { actor });

    expect(await exists(join(projectDir, 'index.ts'))).toBe(true);
    expect(await exists(join(projectDir, '.roundtable', 'runs'))).toBe(false);
  });
});
