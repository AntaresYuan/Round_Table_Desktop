import type { PlanTask } from '../types.js';
import type { SafetyFinding } from './safety.js';

/* ============================================================================
   scheduler.ts — topological (Kahn-wave) DAG scheduler.

   The scheduler is a pure orchestration primitive: it knows nothing about
   agents, safety, or sandboxes. It takes a set of tasks with `deps`, runs every
   task whose deps are all satisfied as one parallel wave, then unlocks the next
   wave, and so on. Failures propagate to transitive dependents (which are marked
   blocked), while independent branches keep running. An optional `onFailure`
   hook can derive a fixer task that re-attempts the failed branch, bounded by
   `maxFixRounds`.

   Design constraints:
   - Never mutate the input `tasks` array or its elements (immutability rule).
   - Detect cycles before executing anything (AI-generated DAGs can loop).
   - Use Promise.allSettled per wave so one rejection can't sink sibling tasks.
   ============================================================================ */

export type TaskOutput = { summary: string; artifactId?: string | undefined };

// Why a task failed. `scan` carries safety findings; `review` carries a reviewer
// report when a review found blocking issues (so a derived fixer gets the
// concrete problems to repair).
export type TaskError = {
  message: string;
  scan?: SafetyFinding[] | undefined;
  review?: string | undefined;
};

export type TaskResult =
  | { ok: true; output: TaskOutput }
  | { ok: false; error: TaskError };

export type SchedulerTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked';

export type ScheduledTask = PlanTask & {
  status: SchedulerTaskStatus;
  output?: TaskOutput | null;
  error?: TaskError | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type SchedulerRecord = {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed' | 'blocked';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  producedFor?: string | undefined;
  fixRound?: number | undefined;
};

export type SchedulerRun = {
  tasks: ScheduledTask[];
  records: SchedulerRecord[];
};

export type RunTask = (
  task: PlanTask,
  depOutputs: Record<string, TaskOutput>,
) => Promise<TaskResult>;

export type OnFailure = (
  task: ScheduledTask,
  error: TaskError,
) => PlanTask | null;

// Fired as a task transitions, so callers can stream live progress (e.g. persist
// per-task stage state for the UI to poll). Best-effort: errors are swallowed so
// progress reporting can never break the run.
export type OnTaskState = (
  taskId: string,
  status: 'running' | 'completed' | 'failed' | 'blocked',
) => void | Promise<void>;

export type SchedulerOpts = {
  tasks: PlanTask[];
  runTask: RunTask;
  onFailure?: OnFailure | undefined;
  onTaskState?: OnTaskState | undefined;
  maxFixRounds?: number | undefined;
  now?: (() => string) | undefined;
};

export class CycleDetectedError extends Error {
  readonly code = 'cycle_detected';
  constructor(message = 'cycle_detected') {
    super(message);
    this.name = 'CycleDetectedError';
  }
}

/**
 * Throws CycleDetectedError if the dependency graph contains a cycle or a dep
 * pointing at a task id that doesn't exist. Runs before any task executes.
 */
export function assertAcyclic(tasks: PlanTask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!ids.has(dep)) {
        throw new CycleDetectedError(`unknown_dep:${task.id}->${dep}`);
      }
    }
  }
  // Kahn's algorithm: if we can't peel every node, a cycle remains.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, task.deps.length);
    for (const dep of task.deps) {
      const list = dependents.get(dep) ?? [];
      list.push(task.id);
      dependents.set(dep, list);
    }
  }
  const queue = tasks.filter((task) => task.deps.length === 0).map((task) => task.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (visited !== tasks.length) {
    throw new CycleDetectedError('cycle_detected');
  }
}

/**
 * All tasks that (transitively) depend on `targetId`, via reverse-edge BFS.
 * Used to mark a failed task's downstream as blocked. O(V + E).
 */
export function downstreamOf(targetId: string, tasks: PlanTask[]): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.deps) {
      const list = dependents.get(dep) ?? [];
      list.push(task.id);
      dependents.set(dep, list);
    }
  }
  const out = new Set<string>();
  const queue = [...(dependents.get(targetId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const next of dependents.get(id) ?? []) {
      if (!out.has(next)) queue.push(next);
    }
  }
  return out;
}

