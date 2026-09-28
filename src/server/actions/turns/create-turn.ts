import { id, mutateData, nowIso } from '../../store.js';
import type {
  Actor,
  ClarifyAnswer,
  ClarifyQuestion,
  LocalTurn,
  WorkflowTemplate,
  WorkingStyleSnapshot,
} from '../../types.js';
import { applyAnswers, assessClarity } from '../clarify-actions.js';
import { getChat } from '../chat-actions.js';
import {
  buildMissionSnapshot,
  createMission,
  latestMissionForChat,
  resolveWorkflowTemplate,
  selectWorkflowTemplate,
  updateMissionForPlannedTurn,
  workflowRunForTurn,
  workflowTemplateById,
} from '../mission-actions.js';
import { emptyWorkingStyle, getWorkingStyleSnapshot } from '../skill-actions.js';
import { baseArtifacts, upsertArtifacts } from './artifacts.js';
import { ActionError } from './errors.js';
import { handoffForTurn } from './handoffs.js';
import { conductPlanningMeeting } from './planning-meeting.js';
import { intakeFromMessage, planFromMessage, plannedTaskPatches } from './planning.js';
import { turnResponse, type TurnResponse } from './responses.js';
import { getTurn } from './turn-store.js';
import { workspacePathForChat } from './workspace.js';

export type CreateTurnInput = {
  message: string;
  turnId?: string | undefined;
  chatId?: string | undefined;
  workflowTemplateId?: string | undefined;
  actor?: Actor | null | undefined;
};

export async function createTurn(input: CreateTurnInput): Promise<TurnResponse> {
  const message = input.message.trim();
  if (!message) throw new ActionError('missing_message', 400);
  const turnId = input.turnId?.trim() || id('turn');
  const chatId = input.chatId?.trim() || null;
  if (chatId && input.actor && !await getChat(input.actor, chatId)) throw new ActionError('chat_not_found', 404);
  const workingStyle = await getWorkingStyleSnapshot(input.actor, chatId);

  // Clarify gate: the planner judges whether the request is clear enough to plan.
  // If not, pause here with multiple-choice questions and DON'T build a plan yet —
  // the user answers, then answerClarification() resumes with the enriched goal.
  // A question is answered as-is: interrogating the user about "scope and tech
  // stack" before answering their question is the build pipeline leaking.
  const intentType = intakeFromMessage(message).intentType;
  const assessment = intentType === 'question'
    ? { clarity: 1, needsClarification: false, questions: [] }
    : await assessClarity(message);
  // Cross-turn continuity: a follow-up request in a chat continues the chat's
  // ongoing mission (revising its plan) instead of stacking a new mission per
  // message. Questions stay standalone — asking about the work must never
  // reset the work's plan.
  const continuedMission = intentType === 'question'
    ? null
    : await latestMissionForChat(input.actor?.id ?? null, chatId);
  // Custom-aware: a user-edited template (same id as a builtin, or a novel
  // one) drives both the mission stages AND the generated task DAG.
  const template = await resolveWorkflowTemplate(input.workflowTemplateId, message);
  const now = nowIso();
  if (assessment.needsClarification) {
    const turn = buildTurn({
      turnId,
      chatId,
      ownerId: input.actor?.id ?? null,
      message,
      now,
      needsClarification: true,
      clarifyQuestions: assessment.questions,
      clarifyAnswers: [],
      missionId: continuedMission?.id,
      workflowTemplateId: input.workflowTemplateId,
      template,
      workingStyle,
    });
    const mission = await createMission({
      actor: input.actor,
      chatId,
      turnId: turn.id,
      missionId: turn.missionId,
      goal: message,
      plan: turn.plan,
      needsClarification: true,
      workflowTemplateId: turn.workflowTemplateId,
      template,
      workingStyle,
    });
    const turnWithMission = {
      ...turn,
      mission,
      workflowRun: workflowRunForTurn({ ...turn, mission }),
    };
    await mutateData((data) => {
      data.turns = [turnWithMission, ...data.turns.filter((item) => item.id !== turnId)];
    });
    return turnResponse(turnWithMission);
  }

  const draftTurn = buildTurn({
    turnId,
    chatId,
    ownerId: input.actor?.id ?? null,
    message,
    now,
    missionId: continuedMission?.id,
    workflowTemplateId: input.workflowTemplateId,
    template,
    workingStyle,
  });
  // Persist before the planning meeting runs. The meeting can take long enough
  // for the user to refresh or navigate away; history must still be able to
  // restore the in-progress turn instead of losing the current task.
  const pendingTurn: LocalTurn = {
    ...draftTurn,
    status: 'pending',
    pmMessage: 'Planning meeting in progress.',
    dispatchStage: 'planning',
    workflowRun: workflowRunForTurn({
      ...draftTurn,
      status: 'pending',
      pmMessage: 'Planning meeting in progress.',
      dispatchStage: 'planning',
    }),
  };
  await mutateData((data) => {
    data.turns = [pendingTurn, ...data.turns.filter((item) => item.id !== turnId)];
  });
  const turn = await attachPlanningMeeting(draftTurn, message);
  const mission = await createMission({
    actor: input.actor,
    chatId,
    turnId: turn.id,
    missionId: turn.missionId,
    goal: message,
    plan: turn.plan,
    needsClarification: false,
    workflowTemplateId: turn.workflowTemplateId,
    template,
    workingStyle,
    standalone: intentType === 'question',
  });
  const turnWithMission = {
    ...turn,
    mission,
    workflowRun: workflowRunForTurn({ ...turn, mission }),
  };
  await mutateData((data) => {
    data.turns = [turnWithMission, ...data.turns.filter((item) => item.id !== turnId)];
    if (chatId) {
      upsertArtifacts(data.artifacts, turnWithMission.artifacts);
      data.handoffs.push(handoffForTurn(input.actor, chatId, turnWithMission));
    }
  });
  return turnResponse(turnWithMission);
}

