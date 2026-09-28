/* ============================================================================
   Roundtable — live-scene.js
   Data assembly for the live (real-model) run: pick the latest turn, fold its
   artifacts into the gallery shape, and project a turn onto the roundtable
   scene (per-agent status + dependency-arrow task states). Pure functions,
   extracted from app-root.jsx so the App shell and the inspector group share one
   source of truth.
   ============================================================================ */

import { agentForArtifact } from './agent-utils';
import { bundlePreviewArtifacts } from './preview-html';

function latestLiveTurn(liveTurns) {
  const turns = (liveTurns || []).filter((turn) => turn.result || turn.status === 'pending' || turn.status === 'error');
  if (turns.length === 0) return null;
  const timeOf = (turn) => {
    const fromCreatedAt = turn.createdAt ? Date.parse(turn.createdAt) : NaN;
    if (!Number.isNaN(fromCreatedAt)) return fromCreatedAt;
    const fromId = /^live-(\d+)$/.exec(turn.id);
    return fromId ? Number(fromId[1]) : 0;
  };
  return [...turns].sort((a, b) => timeOf(b) - timeOf(a))[0];
}

function livePlanArtifact(liveTurns, liveStatus) {
  return {
    id: 'live-code-log',
    kind: 'code',
    title: 'roundtable-live-run.json',
    ownerAgentId: 'orchestrator',
    version: 1,
    source: 'generated',
    createdAt: new Date().toISOString(),
    code: JSON.stringify({
      server: {
        status: 'running',
        url: 'http://localhost:3000',
        currentUiStatus: liveStatus,
      },
      turns: (liveTurns || []).map((turn) => ({
        id: turn.id,
        createdAt: turn.createdAt,
        status: turn.status,
        approvalStatus: turn.result?.approvalStatus,
        dispatchStatus: turn.result?.dispatchStatus,
        dispatchAdapter: turn.result?.dispatchAdapter,
        artifactCount: turn.result?.artifacts?.length || 0,
        workspacePath: turn.result?.dispatchWorkspacePath,
        taskCount: turn.result?.plan?.tasks?.length || 0,
        message: turn.message,
        error: turn.error,
        plan: turn.result?.plan,
      })),
    }, null, 2),
  };
}

function normalizeLiveArtifacts(artifacts, agents) {
  return (artifacts || []).map((artifact) => {
    const owner = agentForArtifact(artifact, agents);
    return {
      ...artifact,
      ownerAgentId: owner.agentId,
      source: 'generated',
      code: artifact.kind === 'code' ? artifact.preview : undefined,
      preview: artifact.preview || '',
    };
  });
}

function uniqueTasksById(tasks) {
  const byId = new Map();
  for (const task of tasks || []) byId.set(task.id, task);
  return [...byId.values()];
}

// Each turn's result.artifacts is a full snapshot (backend upserts by id + bumps
// version), not a delta — so concatenating across turns re-lists every file from
// every prior turn. Dedupe by id here too, keeping the highest version seen.
function uniqueArtifactsById(artifacts) {
  const byId = new Map();
  for (const artifact of artifacts || []) {
    const existing = byId.get(artifact.id);
    if (!existing || (artifact.version ?? 0) >= (existing.version ?? 0)) byId.set(artifact.id, artifact);
  }
  return [...byId.values()];
}

function liveArtifactsFromTurns(liveTurns, agents, liveStatus) {
  const turns = liveTurns || [];
  const flattened = turns.flatMap((turn) => normalizeLiveArtifacts(turn.result?.artifacts || [], agents));
  return [
    ...(turns.length > 0 ? [livePlanArtifact(turns, liveStatus)] : []),
    ...bundlePreviewArtifacts(uniqueArtifactsById(flattened)),
  ];
}

