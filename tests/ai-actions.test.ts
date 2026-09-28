import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { polishText, suggestTasks } from '../src/server/actions/ai-actions.js';
import { createChat } from '../src/server/actions/chat-actions.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';
const actor: Actor = { id: 'user-ai', email: 'ai@roundtable.local', name: 'AI User' };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-ai-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_CLARIFY_ENABLED = 'false';
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_OPENAI_API_KEY;
  delete process.env.ROUNDTABLE_OPENAI_BASE_URL;
  delete process.env.ROUNDTABLE_OPENAI_MODEL;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  await rm(tempDir, { recursive: true, force: true });
});

describe('polishText fallback', () => {
  it('rewrites a short clean request into a mission-ready brief without model keys', async () => {
    const result = await polishText({ text: 'A pricing page with monthly/annual toggle.' });

    expect(result.text).not.toBe('A pricing page with monthly/annual toggle.');
    expect(result.text).toContain('Feature Builder Mission');
    expect(result.text).toContain('front-end/back-end');
    expect(result.text).toContain('final delivery report');
  });

  it('keeps Chinese input in Chinese when using the local fallback', async () => {
    const result = await polishText({ text: '做一个价格页' });

    expect(result.text).toContain('启动一个可交付的 Mission');
    expect(result.text).toContain('做一个价格页');
  });
});

describe('suggestTasks', () => {
  it('recalls scene-library suggestions from recent chat context', async () => {
    const workbench = await createWorkbench(actor, { name: 'AI suggestions' });
    await createChat(actor, { workbenchId: workbench.id, title: 'CSV export endpoint for admin reports' });

    const suggestions = await suggestTasks(actor);

    expect(suggestions[0]?.goal).toContain('CSV export');
  });

  it('recalls scene-library suggestions from explicit local context', async () => {
    const suggestions = await suggestTasks(null, 'The user is building dashboard analytics with charts and filters.');

    expect(suggestions[0]?.title).toBe('Dashboard analytics');
  });
});
