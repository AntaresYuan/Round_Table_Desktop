'use client';
/* ============================================================================
   Roundtable — stage-scene.jsx
   The roundtable "stage" surface: the Thread (table-view center transcript), the
   top-bar segmented control + TopBar, the now-dock with its live status and
   workflow recommendation. Extracted from app-root.jsx.
   ============================================================================ */

import React from 'react';
import { Avatar, Icon, alpha } from './primitives';
import { TodoListCard, HandoffCard, BreakoutChip, iconBtn } from './cards';
import { MessageGroup, Composer } from './chat';
import { WorkflowStrip } from './workflow';
import { EditHandoffModal } from './modals';
import { UserMsg } from './live-turn';
import { RT } from '../lib/rt';

const { useState, useEffect, useRef, useMemo } = React;

/* ---- Aggregate quick actions --------------------------------------------- */
function Aggregate({ beat, agents, onAction }) {
  const pm = agents.orchestrator;
  return (
    <div className="rt-rise" style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
      <Avatar agent={pm} size={26} ring={false} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <Icon name="check" size={15} style={{ color: 'var(--ok)' }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Round complete</span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13.5, marginBottom: 12, lineHeight: 1.55 }}>{beat.text}</div>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {beat.actions.map(a => (
            <button key={a.id} onClick={() => onAction(a.id)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px',
              borderRadius: 'var(--r-sm)', font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              border: a.kind === 'primary' ? 'none' : '1px solid var(--border)',
              background: a.kind === 'primary' ? 'var(--accent)' : 'var(--surface)',
              color: a.kind === 'primary' ? '#fff' : 'var(--text)', transition: 'all .15s ease' }}>
              <Icon name={a.icon} size={15} />{a.label}
              {a.badge && <span className="tnum" style={{ fontSize: 11, fontWeight: 700, minWidth: 16, height: 16,
                padding: '0 4px', borderRadius: 8, display: 'grid', placeItems: 'center',
                background: a.kind === 'primary' ? alpha('#fff', 25) : alpha('var(--warn)', 18),
                color: a.kind === 'primary' ? '#fff' : 'var(--warn)' }}>{a.badge}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Thread({ agents, scene, onOpenArtifact, onAction }) {
  const ref = useRef(null);
  const revealed = RT.SCRIPT.filter(b => b.at <= scene.clock);
  const [handoff, setHandoff] = useState(RT.HANDOFF);
  const [syncHandoffs, setSyncHandoffs] = useState([]);
  const [editingHandoff, setEditingHandoff] = useState(null); // { ho, onSave } | null
  const noticesByArtifact = useMemo(() => {
    const m = new Map();
    (RT.DEP_CHANGED_NOTICES || []).forEach(n => m.set(n.downstream.artifactId, n));
    return m;
  }, []);
  const reviewsByArtifact = useMemo(() => {
    const m = new Map();
    (RT.REVIEW_COMMENTS || []).forEach(c => {
      if (!m.has(c.artifactId)) m.set(c.artifactId, []);
      m.get(c.artifactId).push(c);
    });
    return m;
  }, []);
  const applyReviewFix = (comment) => {
    const art = Object.values(RT.ARTIFACTS).find(a => a.id === comment.artifactId);
    const fixer = agents[comment.author] || agents.vera;
    const prefill = {
      ...handoff,
      id: `ho-fix-${comment.id}`,
      to: `@fixer`,
      scenario: 'agent_handoff',
      taskBrief:
        `Apply ${fixer?.displayName || comment.author}'s review note ` +
        `on ${art?.title || comment.artifactId}` +
        (comment.line !== undefined ? `:${comment.line}` : '') +
        `:\n\n${comment.body}\n\n` +
        `Edit the file in place — multi-author diff lines will tint by author.`,
    };
    setEditingHandoff({
      ho: prefill,
      onSave: (next) =>
        setSyncHandoffs((prev) => {
          const without = prev.filter((p) => p.id !== next.id);
          return [...without, next];
        }),
    });
  };
  const openEditDispatch = () =>
    setEditingHandoff({ ho: handoff, onSave: (next) => setHandoff(next) });
  const askSync = (notice) => {
    const owner = agents[notice.upstream.ownerAgentId];
    const prefill = {
      ...handoff,
      id: `ho-sync-${notice.upstream.artifactId}-${notice.upstream.toVersion}`,
      to: `@${owner?.role || notice.upstream.ownerAgentId}`,
      scenario: 'agent_handoff',
      taskBrief:
        `Sync ${notice.downstream.title || notice.downstream.artifactId} ` +
        `after ${notice.upstream.title || notice.upstream.artifactId} bumped ` +
        `v${notice.upstream.fromVersion}→v${notice.upstream.toVersion} ` +
        `(${notice.kind}). Repair the downstream call site.`,
    };
    setEditingHandoff({
      ho: prefill,
      onSave: (next) =>
        setSyncHandoffs((prev) => {
          const without = prev.filter((p) => p.id !== next.id);
          return [...without, next];
        }),
    });
  };
  const plan = useMemo(() => {
    const tasks = RT.PLAN.tasks.map(t => ({ ...t }));
    RT.PLAN_TIMELINE.forEach(u => { if (u.at <= scene.clock) { const tk = tasks.find(x => x.id === u.id); if (tk) tk.status = u.status; } });
    return { ...RT.PLAN, tasks };
  }, [scene.clock]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [revealed.length, scene.clock >= RT.SCENE_DURATION]);

  // follow the live stream to the bottom while playing
  useEffect(() => {
    if (!scene.playing) return;
    const iv = setInterval(() => {
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, 160);
    return () => clearInterval(iv);
  }, [scene.playing]);

  return (
    <div ref={ref} id="thread-scroll" style={{ flex: 1, overflowY: 'auto', padding: '26px 26px 8px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--thread-gap)' }}>
        {revealed.map(b => {
          const live = scene.playing && scene.clock < b.at + (b.dur || 1400) + 300;
          if (b.kind === 'user') return <UserMsg key={b.id} text={b.text} />;
          if (b.kind === 'agent') return <MessageGroup key={b.id} beat={b} agents={agents} playing={live} onOpenArtifact={onOpenArtifact} noticesByArtifact={noticesByArtifact} onAskSync={askSync} reviewsByArtifact={reviewsByArtifact} onApplyFix={applyReviewFix} />;
          if (b.kind === 'plan') return <TodoListCard key={b.id} plan={plan} agents={agents} />;
          if (b.kind === 'handoff') return <HandoffCard key={b.id} ho={handoff} agents={agents} onEdit={openEditDispatch} />;
          if (b.kind === 'breakout') return <div key={b.id} className="rt-rise"><BreakoutChip data={b} agents={agents} /></div>;
          if (b.kind === 'aggregate') return <Aggregate key={b.id} beat={b} agents={agents} onAction={onAction} />;
          return null;
        })}
        {syncHandoffs.map((syncHo) => (
          <HandoffCard
            key={syncHo.id}
            ho={syncHo}
            agents={agents}
            onEdit={() =>
              setEditingHandoff({
                ho: syncHo,
                onSave: (next) =>
                  setSyncHandoffs((prev) =>
                    prev.map((p) => (p.id === syncHo.id ? next : p)),
                  ),
              })
            }
          />
        ))}
        <div style={{ height: 8 }} />
      </div>
      {editingHandoff && (
        <EditHandoffModal
          ho={editingHandoff.ho}
          onClose={() => setEditingHandoff(null)}
          onSave={editingHandoff.onSave}
        />
      )}
    </div>
  );
}
function MiniSeg({ value, options, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
      border: '1px solid var(--border)' }}>
      {options.map(o => (
        <button key={o.v} onClick={() => onChange(o.v)} title={o.label} style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 'calc(var(--r-sm) - 2px)',
          border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 500,
          background: value === o.v ? 'var(--surface)' : 'transparent',
          color: value === o.v ? 'var(--text)' : 'var(--text-muted)',
          boxShadow: value === o.v ? 'var(--shadow-card)' : 'none', transition: 'all .15s ease' }}>
          {o.icon && <Icon name={o.icon} size={14} />}{o.label}
        </button>
      ))}
    </div>
  );
}

/* ---- TopBar --------------------------------------------------------------- */
function AccountControl({ authStatus, user, onSignIn, onSignUp, onSignOut }) {
  const authed = authStatus === 'authenticated';
  const loading = authStatus === 'loading';
  const label = user?.email || user?.name || 'Account';

  if (authed) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0,
        padding: '4px 4px 4px 10px', borderRadius: 'var(--r-chip)', border: '1px solid var(--border)',
        background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
        <Icon name="at" size={14} />
        <span style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontSize: 12.5, fontWeight: 500 }}>{label}</span>
        <button onClick={onSignOut} title="Sign out" style={{ display: 'inline-grid', placeItems: 'center',
          width: 28, height: 26, borderRadius: 'calc(var(--r-sm) - 2px)', border: '1px solid var(--border)',
          background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <Icon name="door" size={14} />
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button onClick={onSignIn} disabled={loading} title="Sign in" style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px',
        borderRadius: 'var(--r-chip)', border: '1px solid var(--border)',
        background: 'var(--surface-2)', color: loading ? 'var(--text-faint)' : 'var(--text-muted)',
        font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: loading ? 'default' : 'pointer',
      }}>
        <Icon name="at" size={14} />{loading ? 'Checking...' : 'Sign in'}
      </button>
      <button onClick={onSignUp} disabled={loading} title="Create an account" style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px',
        borderRadius: 'var(--r-chip)', border: 'none',
        background: 'var(--accent)', color: '#fff',
        font: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: loading ? 'default' : 'pointer',
        opacity: loading ? .72 : 1,
      }}>
        <Icon name="plus" size={14} />Sign up
      </button>
    </div>
  );
}