// Project each task's live runtime transcript onto its agent: the latest
// transcript entry becomes the seat's "now doing" bubble on the roundtable
// (tool use → working, thinking → thinking, response → speaking). Only tasks
// that are actually running get a bubble; finished transcripts would read as
// stale chatter.
function workByAgent(liveActivity, tasks, agents) {
  const work = {};
  for (const [taskId, activity] of Object.entries(liveActivity || {})) {
    if (!activity || activity.status !== 'running') continue;
    const task = (tasks || []).find((item) => item.id === taskId);
    const agentId = agents[activity.agentId] ? activity.agentId : task?.owner;
    if (!agentId) continue;
    const entries = activity.transcript || [];
    const latest = entries[entries.length - 1] || null;
    const tool = latest?.kind === 'status' ? latest.content.replace(/^Using\s+/i, '') : null;
    work[agentId] = {
      taskId,
      mode: !latest ? 'starting' : latest.kind === 'thinking' ? 'thinking' : latest.kind === 'status' ? 'working' : 'speaking',
      text: latest ? latest.content : 'Starting up…',
      tool,
      steps: entries.length,
    };
  }
  return work;
}

// Map a stored turn (GET /api/orchestrator/history) onto the client live-turn
// shape the scene and chat cards read: turn-level fields stay on the turn, the
// run result moves under `result`.
function storedTurnToLiveTurn(turn) {
  const base = {
    id: turn.id,
    chatId: turn.localChatId,
    serverConfirmed: true,
    message: turn.message,
    status: turn.status,
    createdAt: turn.createdAt,
  };
  if (turn.status === 'error') return { ...base, error: turn.error || 'orchestrator_turn_failed' };
  if (turn.status !== 'done') return base;
  return {
    ...base,
    result: {
      ok: true,
      id: turn.id,
      missionId: turn.missionId,
      workflowTemplateId: turn.workflowTemplateId,
      provider: turn.provider,
      model: turn.model,
      pmMessage: turn.pmMessage,
      needsApproval: turn.needsApproval,
      approvalStatus: turn.approvalStatus,
      approvedAt: turn.approvedAt,
      dispatchStatus: turn.dispatchStatus,
      dispatchAdapter: turn.dispatchAdapter,
      dispatchedAt: turn.dispatchedAt,
      dispatchStage: turn.dispatchStage,
      dispatchError: turn.dispatchError,
      dispatchWorkspacePath: turn.dispatchWorkspacePath,
      dispatch: turn.dispatch,
      artifacts: turn.artifacts,
      intake: turn.intake,
      plan: turn.plan,
      planningMeeting: turn.planningMeeting || null,
      workflow: turn.workflow,
      workflowRun: turn.workflowRun,
      mission: turn.mission,
      needsClarification: turn.needsClarification,
      clarifyQuestions: turn.clarifyQuestions,
      clarifyAnswers: turn.clarifyAnswers,
      liveActivity: turn.liveActivity,
    },
  };
}

