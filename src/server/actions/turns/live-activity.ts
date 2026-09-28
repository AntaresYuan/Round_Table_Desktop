import type { AgentRuntimeConversation, LocalTurn, TurnLiveActivity } from '../../types.js';

// Attach each task's runtime conversation transcript to the turn (response
// only, never persisted): dispatch records land in the store only after the
// whole run finishes, but conversations stream per-event — this is what lets
// the polling UI show what an agent is thinking WHILE it works.
export function withLiveActivity(
  turn: LocalTurn,
  conversations: AgentRuntimeConversation[],
): LocalTurn & { liveActivity?: TurnLiveActivity } {
  const liveActivity: TurnLiveActivity = {};
  // Conversations are stored newest-first; keep the newest per task so a
  // repair re-run replaces the transcript of the original failed attempt.
  for (const conversation of conversations) {
    if (conversation.turnId !== turn.id || !conversation.taskId) continue;
    if (liveActivity[conversation.taskId]) continue;
    liveActivity[conversation.taskId] = {
      conversationId: conversation.id,
      agentId: conversation.agentId,
      runtime: conversation.runtime,
      status: conversation.status,
      error: conversation.error,
      updatedAt: conversation.updatedAt,
      transcript: conversation.transcript.slice(-30),
    };
  }
  return Object.keys(liveActivity).length > 0 ? { ...turn, liveActivity } : turn;
}
