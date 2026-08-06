import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChat } from '../src/server/actions/chat-actions.js';
import {
  answerClarification,
  approveTurn,
  createTurn,
  getTurn,
  interruptTurn,
  listTurns,
} from '../src/server/actions/turn-actions.js';
import { saveAgentRuntimeConfig } from '../src/server/actions/runtime-actions.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';
const actor: Actor = { id: 'test-user', email: 'test@roundtable.local', name: 'Test User' };
const otherActor: Actor = { id: 'other-user', email: 'other@roundtable.local', name: 'Other User' };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-turn-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_WORKSPACE_ROOT = join(tempDir, 'workspaces');
  process.env.ROUNDTABLE_AGENT_ADAPTER = 'local-dispatch';
  // Exercise dispatch directly; the clarify gate is covered in its own suite.
  process.env.ROUNDTABLE_CLARIFY_ENABLED = 'false';
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_WORKSPACE_ROOT;
  delete process.env.ROUNDTABLE_AGENT_ADAPTER;
  delete process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT;
  delete process.env.ROUNDTABLE_MAX_FIX_ROUNDS;
  delete process.env.ROUNDTABLE_SAFETY_ENABLED;
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  delete process.env.ROUNDTABLE_OPENAI_API_KEY;
  delete process.env.ROUNDTABLE_OPENAI_BASE_URL;
  delete process.env.ROUNDTABLE_OPENAI_MODEL;
  delete process.env.ROUNDTABLE_ENABLE_PUBLIC_AI;
  delete process.env.VERCEL;
  await rm(tempDir, { recursive: true, force: true });
});