function TopBar({ t, setTweak, view, setView, authStatus, user, onSignIn, onSignUp, onSignOut }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px', height: 54,
      borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
      <MiniSeg value={view} onChange={setView} options={[
        { v: 'roundtable', label: 'Roundtable', icon: 'layers' },
        { v: 'workflow', label: 'Workflow', icon: 'sparkle' }]} />
      <div style={{ flex: 1 }} />
      <a href="/agents" title="Agent CLI console" style={{ ...iconBtn, background: 'var(--surface-2)', color: 'var(--text-muted)', textDecoration: 'none' }}>
        <Icon name="code" size={16} />
      </a>
      <a href="/settings" title="Settings" style={{ ...iconBtn, background: 'var(--surface-2)', color: 'var(--text-muted)', textDecoration: 'none' }}>
        <Icon name="wrench" size={16} />
      </a>
      <AccountControl authStatus={authStatus} user={user} onSignIn={onSignIn} onSignUp={onSignUp} onSignOut={onSignOut} />
      <button onClick={() => setTweak('theme', t.theme === 'light' ? 'dark' : 'light')} title="Toggle theme"
        style={{ ...iconBtn, background: 'var(--surface-2)' }}>
        <Icon name={t.theme === 'light' ? 'moon' : 'sun'} size={16} />
      </button>
    </div>
  );
}
function recommendWorkflow(task, workflows, currentId) {
  const t = (task || '').toLowerCase();
  if (t.length < 4) return null;
  let pick = 'wf-fullstack';
  let reason = 'A full build → review → ship loop fits a feature like this.';
  if (/research|brief|spec|investigat|explore|compare|analy|gather|source|study|audit/.test(t)) {
    pick = 'wf-research'; reason = 'This reads like research — gather → synthesize → brief fits better.';
  } else if (/landing|marketing|convert|sign\s?up|wait\s?list|campaign|\bseo\b|hero|pricing page/.test(t)) {
    pick = 'wf-growth'; reason = 'This is a marketing page — brief → build → QA → launch fits better.';
  }
  const wf = (workflows || []).find((w) => w.id === pick);
  if (!wf || pick === currentId) return null;
  return { id: wf.id, name: wf.name, reason };
}

