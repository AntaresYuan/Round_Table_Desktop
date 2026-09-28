import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteWorkflowTemplate,
  listWorkflowTemplates,
  resolveWorkflowTemplate,
  saveWorkflowTemplate,
  workflowTemplateById,
  WorkflowTemplateError,
} from '../src/server/actions/mission-actions.js';
import { createTurn } from '../src/server/actions/turn-actions.js';
import { planFromMessage, tasksFromTemplate } from '../src/server/actions/turns/planning.js';
import { emptyWorkingStyle } from '../src/server/actions/skill-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor, WorkflowTemplate } from '../src/server/types.js';

let tempDir = '';
const actor: Actor = { id: 'test-user', email: 'test@roundtable.local', name: 'Test User' };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-wft-'));
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

function featureBuilder(): WorkflowTemplate {
  return workflowTemplateById('wf-feature-builder');
}

describe('tasksFromTemplate — the template IS the task chain', () => {
  it('generates the architect-bracketed default chain from the feature-builder template', () => {
    const tasks = tasksFromTemplate(featureBuilder(), 'Build a waitlist page.', 'a waitlist page', emptyWorkingStyle());
    expect(tasks.map((task) => task.id)).toEqual([
      'task_planning',
      'task_nova',
      'task_atlas',
      'task_vera',
      'task_nova_review',
    ]);
    // Plan stage chains sequentially; build depends on the plan stage's tasks.
    expect(tasks.find((task) => task.id === 'task_nova')?.deps).toEqual(['task_planning']);
    expect(tasks.find((task) => task.id === 'task_atlas')?.deps).toEqual(['task_planning', 'task_nova']);
    // Both review-stage tasks run in parallel off the build.
    expect(tasks.find((task) => task.id === 'task_vera')?.deps).toEqual(['task_atlas']);
    expect(tasks.find((task) => task.id === 'task_nova_review')?.deps).toEqual(['task_atlas']);
    expect(tasks.find((task) => task.id === 'task_nova_review')?.stageKind).toBe('review');
  });

  it('picks the message-preferred implementer from a multi-implementer work stage', () => {
    const backend = tasksFromTemplate(featureBuilder(), 'Build an API endpoint for auth.', 'auth api', emptyWorkingStyle());
    expect(backend.some((task) => task.id === 'task_beam')).toBe(true);
    expect(backend.some((task) => task.id === 'task_atlas')).toBe(false);
  });

  it('reordering stages reorders the execution chain', () => {
    const template = featureBuilder();
    // Move review BEFORE build (nonsensical but must be honored: the editor
    // is the source of truth, not a hidden hardcoded order).
    const review = template.stages.find((stage) => stage.id === 'review')!;
    const build = template.stages.find((stage) => stage.id === 'build')!;
    template.stages = template.stages
      .filter((stage) => stage.id !== 'review' && stage.id !== 'build')
      .flatMap((stage) => (stage.id === 'plan' ? [stage, review, build] : [stage]));
    const tasks = tasksFromTemplate(template, 'Build a page.', 'a page', emptyWorkingStyle());
    const buildTask = tasks.find((task) => task.owner === 'atlas');
    expect(buildTask?.deps).toEqual(expect.arrayContaining(['task_vera']));
  });

  it('removing the architect seat removes the architecture tasks', () => {
    const template = featureBuilder();
    for (const stage of template.stages) {
      stage.seats = stage.seats.filter((seatItem) => seatItem.ref.kind !== 'role' || seatItem.ref.role !== 'architect');
    }
    const tasks = tasksFromTemplate(template, 'Build a page.', 'a page', emptyWorkingStyle());
    expect(tasks.map((task) => task.id)).toEqual(['task_planning', 'task_atlas', 'task_vera']);
  });
});

describe('custom template storage — override by id', () => {
  it('a saved custom template with a builtin id overrides resolution and auto-select', async () => {
    const template = featureBuilder();
    template.stages = template.stages.filter((stage) => stage.id !== 'review');
    await saveWorkflowTemplate(template);

    const resolved = await resolveWorkflowTemplate(undefined, 'Build a checkout page.');
    expect(resolved.id).toBe('wf-feature-builder');
    expect(resolved.builtin).toBe(false);
    expect(resolved.stages.some((stage) => stage.id === 'review')).toBe(false);

    const listed = await listWorkflowTemplates();
    expect(listed.filter((item) => item.id === 'wf-feature-builder')).toHaveLength(1);
    expect(listed.find((item) => item.id === 'wf-feature-builder')?.builtin).toBe(false);

    await deleteWorkflowTemplate('wf-feature-builder');
    const restored = await resolveWorkflowTemplate('wf-feature-builder', '');
    expect(restored.builtin).toBe(true);
    expect(restored.stages.some((stage) => stage.id === 'review')).toBe(true);
  });

  it('rejects templates that cannot produce a runnable task chain', async () => {
    const template = featureBuilder();
    template.stages = template.stages.filter((stage) => !['plan', 'build', 'review'].includes(stage.id));
    await expect(saveWorkflowTemplate(template)).rejects.toThrow(WorkflowTemplateError);
  });

  it('rejects runnable templates with no agent seats instead of falling back silently', async () => {
    const template = featureBuilder();
    for (const stage of template.stages) {
      if (['plan', 'build', 'review'].includes(stage.id)) stage.seats = [];
    }
    await expect(saveWorkflowTemplate(template)).rejects.toThrow(/no_runnable_agent_seat/);
  });

  it('rejects seats that point at unknown agents', async () => {
    const template = featureBuilder();
    template.stages[2]!.seats = [{ ref: { kind: 'role', role: 'implementer', agentId: 'ghost' } }];
    await expect(saveWorkflowTemplate(template)).rejects.toThrow(/unknown_seat_agent/);
  });

  it('an edited template drives the plan of the next created turn', async () => {
    const template = featureBuilder();
    // User removes the architect entirely: their call — the next mission's
    // plan must follow it (no hidden re-addition).
    for (const stage of template.stages) {
      stage.seats = stage.seats.filter((seatItem) => seatItem.ref.kind !== 'role' || seatItem.ref.role !== 'architect');
    }
    await saveWorkflowTemplate(template);

    const turn = await createTurn({ actor, message: 'Build a landing page and review it.' });
    // Planner was satisfied by the API meeting; the edited template still
    // controls every CLI task that remains.
    expect(turn.plan.tasks.map((task) => task.owner)).toEqual(['atlas', 'vera']);
  });
});

describe('planFromMessage — template parameter', () => {
  it('uses the provided template for the default chain', () => {
    const plan = planFromMessage('Build a page.', emptyWorkingStyle(), 'build', featureBuilder());
    expect(plan.tasks.map((task) => task.id)).toContain('task_nova_review');
  });

  it('falls back to the canonical chain without a template', () => {
    const plan = planFromMessage('Build a page.', emptyWorkingStyle(), 'build');
    expect(plan.tasks.map((task) => task.id)).toEqual([
      'task_planning', 'task_nova', 'task_atlas', 'task_vera', 'task_nova_check',
    ]);
  });

  it('keeps explicit @mentions above the template', () => {
    const plan = planFromMessage('@atlas build the navbar.', emptyWorkingStyle(), 'build', featureBuilder());
    expect(plan.tasks.map((task) => task.owner)).toEqual(['atlas']);
  });
});
