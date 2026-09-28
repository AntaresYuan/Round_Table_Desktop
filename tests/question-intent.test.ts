import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptPathForTask } from '../src/server/actions/agent-runner.js';
import { createChat } from '../src/server/actions/chat-actions.js';
import { upsertArtifacts } from '../src/server/actions/turns/artifacts.js';
import { intakeFromMessage, isQuestionMessage, planFromMessage } from '../src/server/actions/turns/planning.js';
import { approveTurn, createTurn } from '../src/server/actions/turn-actions.js';
import {
  createWorkbench,
  isForbiddenWorkspace,
  managedWorkspaceRoot,
  workspacePathForWorkbench,
} from '../src/server/actions/workbench-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor, Artifact, PlanTask } from '../src/server/types.js';

let tempDir = '';
const actor: Actor = { id: 'test-user', email: 'test@roundtable.local', name: 'Test User' };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-question-'));
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
  delete process.env.VERCEL;
  await rm(tempDir, { recursive: true, force: true });
});

describe('isQuestionMessage — questions get answers, not build pipelines', () => {
  it('detects EN and 中文 questions', () => {
    expect(isQuestionMessage('Why does the preview show a document?')).toBe(true);
    expect(isQuestionMessage('这是不是我想要的那个网站?')).toBe(true);
    expect(isQuestionMessage('Agent 之间的上下文是怎么管理的')).toBe(true);
    expect(isQuestionMessage('上下文共享了吗')).toBe(true);
  });

  it('keeps requests with build verbs on the build path, even phrased as questions', () => {
    expect(isQuestionMessage('帮我做一个镜头测评网站吗?')).toBe(false);
    expect(isQuestionMessage('Can you build a landing page for me?')).toBe(false);
    expect(isQuestionMessage('修复预览的 bug 好吗?')).toBe(false);
    expect(isQuestionMessage('Build a lens review website')).toBe(false);
  });

  it('flows into intake as the question intent', () => {
    expect(intakeFromMessage('为什么每次都会重新出一个计划?').intentType).toBe('question');
    expect(intakeFromMessage('做一个镜头测评网站').intentType).toBe('build');
  });
});

describe('planFromMessage — question intent plans a single answer task', () => {
  it('returns one answer-stage task instead of plan→build→review', () => {
    const plan = planFromMessage('这是不是我想要的那个网站?', undefined, 'question');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.stageId).toBe('answer');
    expect(plan.summary).toContain('Answer');
  });

  it('keeps the full pipeline for build intent', () => {
    const plan = planFromMessage('Build a lens review website', undefined, 'build');
    expect(plan.tasks.length).toBeGreaterThanOrEqual(3);
  });
});

describe('createTurn — question turns carry no mission dossier artifacts', () => {
  it('creates a question turn with an answer task and zero base artifacts', async () => {
    const workbench = await createWorkbench(actor, { name: 'QA bench' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Questions' });
    const turn = await createTurn({
      message: '为什么预览出来是一个文档?',
      chatId: chat.id,
      actor,
    });
    expect(turn.intake.intentType).toBe('question');
    expect(turn.plan.tasks).toHaveLength(1);
    expect(turn.plan.tasks[0]!.stageId).toBe('answer');
    expect(turn.artifacts).toHaveLength(0);
    expect(turn.needsClarification).toBe(false);
  });

  it('skips review-summary and final-report artifacts when dispatching a question', async () => {
    const workbench = await createWorkbench(actor, { name: 'QA bench' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Questions' });
    const turn = await createTurn({
      message: '上下文是怎么管理的?',
      chatId: chat.id,
      actor,
    });
    const dispatched = await approveTurn({ turnId: turn.id, decision: 'approve', autoDispatch: true, actor });
    const titles = dispatched.artifacts.map((artifact) => artifact.title);
    expect(titles.some((title) => title.includes('final-delivery'))).toBe(false);
    expect(titles.some((title) => title.includes('review-summary'))).toBe(false);
  });
});

describe('transcriptPathForTask — CLI narration is a log, never a page', () => {
  it('always lands under runs/logs as Markdown, even for website builds', () => {
    const task: PlanTask = {
      id: 'task_atlas',
      title: 'Build the lens review website',
      assignee: '@atlas',
      owner: 'atlas',
      role: 'implementer',
      stageId: 'build',
      requiredCapabilities: [],
      brief: 'Build a lens review website',
      deps: [],
      parallel: false,
    };
    const path = transcriptPathForTask(task);
    expect(path).toBe('.roundtable/runs/logs/build-the-lens-review-website.md');
    expect(path.endsWith('.html')).toBe(false);
  });
});

describe('upsertArtifacts — replace by identity with version bumps', () => {
  const artifact = (overrides: Partial<Artifact>): Artifact => ({
    id: 'plan_chat_1',
    chatId: 'chat_1',
    kind: 'code',
    title: 'mission/plan.json',
    ownerAgentId: 'orchestrator',
    version: 1,
    uri: 'turn://t1/plan',
    preview: '{"v":1}',
    code: '{"v":1}',
    createdAt: '2026-07-03T00:00:00.000Z',
    ...overrides,
  });

  it('bumps the version when content changed instead of duplicating', () => {
    const target: Artifact[] = [artifact({})];
    upsertArtifacts(target, [artifact({ preview: '{"v":2}', code: '{"v":2}' })]);
    expect(target).toHaveLength(1);
    expect(target[0]!.version).toBe(2);
    expect(target[0]!.preview).toBe('{"v":2}');
  });

  it('keeps the version when content is identical', () => {
    const target: Artifact[] = [artifact({ version: 3 })];
    upsertArtifacts(target, [artifact({})]);
    expect(target).toHaveLength(1);
    expect(target[0]!.version).toBe(3);
  });

  it('appends unknown artifacts', () => {
    const target: Artifact[] = [artifact({})];
    upsertArtifacts(target, [artifact({ id: 'file_site-index-html_chat_1', title: 'site/index.html' })]);
    expect(target).toHaveLength(2);
  });
});

describe('workspace guard — the app source tree is never a workspace', () => {
  it('flags the app root and its ancestors as forbidden', () => {
    expect(isForbiddenWorkspace(process.cwd())).toBe(true);
    expect(isForbiddenWorkspace(join(process.cwd(), '..'))).toBe(true);
    expect(isForbiddenWorkspace('/')).toBe(true);
    expect(isForbiddenWorkspace(join(process.cwd(), '.roundtable', 'workspaces', 'x'))).toBe(false);
    expect(isForbiddenWorkspace(join(tmpdir(), 'elsewhere'))).toBe(false);
  });

  it('falls back to the managed path when a workbench requests the app root', () => {
    const resolved = workspacePathForWorkbench('owner-1', 'wb-1', process.cwd());
    expect(resolved).toBe(join(tempDir, 'workspaces', 'owner-1', 'wb-1'));
  });

  it('uses /tmp for managed workspaces on Vercel when no root is configured', () => {
    delete process.env.ROUNDTABLE_WORKSPACE_ROOT;
    process.env.VERCEL = '1';
    try {
      expect(managedWorkspaceRoot()).toBe(join(tmpdir(), 'roundtable', 'workspaces'));
      expect(workspacePathForWorkbench('owner-1', 'wb-1', process.cwd()))
        .toBe(join(tmpdir(), 'roundtable', 'workspaces', 'owner-1', 'wb-1'));
    } finally {
      delete process.env.VERCEL;
      process.env.ROUNDTABLE_WORKSPACE_ROOT = join(tempDir, 'workspaces');
    }
  });
});
