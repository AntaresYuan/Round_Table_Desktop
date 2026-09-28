import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChat } from '../src/server/actions/chat-actions.js';
import {
  getMissionByTurn,
  latestMissionForChat,
  listMissions,
} from '../src/server/actions/mission-actions.js';
import { approveTurn, createTurn, deleteTurn } from '../src/server/actions/turn-actions.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { readData, resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';

const actor: Actor = {
  id: 'continuity-user',
  email: 'continuity@roundtable.local',
  name: 'Continuity User',
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-continuity-'));
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

describe('cross-turn mission continuity — one chat, one ongoing mission', () => {
  it('a follow-up turn continues the chat mission instead of creating a sibling', async () => {
    const workbench = await createWorkbench(actor, { name: 'Continuity bench' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Continuity chat' });

    const first = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Build a full stack profile settings feature and review it.',
    });
    await approveTurn({
      actor,
      turnId: first.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });
    const missionAfterFirst = await latestMissionForChat(actor.id, chat.id);
    expect(missionAfterFirst?.id).toBe(first.missionId);

    const second = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Add an avatar upload section to the settings page and review it.',
    });

    // Same mission id: the plan was revised, not duplicated.
    expect(second.missionId).toBe(first.missionId);
    expect(await listMissions(actor, chat.id)).toHaveLength(1);

    const mission = second.mission;
    expect(mission?.goal).toContain('avatar upload');
    expect(mission?.turnIds).toEqual([first.id, second.id]);
    expect(mission?.createdAt).toBe(missionAfterFirst?.createdAt);
    expect(mission?.status).toBe('awaiting_approval');
    expect(mission?.decisions.some((decision) => decision.id === `decision_followup_${second.id}`)).toBe(true);

    // Both turns resolve to the shared mission.
    expect((await getMissionByTurn(actor, first.id))?.id).toBe(first.missionId);
    expect((await getMissionByTurn(actor, second.id))?.id).toBe(first.missionId);

    // The continued mission dispatches and completes like any fresh one.
    const dispatched = await approveTurn({
      actor,
      turnId: second.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });
    expect(dispatched.dispatchStatus).toBe('completed');
    expect(dispatched.mission?.status).toBe('completed');
  });

  it('question turns stay standalone and never hijack the chat mission', async () => {
    const workbench = await createWorkbench(actor, { name: 'Question bench' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Question chat' });

    const build = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Build a landing page for the lens review site and review it.',
    });
    const question = await createTurn({
      actor,
      chatId: chat.id,
      message: '这个页面的上下文是怎么管理的?',
    });

    expect(question.intake.intentType).toBe('question');
    expect(question.missionId).not.toBe(build.missionId);
    // The build mission remains the chat's continuing mission.
    expect((await latestMissionForChat(actor.id, chat.id))?.id).toBe(build.missionId);

    const followUp = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Add a hero image to the landing page.',
    });
    expect(followUp.missionId).toBe(build.missionId);
  });

  it('keeps missions isolated between chats', async () => {
    const workbench = await createWorkbench(actor, { name: 'Isolation bench' });
    const chatA = await createChat(actor, { workbenchId: workbench.id, title: 'Chat A' });
    const chatB = await createChat(actor, { workbenchId: workbench.id, title: 'Chat B' });

    const turnA = await createTurn({ actor, chatId: chatA.id, message: 'Build a pricing page and review it.' });
    const turnB = await createTurn({ actor, chatId: chatB.id, message: 'Build a pricing page and review it.' });

    expect(turnA.missionId).not.toBe(turnB.missionId);
    expect(await listMissions(actor, chatA.id)).toHaveLength(1);
    expect(await listMissions(actor, chatB.id)).toHaveLength(1);
  });

  it('deleting one turn keeps the shared mission until its last turn is gone', async () => {
    const workbench = await createWorkbench(actor, { name: 'Delete bench' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Delete chat' });

    const first = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Build a settings page and review it.',
    });
    const second = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Add a notifications section to the settings page.',
    });
    expect(second.missionId).toBe(first.missionId);

    await deleteTurn(second.id, { actor });
    const survivor = (await readData()).missions.find((mission) => mission.id === first.missionId);
    expect(survivor).toBeDefined();
    expect(survivor?.turnIds).toEqual([first.id]);
    expect(survivor?.sourceTurnId).toBe(first.id);

    await deleteTurn(first.id, { actor });
    expect((await readData()).missions.find((mission) => mission.id === first.missionId)).toBeUndefined();
  });
});
