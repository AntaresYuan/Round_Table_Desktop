import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChat } from '../src/server/actions/chat-actions.js';
import { pinWorkbench, updateUserProfile } from '../src/server/actions/memory-actions.js';
import { getWorkingStyleSnapshot } from '../src/server/actions/skill-actions.js';
import { createTurn } from '../src/server/actions/turn-actions.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';

const actor: Actor = {
  id: 'skills-user',
  email: 'skills@roundtable.local',
  name: 'Skills User',
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-skills-'));
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

describe('Working style pipe (profile skills + workbench pins)', () => {
  it('injects profile default skills and workbench rules into planned turns', async () => {
    const workbench = await createWorkbench(actor, {
      name: 'Skills test',
      workspacePath: 'workspaces/skills-test',
    });
    const chat = await createChat(actor, {
      workbenchId: workbench.id,
      title: 'Build settings',
    });
    await updateUserProfile(actor, {
      defaultSkills: ['plan_before_implementation'],
    });
    await pinWorkbench(actor, {
      workbenchId: workbench.id,
      content: 'Show visual approval before marking UI work done.',
    });

    const turn = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Build a profile settings UI and review it.',
    });

    expect(turn.mission?.workingStyle.skills.map((skill) => skill.key)).toContain('plan_before_implementation');
    expect(turn.mission?.workingStyle.projectRules).toContain('Show visual approval before marking UI work done.');
    expect(turn.plan.tasks[0]?.brief).toContain('Plan before implementation');
    // Intake artifacts are chat-scoped so follow-up turns replace them in place.
    expect(turn.artifacts.find((artifact) => artifact.id === `intake_${chat.id}`)?.preview)
      .toContain('Show visual approval before marking UI work done.');
  });

  it('scopes pin-derived project rules to the pinned workbench', async () => {
    const pinned = await createWorkbench(actor, {
      name: 'Pinned bench',
      workspacePath: 'workspaces/pinned-bench',
    });
    const other = await createWorkbench(actor, {
      name: 'Other bench',
      workspacePath: 'workspaces/other-bench',
    });
    const pinnedChat = await createChat(actor, { workbenchId: pinned.id, title: 'Pinned chat' });
    const otherChat = await createChat(actor, { workbenchId: other.id, title: 'Other chat' });
    await pinWorkbench(actor, {
      workbenchId: pinned.id,
      content: 'Always answer in Chinese.',
    });

    const pinnedStyle = await getWorkingStyleSnapshot(actor, pinnedChat.id);
    const otherStyle = await getWorkingStyleSnapshot(actor, otherChat.id);

    expect(pinnedStyle.projectRules).toContain('Always answer in Chinese.');
    expect(otherStyle.projectRules).toHaveLength(0);
  });

  it('normalizes free-form profile skills and falls back to a generated label', async () => {
    await updateUserProfile(actor, {
      defaultSkills: ['Reply In Chinese!', 'verify_before_push', 'verify before push'],
    });
    const style = await getWorkingStyleSnapshot(actor, null);
    expect(style.skills.map((skill) => skill.key)).toEqual(['reply_in_chinese', 'verify_before_push']);
    expect(style.skills[0]?.label).toBe('Reply In Chinese');
    // Catalog keys keep their curated descriptions.
    expect(style.skills[1]?.description).toContain('typecheck');
  });
});
