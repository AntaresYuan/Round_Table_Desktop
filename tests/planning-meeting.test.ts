import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conductPlanningMeeting } from '../src/server/actions/turns/planning-meeting.js';
import { resetData } from '../src/server/store.js';
import type { Plan } from '../src/server/types.js';

let tempDir = '';

const plan: Plan = {
  summary: 'Build and verify the feature',
  tasks: [
    {
      id: 'task_planning',
      title: 'Plan feature',
      assignee: '@planning',
      owner: 'orchestrator',
      role: 'planner',
      stageId: 'plan',
      brief: 'Plan the feature.',
      deps: [],
      parallel: false,
    },
    {
      id: 'task_atlas',
      title: 'Build feature',
      assignee: '@atlas',
      owner: 'atlas',
      role: 'implementer',
      stageId: 'build',
      brief: 'Build the feature.',
      deps: ['task_planning'],
      parallel: false,
    },
  ],
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-meeting-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  delete process.env.VERCEL;
  delete process.env.ROUNDTABLE_ENABLE_PUBLIC_AI;
  delete process.env.ROUNDTABLE_OPENAI_API_KEY;
  delete process.env.ROUNDTABLE_OPENAI_BASE_URL;
  delete process.env.ROUNDTABLE_OPENAI_MODEL;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.ROUNDTABLE_PLANNING_MEETING_MODEL;
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_OPENAI_API_KEY;
  delete process.env.ROUNDTABLE_OPENAI_BASE_URL;
  delete process.env.ROUNDTABLE_OPENAI_MODEL;
  delete process.env.ROUNDTABLE_PLANNING_MEETING_MODEL;
  vi.unstubAllGlobals();
  await rm(tempDir, { recursive: true, force: true });
});

describe('planning meeting', () => {
  it('produces a bounded deterministic meeting and preserves the compiled DAG', async () => {
    process.env.ROUNDTABLE_PLANNING_MEETING_MODEL = 'local';
    await writeFile(join(tempDir, 'package.json'), '{"name":"meeting-fixture"}', 'utf8');

    const result = await conductPlanningMeeting({
      message: 'Build a reliable feature with clear ownership.',
      plan,
      workspace: tempDir,
      now: '2026-07-12T00:00:00.000Z',
    });

    expect(result.meeting.status).toBe('fallback');
    expect(result.meeting.provider).toBe('local-deterministic');
    expect(result.meeting.algorithm).toBe('facilitated-role-relay-v2');
    expect(result.meeting.messages.map((message) => message.phase)).toEqual([
      'opening',
      'position',
      'position',
      'facilitation',
      'commitment',
      'challenge',
      'decision',
    ]);
    expect(result.meeting.messages.find((message) => message.phase === 'facilitation')?.references)
      .toEqual(['meeting_position_mira', 'meeting_position_nova']);
    expect(result.meeting.messages.find((message) => message.phase === 'commitment')?.references)
      .toEqual(['meeting_position_mira', 'meeting_position_nova']);
    expect(result.meeting.messages.every((message) => message.content.length > 0)).toBe(true);
    expect(result.meeting.messages.map((message) => message.content).join('\n'))
      .not.toMatch(/^(OUTCOME|SCOPE|ACCEPTANCE|ARCHITECTURE|REUSE|CONCERN|ACCEPT|ADJUST|EXECUTE|BLOCKER|RISK|EVIDENCE):/m);
    expect(result.meeting.decisions.length).toBeGreaterThan(0);
    expect(result.plan.tasks.map((task) => task.deps)).toEqual(plan.tasks.map((task) => task.deps));
    expect(result.plan.tasks.filter((task) => task.role !== 'planner')
      .every((task) => (task.acceptanceCriteria?.length ?? 0) > 0)).toBe(true);
    expect(result.plan.tasks[1]?.brief).toContain('Do not start until all are completed');
  });

  it('does not rewrite a Chinese Python coding request into a page/mobile task during fallback', async () => {
    process.env.ROUNDTABLE_PLANNING_MEETING_MODEL = 'local';

    const result = await conductPlanningMeeting({
      message: '去调研一下 llm unlearning 中 WMDP paper 里的 RMU 方法，写好 Python 代码',
      plan,
      workspace: null,
      now: '2026-07-12T00:00:00.000Z',
    });

    const implementer = result.plan.tasks.find((task) => task.role === 'implementer');
    const text = `${implementer?.objective ?? ''}\n${implementer?.brief ?? ''}\n${(implementer?.acceptanceCriteria ?? []).join('\n')}`;
    expect(text).toContain('Python');
    expect(text).toContain('代码');
    expect(text).not.toContain('核心页面');
    expect(text).not.toContain('移动端验证');
    expect(text).not.toContain('mobile verification');
  });

  it('uses a cheap API model in linear rounds and validates synthesis task ids', async () => {
    process.env.ROUNDTABLE_OPENAI_API_KEY = 'test-key';
    process.env.ROUNDTABLE_OPENAI_BASE_URL = 'https://planning.test/v1';
    process.env.ROUNDTABLE_OPENAI_MODEL = 'delivery-model';
    process.env.ROUNDTABLE_PLANNING_MEETING_MODEL = 'cheap-planning-model';
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const messages = body.messages as Array<{ content: string }>;
      const prompt = messages.at(-1)?.content ?? '';
      const content = prompt.includes('Return ONLY valid JSON')
        ? JSON.stringify({
            summary: 'The team locked scope, prerequisites, and evidence before execution.',
            decisions: [{
              summary: 'Ship the bounded slice first.',
              rationale: 'It reduces integration risk.',
              taskIds: ['task_atlas', 'not-a-real-task'],
            }],
            risks: ['Existing interfaces require verification.'],
            unresolved: [],
            taskNotes: [
              { taskId: 'task_planning', objective: 'Lock the execution contract.', acceptanceCriteria: ['Dependencies are explicit.'] },
              { taskId: 'task_atlas', objective: 'Implement the approved slice.', acceptanceCriteria: ['Tests pass.'] },
            ],
          })
        : prompt.includes('challenge round')
          ? 'AGREE: ownership is clear.\nOBJECT: none.\nRISK: verify existing interfaces.'
          : 'PROPOSAL: keep the slice bounded.\nPROBLEM: none.\nREQUIRED CHANGE: attach evidence.';
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const result = await conductPlanningMeeting({
      message: 'Build the feature.',
      plan,
      workspace: null,
      now: '2026-07-12T00:00:00.000Z',
    });

    // Two independent views + implementation commitment + review + synthesis.
    expect(bodies).toHaveLength(5);
    expect(bodies.every((body) => body.model === 'cheap-planning-model')).toBe(true);
    expect(result.meeting.status).toBe('completed');
    expect(result.meeting.provider).toBe('openai-compatible');
    expect(result.meeting.decisions[0]?.taskIds).toEqual(['task_atlas']);
    expect(result.plan.tasks.map((task) => task.deps)).toEqual(plan.tasks.map((task) => task.deps));
    expect(result.plan.tasks[1]?.acceptanceCriteria).toEqual(['Tests pass.']);
    expect(result.plan.tasks[1]?.objective).toBe('Implement the approved slice.');
  });
});