function Dock({ st, agents, scene, onAction, onOpenChat, onOpenWorkflow, onSend, liveStatus, rec, onUseWorkflow, onDismissRec, workflow, workflowRun }) {
  let dotColor = 'var(--text-faint)', body;
  if (st.decision) {
    const ag = agents[st.decision.agentId];
    dotColor = ag.color;
    body = (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5 }}>
          <span style={{ fontSize: 15 }}>✋</span>
          <b style={{ color: ag.color }}>{ag.displayName}</b> needs your call:&nbsp;
          <span>{st.decision.question}</span>
        </span>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {st.decision.options.map((o, i) => (
            <button key={o.id} onClick={() => onAction('decide:' + o.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 'var(--r-sm)', font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
              border: i === 0 ? 'none' : '1px solid var(--border)', background: i === 0 ? 'var(--accent)' : 'var(--surface)',
              color: i === 0 ? '#fff' : 'var(--text)' }}>
              {o.label}{o.hint && <span style={{ fontSize: 10, opacity: .8, fontWeight: 500 }}>{o.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  } else if (st.aggregate) {
    dotColor = 'var(--ok)';
    body = (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5 }}><b>Round complete</b> <span style={{ color: 'var(--text-faint)' }}>· 3 shipped · 1 nit</span></span>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {st.aggregate.actions.map((a) => (
            <button key={a.id} onClick={() => onAction(a.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 11px', borderRadius: 'var(--r-sm)', font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
              border: a.kind === 'primary' ? 'none' : '1px solid var(--border)',
              background: a.kind === 'primary' ? 'var(--accent)' : 'var(--surface)', color: a.kind === 'primary' ? '#fff' : 'var(--text)' }}>
              <Icon name={a.icon} size={13} />{a.label}
              {a.badge && <span className="tnum" style={{ fontSize: 10, fontWeight: 700, minWidth: 14, height: 14, padding: '0 3px',
                borderRadius: 7, display: 'grid', placeItems: 'center', background: a.kind === 'primary' ? 'rgba(255,255,255,.25)' : alpha('var(--warn)', 18),
                color: a.kind === 'primary' ? '#fff' : 'var(--warn)' }}>{a.badge}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  } else if (st.speech) {
    const a = agents[st.speech.agentId];
    dotColor = a.pm ? 'var(--pm)' : a.color;
    if (a.pm) {
      // quiet facilitator narration — show the actual line
      body = <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: 'var(--text-muted)' }}>
        <b style={{ color: 'var(--pm)' }}>{a.displayName}</b> · {st.speech.text || 'facilitating…'}</div>;
    } else {
      const verb = st.speech.mode === 'working' ? 'is working' : st.speech.mode === 'thinking' ? 'is thinking' : 'is speaking';
      body = <div style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}><b style={{ color: a.color }}>{a.displayName}</b> {verb}…</div>;
    }
  } else if (st.run?.phase === 'awaiting_approval') {
    dotColor = 'var(--ok)';
    body = (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, fontSize: 13.5 }}>
        <span><b>Plan ready</b> · assignments and prerequisites are now on the table</span>
        <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>Review the plan in Chat, then confirm to start the CLI agents.</span>
      </div>
    );
  } else {
    body = (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, fontSize: 13.5 }}>
        <span>{liveStatus === 'pending' ? 'Drafting the plan…' : !st.started ? 'Ready to begin' : 'The table is quiet'}</span>
        {!st.started && (
          <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>create a task or message the table</span>
        )}
      </div>
    );
  }
  return (
    <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 22px 0' }}>
        <WorkflowStrip clock={scene.clock} onOpen={onOpenWorkflow} workflow={workflow} workflowRun={workflowRun} />
        <span style={{ flex: 1 }} />
      </div>
      {rec && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 22px 0', padding: '8px 12px',
          borderRadius: 'var(--r-sm)', border: `1px solid ${alpha('var(--accent)', 30)}`, background: alpha('var(--accent)', 8) }}>
          <Icon name="sparkle" size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45, minWidth: 0 }}>
            <span>This task fits <b>“{rec.name}”</b> better</span>
            <span style={{ color: 'var(--text-muted)' }}> — {rec.reason}</span>
          </div>
          <button onClick={() => onUseWorkflow && onUseWorkflow(rec.id)} style={{ flexShrink: 0, padding: '5px 12px', borderRadius: 'var(--r-sm)',
            border: 'none', background: 'var(--accent)', color: '#fff', font: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>Use it</button>
          <button onClick={() => onDismissRec && onDismissRec()} title="Dismiss" style={{ flexShrink: 0, display: 'grid', placeItems: 'center',
            width: 24, height: 24, borderRadius: 'var(--r-sm)', border: 'none', background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer' }}><Icon name="x" size={13} /></button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 22px 4px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0,
          boxShadow: st.speech ? `0 0 0 4px ${alpha(dotColor, 22)}` : 'none' }} />
        {body}
      </div>
      <Composer agents={agents} onSend={onSend || (() => scene.replay())} />
    </div>
  );
}


export { Thread, MiniSeg, TopBar, recommendWorkflow, Dock };
