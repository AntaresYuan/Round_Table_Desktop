'use client';
/* ============================================================================
   Roundtable — live-turn.jsx
   The local real-model execution flow: the user message, the plan card with its
   approval gate, the agent-chain / workflow-stage cards, per-task todo rows, the
   stop / interrupted controls, and the final result card. Extracted from
   app-root.jsx so the live pipeline lives in one cohesive module.
   ============================================================================ */

import React from 'react';
import { planSummaryForDisplay, planTaskObjective } from '../lib/plan-presentation';
import { Avatar, Icon, Spinner, Md, tint, alpha } from './primitives';
import { agentForArtifact, agentForSeat, todoStatusFor } from '../lib/agent-utils';
import { bundlePreviewArtifacts, withBundledPreview } from '../lib/preview-html';

const { useState, useEffect, useRef, useMemo } = React;

function UserMsg({ text }) {
  return (
    <div className="rt-rise" style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
      <div style={{ maxWidth: '78%', padding: '11px 15px', borderRadius: '14px 14px 4px 14px',
        background: 'var(--accent)', color: '#fff', fontSize: 14, lineHeight: 1.5,
        boxShadow: 'var(--shadow-card)' }}>{text}</div>
      <Avatar agent={{ id: 'you-user', displayName: 'You', color: '#8076a0' }} size={30} />
    </div>
  );
}

function LocalLiveThread({ turns, agents, turnActions }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [turns?.[0]?.id, turns?.[0]?.result?.dispatchStatus, turns?.[0]?.result?.artifacts?.length]);

  if (!turns || turns.length === 0) {
    return (
      <div style={{ minHeight: 220, display: 'grid', placeItems: 'center', textAlign: 'center', color: 'var(--text-faint)' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5 }}>No live turn yet</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>Send a message below to run the real PM model from local env.</div>
        </div>
      </div>
    );
  }
  return (
    <div ref={ref} style={{ flex: 1, overflowY: 'auto', padding: '18px 24px 26px' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {turns.map((turn, index) => (
          <LocalLiveTurn
            key={turn.id}
            turn={turn}
            agents={agents}
            turnActions={turnActions}
            showPreview={index === 0}
          />
        ))}
      </div>
    </div>
  );
}


const STAGE_STATUS_STYLE = {
  done: { color: 'var(--ok)', label: 'done' },
  running: { color: 'var(--accent)', label: 'running' },
  active: { color: 'var(--accent)', label: 'running' },
  blocked: { color: 'var(--warn, #b8860b)', label: 'blocked' },
  failed: { color: 'var(--bad)', label: 'failed' },
  pending: { color: 'var(--text-faint)', label: 'pending' },
};

const MISSION_STATUS_STYLE = {
  awaiting_clarification: { color: 'var(--warn)', label: 'needs details' },
  awaiting_approval: { color: 'var(--warn)', label: 'awaiting approval' },
  running: { color: 'var(--run)', label: 'running' },
  blocked: { color: 'var(--warn)', label: 'blocked' },
  completed: { color: 'var(--ok)', label: 'ready' },
  failed: { color: 'var(--bad)', label: 'failed' },
};

function MissionHeader({ mission, workflow }) {
  if (!mission) return null;
  const sty = MISSION_STATUS_STYLE[mission.status] || MISSION_STATUS_STYLE.awaiting_approval;
  const checkpoint = (mission.checkpoints || []).find((cp) => cp.status === 'pending' || cp.status === 'blocked');
  const currentStage = (workflow?.stages || []).find((stage) => stage.id === mission.currentStageId)
    || (mission.stages || []).find((stage) => stage.id === mission.currentStageId);
  return (
    <div className="rt-rise" style={{ margin: '0 0 10px', border: '1px solid var(--border)',
      borderLeft: `3px solid ${sty.color}`, borderRadius: 'var(--r-card)', background: 'var(--surface)',
      boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', flexWrap: 'wrap' }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 8,
          background: alpha(sty.color, 14), color: sty.color }}>
          <Icon name={mission.status === 'completed' ? 'check' : 'layers'} size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--text)' }}>Mission</span>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{mission.workflowTemplateName || workflow?.name || 'Workflow'}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{mission.id}</span>
          </div>
          <div style={{ marginTop: 3, fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.35 }}>
            {currentStage ? `Current stage: ${currentStage.name}` : 'Preparing mission state'}
            {checkpoint?.requiredAction ? ` · ${checkpoint.requiredAction}` : ''}
          </div>
        </div>
        <span style={{ fontSize: 11.5, color: sty.color, padding: '3px 8px', borderRadius: 999,
          background: alpha(sty.color, 14), fontWeight: 800 }}>{sty.label}</span>
      </div>
    </div>
  );
}