function agentIdFor(task: PlanTask): string {
  return task.owner ?? task.assignee.replace(/^@/, '');
}

/**
 * Run a task DAG wave by wave. Returns the final per-task state and an execution
 * record per task that actually ran (or was blocked). Pure with respect to the
 * input: the returned tasks are fresh objects.
 */
export async function runScheduler(opts: SchedulerOpts): Promise<SchedulerRun> {
  const now = opts.now ?? (() => new Date().toISOString());
  const maxFixRounds = opts.maxFixRounds ?? 2;

  // Working copy — we never touch opts.tasks. `state` is the live graph that can
  // grow as fixer tasks are derived.
  const state = new Map<string, ScheduledTask>();
  for (const task of opts.tasks) {
    state.set(task.id, {
      ...task,
      deps: [...task.deps],
      status: 'pending',
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
  }

  assertAcyclic([...state.values()]);

  const records: SchedulerRecord[] = [];
  // Fix attempts already spent per repaired branch (keyed by the originally
  // failed task id), so a chain of fixers can't exceed maxFixRounds.
  const fixRoundsByOrigin = new Map<string, number>();
  // Maps a derived fixer's id back to the root failed task of its lineage, so the
  // fix-round cap is counted per branch even across chained fixers.
  const lineageOrigin = new Map<string, string>();

  const isTerminal = (s: SchedulerTaskStatus) =>
    s === 'completed' || s === 'failed' || s === 'blocked';

  // A fixer task's dependency on the task it repairs (`producedFor`) is a "repair
  // edge": it is satisfied when that task has FAILED (the fixer exists to fix the
  // failure), and it must not count toward block-propagation. Every other edge is
  // an ordinary dependency, satisfied only on completion.
  const isRepairEdge = (task: ScheduledTask, dep: string): boolean =>
    task.producedFor === dep;

  const depSatisfied = (task: ScheduledTask, dep: string): boolean => {
    const s = state.get(dep)?.status;
    if (isRepairEdge(task, dep)) return s === 'failed';
    return s === 'completed';
  };

  const depsSatisfied = (task: ScheduledTask): boolean =>
    task.deps.every((dep) => depSatisfied(task, dep));

  const anyDepFailedOrBlocked = (task: ScheduledTask): boolean =>
    task.deps.some((dep) => {
      if (isRepairEdge(task, dep)) return false; // repair edges never block
      const s = state.get(dep)?.status;
      return s === 'failed' || s === 'blocked';
    });

  // Loop until no task can make progress. Each iteration runs one parallel wave.
  // We re-evaluate after every wave because fixer tasks may have been added.
  // A hard ceiling on iterations guards against logic bugs (never expected to hit).
  const maxIterations = opts.tasks.length * (maxFixRounds + 2) + 16;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const all = [...state.values()];

    // Mark tasks whose deps failed/blocked as blocked (they can never run).
    for (const task of all) {
      if (task.status === 'pending' && anyDepFailedOrBlocked(task)) {
        state.set(task.id, { ...task, status: 'blocked', finishedAt: now() });
        records.push({
          taskId: task.id,
          agentId: agentIdFor(task),
          status: 'blocked',
          startedAt: now(),
          finishedAt: now(),
          error: 'blocked_by_failed_dependency',
          producedFor: task.producedFor,
          fixRound: task.fixRound,
        });
      }
    }

    const ready = [...state.values()]
      .filter((task) => task.status === 'pending' && depsSatisfied(task))
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

    if (ready.length === 0) {
      const stillPending = [...state.values()].some((task) => !isTerminal(task.status));
      if (!stillPending) break;
      // No ready tasks but some still pending and none failed/blocked to unblock
      // them — that only happens on a cycle, which assertAcyclic already ruled
      // out. Bail defensively rather than spin.
      break;
    }

    // Run the wave. allSettled so a thrown runTask can't reject the whole wave
    // and starve sibling tasks.
    const waveStart = now();
    for (const task of ready) {
      state.set(task.id, { ...task, status: 'running', startedAt: waveStart });
      await reportTaskState(opts.onTaskState, task.id, 'running');
    }
    const settled = await Promise.allSettled(
      ready.map((task) => {
        const depOutputs: Record<string, TaskOutput> = {};
        for (const dep of task.deps) {
          const depTask = state.get(dep);
          if (!depTask) continue;
          if (depTask.output) {
            depOutputs[dep] = depTask.output;
          } else if (isRepairEdge(task, dep) && depTask.error) {
            // A fixer needs the failure it's repairing as context, not an output.
            depOutputs[dep] = {
              summary: `FAILED: ${depTask.error.message}`
                + (depTask.error.scan && depTask.error.scan.length > 0
                  ? `\nSafety findings:\n${depTask.error.scan
                      .map((f) => `- [${f.severity}] ${f.rule}`)
                      .join('\n')}`
                  : '')
                + (depTask.error.review
                  ? `\n\nReview report to address:\n\n${depTask.error.review}`
                  : ''),
            };
          }
        }
        return opts.runTask(task, depOutputs);
      }),
    );

    for (let i = 0; i < ready.length; i += 1) {
      const task = ready[i]!;
      const outcome = settled[i]!;
      const finishedAt = now();
      const result: TaskResult =
        outcome.status === 'fulfilled'
          ? outcome.value
          : { ok: false, error: { message: errorMessage(outcome.reason) } };

      if (result.ok) {
        state.set(task.id, {
          ...task,
          status: 'completed',
          output: result.output,
          startedAt: waveStart,
          finishedAt,
        });
        records.push({
          taskId: task.id,
          agentId: agentIdFor(task),
          status: 'completed',
          startedAt: waveStart,
          finishedAt,
          error: null,
          producedFor: task.producedFor,
          fixRound: task.fixRound,
        });
        await reportTaskState(opts.onTaskState, task.id, 'completed');
        continue;
      }

      // Failure. Record it, then try to derive a fixer if rounds remain.
      state.set(task.id, {
        ...task,
        status: 'failed',
        error: result.error,
        startedAt: waveStart,
        finishedAt,
      });
      records.push({
        taskId: task.id,
        agentId: agentIdFor(task),
        status: 'failed',
        startedAt: waveStart,
        finishedAt,
        error: result.error.message,
        producedFor: task.producedFor,
        fixRound: task.fixRound,
      });
      await reportTaskState(opts.onTaskState, task.id, 'failed');

      if (!opts.onFailure) continue;
      // `origin` is the root of this repair lineage (the first task that failed),
      // so the cap counts all fix attempts on the branch — not per failed node.
      const origin = lineageOrigin.get(task.id) ?? task.id;
      const spent = fixRoundsByOrigin.get(origin) ?? 0;
      if (spent >= maxFixRounds) continue;

      const derived = opts.onFailure(state.get(task.id)!, result.error);
      if (!derived) continue;

      const nextRound = spent + 1;
      fixRoundsByOrigin.set(origin, nextRound);
      // Guarantee a unique id so a fixer that itself fails and spawns the next
      // round doesn't overwrite the previous fixer's state/record.
      const fixId = state.has(derived.id) ? `${derived.id}__r${nextRound}` : derived.id;
      // The repair edge points at the task that just failed (`task.id`): the fixer
      // becomes runnable once that task is terminal-failed (see isRepairEdge), and
      // receives its error as handoff context. Lineage for the cap stays on origin.
      const fixDeps = derived.deps.includes(task.id)
        ? [...derived.deps]
        : [...derived.deps, task.id];
      state.set(fixId, {
        ...derived,
        id: fixId,
        deps: fixDeps,
        producedFor: task.id,
        fixRound: nextRound,
        status: 'pending',
        output: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      });
      // Track lineage so a fixer spawned by this fixer is still capped against the
      // same origin even though its immediate producedFor is the fixer node.
      lineageOrigin.set(fixId, origin);
    }
  }

  return { tasks: [...state.values()], records };
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

// Best-effort progress notification. A failing/throwing reporter must never
// break the run, so swallow everything.
async function reportTaskState(
  onTaskState: OnTaskState | undefined,
  taskId: string,
  status: 'running' | 'completed' | 'failed' | 'blocked',
): Promise<void> {
  if (!onTaskState) return;
  try {
    await onTaskState(taskId, status);
  } catch {
    /* progress reporting is best-effort */
  }
}
