import { describe, expect, it } from 'vitest';
import {
  CycleDetectedError,
  assertAcyclic,
  downstreamOf,
  runScheduler,
  type RunTask,
  type TaskResult,
} from '../src/server/actions/scheduler.js';
import type { PlanTask } from '../src/server/types.js';

function task(id: string, deps: string[] = [], extra: Partial<PlanTask> = {}): PlanTask {
  return {
    id,
    title: id,
    assignee: `@${id}`,
    owner: id,
    role: 'implementer',
    brief: id,
    deps,
    parallel: deps.length === 0,
    ...extra,
  };
}

// A runTask that records execution order and succeeds, echoing the task id.
function recordingRunner(order: string[]): RunTask {
  return async (t) => {
    order.push(t.id);
    return { ok: true, output: { summary: `did ${t.id}` } };
  };
}

describe('scheduler — graph validation', () => {
  it('detects a direct cycle and executes nothing', async () => {
    const tasks = [task('A', ['B']), task('B', ['A'])];
    expect(() => assertAcyclic(tasks)).toThrow(CycleDetectedError);
    const order: string[] = [];
    await expect(runScheduler({ tasks, runTask: recordingRunner(order) })).rejects.toBeInstanceOf(
      CycleDetectedError,
    );
    expect(order).toHaveLength(0);
  });

  it('rejects a dep pointing at an unknown task id', () => {
    expect(() => assertAcyclic([task('A', ['ghost'])])).toThrow(CycleDetectedError);
  });

  it('downstreamOf returns the transitive dependents', () => {
    // A -> B -> D, A -> C, E independent
    const tasks = [task('A'), task('B', ['A']), task('C', ['A']), task('D', ['B']), task('E')];
    expect(downstreamOf('A', tasks)).toEqual(new Set(['B', 'C', 'D']));
    expect(downstreamOf('B', tasks)).toEqual(new Set(['D']));
    expect(downstreamOf('E', tasks)).toEqual(new Set());
  });
});