// The planner needs more detail before it can build. Render its questions as
// pick-one cards — a nocode user just clicks an option per question, then submits.
function ClarifyCard({ turn, onSubmit }) {
  const questions = turn.result?.clarifyQuestions || [];
  const [picks, setPicks] = useState({});
  const submitting = turn.clarifying;
  const allAnswered = questions.length > 0 && questions.every((q) => picks[q.id]);
  const submit = () => {
    if (!allAnswered || submitting) return;
    const answers = questions.map((q) => {
      const opt = q.options.find((o) => o.id === picks[q.id]);
      return { questionId: q.id, optionId: picks[q.id], label: opt?.label || picks[q.id] };
    });
    onSubmit(answers);
  };
  return (
    <div className="rt-rise" style={{ marginTop: 4, border: '1px solid var(--border)',
      borderLeft: '3px solid var(--accent)', borderRadius: 'var(--r-card)', background: 'var(--surface)',
      boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="layers" size={15} style={{ color: 'var(--accent)' }} />
        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>A few quick questions before we build</div>
      </div>
      <div style={{ padding: '12px 14px', display: 'grid', gap: 16 }}>
        {questions.map((q) => (
          <div key={q.id} style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{q.question}</div>
            <div style={{ display: 'grid', gap: 7 }}>
              {q.options.map((opt) => {
                const active = picks[q.id] === opt.id;
                return (
                  <button key={opt.id} onClick={() => setPicks((p) => ({ ...p, [q.id]: opt.id }))}
                    disabled={submitting}
                    style={{ textAlign: 'left', display: 'grid', gap: 2, padding: '9px 12px', cursor: submitting ? 'default' : 'pointer',
                      borderRadius: 'var(--r-sm)', font: 'inherit',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      background: active ? alpha('var(--accent)', 10) : 'var(--surface-2)',
                      color: 'var(--text)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 }}>
                      <span style={{ width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                        border: `2px solid ${active ? 'var(--accent)' : 'var(--text-faint)'}`,
                        background: active ? 'var(--accent)' : 'transparent', boxShadow: active ? 'inset 0 0 0 2px var(--surface)' : 'none' }} />
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 21, lineHeight: 1.4 }}>{opt.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {turn.clarifyError && (
          <div style={{ fontSize: 12, color: 'var(--bad)' }}>{turn.clarifyError}</div>
        )}
        <button onClick={submit} disabled={!allAnswered || submitting}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '10px 14px',
            borderRadius: 'var(--r-sm)', border: 'none', font: 'inherit', fontSize: 13, fontWeight: 600,
            cursor: !allAnswered || submitting ? 'default' : 'pointer',
            background: !allAnswered || submitting ? 'var(--surface-3)' : 'var(--accent)',
            color: !allAnswered || submitting ? 'var(--text-faint)' : '#fff' }}>
          {submitting ? <><Spinner size={13} color="var(--text-faint)" /> Planning…</> : <><Icon name="check" size={14} /> Start building</>}
        </button>
      </div>
    </div>
  );
}

function LocalLiveTurn({ turn, agents, turnActions, showPreview }) {
  const completed = turn.result?.dispatchStatus === 'completed';
  const failed = turn.result?.dispatchStatus === 'failed';
  const running = turn.result?.dispatchStatus === 'running';
  const stopping = turn.result?.dispatchStage === 'interrupting' || turn.interrupting;
  const interrupted = failed && turn.result?.dispatchError === 'interrupted_by_user';
  const rawArtifacts = turn.result?.artifacts || [];
  const artifacts = useMemo(() => bundlePreviewArtifacts(rawArtifacts), [rawArtifacts]);
  const previewArtifact = previewArtifactFor(artifacts, agents);
  const meetingPlaying = Boolean(turn.result?.planningMeeting)
    && turn.meetingPlaybackComplete === false;
  const planningOnly = turn.status === 'pending' || meetingPlaying;
  // The plan has been drafted but no agent has run yet — show the reviewable plan
  // with a Start button instead of the (empty) run details.
  const awaitingApproval = !!turn.result
    && !turn.result.needsClarification
    && !meetingPlaying
    && turn.result.approvalStatus !== 'approved'
    && turn.result.dispatchStatus === 'not_started';
  return (
    <>
      <UserMsg text={turn.message} />
      {!planningOnly && <div className="rt-rise" style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
        <Avatar agent={agents.orchestrator} size={28} ring={false} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--pm)' }}>Roundtable</span>
            <span className="mono" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>mission run</span>
          </div>
          {turn.result?.mission && (
            <MissionHeader mission={turn.result.mission} workflow={turn.result.workflow} />
          )}
          {turn.status === 'error' && (
            <div style={{ padding: '10px 12px', borderRadius: 'var(--r-sm)', background: alpha('var(--bad)', 12),
              color: 'var(--bad)', fontSize: 13, borderLeft: '2px solid var(--bad)' }}>
              {turn.error}
            </div>
          )}
          {turn.result?.needsClarification && (
            <ClarifyCard
              turn={turn}
              onSubmit={(answers) => turnActions?.clarify && turnActions.clarify(turn.id, answers)}
            />
          )}
          {awaitingApproval && (
            <LocalPlanCard
              plan={turn.result.plan}
              intake={turn.result.intake}
              agents={agents}
              serverConfirmed={turn.serverConfirmed === true}
              approvalStatus={turn.result.approvalStatus}
              approving={turn.approving}
              approvalError={turn.approvalError}
              onApprove={() => turnActions?.approve && turnActions.approve(turn.id)}
              dispatch={turn.result.dispatch}
              dispatchStatus={turn.result.dispatchStatus}
            />
          )}
          {turn.result && !turn.result.needsClarification && !awaitingApproval && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.55 }}>
              <AgentChainCard
                plan={turn.result.plan}
                records={turn.result.dispatch}
                artifacts={artifacts}
                agents={agents}
                dispatchStatus={turn.result.dispatchStatus}
                dispatchAdapter={turn.result.dispatchAdapter}
                dispatchError={turn.result.dispatchError}
                workspacePath={turn.result.dispatchWorkspacePath || turn.result.workspacePath}
                liveActivity={turn.result.dispatchStatus === 'running' ? turn.result.liveActivity : null}
              />
              {running && turnActions && (
                <LocalStopBar
                  stopping={stopping}
                  interruptError={turn.interruptError}
                  onStop={() => turnActions.interrupt(turn.id)}
                />
              )}
              {interrupted && !turn.discarded && (
                <LocalInterruptedCard
                  turn={turn}
                  agents={agents}
                  artifacts={artifacts}
                  onResume={turnActions ? () => turnActions.redispatch(turn.id) : null}
                  onDiscard={turnActions ? () => turnActions.discard(turn.id) : null}
                  onHandoff={null}
                />
              )}
              {turn.result.workflow && turn.result.workflowRun && (
                <StageCards
                  workflow={turn.result.workflow}
                  workflowRun={turn.result.workflowRun}
                  artifacts={artifacts}
                  agents={agents}
                  dispatchStatus={turn.result.dispatchStatus}
                  liveActivity={turn.result.liveActivity}
                  records={turn.result.dispatch}
                />
              )}
              {(completed || failed || running || interrupted) && !(interrupted && turn.discarded) && (
                <LocalResultCard
                  artifacts={artifacts}
                  dispatchStatus={turn.result.dispatchStatus}
                  dispatchAdapter={turn.result.dispatchAdapter}
                  dispatchStage={turn.result.dispatchStage}
                  dispatchError={turn.result.dispatchError}
                  workspacePath={turn.result.dispatchWorkspacePath || turn.result.workspacePath}
                  previewArtifact={showPreview && !interrupted ? previewArtifact : null}
                  agents={agents}
                  mission={turn.result.mission}
                  onDecideDelivery={turnActions?.delivery ? (decision) => turnActions.delivery(turn.id, decision) : null}
                />
              )}
            </div>
          )}
        </div>
      </div>}
    </>
  );
}

function previewArtifactFor(artifacts, agents) {
  const previews = (artifacts || []).filter((artifact) => artifact.kind === 'preview' && artifact.preview);
  // Prefer the homepage over whatever page happened to be scanned/listed first.
  const explicit = previews.find((artifact) => /(^|\/)index\.html?$/i.test(artifact.title || '')) ?? previews[0];
  if (explicit) return withBundledPreview(explicit, artifacts);
  const candidates = (artifacts || [])
    .map((artifact, index) => {
      const owner = agentForArtifact(artifact, agents);
      const html = extractHtmlDocument(`${artifact.preview || ''}\n${artifact.code || ''}`);
      let score = 0;
      if (owner?.role === 'implementer') score += 40;
      if (owner?.role === 'fixer') score += 30;
      if (/\/work\//i.test(artifact.title || '')) score += 20;
      if (/\/fixes\//i.test(artifact.title || '')) score += 10;
      return { artifact, html, score, index };
    })
    .filter((candidate) => candidate.html);
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const best = candidates[0];
  if (!best) return null;
  // Bundle BEFORE renaming: the bundler resolves relative css/js refs against
  // the artifact title, so the "Preview · " prefix would break path resolution.
  const bundled = withBundledPreview(
    { ...best.artifact, kind: 'preview', preview: best.html, code: null },
    artifacts,
  );
  return { ...bundled, title: `Preview · ${best.artifact.title}` };
}

function extractHtmlDocument(raw) {
  const start = raw.search(/<!doctype\s+html[^>]*>|<html[\s>]/i);
  if (start < 0) return null;
  const fromStart = raw.slice(start);
  if (!/<body[\s>]/i.test(fromStart)) return null;
  const end = fromStart.search(/<\/html>/i);
  const document = end >= 0
    ? fromStart.slice(0, end + fromStart.match(/<\/html>/i)[0].length)
    : fromStart.replace(/`+\s*$/, '');
  return document.trim() || null;
}



const TRANSCRIPT_KIND_STYLE = {
  thinking: { icon: 'sparkle', color: 'var(--text-muted)' },
  status: { icon: 'wrench', color: 'var(--text-faint)' },
  response: { icon: 'clip', color: 'var(--text-muted)' },
  error: { icon: 'x', color: 'var(--bad)' },
};

// Live per-task activity feed: streams the runtime conversation transcript
// (thinking / tool status / errors) while the agent works, so a running stage
// shows WHAT the agent is doing instead of a bare "Working…" placeholder —
// and a failed one shows the actual error output, not just a red chip.
// `compact` drops the agent name + status from the header: inside a stage card
// the seat row directly above already shows both, so repeating them made one
// running stage read "running" three times.
function LiveTranscriptFeed({ activity, agents, compact }) {
  const scrollRef = useRef(null);
  const entries = activity?.transcript || [];
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries.length]);
  if (!activity) return null;
  const ag = agents[activity.agentId]
    || Object.values(agents).find((a) => a.agentId === activity.agentId)
    || agents.orchestrator;
  const running = activity.status === 'running';
  const failed = activity.status === 'failed';
  return (
    <div style={{ borderRadius: 'var(--r-sm)', border: `1px solid ${failed ? alpha('var(--bad)', 30) : 'var(--border)'}`,
      background: 'var(--surface-2)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: compact ? '4px 10px' : '6px 10px',
        borderBottom: '1px solid var(--border)' }}>
        {!compact && <Avatar agent={ag} size={18} ring={false} />}
        {!compact && <span style={{ fontSize: 11.5, fontWeight: 700, color: ag.color }}>{ag.displayName}</span>}
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{activity.runtime}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5,
          fontWeight: 700, color: failed ? 'var(--bad)' : running ? 'var(--run, var(--accent))' : 'var(--ok)' }}>
          {running && <Spinner size={9} color="var(--run, var(--accent))" />}
          {!compact && activity.status}
        </span>
      </div>
      <div ref={scrollRef} style={{ maxHeight: 150, overflowY: 'auto', padding: '7px 10px', display: 'grid', gap: 3 }}>
        {entries.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>
            {running ? 'Starting up — no output yet…' : 'No live output captured.'}
          </div>
        )}
        {entries.map((entry, index) => {
          const sty = TRANSCRIPT_KIND_STYLE[entry.kind] || TRANSCRIPT_KIND_STYLE.status;
          return (
            <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11.5,
              lineHeight: 1.45, color: sty.color }}>
              <Icon name={sty.icon} size={10} style={{ marginTop: 3, flexShrink: 0, color: sty.color }} />
              <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{entry.content}</span>
            </div>
          );
        })}
        {failed && activity.error && !entries.some((entry) => entry.kind === 'error') && (
          <div style={{ fontSize: 11.5, color: 'var(--bad)' }}>{activity.error}</div>
        )}
      </div>
    </div>
  );
}

// Per-stage card: as the workflow advances, each stage that starts gets its own
// card showing who's on it, live status, and the artifacts they produced. This
// is the "new stage → new card" timeline (not a tab/strip).
function StageCard({ stage, stageRun, artifacts, agents, liveActivity, records }) {
  const status = stageRun?.status || 'pending';
  const sty = STAGE_STATUS_STYLE[status] || STAGE_STATUS_STYLE.pending;
  const roles = new Set(
    stage.seats.filter((s) => s.ref.kind === 'role').map((s) => s.ref.role),
  );
  const explicitIds = new Set(stageRun?.artifactIds || []);
  const taskIds = new Set(stageRun?.taskIds || []);
  // Dispatch records carry the per-task artifact attribution (including real
  // workspace files, whose ids are path-keyed and never taskId-prefixed).
  const recordIds = new Set((records || [])
    .filter((record) => taskIds.has(record.taskId))
    .flatMap((record) => record.artifactIds || []));
  const stageArtifacts = artifacts.filter((a) =>
    explicitIds.has(a.id)
    || recordIds.has(a.id)
    || [...taskIds].some((taskId) => a.id.startsWith(`${taskId}_`))
    || roles.has(a.ownerAgentId),
  );
  const stageActivities = [...taskIds]
    .map((taskId) => ({ taskId, activity: liveActivity?.[taskId] }))
    .filter((item) => item.activity);
  return (
    <div className="rt-rise" style={{ marginTop: 10, border: `1px solid ${alpha(sty.color, 35)}`,
      borderRadius: 'var(--r-card)', background: 'var(--surface)', boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 13px',
        borderBottom: '1px solid var(--border)', background: alpha(sty.color, 6) }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, borderRadius: 6,
          background: alpha(sty.color, 16), color: sty.color }}>
          {status === 'active' ? <Spinner size={12} color={sty.color} />
            : status === 'done' ? <Icon name="check" size={13} />
            : <Icon name={stage.icon || 'layers'} size={13} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{stage.name}</div>
          {stage.desc && <div style={{ fontSize: 11, color: 'var(--text-faint)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stage.desc}</div>}
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: sty.color, padding: '2px 8px', borderRadius: 999,
          background: alpha(sty.color, 14) }}>{sty.label}</span>
      </div>
      <div style={{ padding: '10px 13px', display: 'grid', gap: 8 }}>
        {(stageRun?.seatRuns || []).map((seatRun, i) => {
          const role = stage.seats[i]?.ref?.kind === 'role' ? stage.seats[i].ref.role : 'user';
          const ag = agentForSeat(agents, seatRun.agentId, role);
          const ss = STAGE_STATUS_STYLE[seatRun.status] || STAGE_STATUS_STYLE.pending;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar agent={ag} size={22} ring={false} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: ag.color }}>{ag.displayName}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>@{ag.role || role}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 11, color: ss.color, fontWeight: 600 }}>
                {seatRun.status === 'active' ? <Spinner size={10} color={ss.color} />
                  : seatRun.status === 'done' ? <Icon name="check" size={11} /> : null}
                {ss.label}
              </span>
            </div>
          );
        })}
        {(status === 'active' || status === 'failed') && stageActivities.length > 0 && (
          <div style={{ display: 'grid', gap: 6 }}>
            {stageActivities.map(({ taskId, activity }) => (
              <LiveTranscriptFeed key={taskId} activity={activity} agents={agents} compact />
            ))}
          </div>
        )}
        {stageArtifacts.length > 0 && (
          <div style={{ display: 'grid', gap: 6, marginTop: 2 }}>
            {stageArtifacts.map((a) => (
              <ExpandableArtifact key={`${a.id}-${a.version}`} artifact={a} owner={agentForArtifact(a, agents)} />
            ))}
          </div>
        )}
        {status === 'active' && stageArtifacts.length === 0 && stageActivities.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>Working…</div>
        )}
      </div>
    </div>
  );
}

function LocalStopBar({ stopping, interruptError, onStop }) {
  return (
    <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
      border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--surface)',
      boxShadow: 'var(--shadow-card)' }}>
      <Spinner size={14} color="var(--run)" />
      <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-muted)' }}>
        {stopping ? 'Stopping — interrupting every active agent session…' : 'Agents are working on this run.'}
        {interruptError && (
          <span style={{ color: 'var(--bad)', marginLeft: 8 }}>{interruptError}</span>
        )}
      </div>
      <button onClick={onStop} disabled={stopping} title="Stop the run — interrupts every active agent session"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px',
          borderRadius: 'var(--r-sm)', border: 'none', cursor: stopping ? 'default' : 'pointer',
          background: stopping ? 'var(--surface-3)' : 'var(--bad)', color: stopping ? 'var(--text-faint)' : '#fff',
          font: 'inherit', fontSize: 12.5, fontWeight: 750, minHeight: 30, flexShrink: 0 }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: 'currentColor', display: 'inline-block' }} />
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  );
}

function LocalInterruptedCard({ turn, agents, artifacts, onResume, onDiscard, onHandoff }) {
  const plan = turn.result?.plan;
  const records = turn.result?.dispatch || [];
  const taskById = new Map((plan?.tasks || []).map((task) => [task.id, task]));
  const ownerFor = (task) => {
    if (task?.owner && agents[task.owner]) return agents[task.owner];
    const target = (task?.assignee || '').replace(/^@/, '');
    if (agents[target]) return agents[target];
    return Object.values(agents).find((a) => a.role === target && !a.pm) || agents.orchestrator;
  };
  // Interrupted runs die before DispatchRecords are folded into the turn, but
  // per-task status still lands in workflowRun.stageStates as each agent runs —
  // fall back to it so the summary doesn't claim "0 tasks ran" after real work.
  const stageStates = turn.result?.workflowRun?.stageStates || {};
  const stageToRecordStatus = { done: 'completed', failed: 'failed', running: 'running' };
  const ranSource = records.length > 0
    ? records
    : Object.entries(stageStates)
        .filter(([, state]) => stageToRecordStatus[state?.status])
        .map(([taskId, state]) => ({ taskId, status: stageToRecordStatus[state.status] }));
  const ranTasks = ranSource.map((record) => {
    const task = taskById.get(record.taskId);
    return {
      taskId: record.taskId,
      title: task?.title || record.taskId,
      owner: ownerFor(task),
      status: record.status,
    };
  });
  const notStarted = (plan?.tasks || []).filter((task) => !ranSource.some((r) => r.taskId === task.id));
  const quickAction = (label, icon, onClick, primary) => onClick && (
    <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 11px',
      borderRadius: 'var(--r-sm)', border: primary ? 'none' : '1px solid var(--border)', cursor: 'pointer',
      background: primary ? 'var(--accent)' : 'var(--surface)', color: primary ? '#fff' : 'var(--text)',
      font: 'inherit', fontSize: 12.5, fontWeight: 700, minHeight: 30 }}>
      <Icon name={icon} size={13} />{label}
    </button>
  );
  return (
    <div style={{ marginTop: 12, border: '1px solid var(--border)', borderLeft: '3px solid var(--warn)',
      borderRadius: 'var(--r-card)', background: 'var(--surface)', boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="pause" size={15} style={{ color: 'var(--warn)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 750, fontSize: 14, color: 'var(--text)' }}>Run interrupted</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
            {ranTasks.length} task{ranTasks.length === 1 ? '' : 's'} ran · {notStarted.length} not started · {artifacts.length} partial artifact{artifacts.length === 1 ? '' : 's'}
          </div>
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--warn)', padding: '3px 8px', borderRadius: 999,
          background: alpha('var(--warn)', 14), fontWeight: 750 }}>stopped by you</span>
      </div>
      <div style={{ padding: '10px 14px', display: 'grid', gap: 7 }}>
        {ranTasks.map((entry) => (
          <div key={entry.taskId} style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <Avatar agent={entry.owner} size={22} />
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{entry.taskId}</span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.title}
            </span>
            <span className="mono" style={{ fontSize: 10.5, color: entry.status === 'completed' ? 'var(--ok)' : 'var(--warn)' }}>
              {entry.status === 'completed' ? 'finished' : 'stopped mid-task'}
            </span>
          </div>
        ))}
        {notStarted.length > 0 && (
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            never started: {notStarted.map((task) => task.id).join(', ')}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px 13px', flexWrap: 'wrap', borderTop: '1px solid var(--border)' }}>
        {quickAction('Resume', 'play', onResume, true)}
        {quickAction('Discard partial', 'x', onDiscard, false)}
        {quickAction('Hand off to different agent', 'send', onHandoff, false)}
      </div>
    </div>
  );
}

// The stage timeline for one workflow-driven turn — renders a card per stage
// that has started, in workflow order. While the dispatch is still running the
// store only holds the initial all-pending projection, so we synthesize an
// "active" marker on the first unfinished stage to keep the run from looking
// frozen until completion.
function StageCards({ workflow, workflowRun, artifacts, agents, dispatchStatus, liveActivity, records }) {
  if (!workflow || !workflowRun) return null;
  const stages = workflow.stages.filter(
    (s) => {
      const status = workflowRun.stageStates?.[s.id]?.status || 'pending';
      return s.kind !== 'intake'
        && (s.seats?.length ?? 0) > 0
        && (s.kind !== 'repair' || status !== 'pending');
    },
  );
  const running = dispatchStatus === 'running';
  const firstUnfinishedId = stages.find(
    (s) => {
      const status = workflowRun.stageStates?.[s.id]?.status || 'pending';
      return status !== 'done' && status !== 'completed';
    },
  )?.id;

  const visible = stages.filter((s) => {
    const status = workflowRun.stageStates?.[s.id]?.status || 'pending';
    if (status !== 'pending') return true;
    return running && s.id === firstUnfinishedId;
  });
  if (visible.length === 0) return null;

  return (
    <div style={{ marginTop: 4 }}>
      {visible.map((stage) => {
        let stageRun = workflowRun.stageStates?.[stage.id];
        const status = stageRun?.status || 'pending';
        if (stageRun?.status === 'running') {
          stageRun = { ...stageRun, status: 'active' };
        } else if (running && status === 'pending' && stage.id === firstUnfinishedId) {
          stageRun = {
            ...(stageRun || {}),
            status: 'active',
            seatRuns: (stageRun?.seatRuns || stage.seats.map((seat) => ({
              agentId: seat.ref.kind === 'role' ? seat.ref.agentId ?? seat.ref.role : 'user',
              status: 'pending',
              artifactIds: [],
            }))).map((sr) => ({ ...sr, status: sr.status === 'done' ? 'done' : 'active' })),
          };
        }
        return (
          <StageCard
            key={stage.id}
            stage={stage}
            stageRun={stageRun}
            artifacts={artifacts}
            agents={agents}
            liveActivity={liveActivity}
            records={records}
          />
        );
      })}
    </div>
  );
}

function AgentChainCard({ plan, records, artifacts, agents, dispatchStatus, dispatchAdapter, dispatchError, workspacePath, liveActivity }) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const visibleRecords = Array.isArray(records) ? records : [];
  // Dispatch records only land once the whole run finishes; while agents are
  // still working the live conversation transcript is the only signal, so
  // stream it here instead of a static "waiting" line.
  const liveEntries = Object.entries(liveActivity || {})
    .filter(([taskId]) => !visibleRecords.some((record) => record.taskId === taskId));
  const statusColor = dispatchStatus === 'completed'
    ? 'var(--ok)'
    : dispatchStatus === 'failed'
      ? 'var(--bad)'
      : 'var(--run)';
  const ownerFor = (task, record) => {
    if (task?.owner && agents[task.owner]) return agents[task.owner];
    if (record?.agentId && agents[record.agentId]) return agents[record.agentId];
    const target = String(task?.assignee || record?.agentId || '').replace(/^@/, '');
    if (agents[target]) return agents[target];
    return Object.values(agents).find((agent) => agent.role === target && !agent.pm) || agents.orchestrator;
  };
  // Everything this task's agent produced or edited: records persisted after
  // per-task attribution landed carry explicit artifactIds; older records fall
  // back to the task-prefixed transcript artifact. Real workspace files sort
  // before this system's own run logs — the files are the deliverable.
  const artifactsFor = (record) => {
    const ids = new Set(record.artifactIds || []);
    const matched = ids.size > 0
      ? artifacts.filter((artifact) => ids.has(artifact.id))
      : artifacts.filter((artifact) => artifact.id.startsWith(`${record.taskId}_`));
    const isRunLog = (artifact) => (artifact.title || '').startsWith('.roundtable/runs/') ? 1 : 0;
    return [...matched].sort((a, b) => isRunLog(a) - isRunLog(b));
  };

  return (
    <div style={{ marginTop: 6, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: statusColor, fontSize: 12.5, fontWeight: 700 }}>
        {dispatchStatus === 'running' ? <Spinner size={12} color={statusColor} /> : <Icon name={dispatchStatus === 'failed' ? 'x' : 'check'} size={13} />}
        <span>{dispatchStatus === 'completed' ? 'run complete' : dispatchStatus === 'failed' ? 'run failed' : 'running'}</span>
        {dispatchAdapter && <span className="mono" style={{ color: 'var(--text-faint)', fontWeight: 500 }}>via {dispatchAdapter}</span>}
      </div>
      {liveEntries.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {liveEntries.map(([taskId, activity]) => (
            <LiveTranscriptFeed key={taskId} activity={activity} agents={agents} />
          ))}
        </div>
      )}
      {visibleRecords.length === 0 ? (
        liveEntries.length === 0 && (
          dispatchStatus === 'failed' && dispatchError
            ? <div className="mono" style={{ fontSize: 12.5, color: 'var(--bad)' }}>{dispatchError}</div>
            : <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Waiting for the first agent output.</div>
        )
      ) : visibleRecords.map((record) => {
        const task = taskById.get(record.taskId);
        const owner = ownerFor(task, record);
        const taskArtifacts = artifactsFor(record);
        return (
          <div key={record.taskId} style={{ borderLeft: `2px solid ${alpha(owner.color, 60)}`, paddingLeft: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Avatar agent={owner} size={24} ring={false} />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{owner.displayName}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>@{owner.mention || owner.agentId || owner.role}</span>
              {taskArtifacts.length > 1 && (
                <span className="mono tnum" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                  {taskArtifacts.length} files
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: record.status === 'failed' ? 'var(--bad)' : 'var(--ok)', fontWeight: 700 }}>
                {record.status}
              </span>
            </div>
            {task?.title && (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: taskArtifacts.length > 0 ? 8 : 0 }}>{task.title}</div>
            )}
            {taskArtifacts.length > 0 ? (
              <div style={{ display: 'grid', gap: 6 }}>
                {taskArtifacts.map((artifact) => (
                  <ExpandableArtifact key={`${artifact.id}-${artifact.version}`} artifact={artifact} owner={owner} />
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>No output captured.</div>
            )}
          </div>
        );
      })}
      {workspacePath && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          workspace: {workspacePath}
        </div>
      )}
    </div>
  );
}

// +N/−N line-change badge for one artifact version — who touched a file is only
// half the audit trail; this is the "how much" half.
function ChangeBadge({ change }) {
  if (!change || (!change.added && !change.removed)) return null;
  return (
    <span className="mono tnum" style={{ display: 'inline-flex', gap: 5, fontSize: 10.5, fontWeight: 700, flexShrink: 0 }}>
      {change.added > 0 && <span style={{ color: 'var(--ok)' }}>+{change.added}</span>}
      {change.removed > 0 && <span style={{ color: 'var(--bad)' }}>−{change.removed}</span>}
    </span>
  );
}

// One agent's deliverable, click to expand and read what they actually produced
// — turns the result list from a black box into reviewable output. The header
// is the attribution row: avatar + file path + version + line delta + @owner.
function ExpandableArtifact({ artifact, owner }) {
  const [open, setOpen] = useState(false);
  const content = artifact.preview || '';
  const isHtml = artifact.kind === 'html' || artifact.kind === 'preview';
  return (
    <div style={{ borderRadius: 'var(--r-sm)', background: tint(owner.color, 7),
      border: `1px solid ${alpha(owner.color, 22)}`, overflow: 'hidden' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: '100%', display: 'grid',
        gridTemplateColumns: 'auto auto auto 1fr auto auto auto', gap: 9, alignItems: 'center', padding: '8px 10px',
        background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
        <Icon name={open ? 'chevdown' : 'chevron'} size={12} style={{ color: owner.color }} />
        <Avatar agent={owner} size={20} ring={false} />
        <Icon name={artifact.kind === 'preview' ? 'eye' : artifact.kind === 'markdown' ? 'clip' : 'code'} size={14}
          style={{ color: owner.color }} />
        <span className="mono" style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.title}</span>
        {artifact.version > 1 && (
          <span className="mono tnum" style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 5,
            background: 'var(--surface-3)', color: 'var(--text-muted)', flexShrink: 0 }}>v{artifact.version}</span>
        )}
        <ChangeBadge change={artifact.change} />
        <span style={{ fontSize: 11, color: owner.color, fontWeight: 700 }}>@{owner.role || artifact.ownerAgentId}</span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${alpha(owner.color, 22)}`, background: 'var(--bg)', padding: '10px 12px',
          maxHeight: 320, overflowY: 'auto' }}>
          {!content
            ? <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>No content captured for this artifact.</div>
            : isHtml
            ? <iframe title={artifact.title} srcDoc={content} sandbox="allow-scripts"
                style={{ width: '100%', height: 280, border: 'none', background: '#fff', borderRadius: 6 }} />
            : <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)' }}><Md text={content} /></div>}
        </div>
      )}
    </div>
  );
}

function LocalResultCard({ artifacts, dispatchStatus, dispatchAdapter, dispatchStage, dispatchError, workspacePath, previewArtifact, agents, mission, onDecideDelivery }) {
  const completed = dispatchStatus === 'completed';
  const codeCount = artifacts.filter((artifact) => artifact.kind === 'code').length;
  const reviewCount = artifacts.filter((artifact) => artifact.ownerAgentId === 'reviewer').length;
  const reportReady = mission?.finalDelivery?.status === 'ready';
  const accepted = mission?.finalDelivery?.status === 'accepted';
  const rejected = mission?.finalDelivery?.status === 'rejected';
  const confidence = mission?.finalDelivery?.confidence || 'unknown';
  const riskCount = mission?.finalDelivery?.risks?.length || 0;
  const statusColor = completed ? 'var(--ok)' : dispatchStatus === 'failed' ? 'var(--bad)' : 'var(--run)';
  return (
    <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
      background: 'var(--surface)', boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Icon name={completed ? 'check' : 'code'} size={15} style={{ color: statusColor }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 750, fontSize: 14, color: 'var(--text)' }}>
            {completed ? 'Delivery ready' : 'Delivery in progress'}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
            {artifacts.length} artifacts · {codeCount} code · {reviewCount} review · confidence={confidence} · tests={mission?.finalDelivery?.testsObserved ? 'observed' : 'missing'} · risks={riskCount} · delivery={reportReady ? mission.finalDelivery.recommendation : 'not_ready'} · adapter={dispatchAdapter || 'local-dispatch'} · next={dispatchStage || 'done'}
          </div>
        </div>
        <span style={{ fontSize: 11.5, color: statusColor, padding: '3px 8px', borderRadius: 999,
          background: alpha(statusColor, 14), fontWeight: 750 }}>
          {dispatchStatus || 'not_started'}
        </span>
      </div>
      {reportReady && onDecideDelivery && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px',
          borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 180, fontSize: 12.5, color: 'var(--text-muted)' }}>
            Delivery is ready for acceptance.
          </span>
          <button onClick={() => onDecideDelivery('repair')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 11px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text-muted)', cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 700 }}>
            <Icon name="wrench" size={13} /> Request repair
          </button>
          <button onClick={() => onDecideDelivery('tests')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 11px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text-muted)', cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 700 }}>
            <Icon name="eye" size={13} /> Request tests
          </button>
          <button onClick={() => onDecideDelivery('accept')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 11px', borderRadius: 'var(--r-sm)', border: 'none', background: 'var(--ok)',
            color: '#fff', cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 700 }}>
            <Icon name="check" size={13} /> Accept delivery
          </button>
        </div>
      )}
      {(accepted || rejected) && (
        <div style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)',
          background: alpha(accepted ? 'var(--ok)' : 'var(--warn)', 10), color: accepted ? 'var(--ok)' : 'var(--warn)',
          fontSize: 12.5, fontWeight: 750 }}>
          {accepted ? 'Final delivery accepted.' : 'Repair requested for final delivery.'}
        </div>
      )}
      {dispatchStatus === 'failed' && dispatchError && (
        <div className="mono" style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          color: 'var(--bad)',
          background: 'color-mix(in oklab, var(--bad) 8%, var(--surface))',
          fontSize: 11.5,
          lineHeight: 1.45,
          overflowWrap: 'anywhere',
        }}>
          {dispatchError}
        </div>
      )}
      {previewArtifact && (
        <div style={{ background: 'var(--surface-3)', padding: 12 }}>
          <div style={{ borderRadius: 'var(--r-sm)', overflow: 'hidden', border: '1px solid var(--border)',
            background: '#fff', boxShadow: 'var(--shadow-card)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
              background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
              {['#e5687a', '#e6a23c', '#4cc38a'].map((color) => (
                <span key={color} style={{ width: 9, height: 9, borderRadius: '50%', background: color, opacity: .8 }} />
              ))}
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 6 }}>
                {previewArtifact.title}
              </span>
            </div>
            <iframe title={previewArtifact.title} srcDoc={previewArtifact.preview} sandbox="allow-scripts allow-forms allow-modals"
              style={{ width: '100%', height: 360, border: 'none', display: 'block', background: '#fff' }} />
          </div>
        </div>
      )}
      <div style={{ padding: '11px 14px', display: 'grid', gap: 8 }}>
        {artifacts.slice(0, 8).map((artifact) => (
          <ExpandableArtifact
            key={`${artifact.id}-${artifact.version}`}
            artifact={artifact}
            owner={agentForArtifact(artifact, agents)}
          />
        ))}
        {workspacePath && (
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>workspace: {workspacePath}</div>
        )}
      </div>
    </div>
  );
}