// Builds a LocalTurn. When `needsClarification` is set the turn is parked before
// planning (empty plan); otherwise a real plan + base artifacts are attached.
function buildTurn(opts: {
  turnId: string;
  chatId: string | null;
  ownerId: string | null;
  message: string;
  now: string;
  needsClarification?: boolean;
  clarifyQuestions?: ClarifyQuestion[];
  clarifyAnswers?: ClarifyAnswer[];
  missionId?: string | undefined;
  workflowTemplateId?: string | undefined;
  // The custom-aware resolved template from resolveWorkflowTemplate(). The
  // sync fallback below only sees builtins, so async callers should always
  // resolve and pass this.
  template?: WorkflowTemplate | undefined;
  workingStyle?: WorkingStyleSnapshot | undefined;
}): LocalTurn {
  const { turnId, chatId, ownerId, message, now } = opts;
  const parked = opts.needsClarification === true;
  const workingStyle = opts.workingStyle ?? emptyWorkingStyle();
  const workflowTemplate = opts.template
    ?? (opts.workflowTemplateId
      ? workflowTemplateById(opts.workflowTemplateId)
      : selectWorkflowTemplate(message));
  const missionId = opts.missionId ?? id('mission');
  const intake = intakeFromMessage(message);
  const plan = parked
    ? { summary: `Awaiting clarification: ${message.slice(0, 80)}`, tasks: [] }
    : planFromMessage(message, workingStyle, intake.intentType, workflowTemplate);
  // Question turns produce an answer, not a mission dossier: intake/plan
  // artifacts would be noise next to it.
  const artifacts = parked || intake.intentType === 'question'
    ? []
    : baseArtifacts(turnId, chatId ?? `local-${turnId}`, message, intake, plan, workingStyle);
  const mission = buildMissionSnapshot({
    ownerId,
    chatId,
    turnId,
    missionId,
    goal: message,
    workingStyle,
    plan,
    needsClarification: parked,
    workflowTemplateId: workflowTemplate.id,
  });
  const workflowRun = workflowRunForTurn({
    id: turnId,
    localChatId: chatId,
    ownerId,
    missionId,
    workflowTemplateId: workflowTemplate.id,
    message,
    workingStyle,
    status: 'done',
    createdAt: now,
    provider: 'roundtable-local',
    model: 'agent-chain-v1',
    pmMessage: '',
    needsClarification: parked,
    clarifyQuestions: opts.clarifyQuestions ?? [],
    clarifyAnswers: opts.clarifyAnswers ?? [],
    needsApproval: !parked,
    approvalStatus: parked ? 'approved' : 'pending',
    approvedAt: parked ? now : null,
    dispatchStatus: 'not_started',
    dispatchAdapter: null,
    dispatchedAt: null,
    dispatchStage: parked ? 'clarifying' : 'awaiting_approval',
    dispatchError: null,
    dispatchWorkspacePath: null,
    dispatch: [],
    artifacts,
    intake,
    plan,
    planningMeeting: null,
    workflow: workflowTemplate,
    workflowRun: null,
    mission,
    error: null,
  });
  return {
    id: turnId,
    localChatId: chatId,
    ownerId,
    missionId,
    workflowTemplateId: workflowTemplate.id,
    message,
    workingStyle,
    status: 'done',
    createdAt: now,
    provider: 'roundtable-local',
    model: 'agent-chain-v1',
    pmMessage: parked
      ? 'I need a couple of details before I plan this.'
      : intake.intentType === 'question'
        ? 'This reads as a question — one agent will answer it directly. Start when ready.'
        : `Plan ready — ${plan.tasks.length} agent step${plan.tasks.length === 1 ? '' : 's'}. Review and start when you're ready.`,
    needsClarification: parked,
    clarifyQuestions: opts.clarifyQuestions ?? [],
    clarifyAnswers: opts.clarifyAnswers ?? [],
    // The plan must be reviewed and approved by the user before any agent runs.
    // A parked (clarifying) turn has no plan yet, so it isn't pending approval.
    needsApproval: !parked,
    approvalStatus: parked ? 'approved' : 'pending',
    approvedAt: parked ? now : null,
    dispatchStatus: 'not_started',
    dispatchAdapter: null,
    dispatchedAt: null,
    dispatchStage: parked ? 'clarifying' : 'awaiting_approval',
    dispatchError: null,
    dispatchWorkspacePath: null,
    dispatch: [],
    artifacts,
    intake,
    plan,
    planningMeeting: null,
    workflow: workflowTemplate,
    workflowRun,
    mission,
    error: null,
  };
}

