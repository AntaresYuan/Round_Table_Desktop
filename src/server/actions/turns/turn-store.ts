import { mutateData, nowIso, readData } from '../../store.js';
import type { Actor, LocalTurn, TurnLiveActivity } from '../../types.js';
import { removeWorkspace } from '../workspace-cleanup.js';
import { ActionError } from './errors.js';
import { withLiveActivity } from './live-activity.js';

export type TurnAccess = {
  actor?: Actor | null | undefined;
};

export async function listTurns(
  chatId?: string | undefined,
  access?: TurnAccess | undefined,
): Promise<Array<LocalTurn & { liveActivity?: TurnLiveActivity }>> {
  const data = await readData();
  return data.turns
    .filter((turn) => !chatId || turn.localChatId === chatId)
    .filter((turn) => canAccessTurn(turn, access))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((turn) => withLiveActivity(turn, data.agentRuntimeConversations));
}

export async function getTurn(turnId: string, access?: TurnAccess | undefined): Promise<LocalTurn | null> {
  const data = await readData();
  const turn = data.turns.find((item) => item.id === turnId) ?? null;
  if (!turn || !canAccessTurn(turn, access)) return null;
  return turn;
}

// Delete a session: the turn, its mission, its turn-scoped artifacts/handoffs,
// AND its workspace on disk. Managed workspaces (under ROUNDTABLE_WORKSPACE_ROOT)
// are removed entirely; a workbench-linked project directory only loses our
// .roundtable/runs output — never the user's own files (see workspace-cleanup).
export async function deleteTurn(turnId: string, access?: TurnAccess | undefined): Promise<{ id: string }> {
  const turn = await getTurn(turnId, access);
  if (!turn) throw new ActionError('turn_not_found', 404);
  await mutateData((data) => {
    data.turns = data.turns.filter((item) => item.id !== turnId);
    // A mission can span several turns of a chat. Deleting its only turn
    // deletes the mission; otherwise the mission survives with the turn
    // removed from its history (its plan re-syncs on the next dispatch).
    let missionDeleted = false;
    data.missions = data.missions.flatMap((mission) => {
      const turnIds = mission.turnIds?.length ? mission.turnIds : [mission.sourceTurnId];
      if (mission.id !== turn.missionId && !turnIds.includes(turnId)) return [mission];
      const remaining = turnIds.filter((item) => item !== turnId);
      if (remaining.length === 0) {
        missionDeleted = true;
        return [];
      }
      return [{
        ...mission,
        turnIds: remaining,
        sourceTurnId: mission.sourceTurnId === turnId ? remaining[remaining.length - 1]! : mission.sourceTurnId,
        updatedAt: nowIso(),
      }];
    });
    // Turn-scoped artifacts carry ids of the form `${taskId}_${turnId}`; the
    // local (chat-less) flow also parents them under the synthetic chat id.
    data.artifacts = data.artifacts.filter((artifact) =>
      !artifact.id.endsWith(`_${turnId}`) && artifact.chatId !== `local-${turnId}`,
    );
    // Handoff cards are per-turn (card.turnId); sweep the whole mission's
    // handoffs only when the mission itself is gone (covers older cards that
    // predate the turnId field).
    data.handoffs = data.handoffs.filter((handoff) => {
      if (handoff.chatId === `local-${turnId}`) return false;
      if (handoff.card?.['turnId'] === turnId) return false;
      const cardId = typeof handoff.card?.['id'] === 'string' ? handoff.card['id'] as string : '';
      if (cardId === `handoff-${turnId}` || cardId.startsWith(`handoff-${turnId}-`)) return false;
      return !(missionDeleted && handoff.card?.['missionId'] === turn.missionId);
    });
  });
  // Files go after the store commit so a failed deletion never leaves a
  // half-deleted session pointing at a vanished workspace. The workspace is
  // chat-scoped: only remove it when no surviving turn still works in it.
  if (turn.dispatchWorkspacePath) {
    const remaining = await readData();
    const workspaceShared = remaining.turns.some((item) => item.dispatchWorkspacePath === turn.dispatchWorkspacePath);
    if (!workspaceShared) await removeWorkspace(turn.dispatchWorkspacePath);
  }
  return { id: turnId };
}

export async function updateTurn(
  turnId: string,
  update: (turn: LocalTurn) => LocalTurn,
  access?: TurnAccess | undefined,
): Promise<LocalTurn | null> {
  return mutateData((data) => {
    const index = data.turns.findIndex((turn) => turn.id === turnId);
    if (index === -1) return null;
    const current = data.turns[index];
    if (!current) return null;
    if (!canAccessTurn(current, access)) return null;
    const next = update(current);
    data.turns[index] = next;
    return next;
  });
}

export function requireTurn(turn: LocalTurn | null): LocalTurn {
  if (!turn) throw new ActionError('turn_not_found', 404);
  return turn;
}

export function canAccessTurn(turn: LocalTurn, access?: TurnAccess | undefined): boolean {
  if (!access || !Object.prototype.hasOwnProperty.call(access, 'actor') || access.actor === undefined) return true;
  if (access.actor) return turn.ownerId === access.actor.id;
  return turn.ownerId === null;
}