// #12: live TodoList — per-task status derived from approval + dispatch records,
// so one card transitions pending → running → done/failed in place as the run polls.
const TODO_STATUS_STYLE = {
  pending: { color: 'var(--text-faint)', label: 'pending', icon: null },
  running: { color: 'var(--run, var(--accent))', label: 'running', icon: 'spinner' },
  completed: { color: 'var(--ok)', label: 'done', icon: 'check' },
  failed: { color: 'var(--bad)', label: 'failed', icon: 'x' },
};

function conciseTaskTitle(task, owner) {
  const stage = task?.stageKind || task?.stageId;
  if (task?.role === 'pm') return 'Product direction';
  if (task?.role === 'architect') return stage === 'review' ? 'Architecture check' : 'Architecture direction';
  if (task?.role === 'implementer') return `Build · ${owner?.displayName || 'Implementer'}`;
  if (task?.role === 'reviewer') return 'Review the build';
  if (task?.role === 'fixer') return 'Apply review fixes';
  return String(task?.title || 'Assigned task').slice(0, 64);
}


function TodoRow({ task, owner, record, status, last, dependencyLabels, cliNumber }) {
  const [open, setOpen] = useState(false);
  const sty = TODO_STATUS_STYLE[status];
  const events = (record?.events || []).filter((e) => e.type === 'thinking_delta' || e.type === 'tool_use');
  const deps = Array.isArray(task?.deps) ? task.deps : [];
  const acceptanceCriteria = Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [];
  const assignee = task?.assignee || '@planner';
  const displayTitle = conciseTaskTitle(task, owner);
  const objective = planTaskObjective(task);
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <button onClick={() => setOpen((v) => !v)} title="Expand task activity"
        style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 0',
          background: 'none', border: 'none', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 18, height: 18, marginTop: 3,
          borderRadius: 5, flexShrink: 0, background: alpha(sty.color, status === 'pending' ? 8 : 16), color: sty.color }}>
          {sty.icon === 'spinner' ? <Spinner size={11} color={sty.color} />
            : sty.icon ? <Icon name={sty.icon} size={11} />
            : <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', opacity: .6 }} />}
        </span>
        <Avatar agent={owner} size={24} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 9.5, fontWeight: 750, color: 'var(--accent)',
              padding: '2px 5px', borderRadius: 5, background: alpha('var(--accent)', 10) }}>CLI {cliNumber}</span>
            <span style={{ fontSize: 13.5, fontWeight: 650,
              color: status === 'completed' ? 'var(--text-muted)' : 'var(--text)',
              textDecorationLine: status === 'completed' ? 'line-through' : 'none',
              textDecorationColor: alpha('var(--ok)', 50) }}>{displayTitle}</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.52, marginTop: 5 }}>
            {objective}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>
            {assignee}{task?.parallel ? ' · parallel' : ''}{deps.length ? ` · starts after ${deps.map((id) => dependencyLabels?.get(id) || id).join(' + ')}` : ' · ready after approval'}
          </div>
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: sty.color, padding: '2px 8px', borderRadius: 999,
          background: alpha(sty.color, 13), flexShrink: 0, marginTop: 3 }}>{sty.label}</span>
        <Icon name={open ? 'chevdown' : 'chevron'} size={11} style={{ color: 'var(--text-faint)', marginTop: 6, flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{ margin: '0 0 9px 28px', padding: '8px 11px', borderRadius: 'var(--r-sm)',
          background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 7 }}>
            {task.id}
          </div>
          {acceptanceCriteria.length > 0 && (
            <div style={{ marginBottom: events.length > 0 ? 8 : 0 }}>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase',
                letterSpacing: '.06em', marginBottom: 4 }}>Definition of done</div>
              {acceptanceCriteria.map((criterion, index) => (
                <div key={`${task.id}-criterion-${index}`} style={{ display: 'grid', gridTemplateColumns: '11px 1fr',
                  gap: 5, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  <span style={{ color: 'var(--ok)' }}>✓</span><span>{criterion}</span>
                </div>
              ))}
            </div>
          )}
          {events.length === 0
            ? acceptanceCriteria.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>
                {status === 'pending' ? 'Not started yet.' : 'No activity captured.'}</div>
            : events.slice(0, 6).map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12,
                  color: 'var(--text-muted)', padding: '2px 0' }}>
                  <Icon name={e.type === 'tool_use' ? 'wrench' : 'sparkle'} size={11}
                    style={{ color: 'var(--text-faint)', marginTop: 2, flexShrink: 0 }} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.type === 'tool_use' ? `${e.name}(${(e.input?.path || e.input?.title || '')})` : e.delta}
                  </span>
                </div>
              ))}
        </div>
      )}
    </div>
  );
}

