import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBreakoutRoom,
  listBreakoutRooms,
  postBreakoutMessage,
} from '../src/server/actions/breakout-actions.js';
import { createChat, createMessage } from '../src/server/actions/chat-actions.js';
import { saveSettings } from '../src/server/actions/settings-actions.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { mutateData, readData, resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';
const actor: Actor = { id: 'user-breakout', email: 'breakout@roundtable.local', name: 'Breakout User' };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-breakout-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_CLARIFY_ENABLED = 'false';
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  delete process.env.ROUNDTABLE_OPENAI_API_KEY;
  delete process.env.ROUNDTABLE_OPENAI_BASE_URL;
  delete process.env.ROUNDTABLE_OPENAI_MODEL;
  delete process.env.MINIMAX_API_KEY;
  // unstubAllGlobals (NOT restoreAllMocks) is what actually undoes vi.stubGlobal.
  vi.unstubAllGlobals();
  await rm(tempDir, { recursive: true, force: true });
});

async function makeChat(): Promise<string> {
  const workbench = await createWorkbench(actor, { name: 'Breakout WB' });
  const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Main chat' });
  return chat.id;
}

// Capture the request body the model adapter sends, and reply with canned text.
function stubModel(replyText: string): () => { body: unknown } {
  let lastBody: unknown = null;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    lastBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({
      choices: [{ message: { content: replyText }, finish_reason: 'stop' }],
      usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return () => ({ body: lastBody });
}

describe('breakout rooms', () => {
  it('creates a two-participant room and lists it with its transcript', async () => {
    const chatId = await makeChat();
    const room = await createBreakoutRoom(actor, { chatId, participantAgentIds: ['beam', 'vera'] });
    expect(room.participantAgentIds).toEqual(['beam', 'vera']);
    expect(room.status).toBe('open');

    const rooms = await listBreakoutRooms(actor, chatId);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.id).toBe(room.id);
    expect(rooms[0]!.messages).toEqual([]);
  });

  it('rejects a room without exactly two participants', async () => {
    const chatId = await makeChat();
    await expect(createBreakoutRoom(actor, { chatId, participantAgentIds: ['beam'] }))
      .rejects.toThrow('breakout_requires_two_participants');
  });

  it('rejects a room with a participant id not in the roster', async () => {
    const chatId = await makeChat();
    await expect(createBreakoutRoom(actor, { chatId, participantAgentIds: ['beam', 'ghost-agent'] }))
      .rejects.toThrow('breakout_unknown_participant');
  });

  it('listBreakoutRooms is a pure read — it never writes to the store', async () => {
    const chatId = await makeChat();
    await createBreakoutRoom(actor, { chatId, participantAgentIds: ['beam', 'vera'] });

    // Sentinel the store cannot legitimately clear on a read.
    await mutateData((data) => { data.users.push({ id: 'sentinel', email: 's@x', name: null, createdAt: 'now' }); });
    await listBreakoutRooms(actor, chatId);
    const after = await readData();
    expect(after.users.some((u) => u.id === 'sentinel')).toBe(true);
  });

  it('a posted user message gets a persisted agent reply from a room participant', async () => {
    stubModel('Local judgment: clarify the acceptance bar first.');
    process.env.ROUNDTABLE_OPENAI_API_KEY = 'test-key';
    process.env.ROUNDTABLE_OPENAI_BASE_URL = 'https://example.test/v1';
    process.env.ROUNDTABLE_OPENAI_MODEL = 'test-model';
    const chatId = await makeChat();
    const room = await createBreakoutRoom(actor, { chatId, participantAgentIds: ['beam', 'vera'] });

    await postBreakoutMessage(actor, { roomId: room.id, content: 'Is this input accessible?' });

    const [listed] = await listBreakoutRooms(actor, chatId);
    expect(listed!.messages).toHaveLength(2);
    expect(listed!.messages[0]!.authorType).toBe('user');
    const reply = listed!.messages[1]!;
    expect(reply.authorType).toBe('agent');
    expect(['beam', 'vera']).toContain(reply.authorId);
    expect(reply.content).toContain('acceptance bar');
  });

  it('injects the main-chat context (mission goal + messages) into the model prompt', async () => {
    const readBody = stubModel('Noted.');
    process.env.ROUNDTABLE_OPENAI_API_KEY = 'test-key';
    process.env.ROUNDTABLE_OPENAI_BASE_URL = 'https://example.test/v1';
    process.env.ROUNDTABLE_OPENAI_MODEL = 'test-model';
    const chatId = await makeChat();
    // Seed real main-chat context: a mission goal and a user message.
    await createMessage(actor, { chatId, content: 'The pricing page toggle is misaligned on mobile.' });
    await mutateData((data) => {
      data.missions.push({
        id: 'mission-1', ownerId: actor.id, chatId,
        goal: 'Ship a responsive pricing page',
        stages: [], currentStageId: null, tasks: [],
        createdAt: 'now', updatedAt: 'now',
      } as never);
    });
    const room = await createBreakoutRoom(actor, { chatId, participantAgentIds: ['atlas', 'vera'] });

    await postBreakoutMessage(actor, { roomId: room.id, content: 'How should we fix this layout?' });

    const body = readBody().body as { messages: Array<{ role: string; content: string }> };
    const promptText = body.messages.map((m) => m.content).join('\n');
    expect(promptText).toContain('Ship a responsive pricing page');
    expect(promptText).toContain('pricing page toggle is misaligned');
  });

  it('uses a model configured through settings (store only, no env vars)', async () => {
    // The regression this guards: the reply path must consult saved settings,
    // not just env vars, so a key entered in the UI actually drives replies.
    const readBody = stubModel('Settings-backed reply.');
    const chatId = await makeChat();
    await saveSettings({
      providers: [{
        provider: 'openai-compatible',
        enabled: true,
        apiKey: 'settings-key',
        baseUrl: 'https://settings.test/v1',
        model: 'settings-model',
      }],
    });
    expect(process.env.ROUNDTABLE_OPENAI_API_KEY).toBeUndefined();
    const room = await createBreakoutRoom(actor, { chatId, participantAgentIds: ['beam', 'vera'] });

    await postBreakoutMessage(actor, { roomId: room.id, content: 'What do you think?' });

    expect(readBody().body).not.toBeNull();
    const [listed] = await listBreakoutRooms(actor, chatId);
    expect(listed!.messages[1]!.content).toBe('Settings-backed reply.');
  });

  it('falls back to a local reply when no model is configured (no env, no settings)', async () => {
    const chatId = await makeChat();
    const room = await createBreakoutRoom(actor, { chatId, participantAgentIds: ['beam', 'vera'] });

    await postBreakoutMessage(actor, { roomId: room.id, content: '这个实现看起来怎么样？' });

    const [listed] = await listBreakoutRooms(actor, chatId);
    const reply = listed!.messages[1]!;
    expect(reply.authorType).toBe('agent');
    expect(reply.content.length).toBeGreaterThan(0);
  });

  it('rejects a message posted to a closed room', async () => {
    const chatId = await makeChat();
    const room = await createBreakoutRoom(actor, { chatId, participantAgentIds: ['beam', 'vera'] });
    await mutateData((data) => {
      const stored = data.breakoutRooms.find((r) => r.id === room.id)!;
      stored.status = 'closed';
    });

    await expect(postBreakoutMessage(actor, { roomId: room.id, content: 'still open?' }))
      .rejects.toThrow('breakout_room_closed');
  });
});