describe('dispatchTurn — DAG scheduler integration', () => {
  it('ignores custom workspace paths in production', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    setNodeEnv('production');
    delete process.env.ROUNDTABLE_ALLOW_CUSTOM_WORKSPACE_PATH;
    try {
      const workbench = await createWorkbench(actor, {
        name: 'Production workspace',
        workspacePath: '/tmp/roundtable-should-not-use-this',
      });
      expect(workbench.workspacePath).toBe(join(tempDir, 'workspaces', actor.id, workbench.id));
    } finally {
      setNodeEnv(originalNodeEnv);
    }
  });

  it('enforces owner boundaries for turns and chat-linked creation', async () => {
    const workbench = await createWorkbench(actor, { name: 'Private workbench' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Private chat' });
    const turn = await createTurn({ actor, chatId: chat.id, message: 'Build a private feature.' });

    await expect(approveTurn({ actor: otherActor, turnId: turn.id, decision: 'approve' }))
      .rejects.toThrow('turn_not_found');
    await expect(createTurn({ actor: otherActor, chatId: chat.id, message: 'Attach to someone else chat.' }))
      .rejects.toThrow('chat_not_found');
    expect(await listTurns(chat.id, { actor: otherActor })).toHaveLength(0);
  });

  it('runs a linear plan to completion with per-task stage states (shape, not order)', async () => {
    const turn = await createTurn({ actor, message: 'Build a waitlist page and review it.' });
    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });

    expect(result.dispatchStatus).toBe('completed');

    // Shape assertion: every planned task has a terminal record; deps are honored
    // (a task's record exists only if its deps completed). No ordering assumption.
    const byTask = Object.fromEntries(result.records.map((r) => [r.taskId, r.status]));
    for (const task of turn.plan.tasks) {
      expect(byTask[task.id]).toBe('completed');
    }
    const stageStates = result.workflowRun?.stageStates ?? {};
    for (const task of turn.plan.tasks) {
      expect(stageStates[task.id]?.status).toBe('done');
    }
  });

  it('blocks a high-severity finding and derives bounded fixer tasks', async () => {
    // Force every agent run to emit an OpenAI-style key via the configured CLI
    // runtime. The safety gate marks each task as a blocking failure, which
    // routes into the fix loop; fixers also emit the key, so the loop is capped
    // at ROUNDTABLE_MAX_FIX_ROUNDS.
    await configureRuntimeOutput('atlas', 'sk-aaaaaaaaaaaaaaaaaaaaaaaa');
    await configureRuntimeOutput('fixer', 'sk-aaaaaaaaaaaaaaaaaaaaaaaa');
    process.env.ROUNDTABLE_MAX_FIX_ROUNDS = '2';

    const turn = await createTurn({ actor, message: '@atlas build the navbar.' });
    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'agent-cli',
    });

    expect(result.dispatchStatus).toBe('failed');
    // Original task failed on safety, then up to 2 fixer attempts were derived.
    const failed = result.records.filter((r) => r.status === 'failed');
    const fixers = result.records.filter((r) => r.fixRound !== undefined);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(fixers.length).toBeGreaterThanOrEqual(1);
    expect(fixers.length).toBeLessThanOrEqual(2);
    expect(fixers.every((r) => (r.fixRound ?? 0) <= 2)).toBe(true);
    // Spawns ~5 sequential node fixtures; under full-suite CPU contention the
    // default 10s budget flakes (also on the unmodified baseline).
  }, 30_000);

  it('does not block when safety is disabled', async () => {
    await configureRuntimeOutput('atlas', 'sk-aaaaaaaaaaaaaaaaaaaaaaaa');
    process.env.ROUNDTABLE_SAFETY_ENABLED = 'false';

    const turn = await createTurn({ actor, message: '@atlas build the navbar.' });
    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'agent-cli',
    });

    expect(result.dispatchStatus).toBe('completed');
    expect(result.records.every((r) => r.status === 'completed')).toBe(true);
  });

  it('forces local dispatch on Vercel even when a request asks for an AI adapter', async () => {
    process.env.VERCEL = '1';
    process.env.ROUNDTABLE_OPENAI_API_KEY = 'test-key';
    process.env.ROUNDTABLE_OPENAI_BASE_URL = 'https://model.test/v1';
    process.env.ROUNDTABLE_OPENAI_MODEL = 'test-model';

    const turn = await createTurn({ actor, message: '@atlas build the navbar.' });
    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'openai-compat',
    });

    expect(result.dispatchStatus).toBe('completed');
    expect(result.dispatchAdapter).toBe('local-dispatch');
  });

  it('falls back to local dispatch when an OpenAI-compatible provider request fails', async () => {
    process.env.ROUNDTABLE_OPENAI_API_KEY = 'test-key';
    process.env.ROUNDTABLE_OPENAI_BASE_URL = 'https://model.test/v1';
    process.env.ROUNDTABLE_OPENAI_MODEL = 'test-model';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const turn = await createTurn({ actor, message: '@atlas build the navbar.' });
    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'openai-compat',
    });

    expect(result.dispatchStatus).toBe('completed');
    expect(result.dispatchAdapter).toBe('openai-compat');
    expect(result.records.every((record) => record.status === 'completed')).toBe(true);
    expect(result.records.some((record) =>
      record.events.some((event) =>
        event.type === 'thinking_delta'
        && event.delta.includes('fell back to local-dispatch'),
      ),
    )).toBe(true);
  });

  it('does not keep final delivery blocked after a fixer repairs a blocking review', async () => {
    await configureRuntimeOutput('orchestrator', 'Looks good -- no blockers');
    await configureRuntimeOutput('nova', 'Architecture is solid -- no blockers');
    await configureRuntimeOutput('atlas', 'Looks good -- no blockers');
    await configureRuntimeOutput('vera', 'Critical: generated page is missing the checkout confirmation');
    await configureRuntimeOutput('fixer', 'Fixed checkout confirmation and verified the repair');
    process.env.ROUNDTABLE_MAX_FIX_ROUNDS = '1';

    const turn = await createTurn({ actor, message: 'Build a checkout page and review it.' });
    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'agent-cli',
    });

    expect(result.dispatchStatus).toBe('completed');
    expect(result.records.some((r) => r.status === 'failed' && r.agentId === 'vera')).toBe(true);
    expect(result.records.some((r) => r.status === 'completed' && r.agentId === 'fixer' && r.producedFor)).toBe(true);
    const stored = await getTurn(turn.id);
    expect(stored).not.toBeNull();
    const taskIds = stored?.plan.tasks.map((task) => task.id) ?? [];
    expect(new Set(taskIds).size).toBe(taskIds.length);
    expect(result.mission?.finalDelivery.confidence).not.toBe('blocked');
    expect(result.mission?.finalDelivery.recommendation).toBe('accept');
    expect(JSON.parse(result.artifacts.find((artifact) => artifact.id === `review_summary_${turn.id}`)?.preview ?? '{}')?.risks)
      .toEqual([]);
    // Spawns one node fixture per task (6 with the architect bracket + fixer);
    // under full-suite CPU contention the default 5s budget flakes.
  }, 30_000);

  it('parks a vague request for clarification, then plans after the user answers', async () => {
    // Enable the clarify gate for this case (heuristic path, no model key).
    process.env.ROUNDTABLE_CLARIFY_ENABLED = 'true';

    const parked = await createTurn({ actor, message: 'make a website' });
    expect(parked.needsClarification).toBe(true);
    expect(parked.clarifyQuestions.length).toBeGreaterThan(0);
    expect(parked.plan.tasks).toHaveLength(0); // not planned yet

    const q = parked.clarifyQuestions[0]!;
    const opt = q.options[0]!;
    const resumed = await answerClarification({
      actor,
      turnId: parked.id,
      answers: [{ questionId: q.id, optionId: opt.id, label: opt.label }],
    });

    expect(resumed.needsClarification).toBe(false);
    expect(resumed.plan.tasks.length).toBeGreaterThan(0); // now planned
    expect(resumed.clarifyAnswers).toHaveLength(1);
  });

  it('syncs Mission state when a turn is interrupted', async () => {
    const turn = await createTurn({ actor, message: 'Build a waitlist page and review it.' });
    await approveTurn({ actor, turnId: turn.id, decision: 'approve' });
    const interrupted = await interruptTurn(turn.id, { actor });

    expect(interrupted.dispatchStage).toBe('interrupted');
    expect(interrupted.mission?.status).toBe('failed');
    expect(interrupted.workflowRun).not.toBeNull();
  });

  it('attaches per-task runtime conversation transcripts to listed turns', async () => {
    await configureRuntimeOutput('atlas', 'navbar built');

    const workbench = await createWorkbench(actor, { name: 'Live transcript test' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Live transcripts' });
    const turn = await createTurn({ actor, chatId: chat.id, message: '@atlas build the navbar.' });
    await approveTurn({
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'agent-cli',
    });

    const listed = (await listTurns(chat.id, { actor })).find((item) => item.id === turn.id);
    const atlasTaskId = turn.plan.tasks.find((task) => task.owner === 'atlas')?.id ?? '';
    const activity = listed?.liveActivity?.[atlasTaskId];

    expect(activity).toBeDefined();
    expect(activity).toMatchObject({ agentId: 'atlas', runtime: 'claude-code', status: 'completed' });
    expect(activity?.transcript.some((entry) => entry.kind === 'response' || entry.kind === 'thinking')).toBe(true);
    // The stored turn itself stays lean: live activity is a response-time view.
    expect((await getTurn(turn.id))).not.toHaveProperty('liveActivity');
  });

  it('scopes turn reads and mutations to the route actor when provided', async () => {
    const workbench = await createWorkbench(actor, { name: 'Scoping test' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Shared chat' });
    const owned = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Build a waitlist page and review it.',
    });
    // Anonymous turns skip the chat-ownership gate (local/CLI convenience).
    const anonymous = await createTurn({
      chatId: chat.id,
      message: 'Build a public local-only task and review it.',
    });

    expect((await listTurns(chat.id, { actor })).map((turn) => turn.id)).toEqual([owned.id]);
    expect((await listTurns(chat.id, { actor: otherActor }))).toHaveLength(0);
    expect((await listTurns(chat.id, { actor: null })).map((turn) => turn.id)).toEqual([anonymous.id]);
    expect(await getTurn(owned.id, { actor: otherActor })).toBeNull();

    await expect(approveTurn({
      actor: otherActor,
      turnId: owned.id,
      decision: 'approve',
    })).rejects.toMatchObject({ code: 'turn_not_found', status: 404 });
  });
});

async function configureRuntimeOutput(agentId: string, text: string): Promise<void> {
  await saveAgentRuntimeConfig({
    agentId,
    runtime: 'claude-code',
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(text)})`],
  });
}

function setNodeEnv(value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}
