/* ============================================================================
   Roundtable — agent-utils.js
   Pure helpers for resolving the agent that owns a task/seat/artifact, and for
   deriving a task's live status from approval + dispatch state. Extracted from
   app-root.jsx so the live-turn, inspector, and stage component groups can each
   import them without depending on one another.
   ============================================================================ */

// Resolve the agent on a workflow seat: explicit agentId → by role → fallback.
export function agentForSeat(agents, agentId, role) {
  return (
    agents[agentId] ||
    Object.values(agents).find((a) => a.role === role) ||
    agents.orchestrator
  );
}

// Resolve the agent that produced an artifact. ownerAgentId may be a concrete
// agent id or a bare role; fall back to a non-PM agent of that role, then to the
// orchestrator.
export function agentForArtifact(artifact, agents) {
  if (agents[artifact.ownerAgentId]) return agents[artifact.ownerAgentId];
  const role = artifact.ownerAgentId;
  return Object.values(agents).find((agent) => agent.role === role && !agent.pm) || agents.orchestrator;
}

// A task's live status, derived from its dispatch record plus whether the plan
// has been approved and is running. Used by the plan card / todo rows.
export function todoStatusFor(_task, record, approved, dispatchStatus) {
  if (record?.status === 'completed' || record?.status === 'failed') return record.status;
  if (record?.status === 'running') return 'running';
  if (approved && dispatchStatus === 'running') return 'running';
  return 'pending';
}
