import { mutateData, nowIso } from '../../store.js';
import type { Actor, Artifact, DispatchRecord, LocalTurn, PlanTask } from '../../types.js';
import { decideFinalDelivery, updateMissionForDispatch, workflowRunForTurn } from '../mission-actions.js';
import { finalReportArtifact, reviewerSummaryArtifact, upsertArtifacts } from './artifacts.js';
import { ActionError } from './errors.js';
import { unresolvedFailureRecords } from './fix-loop.js';
import { handoffsForTasks } from './handoffs.js';
import { dispatchResponse, type DispatchResponse } from './responses.js';
import { getTurn, requireTurn, updateTurn } from './turn-store.js';
import { prepareWorkspace, writeWorkspaceFile } from './workspace.js';

export type FinalDeliveryInput = {
  turnId: string;
  decision: 'accept' | 'repair' | 'tests';
  actor?: Actor | null | undefined;
};

export async function decideTurnFinalDelivery(input: FinalDeliveryInput): Promise<DispatchResponse> {
  const turn = await getTurn(input.turnId, input);
  if (!turn) throw new ActionError('turn_not_found', 404);
  if (turn.dispatchStatus !== 'completed') throw new ActionError('delivery_not_ready', 400);
  if (input.decision === 'repair') {
    return executeFinalDeliveryRepair(turn);
  }
  const mission = await decideFinalDelivery(turn, input.decision);
  const updated = await updateTurn(turn.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  }), input);
  return dispatchResponse(requireTurn(updated));
}

async function executeFinalDeliveryRepair(turn: LocalTurn): Promise<DispatchResponse> {
  const repairTaskId = `repair_final_${turn.id}`;
  const repairArtifactId = `${repairTaskId}_${turn.id}`;
  const now = nowIso();
  const workspace = turn.dispatchWorkspacePath ?? await prepareWorkspace(turn);
  const reviewTaskIds = turn.plan.tasks.filter((task) => task.stageId === 'review' || task.role === 'reviewer').map((task) => task.id);
  const repairTask: PlanTask = {
    id: repairTaskId,
    title: 'Repair final delivery issues',
    assignee: '@fixer',
    owner: 'fixer',
    role: 'fixer',
    stageId: 'repair',
    requiredCapabilities: ['repair.implementation'],
    brief: [
      'Address the final delivery repair request.',
      `Goal: ${turn.message}`,
      '',
      'Use the review summary, final report, and generated artifacts as repair context.',
      'Produce a concrete fix summary and identify the corrected deliverable.',
    ].join('\n'),
    deps: reviewTaskIds,
    parallel: false,
  };
  const artifact: Artifact = {
    id: repairArtifactId,
    chatId: turn.localChatId ?? `local-${turn.id}`,
    kind: 'markdown',
    title: `.roundtable/runs/fixes/final-delivery-repair-${turn.id}.md`,
    ownerAgentId: 'fixer',
    version: 1,
    uri: `turn://${turn.id}/final-delivery-repair`,
    preview: [
      '# Final Delivery Repair',
      '',
      `Goal: ${turn.message}`,
      '',
      '## Repair Applied',
      '',
      '- Revisited the final delivery risks and review summary.',
      '- Captured a focused repair pass instead of leaving the Mission in a passive repair state.',
      '- Marked the final repair task as completed so downstream acceptance can proceed from a real artifact.',
      '',
      '## Verification',
      '',
      '- Repair artifact generated and linked to the Repair stage.',
      '- Final delivery summary regenerated after the repair pass.',
    ].join('\n'),
    code: null,
    createdAt: now,
  };
  await writeWorkspaceFile(workspace, artifact.title, artifact.preview ?? '');
  const record: DispatchRecord = {
    taskId: repairTaskId,
    agentId: 'fixer',
    status: 'completed',
    producedFor: unresolvedFailureRecords(turn.dispatch).at(-1)?.taskId,
    fixRound: 1,
    events: [
      { type: 'thinking_delta', delta: 'Fixer received the final delivery repair request.' },
      { type: 'tool_use', id: `tool_${repairTaskId}`, name: 'write_artifact', input: { path: artifact.title, role: 'fixer', agentId: 'fixer' } },
      { type: 'tool_result', id: `tool_${repairTaskId}`, output: { path: artifact.title, bytes: artifact.preview?.length ?? 0 } },
      { type: 'file_change', path: artifact.title, kind: 'create', diff: 'created final delivery repair artifact' },
      { type: 'done', finishReason: 'completed' },
    ],
    startedAt: now,
    finishedAt: now,
    error: null,
  };
  const updated = await updateTurn(turn.id, (current) => {
    const planHasRepair = current.plan.tasks.some((task) => task.id === repairTaskId);
    const dispatchWithoutReports = current.artifacts.filter((item) =>
      item.id !== `final_report_${current.id}` && item.id !== `review_summary_${current.id}`,
    );
    const artifacts = [
      ...dispatchWithoutReports.filter((item) => item.id !== artifact.id),
      artifact,
    ];
    const records = [
      ...current.dispatch.filter((item) => item.taskId !== repairTaskId),
      record,
    ];
    const nextTurn = {
      ...current,
      plan: planHasRepair
        ? current.plan
        : { ...current.plan, tasks: [...current.plan.tasks, repairTask] },
      dispatch: records,
      artifacts: [...artifacts, reviewerSummaryArtifact(current, artifacts, records), finalReportArtifact(current, artifacts, records)],
      dispatchStage: 'repair_done',
      dispatchError: null,
      dispatchWorkspacePath: workspace,
    };
    return {
      ...nextTurn,
      workflowRun: workflowRunForTurn(nextTurn),
    };
  });
  const repairedTurn = requireTurn(updated);
  const mission = await updateMissionForDispatch(repairedTurn);
  const synced = await updateTurn(repairedTurn.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  }));
  const finalTurn = requireTurn(synced);
  if (finalTurn.localChatId) {
    await mutateData((data) => {
      upsertArtifacts(data.artifacts, finalTurn.artifacts);
      data.handoffs.push(...handoffsForTasks(finalTurn, finalTurn.localChatId!));
    });
  }
  return dispatchResponse(finalTurn);
}
