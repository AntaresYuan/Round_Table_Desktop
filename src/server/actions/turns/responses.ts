import type { LocalTurn } from '../../types.js';

export type TurnResponse = ReturnType<typeof turnResponse>;
export type DispatchResponse = ReturnType<typeof dispatchResponse>;

export function turnResponse(turn: LocalTurn) {
  return {
    ok: true,
    id: turn.id,
    missionId: turn.missionId,
    workflowTemplateId: turn.workflowTemplateId,
    provider: turn.provider,
    model: turn.model,
    pmMessage: turn.pmMessage,
    needsClarification: turn.needsClarification,
    clarifyQuestions: turn.clarifyQuestions,
    clarifyAnswers: turn.clarifyAnswers,
    needsApproval: turn.needsApproval,
    approvalStatus: turn.approvalStatus,
    dispatchStatus: turn.dispatchStatus,
    dispatchStage: turn.dispatchStage,
    artifacts: turn.artifacts,
    intake: turn.intake,
    plan: turn.plan,
    planningMeeting: turn.planningMeeting ?? null,
    workflow: turn.workflow,
    workflowRun: turn.workflowRun,
    mission: turn.mission,
  };
}

export function dispatchResponse(turn: LocalTurn) {
  return {
    ok: true,
    id: turn.id,
    missionId: turn.missionId,
    workflowTemplateId: turn.workflowTemplateId,
    needsApproval: turn.needsApproval,
    approvalStatus: turn.approvalStatus,
    approvedAt: turn.approvedAt,
    dispatchStatus: turn.dispatchStatus,
    dispatchAdapter: turn.dispatchAdapter,
    dispatchedAt: turn.dispatchedAt,
    dispatchStage: turn.dispatchStage,
    dispatchError: turn.dispatchError,
    workspacePath: turn.dispatchWorkspacePath,
    records: turn.dispatch,
    artifacts: turn.artifacts,
    planningMeeting: turn.planningMeeting ?? null,
    workflowRun: turn.workflowRun,
    mission: turn.mission,
  };
}