/**
 * Resume a clarification-parked turn: fold the user's choices into the goal,
 * build the real plan, and replace the parked turn so it can be dispatched.
 */
export async function answerClarification(input: {
  turnId: string;
  answers: ClarifyAnswer[];
  actor: Actor;
}): Promise<TurnResponse> {
  const existing = await getTurn(input.turnId, input);
  if (!existing) throw new ActionError('turn_not_found', 404);
  if (!existing.needsClarification) throw new ActionError('turn_not_awaiting_clarification', 400);

  const enrichedMessage = applyAnswers(existing.message, existing.clarifyQuestions, input.answers);
  const now = nowIso();
  const resumedTemplate = await resolveWorkflowTemplate(existing.workflowTemplateId, enrichedMessage);
  const draftPlan = buildTurn({
    turnId: existing.id,
    chatId: existing.localChatId,
    ownerId: existing.ownerId,
    message: enrichedMessage,
    now,
    clarifyAnswers: input.answers,
    missionId: existing.missionId,
    workflowTemplateId: existing.workflowTemplateId,
    template: resumedTemplate,
    workingStyle: existing.workingStyle,
  });
  const planned = await attachPlanningMeeting(draftPlan, enrichedMessage);
  // Preserve the original user-facing message; keep the enriched text in the plan.
  const syncedMission = await updateMissionForPlannedTurn({
    ...planned,
    message: existing.message,
    createdAt: existing.createdAt,
  });
  const turn: LocalTurn = {
    ...planned,
    message: existing.message,
    createdAt: existing.createdAt,
    mission: syncedMission ?? planned.mission,
  };
  const turnWithWorkflowRun: LocalTurn = {
    ...turn,
    workflowRun: workflowRunForTurn(turn),
  };

  await mutateData((data) => {
    data.turns = [turnWithWorkflowRun, ...data.turns.filter((item) => item.id !== turn.id)];
    if (turnWithWorkflowRun.localChatId) {
      upsertArtifacts(data.artifacts, turnWithWorkflowRun.artifacts);
      data.handoffs.push(handoffForTurn(input.actor, turnWithWorkflowRun.localChatId, turnWithWorkflowRun));
    }
  });
  return turnResponse(turnWithWorkflowRun);
}

