import { mutateData, nowIso, readData } from '../../store.js';
import type {
  Actor,
  AgentEvent,
  Artifact,
  DispatchRecord,
  PlanTask,
  WorkflowRun,
} from '../../types.js';
import { E2BUnavailableError } from '../adapters/e2b-adapter.js';
import { A2ARequestError, A2AUnavailableError, cancelA2ABinding } from '../adapters/a2a-adapter.js';
import { resolveA2ARemoteAgentConfig } from '../a2a/config.js';
import { bindingsForTurn } from '../a2a/task-store.js';
import { MiniMaxRequestError, MiniMaxUnavailableError } from '../adapters/minimax-adapter.js';
import { OpenAICompatRequestError, OpenAICompatUnavailableError } from '../adapters/openai-compat-adapter.js';
import { normalizeAdapter, runAgentTask } from '../agent-runner.js';
import {
  buildHandoffCardV2,
  buildMissionSnapshot,
  setMissionRejected,
  updateMissionForDispatch,
  updateMissionForPlannedTurn,
  workflowRunForTurn,
} from '../mission-actions.js';
import { hasBlockingFinding, safetyEnabled, scanArtifact } from '../safety.js';
import { runScheduler, type ScheduledTask, type TaskResult } from '../scheduler.js';
import { publicAiExecutionDisabled, resolveDefaultAgentAdapter } from '../settings-actions.js';
import { artifactsFromRun, finalReportArtifact, reviewerSummaryArtifact, upsertArtifacts } from './artifacts.js';
import { buildDocsAuditContext } from './doc-policy.js';
import { ActionError } from './errors.js';
import {
  isReviewGateTask,
  makeFixerTask,
  maxFixRounds,
  repairedTargetArtifact,
  reviewRequestsFix,
  reviewSeverities,
  shouldAttemptFix,
} from './fix-loop.js';
import { formatHandoffContext, handoffsForTasks } from './handoffs.js';
import { formatWorkingStyleForPrompt, plannedTaskPatches, retitleDownstreamTasks } from './planning.js';
import { dispatchResponse, type DispatchResponse } from './responses.js';
import { getTurn, requireTurn, updateTurn } from './turn-store.js';
import { prepareWorkspace } from './workspace.js';

export type ApprovalInput = {
  turnId: string;
  decision: 'approve' | 'reject';
  autoDispatch?: boolean | undefined;
  agentAdapter?: string | undefined;
  actor?: Actor | null | undefined;
  // When true, kick off dispatch in the background and return immediately with
  // dispatchStatus 'running' — the client then polls /history for live progress.
  // When false/omitted, await the full run (used by tests and the CLI).
  background?: boolean | undefined;
};

export type DispatchInput = {
  turnId: string;
  agentAdapter?: string | undefined;
  actor?: Actor | null | undefined;
};

export async function approveTurn(input: ApprovalInput): Promise<DispatchResponse> {
  const turn = await getTurn(input.turnId, input);
  if (!turn) throw new ActionError('turn_not_found', 404);
  if (input.decision === 'reject') {
    const rejected = await updateTurn(input.turnId, (current) => ({
      ...current,
      needsApproval: true,
      approvalStatus: 'rejected',
      dispatchStatus: 'failed',
      dispatchStage: 'rejected',
      dispatchError: 'rejected_by_user',
    }), input);
    const rejectedTurn = requireTurn(rejected);
    const mission = await setMissionRejected(rejectedTurn);
    const withMission = await updateTurn(rejectedTurn.id, (current) => ({
      ...current,
      mission: mission ?? current.mission,
      workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
    }), input);
    return dispatchResponse(requireTurn(withMission));
  }

  const approved = await updateTurn(input.turnId, (current) => ({
    ...current,
    needsApproval: false,
    approvalStatus: 'approved',
    approvedAt: nowIso(),
    dispatchStage: 'approved',
  }), input);
  const approvedTurn = requireTurn(approved);
  const mission = await updateMissionForPlannedTurn(approvedTurn);
  const synced = await updateTurn(approvedTurn.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  }), input);
  const next = requireTurn(synced);
  if (input.autoDispatch) {
    if (input.background) {
      // Mark running now, run the DAG in the background, and return immediately.
      // The client polls /history; per-task stageStates stream in as agents work.
      const running = await updateTurn(next.id, (current) => {
        const runTurn = {
          ...current,
          dispatchStatus: 'running' as const,
          dispatchStage: 'dispatch',
          dispatchError: null,
        };
        return {
          ...runTurn,
          workflowRun: workflowRunForTurn(runTurn),
        };
      }, input);
      const runningTurn = requireTurn(running);
      const runningMission = await updateMissionForDispatch(runningTurn);
      const runningSynced = await updateTurn(next.id, (current) => ({
        ...current,
        mission: runningMission ?? current.mission,
        workflowRun: workflowRunForTurn({ ...current, mission: runningMission ?? current.mission }),
      }), input);
      void dispatchTurn({ turnId: next.id, agentAdapter: input.agentAdapter, actor: input.actor }).catch(async (error) => {
        const message = error instanceof Error ? error.message : 'dispatch_failed';
        const failed = await updateTurn(next.id, (current) => {
          const failedTurn = {
            ...current,
            dispatchStatus: 'failed' as const,
            dispatchStage: 'failed',
            dispatchError: message,
          };
          return {
            ...failedTurn,
            workflowRun: workflowRunForTurn(failedTurn),
          };
        }, input).catch(() => null);
        const failedTurn = failed ? requireTurn(failed) : null;
        if (!failedTurn) return;
        const failedMission = await updateMissionForDispatch(failedTurn).catch(() => null);
        await updateTurn(next.id, (current) => ({
          ...current,
          mission: failedMission ?? current.mission,
          workflowRun: workflowRunForTurn({ ...current, mission: failedMission ?? current.mission }),
        }), input).catch(() => {});
      });
      return dispatchResponse(requireTurn(runningSynced));
    }
    return dispatchTurn({ turnId: next.id, agentAdapter: input.agentAdapter, actor: input.actor });
  }
  return dispatchResponse(next);
}

