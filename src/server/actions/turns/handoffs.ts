import { id, nowIso } from '../../store.js';
import type { Actor, Handoff, HandoffCardV2, LocalTurn } from '../../types.js';
import { AGENT_ROSTER } from '../agent-roster.js';
import { buildHandoffCardV2, buildMissionSnapshot } from '../mission-actions.js';

export function handoffForTurn(actor: Actor | null | undefined, chatId: string, turn: LocalTurn): Handoff {
  const mission = turn.mission ?? buildMissionSnapshot({
    ownerId: turn.ownerId,
    chatId: turn.localChatId,
    turnId: turn.id,
    missionId: turn.missionId,
    goal: turn.message,
    plan: turn.plan,
    needsClarification: turn.needsClarification,
    workflowTemplateId: turn.workflowTemplateId,
  });
  const firstTask = turn.plan.tasks[0];
  const v2 = firstTask
    ? buildHandoffCardV2({ mission, turn, task: firstTask, artifacts: turn.artifacts, generatedAt: turn.createdAt })
    : null;
  return {
    id: id('handoff'),
    ownerId: actor?.id ?? 'local-user',
    chatId,
    createdAt: nowIso(),
    card: {
      protocolVersion: v2?.protocolVersion ?? 'roundtable.handoff.v1',
      missionId: turn.missionId,
      // Missions span turns; the turn id is what deleteTurn scopes cleanup by.
      turnId: turn.id,
      handoffV2: v2,
      id: `handoff-${turn.id}`,
      from: 'orchestrator',
      to: turn.plan.tasks[0]?.assignee ?? '@planning',
      scenario: 'dispatch',
      task: turn.message,
      userIntent: turn.message,
      taskBrief: firstTask?.brief ?? turn.plan.summary,
      pinnedMessages: [],
      rolesInGroup: AGENT_ROSTER,
      previousAgent: null,
      relevantArtifacts: turn.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
      })),
      fullHistoryRef: turn.localChatId ? `chat://${turn.localChatId}` : `turn://${turn.id}`,
      artifacts: turn.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
      })),
      createdAt: turn.createdAt,
      generatedBy: 'orchestrator',
    },
  };
}

export function handoffsForTasks(turn: LocalTurn, chatId: string): Handoff[] {
  const mission = turn.mission ?? buildMissionSnapshot({
    ownerId: turn.ownerId,
    chatId: turn.localChatId,
    turnId: turn.id,
    missionId: turn.missionId,
    goal: turn.message,
    plan: turn.plan,
    needsClarification: turn.needsClarification,
    workflowTemplateId: turn.workflowTemplateId,
  });
  return turn.plan.tasks.map((task) => {
    const taskArtifacts = turn.artifacts.filter((artifact) => artifact.id.startsWith(`${task.id}_`));
    const v2 = buildHandoffCardV2({ mission, turn, task, artifacts: taskArtifacts });
    return {
      id: id('handoff'),
      ownerId: turn.ownerId ?? 'local-user',
      chatId,
      createdAt: nowIso(),
      card: {
        protocolVersion: v2.protocolVersion,
        missionId: turn.missionId,
        turnId: turn.id,
        handoffV2: v2,
        id: v2.cardId,
        from: v2.fromAgent,
        to: `@${v2.toAgent}`,
        scenario: 'agent_handoff',
        task: task.title,
        userIntent: turn.message,
        taskBrief: task.brief,
        pinnedMessages: [],
        rolesInGroup: AGENT_ROSTER,
        previousAgent: null,
        relevantArtifacts: taskArtifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          title: artifact.title,
        })),
        fullHistoryRef: turn.localChatId ? `chat://${turn.localChatId}` : `turn://${turn.id}`,
        artifacts: taskArtifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          title: artifact.title,
        })),
        createdAt: nowIso(),
        generatedBy: 'orchestrator',
      },
    };
  });
}

export function formatHandoffContext(
  card: HandoffCardV2,
  depOutputs: Record<string, { summary: string; artifactId?: string | undefined }>,
): string {
  const upstream = Object.entries(depOutputs)
    .map(([depId, out]) => [
      `### ${depId}`,
      out.artifactId ? `Artifact: ${out.artifactId}` : null,
      out.summary,
    ].filter(Boolean).join('\n\n'))
    .join('\n\n---\n\n');
  return [
    `# Roundtable handoff`,
    '',
    `From ${card.fromAgent} to ${card.toAgent}.`,
    '',
    `## Current task`,
    '',
    card.task.title,
    '',
    card.task.brief,
    '',
    `## Mission context`,
    '',
    card.contextPackage.summary,
    '',
    upstream ? `## Upstream output\n\n${upstream}` : '',
    '',
    card.risks.length > 0 ? `## Risks\n\n${card.risks.map((risk) => `- ${risk}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}
