import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentTask } from '../src/server/actions/agent-runner.js';
import { resetData } from '../src/server/store.js';
import {
  isReviewGateTask,
  makeFixerTask,
  plannedTaskPatches,
  repairedTargetArtifact,
  shouldAttemptFix,
} from '../src/server/actions/turn-actions.js';
import type { ScheduledTask } from '../src/server/actions/scheduler.js';
import type { Artifact, PlanTask } from '../src/server/types.js';

function task(overrides: Partial<PlanTask> & { id: string }): PlanTask {
  return {
    title: overrides.id,
    assignee: '@agent',
    brief: `${overrides.id} brief`,
    deps: [],
    parallel: false,
    ...overrides,
  };
}

function scheduled(overrides: Partial<ScheduledTask> & { id: string }): ScheduledTask {
  return {
    ...task(overrides),
    status: 'failed',
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('isReviewGateTask — which tasks gate delivery through the fix loop', () => {
  it('gates the quality reviewer and the architect post-build check, not the design pass', () => {
    expect(isReviewGateTask({ role: 'reviewer', stageId: 'review' })).toBe(true);
    // Architect's post-build check gates like a review …
    expect(isReviewGateTask({ role: 'architect', stageId: 'review' })).toBe(true);
    // … but its upfront design pass (plan stage) must not.
    expect(isReviewGateTask({ role: 'architect', stageId: 'plan' })).toBe(false);
    expect(isReviewGateTask({ role: 'implementer', stageId: 'build' })).toBe(false);
  });

  it('derives a review-style fixer from a failed architecture check', () => {
    const failed = scheduled({
      id: 'task_nova_check',
      role: 'architect',
      stageId: 'review',
      assignee: '@nova',
      owner: 'nova',
      deps: ['task_atlas'],
    });
    const fixer = makeFixerTask(failed, {
      message: 'review_found_issues: 1 critical · 0 high',
      review: '# Architecture check\n\nCritical: hardcoded API URL duplicated across 4 files',
    });
    expect(fixer.title).toContain('Apply review fixes');
    expect(fixer.brief).toContain('hardcoded API URL');
    expect(fixer.deps).toContain('task_nova_check');
    expect(fixer.deps).toContain('task_atlas');
  });
});

describe('makeFixerTask — repair context deps', () => {
  it('inherits the failed reviewer deps so the fixer sees the reviewed deliverable', () => {
    const failed = scheduled({
      id: 'task_review',
      role: 'reviewer',
      assignee: '@vera',
      owner: 'vera',
      deps: ['task_build'],
    });
    const fixer = makeFixerTask(failed, { message: 'review_found_issues: 1 Critical', review: '# Review' });
    expect(fixer.deps).toContain('task_review');
    expect(fixer.deps).toContain('task_build');
  });

  it('excludes the failed task own repair edge so chained fixers are not blocked', () => {
    const failedFixer = scheduled({
      id: 'fix_task_review_r1',
      role: 'fixer',
      assignee: '@fixer',
      owner: 'fixer',
      deps: ['task_review', 'task_build'],
      producedFor: 'task_review',
      fixRound: 1,
    });
    const fixer = makeFixerTask(failedFixer, { message: 'agent_task_failed' });
    expect(fixer.deps).toContain('fix_task_review_r1');
    expect(fixer.deps).toContain('task_build');
    // task_review is failed (that's why fix round 1 existed): inheriting it as an
    // ordinary dep would mark the round-2 fixer blocked forever.
    expect(fixer.deps).not.toContain('task_review');
  });

  it('constrains a planning-failure fixer to re-planning only', () => {
    const failed = scheduled({
      id: 'task_planning',
      role: 'planner',
      assignee: '@planning',
      owner: 'orchestrator',
      title: 'Plan the lens review site',
    });
    const fixer = makeFixerTask(failed, { message: 'runtime_exit_1' });
    expect(fixer.replanOnly).toBe(true);
    expect(fixer.title).toContain('Re-plan');
    expect(fixer.brief).toContain('RE-PLANNING ONLY');
    expect(fixer.brief).toMatch(/Do NOT create, modify, or delete/);
  });

  it('keeps the re-planning constraint on chained fix rounds', () => {
    const failed = scheduled({
      id: 'task_planning',
      role: 'planner',
      assignee: '@planning',
      owner: 'orchestrator',
    });
    const round1 = makeFixerTask(failed, { message: 'runtime_exit_1' });
    const failedRound1 = scheduled({
      ...round1,
      id: round1.id,
      producedFor: 'task_planning',
      fixRound: 1,
    });
    const round2 = makeFixerTask(failedRound1, { message: 'runtime_exit_1' });
    expect(round2.replanOnly).toBe(true);
    expect(round2.brief).toContain('RE-PLANNING ONLY');
  });

  it('does not constrain fixers for build failures', () => {
    const failed = scheduled({
      id: 'task_atlas',
      role: 'implementer',
      assignee: '@atlas',
      owner: 'atlas',
    });
    const fixer = makeFixerTask(failed, { message: 'agent_task_failed' });
    expect(fixer.replanOnly).toBeUndefined();
    expect(fixer.brief).not.toContain('RE-PLANNING ONLY');
  });

  it('does not attempt fixer loops for runtime infrastructure failures', () => {
    expect(shouldAttemptFix({
      message: 'runtime_exit_1: API Error: 402 Error from provider(roundtable-openai-compatible,deepseek-chat: 402): Insufficient Balance',
    })).toBe(false);
    expect(shouldAttemptFix({
      message: 'runtime_exit_1: Service startup timeout, please manually run `ccr start` to start the service',
    })).toBe(false);
    expect(shouldAttemptFix({
      message: 'review_found_issues: 1 critical · 0 high',
    })).toBe(true);
    expect(shouldAttemptFix({
      message: 'safety_block',
    })).toBe(true);
  });
});

describe('plannedTaskPatches — concrete titles once the plan exists', () => {
  const tasks: PlanTask[] = [
    task({ id: 'task_planning', role: 'planner', owner: 'orchestrator', assignee: '@planning', title: 'Plan the goal' }),
    task({
      id: 'task_atlas',
      role: 'implementer',
      owner: 'atlas',
      assignee: '@atlas',
      title: 'Build · awaiting plan (Atlas)',
      brief: 'Build · awaiting plan (Atlas). Agent: Atlas. Role: implementer. User request: hotpot site',
      deps: ['task_planning'],
    }),
    task({
      id: 'task_vera',
      role: 'reviewer',
      owner: 'vera',
      assignee: '@vera',
      title: 'Review · awaits the build',
      deps: ['task_atlas'],
    }),
  ];

  it('rewrites downstream placeholder titles and briefs to the concrete goal', () => {
    const patches = plannedTaskPatches(tasks, 'task_planning', 'Build a hotpot restaurant site');
    const atlas = patches.get('task_atlas');
    const vera = patches.get('task_vera');
    expect(atlas).toBeDefined();
    expect(vera).toBeDefined();
    expect(atlas!.title).not.toContain('awaiting plan');
    expect(atlas!.title).toContain('hotpot');
    expect(atlas!.brief).not.toContain('awaiting plan');
    expect(atlas!.brief).toContain('User request: Build a hotpot restaurant site');
    expect(vera!.title).not.toContain('awaits the build');
  });

  it('does not touch the planner itself or unrelated tasks', () => {
    const patches = plannedTaskPatches(tasks, 'task_planning', 'Build a hotpot restaurant site');
    expect(patches.has('task_planning')).toBe(false);
  });
});

describe('repairedTargetArtifact — fix lands in the previewed artifact', () => {
  const original: Artifact = {
    id: 'task_atlas_turn_1',
    chatId: 'chat_1',
    kind: 'preview',
    title: '.roundtable/runs/work/site.html',
    ownerAgentId: 'atlas',
    version: 1,
    uri: 'workspace://.roundtable/runs/work/site.html',
    preview: '<!doctype html><html><body>old</body></html>',
    code: null,
    createdAt: '2026-07-02T00:00:00.000Z',
  };

  it('returns a bumped artifact when the fixer produced a full HTML document', () => {
    const fixed = '<!doctype html>\n<html><body>fixed</body></html>';
    const next = repairedTargetArtifact(original, fixed);
    expect(next).not.toBeNull();
    expect(next!.version).toBe(2);
    expect(next!.preview).toBe(fixed);
    expect(next!.id).toBe(original.id);
    // Immutability: the original object is untouched.
    expect(original.version).toBe(1);
    expect(original.preview).toContain('old');
  });

  it('returns null when the fixer output is prose, not a deliverable', () => {
    expect(repairedTargetArtifact(original, 'I fixed the issues by adjusting the CSS.')).toBeNull();
  });
});

describe('runAgentTask — chat model deliverable extraction', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'roundtable-chat-'));
    process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
    process.env.ROUNDTABLE_OPENAI_API_KEY = 'test-key';
    process.env.ROUNDTABLE_OPENAI_BASE_URL = 'https://model.test/v1';
    process.env.ROUNDTABLE_OPENAI_MODEL = 'test-model';
    await resetData();
  });

  afterEach(async () => {
    delete process.env.ROUNDTABLE_DATA_PATH;
    delete process.env.ROUNDTABLE_OPENAI_API_KEY;
    delete process.env.ROUNDTABLE_OPENAI_BASE_URL;
    delete process.env.ROUNDTABLE_OPENAI_MODEL;
    vi.unstubAllGlobals();
    await rm(tempDir, { recursive: true, force: true });
  });

  function stubModelResponse(content: string): void {
    stubModelResponses([{ content, finishReason: 'stop' }]);
  }

  function stubModelResponses(turns: Array<{ content: string; finishReason: string }>): ReturnType<typeof vi.fn> {
    let call = 0;
    const mock = vi.fn(async () => {
      const turn = turns[Math.min(call, turns.length - 1)]!;
      call += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: turn.content }, finish_reason: turn.finishReason }],
          usage: {},
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  const htmlTask = () => task({
    id: 'task_atlas',
    role: 'implementer',
    owner: 'atlas',
    assignee: '@atlas',
    title: 'Build the hotpot website (Atlas)',
    brief: 'Build the hotpot website. User request: 做一个火锅店网站',
  });

  const toolTask = () => task({
    id: 'task_tool_atlas',
    role: 'implementer',
    owner: 'atlas',
    assignee: '@atlas',
    title: 'Build Fuji organizer tool (Atlas)',
    brief: '做一个富士专用的镜头与相机整理工具',
  });

  const pythonTask = () => task({
    id: 'task_python_atlas',
    role: 'implementer',
    owner: 'atlas',
    assignee: '@atlas',
    title: 'Write RMU Python code (Atlas)',
    brief: '调研 WMDP paper 中的 RMU 方法并写 Python 代码。Planning meeting objective: 在现有项目中调研需求背景并编写可运行的 Python 代码。Acceptance criteria:\n- Python 代码可以在本地运行。\n- 附有运行命令、输入输出说明和验证证据。',
  });

  it('recovers a fenced, truncated HTML response into a clean document', async () => {
    // Fence + cut after body content started: renderable, so keep it clean.
    stubModelResponse('```html\n<!DOCTYPE html>\n<html><head></head><body><h1>真鲜</h1><p>每一天，从产地到');
    const result = await runAgentTask({
      adapter: 'openai-compat',
      workspace: tempDir,
      task: htmlTask(),
      message: '做一个火锅店网站',
    });
    expect(result.ok).toBe(true);
    expect(result.text.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(result.text).not.toContain('```');
    expect(result.kind).toBe('preview');
  });

  it('fails the task when the model returns prose instead of a page', async () => {
    stubModelResponse('抱歉，我无法生成这个页面。');
    const result = await runAgentTask({
      adapter: 'openai-compat',
      workspace: tempDir,
      task: htmlTask(),
      message: '做一个火锅店网站',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('deliverable_not_usable');
  });

  it('auto-continues when the model output is cut at the token ceiling', async () => {
    // First response ends mid-CSS inside <head> (the blank-page production
    // failure); the continuation completes the body. The stitched document
    // must contain both halves.
    const mock = stubModelResponses([
      { content: '<!DOCTYPE html>\n<html><head><style>.hero { color: red', finishReason: 'length' },
      { content: '; }</style></head><body><h1>真鲜火锅</h1></body></html>', finishReason: 'stop' },
    ]);
    const result = await runAgentTask({
      adapter: 'openai-compat',
      workspace: tempDir,
      task: htmlTask(),
      message: '做一个火锅店网站',
    });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('<h1>真鲜火锅</h1>');
    expect(result.text).toContain('.hero { color: red; }');
    expect(result.text.endsWith('</html>')).toBe(true);
  });

  it('fails rather than shipping a blank page when continuations run out', async () => {
    // Every response is length-cut inside <head>: no <body> ever appears. The
    // task must fail (feeding the fix loop), never complete with a blank page.
    stubModelResponses([
      { content: '<!DOCTYPE html>\n<html><head><style>.a { color: red', finishReason: 'length' },
      { content: '; } .b { margin: 0', finishReason: 'length' },
      { content: '; } .c { padding: 0', finishReason: 'length' },
    ]);
    const result = await runAgentTask({
      adapter: 'openai-compat',
      workspace: tempDir,
      task: htmlTask(),
      message: '做一个火锅店网站',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('deliverable_not_usable');
  });

  it('does not force organizer tools into single-page HTML artifacts', async () => {
    stubModelResponse('# Fuji Gear\n\nImplement this as a project with app files when a CLI runtime is available.');
    const result = await runAgentTask({
      adapter: 'openai-compat',
      workspace: tempDir,
      task: toolTask(),
      message: '做一个富士专用的镜头与相机整理工具',
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('markdown');
    expect(result.path.endsWith('.md')).toBe(true);
  });

  it('writes Python coding requests as code artifacts instead of HTML previews', async () => {
    stubModelResponse('```python\nfrom __future__ import annotations\n\n\ndef rmu_loss() -> float:\n    return 0.0\n```');
    const result = await runAgentTask({
      adapter: 'openai-compat',
      workspace: tempDir,
      task: pythonTask(),
      message: '去调研一下 llm unlearning 中 WMDP paper 里的 RMU 方法，写好 Python 代码',
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('code');
    expect(result.path.endsWith('.py')).toBe(true);
    expect(result.text).toContain('def rmu_loss');
    expect(result.text).not.toContain('```');
  });
});

describe('runAgentTask — fixer writes the repaired deliverable in place', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'roundtable-repair-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('honors repairTargetPath so the fix overwrites the original artifact path', async () => {
    const fixer = task({
      id: 'fix_task_review_r1',
      role: 'fixer',
      owner: 'fixer',
      assignee: '@fixer',
      title: 'Apply review fixes (round 1)',
      producedFor: 'task_review',
      fixRound: 1,
      repairTargetPath: '.roundtable/runs/work/site.html',
      repairTargetTaskId: 'task_atlas',
    });
    const result = await runAgentTask({
      adapter: 'local-dispatch',
      workspace: tempDir,
      task: fixer,
      message: 'fix the hotpot site',
    });
    expect(result.path).toBe('.roundtable/runs/work/site.html');
    expect(result.kind).toBe('preview');
  });
});