export async function dispatchTurn(input: DispatchInput): Promise<DispatchResponse> {
  const turn = await getTurn(input.turnId, input);
  if (!turn) throw new ActionError('turn_not_found', 404);
  if (turn.dispatchStatus === 'completed' && turn.dispatch.length > 0) return dispatchResponse(turn);

  const adapter = normalizeAdapter(
    publicAiExecutionDisabled()
      ? 'local-dispatch'
      : input.agentAdapter ?? await resolveDefaultAgentAdapter() ?? undefined,
  );
  const runtimeEnv = { ...process.env };
  const workspace = await prepareWorkspace(turn);
  await updateTurn(turn.id, (current) => ({
    ...current,
    dispatchStatus: 'running',
    dispatchAdapter: adapter,
    dispatchStage: 'dispatch',
    dispatchError: null,
    dispatchWorkspacePath: workspace,
  }), input);

  // Per-task side data the scheduler's lean TaskResult doesn't carry: the agent
  // event stream and the produced artifacts, keyed by task id for later
  // assembly. artifactByTask holds each task's PRIMARY artifact (the built page
  // when one exists) for handoff context and the repair loop; allArtifactsByTask
  // holds everything the task produced, including real workspace files.
  const eventsByTask = new Map<string, AgentEvent[]>();
  const artifactByTask = new Map<string, Artifact>();
  const allArtifactsByTask = new Map<string, Artifact[]>();
  const remoteByTask = new Map<string, NonNullable<DispatchRecord['remote']>>();

  // Work completed by EARLIER turns in this chat: handed to every agent so a
  // follow-up request is treated as an increment on the existing work, not a
  // fresh build. (The files themselves are still in the shared workspace.)
  const priorChatArtifacts = turn.localChatId
    ? (await readData()).artifacts
        .filter((artifact) => artifact.chatId === turn.localChatId)
        .filter((artifact) => !turn.artifacts.some((own) => own.id === artifact.id))
        .slice(-12)
    : [];
  const continuationContext = priorChatArtifacts.length > 0
    ? [
        '# Follow-up in an ongoing mission',
        '',
        'Earlier turns in this chat already produced work; the files are in the workspace.',
        'Treat this request as an INCREMENT: revise or extend the existing work instead of recreating it.',
        '',
        'Prior artifacts:',
        ...priorChatArtifacts.map((artifact) => `- ${artifact.title} (${artifact.kind}, v${artifact.version})`),
      ].join('\n')
    : '';

  // Title/brief patches computed when the planner completes. The scheduler
  // snapshots the task graph BEFORE the planner runs, so without this the model
  // prompts and artifact filenames would keep the "awaiting plan" placeholders
  // (retitleDownstreamTasks only fixes the persisted copy the UI reads).
  const patchByTask = new Map<string, { title: string; brief: string }>();

  const runTask = async (
    task: PlanTask,
    depOutputs: Record<string, { summary: string; artifactId?: string | undefined }>,
  ): Promise<TaskResult> => {
    const patch = patchByTask.get(task.id);
    const effectiveTask = patch ? { ...task, ...patch } : task;
    const depEntries = Object.entries(depOutputs);
    const contextArtifacts = [
      ...priorChatArtifacts,
      ...turn.artifacts,
      ...depEntries
        .map(([depId]) => artifactByTask.get(depId))
        .filter((artifact): artifact is Artifact => artifact !== undefined),
    ];
    const handoffCard = buildHandoffCardV2({
      mission: turn.mission ?? buildMissionSnapshot({
        ownerId: turn.ownerId,
        chatId: turn.localChatId,
        turnId: turn.id,
        missionId: turn.missionId,
        goal: turn.message,
        workingStyle: turn.workingStyle,
        plan: turn.plan,
        needsClarification: turn.needsClarification,
        workflowTemplateId: turn.workflowTemplateId,
      }),
      turn,
      task: effectiveTask,
      artifacts: contextArtifacts,
    });
    // The architect's delivery-gate review doubles as the docs & memory audit:
    // it sees every Markdown artifact and each agent's memory health, and its
    // blocking findings route through the same review→fix loop.
    const docsAudit = effectiveTask.role === 'architect' && isReviewGateTask(effectiveTask)
      ? await buildDocsAuditContext({ workspace, artifacts: contextArtifacts }).catch(() => '')
      : '';
    const handoffContext = [
      formatWorkingStyleForPrompt(turn.workingStyle)
        ? `# User working style\n\n${formatWorkingStyleForPrompt(turn.workingStyle)}`
        : '',
      continuationContext,
      docsAudit,
      formatHandoffContext(handoffCard, depOutputs),
    ].filter(Boolean).join('\n\n---\n\n');

    let result;
    let fallbackNote: AgentEvent | null = null;
    try {
      result = await runAgentTask({
        adapter,
        workspace,
        task: effectiveTask,
        message: turn.message,
        turnId: turn.id,
        chatId: turn.localChatId,
        handoffContext,
        handoffCard,
        missionId: handoffCard.missionId,
        runtimeEnv,
      });
    } catch (error) {
      // Opt-in adapter unavailable (E2B / MiniMax / OpenAI-compatible): fall back
      // to local-dispatch in this layer (not silently inside the adapter). The
      // fallback is surfaced as an event on the task so a misconfig is visible
      // in the UI, not hidden.
      if (
        error instanceof E2BUnavailableError
        || error instanceof MiniMaxUnavailableError
        || error instanceof MiniMaxRequestError
        || error instanceof OpenAICompatUnavailableError
        || error instanceof OpenAICompatRequestError
        || error instanceof A2AUnavailableError
        || error instanceof A2ARequestError
      ) {
        fallbackNote = {
          type: 'thinking_delta',
          delta: `${error.name} (${error.message}); fell back to local-dispatch.`,
        };
        result = await runAgentTask({ adapter: 'local-dispatch', workspace, task: effectiveTask, message: turn.message, turnId: turn.id, chatId: turn.localChatId, handoffContext, runtimeEnv });
      } else {
        throw error;
      }
    }

    eventsByTask.set(task.id, fallbackNote ? [fallbackNote, ...result.events] : result.events);
    if (result.remote) remoteByTask.set(task.id, result.remote);
    const produced = artifactsFromRun(turn, effectiveTask, result);
    artifactByTask.set(task.id, produced.primary);
    allArtifactsByTask.set(task.id, produced.all);

    if (!result.ok) {
      return { ok: false, error: { message: result.error ?? 'agent_task_failed' } };
    }

    // Safety gate: a high-severity finding turns this task into an error, which
    // the scheduler routes into the bounded review→fix loop via onFailure.
    if (safetyEnabled()) {
      const findings = scanArtifact(result.text);
      if (hasBlockingFinding(findings)) {
        return { ok: false, error: { message: 'safety_block', scan: findings } };
      }
    }

    // The plan is now defined: once the planner finishes, the downstream tasks
    // are no longer "awaiting plan" — give them concrete titles so the UI stops
    // showing three placeholder rows that all looked the same. Mirror the same
    // patches onto the in-memory graph the scheduler keeps feeding us.
    if (task.role === 'planner') {
      for (const [taskId, taskPatch] of plannedTaskPatches(turn.plan.tasks, task.id, turn.message)) {
        patchByTask.set(taskId, taskPatch);
      }
      await retitleDownstreamTasks(turn.id, task.id, turn.message);
    }

    // A fixer that produced a complete deliverable repairs the artifact it was
    // derived for: update it in place (bumped version) so the preview shows the
    // FIXED page, not the flawed original the reviewer rejected. (CLI-backed
    // fixers edit the real file instead; their workspace scan re-captures it.)
    if (task.repairTargetTaskId) {
      const target = artifactByTask.get(task.repairTargetTaskId);
      const repaired = target ? repairedTargetArtifact(target, result.text) : null;
      if (repaired) {
        artifactByTask.set(task.repairTargetTaskId, repaired);
        allArtifactsByTask.set(
          task.repairTargetTaskId,
          (allArtifactsByTask.get(task.repairTargetTaskId) ?? [repaired]).map(
            (artifact) => (artifact.id === repaired.id ? repaired : artifact),
          ),
        );
      }
    }

    // Review gate: a reviewer that reports blocking (Critical/High) issues should
    // trigger a fix, not silently end the run. Treat such a review as a failure
    // so the scheduler derives a fixer via onFailure (bounded by maxFixRounds);
    // the fixer receives this review as its repair context. A clean review passes.
    // The architect's post-build check (role architect, review stage) gates the
    // same way: blocking architecture findings get a fix round too.
    if (isReviewGateTask(task) && reviewRequestsFix()) {
      const severities = reviewSeverities(result.text);
      if (severities.blocking > 0) {
        return {
          ok: false,
          error: { message: `review_found_issues: ${severities.label}`, review: result.text },
        };
      }
    }

    return { ok: true, output: { summary: result.text, artifactId: artifactByTask.get(task.id)?.id } };
  };

  // Fixer tasks the scheduler derives at runtime, keyed by id, so onTaskState can
  // fold them into the persisted plan as they start (the UI reads plan.tasks).
  const derivedById = new Map<string, PlanTask>();

  // Stream per-task progress into the turn's workflowRun.stageStates as each
  // agent starts/finishes, so the polling UI can animate the roundtable (who's
  // working right now) instead of jumping straight from "queued" to "done".
  // onTaskState is awaited sequentially by the scheduler, so its store write does
  // not race the final updateTurn (which only runs after the scheduler returns).
  const schedulerToStage = { running: 'running', completed: 'done', failed: 'failed', blocked: 'blocked' } as const;
  const onTaskState = async (taskId: string, status: 'running' | 'completed' | 'failed' | 'blocked') => {
    const derived = derivedById.get(taskId);
    // Persist this task's artifacts as soon as it reaches a terminal state — not
    // only at the end-of-run fold. An interrupted or crashed run must not lose
    // the work of tasks that already finished (their files exist in the
    // workspace but would otherwise never be registered).
    const taskArtifacts = status === 'completed' || status === 'failed'
      ? allArtifactsByTask.get(taskId) ?? []
      : [];
    await updateTurn(turn.id, (current) => {
      const planHasTask = current.plan.tasks.some((task) => task.id === taskId);
      const tasks = derived && !planHasTask
        ? [...current.plan.tasks, derived]
        : current.plan.tasks;
      const artifacts = [...current.artifacts];
      upsertArtifacts(artifacts, taskArtifacts);
      return {
        ...current,
        plan: { ...current.plan, tasks },
        artifacts,
        dispatchStage: status === 'running' ? `running:${taskId}` : current.dispatchStage,
        workflowRun: {
          ...(current.workflowRun ?? { activeStageId: null, stageStates: {}, taskStates: {} }),
          stageStates: {
            ...(current.workflowRun?.stageStates ?? {}),
            [taskId]: { status: schedulerToStage[status] },
          },
          taskStates: {
            ...(current.workflowRun?.taskStates ?? {}),
            [taskId]: {
              status: schedulerToStage[status],
              stageId: tasks.find((task) => task.id === taskId)?.stageId ?? null,
            },
          },
        },
      };
    }, input);
    if (taskArtifacts.length > 0 && turn.localChatId) {
      await mutateData((data) => {
        upsertArtifacts(data.artifacts, taskArtifacts);
      });
    }
    const current = await getTurn(turn.id, input);
    if (current) {
      const mission = await updateMissionForDispatch(current);
      await updateTurn(turn.id, (latest) => ({
        ...latest,
        mission: mission ?? latest.mission,
        workflowRun: workflowRunForTurn({ ...latest, mission: mission ?? latest.mission }),
      }), input);
    }
  };

  const run = await runScheduler({
    tasks: turn.plan.tasks,
    runTask,
    maxFixRounds: maxFixRounds(),
    now: nowIso,
    onFailure: (failed, error) => {
      if (!shouldAttemptFix(error)) return null;
      const fixer = makeFixerTask(failed, error);
      // Point the fixer at the concrete deliverable it repairs (the previewable
      // artifact among the failed task and its upstream deps — for a failed
      // review that's the implementer's page). The fixer then writes its
      // corrected output to the SAME path and the artifact is updated in place,
      // so the fix actually lands in what the user previews.
      const repairTarget = [failed.id, ...failed.deps]
        .map((taskId) => ({ taskId, artifact: artifactByTask.get(taskId) }))
        .find((entry) => entry.artifact?.kind === 'preview');
      const enriched: PlanTask = repairTarget?.artifact
        ? {
            ...fixer,
            repairTargetPath: repairTarget.artifact.title,
            repairTargetTaskId: repairTarget.taskId,
          }
        : fixer;
      // Remember it so onTaskState can add it to the persisted plan when it runs
      // (a concurrent write here would race the store's read-modify-write).
      derivedById.set(enriched.id, enriched);
      return enriched;
    },
    onTaskState,
  });

  // Assemble DispatchRecords from scheduler records, enriching with the captured
  // agent events. Blocked tasks carry no events.
  const records: DispatchRecord[] = run.records.map((record) => ({
    taskId: record.taskId,
    agentId: record.agentId,
    status: record.status,
    events: eventsByTask.get(record.taskId) ?? [],
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    ...(record.producedFor !== undefined ? { producedFor: record.producedFor } : {}),
    ...(record.fixRound !== undefined ? { fixRound: record.fixRound } : {}),
    artifactIds: (allArtifactsByTask.get(record.taskId) ?? []).map((artifact) => artifact.id),
    ...(remoteByTask.get(record.taskId) ? { remote: remoteByTask.get(record.taskId)! } : {}),
  }));

  // Fold every task's artifacts together with replace-by-identity semantics:
  // two tasks (or a fixer round) touching the same file yield ONE artifact with
  // a bumped version, not duplicates.
  const runArtifacts: Artifact[] = [...turn.artifacts];
  for (const task of run.tasks) {
    upsertArtifacts(runArtifacts, allArtifactsByTask.get(task.id) ?? []);
  }

  // A failed task is "repaired" if a fixer in its lineage completed. Walk the
  // producedFor chain from every completed fixer back to the originally failed
  // task so a successful fix doesn't leave the whole run marked failed.
  const taskById = new Map(run.tasks.map((task) => [task.id, task]));
  const repaired = new Set<string>();
  const markRepaired = (taskId: string) => {
    repaired.add(taskId);
    for (const candidate of run.tasks) {
      if (
        candidate.status === 'blocked'
        && candidate.deps.some((dep) => repaired.has(dep) || dep === taskId)
      ) {
        repaired.add(candidate.id);
      }
    }
  };
  for (const task of run.tasks) {
    if (task.status !== 'completed' || task.producedFor === undefined) continue;
    let cursor: string | undefined = task.producedFor;
    while (cursor) {
      markRepaired(cursor);
      cursor = taskById.get(cursor)?.producedFor;
    }
  }
  // The run failed only if a task ended failed/blocked AND was not repaired.
  const failed = run.tasks.some(
    (task) => (task.status === 'failed' || task.status === 'blocked') && !repaired.has(task.id),
  );
  // A question turn delivers an answer, not a build: delivery-report artifacts
  // (review summary, final report) would be noise on top of it.
  const isQuestionTurn = turn.intake.intentType === 'question';
  const artifacts: Artifact[] = failed || isQuestionTurn
    ? runArtifacts
    : [...runArtifacts, reviewerSummaryArtifact(turn, runArtifacts, records), finalReportArtifact(turn, runArtifacts, records)];
  // Persist any fixer tasks the scheduler derived at runtime back into the plan,
  // so the UI (roundtable + todo list, which read plan.tasks) shows the fix pass
  // — front and back stay in sync on the real executed graph.
  const plannedIds = new Set(turn.plan.tasks.map((task) => task.id));
  const derivedTasks: PlanTask[] = run.tasks
    .filter((task) => !plannedIds.has(task.id))
    .map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      owner: task.owner,
      role: task.role,
      stageId: task.stageId,
      requiredCapabilities: task.requiredCapabilities,
      brief: task.brief,
      deps: task.deps,
      parallel: task.parallel,
      ...(task.producedFor !== undefined ? { producedFor: task.producedFor } : {}),
      ...(task.fixRound !== undefined ? { fixRound: task.fixRound } : {}),
      ...(task.repairTargetPath !== undefined ? { repairTargetPath: task.repairTargetPath } : {}),
      ...(task.repairTargetTaskId !== undefined ? { repairTargetTaskId: task.repairTargetTaskId } : {}),
    }));
  const completed = await updateTurn(turn.id, (current) => {
    const mergedTasks = mergePlanTasks(current.plan.tasks, derivedTasks);
    const nextTurn = {
      ...current,
      plan: { ...current.plan, tasks: mergedTasks },
      dispatchStatus: failed ? 'failed' as const : 'completed' as const,
      dispatchAdapter: adapter,
      dispatchedAt: nowIso(),
      dispatchStage: failed ? 'failed' : 'done',
      dispatchError: failed ? 'one_or_more_tasks_failed' : null,
      dispatchWorkspacePath: workspace,
      dispatch: records,
      artifacts,
    };
    const legacyRun = workflowRunFromTasks(run.tasks);
    const missionRun = workflowRunForTurn(nextTurn);
    return {
      ...nextTurn,
      workflowRun: {
        ...missionRun,
        stageStates: {
          ...missionRun.stageStates,
          ...legacyRun.stageStates,
        },
        taskStates: {
          ...missionRun.taskStates,
          ...legacyRun.taskStates,
        },
      },
    };
  }, input);
  const completedTurn = requireTurn(completed);
  const mission = await updateMissionForDispatch(completedTurn);
  const finalTurn = requireTurn(await updateTurn(completedTurn.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  }), input));
  const finalChatId = finalTurn.localChatId;
  if (finalChatId) {
    await mutateData((data) => {
      upsertArtifacts(data.artifacts, finalTurn.artifacts);
      data.handoffs.push(...handoffsForTasks(finalTurn, finalChatId));
    });
  }
  return dispatchResponse(finalTurn);
}