describe('scheduler — execution', () => {
  it('runs a linear chain A→B→C in order', async () => {
    const order: string[] = [];
    const run = await runScheduler({
      tasks: [task('A'), task('B', ['A']), task('C', ['B'])],
      runTask: recordingRunner(order),
    });
    expect(order).toEqual(['A', 'B', 'C']);
    expect(run.tasks.every((t) => t.status === 'completed')).toBe(true);
  });

  it('streams per-task lifecycle via onTaskState (running before terminal)', async () => {
    const events: Array<[string, string]> = [];
    await runScheduler({
      tasks: [task('A'), task('B', ['A'])],
      runTask: recordingRunner([]),
      onTaskState: (taskId, status) => { events.push([taskId, status]); },
    });
    // Each task reports running before completed, and A finishes before B starts.
    expect(events).toEqual([
      ['A', 'running'],
      ['A', 'completed'],
      ['B', 'running'],
      ['B', 'completed'],
    ]);
  });

  it('reports failed via onTaskState', async () => {
    const events: Array<[string, string]> = [];
    const runTask: RunTask = async (t) =>
      t.id === 'A' ? { ok: false, error: { message: 'boom' } } : { ok: true, output: { summary: t.id } };
    await runScheduler({
      tasks: [task('A')],
      runTask,
      onTaskState: (taskId, status) => { events.push([taskId, status]); },
    });
    expect(events).toEqual([['A', 'running'], ['A', 'failed']]);
  });

  it('runs independent tasks as one parallel wave', async () => {
    const started: string[] = [];
    let peakConcurrency = 0;
    let active = 0;
    const runTask: RunTask = async (t) => {
      started.push(t.id);
      active += 1;
      peakConcurrency = Math.max(peakConcurrency, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { ok: true, output: { summary: t.id } };
    };
    await runScheduler({ tasks: [task('A'), task('B'), task('C')], runTask });
    expect(started.sort()).toEqual(['A', 'B', 'C']);
    expect(peakConcurrency).toBe(3); // all three overlapped
  });

  it('handles a diamond A→(B,C)→D with B,C parallel then D', async () => {
    const order: string[] = [];
    const run = await runScheduler({
      tasks: [task('A'), task('B', ['A']), task('C', ['A']), task('D', ['B', 'C'])],
      runTask: recordingRunner(order),
    });
    expect(order[0]).toBe('A');
    expect(order[3]).toBe('D');
    expect(order.slice(1, 3).sort()).toEqual(['B', 'C']);
    expect(run.tasks.find((t) => t.id === 'D')?.status).toBe('completed');
  });

  it('passes only direct-dep outputs as handoff context', async () => {
    const seen: Record<string, string[]> = {};
    const runTask: RunTask = async (t, depOutputs) => {
      seen[t.id] = Object.keys(depOutputs).sort();
      return { ok: true, output: { summary: t.id } };
    };
    await runScheduler({
      tasks: [task('A'), task('B', ['A']), task('C', ['B'])],
      runTask,
    });
    expect(seen.A).toEqual([]);
    expect(seen.B).toEqual(['A']);
    expect(seen.C).toEqual(['B']); // C sees B only, not A
  });
});

describe('scheduler — failure propagation', () => {
  it('blocks transitive dependents but keeps independent branches running', async () => {
    // A fails. B depends on A (→ blocked). C is independent (→ completed).
    const runTask: RunTask = async (t): Promise<TaskResult> =>
      t.id === 'A'
        ? { ok: false, error: { message: 'boom' } }
        : { ok: true, output: { summary: t.id } };
    const run = await runScheduler({
      tasks: [task('A'), task('B', ['A']), task('C')],
      runTask,
    });
    const byId = Object.fromEntries(run.tasks.map((t) => [t.id, t.status]));
    expect(byId.A).toBe('failed');
    expect(byId.B).toBe('blocked');
    expect(byId.C).toBe('completed');
    expect(run.records.find((r) => r.taskId === 'B')?.status).toBe('blocked');
  });

  it('a thrown runTask is treated as a task failure, not a wave crash', async () => {
    const runTask: RunTask = async (t) => {
      if (t.id === 'A') throw new Error('kaboom');
      return { ok: true, output: { summary: t.id } };
    };
    const run = await runScheduler({ tasks: [task('A'), task('B')], runTask });
    const byId = Object.fromEntries(run.tasks.map((t) => [t.id, t.status]));
    expect(byId.A).toBe('failed');
    expect(byId.B).toBe('completed');
  });
});

describe('scheduler — fix loop', () => {
  it('derives a fixer on failure and records the fix round', async () => {
    let attempts = 0;
    const runTask: RunTask = async (t): Promise<TaskResult> => {
      if (t.id === 'A') {
        attempts += 1;
        return { ok: false, error: { message: 'A failed' } };
      }
      // The fixer task succeeds.
      return { ok: true, output: { summary: `fixed via ${t.id}` } };
    };
    const run = await runScheduler({
      tasks: [task('A')],
      runTask,
      maxFixRounds: 2,
      onFailure: (failed) => task(`fix_${failed.id}_${(failed.fixRound ?? 0) + 1}`, [failed.id]),
    });
    expect(attempts).toBe(1);
    const fixer = run.tasks.find((t) => t.id.startsWith('fix_A'));
    expect(fixer).toBeTruthy();
    expect(fixer?.fixRound).toBe(1);
    expect(fixer?.status).toBe('completed');
  });

  it('passes a review report to the derived fixer as repair context', async () => {
    // Reviewer "fails" with a review report; the fixer (depending on it) should
    // receive that report in its handoff context so it knows what to fix.
    const REVIEW = '🔴 Critical: menu images do not render';
    let fixerContext = '';
    const runTask: RunTask = async (t, depOutputs): Promise<TaskResult> => {
      if (t.id === 'review') {
        return { ok: false, error: { message: 'review_found_issues', review: REVIEW } };
      }
      if (t.id.startsWith('fix_')) {
        fixerContext = Object.values(depOutputs).map((o) => o.summary).join('\n');
        return { ok: true, output: { summary: 'fixed' } };
      }
      return { ok: true, output: { summary: t.id } };
    };
    await runScheduler({
      tasks: [task('build'), task('review', ['build'])],
      runTask,
      maxFixRounds: 1,
      onFailure: (failed, error) =>
        // Mirror makeFixerTask: carry the review through onto the derived task is
        // not needed — the scheduler reads it from the failed task's error.
        error.review ? task(`fix_${failed.id}`, [failed.id]) : null,
    });
    expect(fixerContext).toContain('Review report to address');
    expect(fixerContext).toContain('menu images do not render');
  });

  it('stops deriving fixers after maxFixRounds and leaves the branch failed', async () => {
    // Everything fails forever. With maxFixRounds=2 we expect: original A +
    // 2 derived fixers = 3 failed executions, then no more derivation.
    const runIds: string[] = [];
    const runTask: RunTask = async (t): Promise<TaskResult> => {
      runIds.push(t.id);
      return { ok: false, error: { message: `${t.id} failed` } };
    };
    const run = await runScheduler({
      tasks: [task('A')],
      runTask,
      maxFixRounds: 2,
      onFailure: (failed) => task(`fix_${failed.id}`, [failed.id]),
    });
    // A, then two fix rounds.
    expect(runIds.length).toBe(3);
    const fixers = run.tasks.filter((t) => t.id.startsWith('fix_'));
    expect(fixers.length).toBeGreaterThanOrEqual(1);
    expect(run.tasks.find((t) => t.id === 'A')?.status).toBe('failed');
  });
});

describe('scheduler — immutability', () => {
  it('does not mutate the input tasks', async () => {
    const input = [task('A'), task('B', ['A'])];
    const snapshot = JSON.parse(JSON.stringify(input));
    await runScheduler({ tasks: input, runTask: recordingRunner([]) });
    expect(input).toEqual(snapshot);
  });
});