function LocalPlanCard({ plan, intake, agents, serverConfirmed, approvalStatus, approving, approvalError, onApprove, dispatch, dispatchStatus }) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const safeIntake = intake || { intentType: 'build', risk: 'medium', clarity: 'medium' };
  const ownerFor = (task) => {
    if (task?.owner && agents[task.owner]) return agents[task.owner];
    const target = (task?.assignee || '@planning').replace(/^@/, '');
    if (agents[target]) return agents[target];
    return Object.values(agents).find((a) => a.role === target && !a.pm) || agents.orchestrator;
  };
  const dependencyLabels = new Map(tasks.map((task) => [task.id, conciseTaskTitle(task, ownerFor(task))]));
  const approved = approvalStatus === 'approved';
  const waitingForSave = !serverConfirmed;
  const recordFor = (taskId) => (dispatch || []).find((r) => r.taskId === taskId);
  const doneCount = tasks.filter((t) =>
    todoStatusFor(t, recordFor(t.id), approved, dispatchStatus) === 'completed').length;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--surface)',
      boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Icon name="layers" size={15} style={{ color: 'var(--accent)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            Plan
            <span className="mono tnum" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-faint)', marginLeft: 8 }}>
              {doneCount}/{tasks.length} done
            </span>
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
            intent={safeIntake.intentType} · risk={safeIntake.risk} · clarity={safeIntake.clarity}
          </div>
        </div>
        <span style={{ fontSize: 11.5, color: approved ? 'var(--ok)' : 'var(--warn)', padding: '3px 8px', borderRadius: 999,
          background: alpha(approved ? 'var(--ok)' : 'var(--warn)', 14), fontWeight: 700 }}>
          {approved ? 'approved' : 'awaiting approval'}
        </span>
        {!approved && (
          <button onClick={onApprove} disabled={approving || waitingForSave}
            title={waitingForSave ? 'Waiting for the plan to be saved before agents can start' : 'Approve this plan and start the agents'}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '7px 13px', borderRadius: 'var(--r-sm)', border: 'none',
              cursor: approving || waitingForSave ? 'default' : 'pointer', background: approving || waitingForSave ? 'var(--surface-3)' : 'var(--accent)',
              color: approving || waitingForSave ? 'var(--text-faint)' : '#fff', font: 'inherit', fontSize: 12.5,
              fontWeight: 700, minHeight: 30, flexShrink: 0 }}>
            {approving
              ? <><Spinner size={13} color="var(--text-faint)" /> Starting…</>
              : waitingForSave
                ? <><Spinner size={13} color="var(--text-faint)" /> Saving plan…</>
                : <><Icon name="play" size={13} /> Start building</>}
          </button>
        )}
      </div>
      {waitingForSave && (
        <div style={{ padding: '8px 14px', background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 12.5,
          borderBottom: '1px solid var(--border)' }}>
          Saving this plan before agent execution starts.
        </div>
      )}
      {approvalError && (
        <div style={{ padding: '8px 14px', background: alpha('var(--bad)', 10), color: 'var(--bad)', fontSize: 12.5,
          borderBottom: '1px solid var(--border)' }}>
          {approvalError}
        </div>
      )}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.5 }}>
        {planSummaryForDisplay(plan)}
      </div>
      <div style={{ padding: '4px 14px 6px' }}>
        {tasks.map((task, i) => {
          const record = recordFor(task.id);
          return (
            <TodoRow
              key={task.id}
              task={task}
              owner={ownerFor(task)}
              record={record}
              status={todoStatusFor(task, record, approved, dispatchStatus)}
              last={i === tasks.length - 1}
              dependencyLabels={dependencyLabels}
              cliNumber={i + 1}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ---- transport ------------------------------------------------------------ */

export {
  UserMsg,
  LiveTranscriptFeed,
  LocalLiveThread,
  LocalLiveTurn,
  ClarifyCard,
  LocalStopBar,
  LocalInterruptedCard,
  StageCard,
  StageCards,
  AgentChainCard,
  ExpandableArtifact,
  LocalResultCard,
  TodoRow,
  LocalPlanCard,
  STAGE_STATUS_STYLE,
  TODO_STATUS_STYLE,
};