async function attachPlanningMeeting(turn: LocalTurn, planningMessage: string): Promise<LocalTurn> {
  if (turn.needsClarification || turn.intake.intentType === 'question' || turn.plan.tasks.length === 0) {
    return { ...turn, planningMeeting: null };
  }
  const workspace = await workspacePathForChat(turn.localChatId);
  const { meeting, plan: deliberatedPlan } = await conductPlanningMeeting({
    message: planningMessage,
    plan: turn.plan,
    workspace,
    now: nowIso(),
  });
  const plan = executablePlanAfterMeeting(deliberatedPlan, planningMessage);
  return {
    ...turn,
    plan,
    artifacts: baseArtifacts(
      turn.id,
      turn.localChatId ?? `local-${turn.id}`,
      planningMessage,
      turn.intake,
      plan,
      turn.workingStyle,
    ),
    planningMeeting: meeting,
    pmMessage: `Planning meeting complete — ${meeting.participants.length} seats completed the facilitated relay, ${meeting.decisions.length} decision${meeting.decisions.length === 1 ? '' : 's'} locked, ${plan.tasks.length} CLI step${plan.tasks.length === 1 ? '' : 's'} ready for approval.`,
  };
}

// The API planning meeting itself satisfies the planner task. Do not invoke a
// coding CLI to plan the same request a second time: remove the completed
// planner node, reconnect its downstream dependencies, and resolve placeholder
// titles before the user sees the executable plan.
function executablePlanAfterMeeting(plan: LocalTurn['plan'], message: string): LocalTurn['plan'] {
  const plannerTasks = plan.tasks.filter((task) => task.role === 'planner');
  const hasExecutableWork = plan.tasks.some((task) => task.role !== 'planner');
  if (!hasExecutableWork || plannerTasks.length === 0) return plan;

  const removed = new Set(plannerTasks.map((task) => task.id));
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const patches = new Map<string, { title: string; brief: string }>();
  for (const planner of plannerTasks) {
    for (const [taskId, patch] of plannedTaskPatches(plan.tasks, planner.id, message)) {
      patches.set(taskId, patch);
    }
  }
  const executableTasks = plan.tasks
    .filter((task) => !removed.has(task.id))
    .map((task) => {
      const expanded = new Set<string>();
      const visit = (dependencyId: string) => {
        const dependency = byId.get(dependencyId);
        if (!removed.has(dependencyId) || !dependency) {
          if (dependencyId !== task.id) expanded.add(dependencyId);
          return;
        }
        for (const upstream of dependency.deps) visit(upstream);
      };
      for (const dependencyId of task.deps) visit(dependencyId);
      const patch = patches.get(task.id);
      const preservedContext = task.brief.split('\n\n').slice(1).join('\n\n');
      return {
        ...task,
        ...(patch
          ? {
              title: patch.title,
              brief: [patch.brief, preservedContext].filter(Boolean).join('\n\n'),
            }
          : {}),
        deps: [...expanded],
      };
    });
  return {
    ...plan,
    // Keep the Planner's real meeting conclusion. The task count is already
    // visible in the approval UI; replacing this with a scheduler sentence
    // discarded the only user-facing summary of what the team decided.
    summary: plan.summary,
    tasks: executableTasks,
  };
}