export async function interruptTurn(turnId: string, access?: { actor?: Actor | null | undefined } | undefined): Promise<DispatchResponse> {
  const existing = await getTurn(turnId, access);
  if (!existing) throw new ActionError('turn_not_found', 404);
  await cancelA2ATasksForTurn(turnId);
  const turn = await updateTurn(turnId, (current) => ({
    ...current,
    dispatchStatus: 'failed',
    dispatchStage: 'interrupted',
    dispatchError: 'interrupted_by_user',
  }), access);
  const interrupted = requireTurn(turn);
  const mission = await updateMissionForDispatch(interrupted);
  const synced = await updateTurn(interrupted.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  }), access);
  return dispatchResponse(requireTurn(synced));
}

export async function cancelA2ATasksForTurn(turnId: string): Promise<void> {
  const terminal = new Set(['completed', 'failed', 'canceled', 'rejected']);
  const bindings = (await bindingsForTurn(turnId)).filter((binding) => !terminal.has(binding.state));
  await Promise.allSettled(bindings.map(async (binding) => {
    const config = await resolveA2ARemoteAgentConfig(binding.agentId);
    if (!config) return;
    await cancelA2ABinding(binding, config);
  }));
}

// Map the scheduler's per-task status onto the WorkflowRun shape the UI reads.
function workflowRunFromTasks(tasks: ScheduledTask[]): WorkflowRun {
  const map: Record<string, 'pending' | 'running' | 'done' | 'blocked' | 'failed'> = {
    completed: 'done',
    failed: 'failed',
    blocked: 'blocked',
    running: 'running',
    pending: 'pending',
  };
  return {
    activeStageId: null,
    stageStates: Object.fromEntries(
      tasks.map((task) => [task.id, { status: map[task.status] ?? 'pending' }]),
    ),
    taskStates: Object.fromEntries(
      tasks.map((task) => [task.id, {
        status: map[task.status] ?? 'pending',
        stageId: task.stageId ?? null,
      }]),
    ),
  };
}

function mergePlanTasks(existing: PlanTask[], additions: PlanTask[]): PlanTask[] {
  const byId = new Map<string, PlanTask>();
  for (const task of existing) byId.set(task.id, task);
  for (const task of additions) {
    byId.set(task.id, { ...(byId.get(task.id) ?? {}), ...task });
  }
  return [...byId.values()];
}
