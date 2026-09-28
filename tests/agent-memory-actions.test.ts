import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportAgentMemory, importAgentMemory } from '../src/server/actions/agent-memory-actions.js';
import { loadAgentMemory, writeProjectFact } from '../src/server/actions/agent-memory.js';
import { createChat } from '../src/server/actions/chat-actions.js';
import { workspacePathForChat } from '../src/server/actions/turns/workspace.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

const actor: Actor = { id: 'memory-user', email: 'memory@example.com', name: 'Memory User' };
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'roundtable-memory-actions-'));
  process.env.ROUNDTABLE_DATA_PATH = join(root, 'data.json');
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  await rm(root, { recursive: true, force: true });
});

describe('agent memory portable bundles', () => {
  it('imports the exact object produced by export without reshaping it', async () => {
    const sourceWorkbench = await createWorkbench(actor, { name: 'Source', workspacePath: join(root, 'source') });
    const targetWorkbench = await createWorkbench(actor, { name: 'Target', workspacePath: join(root, 'target') });
    const sourceChat = await createChat(actor, { workbenchId: sourceWorkbench.id, title: 'Source chat' });
    const targetChat = await createChat(actor, { workbenchId: targetWorkbench.id, title: 'Target chat' });
    const sourceWorkspace = await workspacePathForChat(sourceChat.id);
    const targetWorkspace = await workspacePathForChat(targetChat.id);
    await mkdir(sourceWorkspace!, { recursive: true });
    await mkdir(targetWorkspace!, { recursive: true });
    await writeProjectFact({
      workspace: sourceWorkspace!, agentId: 'nova', slug: 'lens-boundary',
      description: 'Lens modules stay separate.', type: 'pattern', source: 'test', body: 'Keep filters outside cards.',
    });

    const bundle = await exportAgentMemory(actor, { chatId: sourceChat.id });
    const result = await importAgentMemory(actor, { chatId: targetChat.id, files: bundle.files });

    expect(result.imported).toEqual(['nova/lens-boundary.md']);
    expect((await loadAgentMemory({ workspace: targetWorkspace!, agentId: 'nova' })).facts[0]?.slug)
      .toBe('lens-boundary');
    expect(await readFile(join(targetWorkspace!, '.roundtable/agents/nova/memory/lens-boundary.md'), 'utf8'))
      .toContain('Keep filters outside cards.');
  });

  it('rejects paths that could escape the agent memory folder', async () => {
    const workbench = await createWorkbench(actor, { name: 'Target', workspacePath: join(root, 'target') });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Target chat' });
    await expect(importAgentMemory(actor, {
      chatId: chat.id,
      files: [{ path: '../outside.md', content: 'nope' }],
    })).rejects.toThrow('invalid_memory_bundle_path');
  });
});