function buildLocalScene(baseScene, liveTurns, agents, planningPlayback = {}) {
  const latest = latestLiveTurn(liveTurns);
  if (!latest) return baseScene;
  const status = { ...baseScene.status };
  Object.keys(status).forEach((id) => { status[id] = 'idle'; });
  const result = latest.result;
  const completed = result?.dispatchStatus === 'completed';
  status.orchestrator = latest.status === 'pending' ? 'working' : result ? 'done' : 'idle';

  const meeting = result?.planningMeeting;
  const meetingMessages = meeting?.messages || [];
  const meetingActive = latest.status === 'pending'
    || (meetingMessages.length > 0 && planningPlayback.meetingComplete === false);
  if (meetingActive) {
    const index = Math.max(0, Math.min(
      planningPlayback.meetingMessageIndex ?? 0,
      Math.max(0, meetingMessages.length - 1),
    ));
    const message = meetingMessages[index] || null;
    for (const participant of meeting?.participants || ['orchestrator']) {
      if (status[participant] !== undefined) status[participant] = 'thinking';
    }
    const pendingText = /[\u3400-\u9fff]/.test(latest.message || '')
      ? '我先读取项目上下文，然后请团队依次从计划、架构、执行和风险角度发言。'
      : 'I am reading the project context, then the team will speak in order: plan, architecture, execution, and risk.';
    const speech = message
      ? {
          agentId: agents[message.agentId] ? message.agentId : 'orchestrator',
          mode: 'speaking',
          text: meetingSpeechText(message.content),
          phase: message.phase,
          step: index + 1,
          steps: Math.max(meetingMessages.length, 1),
        }
      : {
          agentId: 'orchestrator', mode: 'speaking', text: pendingText, phase: 'opening', step: 1, steps: 1,
        };
    status[speech.agentId] = 'speaking';
    return {
      ...baseScene,
      live: true,
      started: true,
      speech,
      planPosted: false,
      work: {},
      run: {
        phase: 'planning_meeting',
        message: latest.message,
        meetingStep: index + 1,
        meetingSteps: Math.max(meetingMessages.length, 1),
      },
      status,
      tasks: [],
      placed: [],
    };
  }

  const roleCursor = {};
  const ownerFor = (task) => {
    if (task?.owner && agents[task.owner]) return agents[task.owner];
    const target = String(task?.assignee || '').replace(/^@/, '');
    if (agents[target]) return agents[target];
    const candidates = Object.values(agents).filter((agent) => agent.role === target && !agent.pm);
    if (candidates.length === 0) return agents.orchestrator;
    const index = roleCursor[target] || 0;
    roleCursor[target] = index + 1;
    return candidates[index % candidates.length];
  };
  // Per-task status from the backend's workflowRun.stageStates, so dependency
  // arrows on the table appear as each task finishes — not all at once.
  const stageStates = result?.workflowRun?.stageStates || {};
  const stageToTaskStatus = { done: 'completed', failed: 'failed', blocked: 'blocked', running: 'running', pending: 'pending' };
  const liveTasks = uniqueTasksById(result?.plan?.tasks || []).map((task) => {
    const owner = ownerFor(task);
    const stageStatus = stageStates[task.id]?.status;
    const taskStatus = stageStatus
      ? (stageToTaskStatus[stageStatus] || 'pending')
      : (completed ? 'completed' : result?.dispatchStatus === 'running' ? 'running' : 'pending');
    status[owner.agentId] = taskStatus === 'completed' ? 'done' : taskStatus === 'running' ? 'working' : 'idle';
    return { ...task, owner: owner.agentId, status: taskStatus };
  });

  const work = workByAgent(result?.liveActivity, liveTasks, agents);
  // A live transcript is a stronger signal than the coarse task status: an
  // agent with a running conversation is thinking/working right now.
  for (const [agentId, now] of Object.entries(work)) {
    status[agentId] = now.mode === 'thinking' ? 'thinking' : 'working';
  }

  return {
    ...baseScene,
    live: true,
    started: true,
    speech: null,
    planPosted: Boolean(result?.plan),
    work,
    run: {
      phase: completed
        ? 'completed'
        : result?.dispatchStatus === 'running'
          ? 'running'
          : result?.dispatchStatus === 'not_started' && result?.approvalStatus !== 'approved'
            ? 'awaiting_approval'
            : 'running',
      message: latest.message,
      error: latest.error,
      provider: result?.provider,
      model: result?.model,
      dispatchStatus: result?.dispatchStatus,
      artifactCount: result?.artifacts?.length || 0,
      workspacePath: result?.dispatchWorkspacePath,
    },
    status,
    tasks: liveTasks,
    placed: result?.plan ? liveArtifactsFromTurns([latest], agents, 'idle').map((art) => ({
      art,
      ownerAgentId: art.ownerAgentId,
    })) : [],
  };
}

function meetingSpeechText(content) {
  const spoken = String(content || '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return spoken.length > 520 ? `${spoken.slice(0, 520).trim()}…` : spoken;
}

function planningMessageDuration(content) {
  return Math.min(11_000, Math.max(6_000, String(content || '').length * 27));
}

export {
  latestLiveTurn,
  livePlanArtifact,
  normalizeLiveArtifacts,
  liveArtifactsFromTurns,
  buildLocalScene,
  meetingSpeechText,
  planningMessageDuration,
  storedTurnToLiveTurn,
};
