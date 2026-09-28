/* ============================================================================
   Roundtable — roundtable.jsx
   A meeting ROOM. Two layouts:
     • stacked (default): framed whiteboard up top, round table below.
     • wide (both side rails collapsed): whiteboard LEFT (large), table RIGHT —
       fills the freed horizontal space instead of leaving it empty.
   Agents sit around the table as little 3D figures; the speaker lifts to talk.
   Scene state is derived deterministically from the clock.
   ============================================================================ */
import React from 'react';
import { RT } from '../lib/rt';
import { AgentMark, Icon, RoleTag, Spinner, tint, alpha } from './primitives';
const { useState, useEffect, useRef, useMemo } = React;

/* ---- layout presets ------------------------------------------------------ */
const LAYOUTS = {
  stacked: { W: 900, H: 848,
    WB:  { x: 400, y: 152, w: 556, h: 276 },
    TBL: { cx: 432, cy: 556, rx: 244, ry: 112, depth: 26 },
    SEAT_RX: 312, SEAT_RY: 158, DOOR: { x: 802, y: 174 } },
  wide: { W: 1800, H: 772,
    WB:  { x: 410, y: 386, w: 700, h: 486 },
    TBL: { cx: 1180, cy: 404, rx: 284, ry: 150, depth: 30 },
    SEAT_RX: 340, SEAT_RY: 214, DOOR: { x: 1690, y: 388 } },
};
let L = LAYOUTS.stacked;                    // current layout (set in RoundtableScene)

const d2r = (d) => (d * Math.PI) / 180;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

const SEATS_DEFAULT = [
  { key: 'pm', agentId: 'orchestrator', angle: 270, head: true },
  { key: 'user', user: true, angle: 90 },
];
// Distribute the workbench's real members around the table: PM at the head,
// You at the foot, everyone else split evenly across the two sides. No empty seat.
function buildSeats(memberIds) {
  const others = (memberIds || []).filter((id) => id !== 'orchestrator');
  const rightCount = Math.ceil(others.length / 2);
  const right = others.slice(0, rightCount);
  const left = others.slice(rightCount);
  const seats = [{ key: 'pm', agentId: 'orchestrator', angle: 270, head: true }];
  right.forEach((id, i) => seats.push({ key: id, agentId: id, angle: (270 + (i + 1) * (180 / (right.length + 1))) % 360 }));
  seats.push({ key: 'user', user: true, angle: 90 });
  left.forEach((id, i) => seats.push({ key: id, agentId: id, angle: (90 + (i + 1) * (180 / (left.length + 1))) % 360 }));
  return seats;
}
const seatPos = (angle) => {
  const r = d2r(angle);
  return {
    x: L.TBL.cx + L.SEAT_RX * Math.cos(r),
    y: L.TBL.cy + L.SEAT_RY * Math.sin(r),
    s: 0.82 + 0.26 * ((Math.sin(r) + 1) / 2),
  };
};

/* ---- derive the scene from the clock ------------------------------------- */
function sceneAt(clock) {
  const beats = RT.SCRIPT;
  const status = {};
  Object.keys(RT.AGENTS).forEach((id) => (status[id] = 'idle'));
  let active = null;
  beats.forEach((b) => {
    if (b.kind !== 'agent') return;
    const dur = b.dur || 2000;
    if (clock >= b.at + dur) status[b.agentId] = 'done';
    else if (clock >= b.at) {
      active = b;
      const p = (clock - b.at) / dur;
      const hasThink = b.events.some((e) => e.type === 'thinking_delta');
      const hasTool = b.events.some((e) => e.type === 'tool_use');
      status[b.agentId] = hasThink && p < 0.16 ? 'thinking' : hasTool && p < 0.6 ? 'working' : 'speaking';
    }
  });
  let speech = null;
  if (active) {
    const dur = active.dur || 2000;
    const p = (clock - active.at) / dur;
    const hasThink = active.events.some((e) => e.type === 'thinking_delta');
    const hasTool = active.events.some((e) => e.type === 'tool_use');
    const tStart = hasTool ? 0.6 : hasThink ? 0.16 : 0;
    const full = active.events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
    let mode = 'speaking', text = full;
    if (hasThink && p < 0.16) mode = 'thinking';
    else if (hasTool && p < 0.6) mode = 'working';
    else { const tp = clamp01((p - tStart) / (1 - tStart)); text = full.slice(0, Math.ceil(tp * full.length)); }
    speech = { agentId: active.agentId, mode, text, tool: active.events.find((e) => e.type === 'tool_use') };
  }
  const placed = [];
  beats.forEach((b) => {
    if (b.kind !== 'agent') return;
    const dur = b.dur || 2000;
    const aEv = b.events.find((e) => e.type === 'artifact');
    if (aEv && clock >= b.at + dur * 0.64) {
      const art = RT.ARTIFACTS[aEv.artifactId];
      if (art) placed.push({ art, ownerAgentId: b.agentId });
    }
  });
  const tasks = RT.PLAN.tasks.map((t) => ({ ...t }));
  RT.PLAN_TIMELINE.forEach((u) => { if (u.at <= clock) { const tk = tasks.find((x) => x.id === u.id); if (tk) tk.status = u.status; } });
  const bBeat = beats.find((b) => b.kind === 'breakout');
  const aggBeat = beats.find((b) => b.kind === 'aggregate');
  const dec = RT.DECISION;
  return {
    status, speech, active, placed, tasks,
    breakout: bBeat && clock >= bBeat.at ? bBeat : null,
    aggregate: aggBeat && clock >= aggBeat.at ? aggBeat : null,
    decision: dec && clock >= dec.at && clock < dec.until ? dec : null,
    planPosted: clock >= 2900,
    started: clock > 250,
  };
}

/* ---- live meeting notes -------------------------------------------------- */
const NOTE_BEATS = [
  { at: 700,   icon: 'layers', text: 'PM convened the table and planned 3 parallel tasks.' },
  { at: 2900,  icon: 'edit',   text: 'Plan sketched on the whiteboard.' },
  { at: 8580,  icon: 'code',   text: 'Beam shipped the waitlist API — route.ts (v1).' },
  { at: 8848,  icon: 'code',   text: 'Atlas scaffolded the landing page — page.tsx (v1).' },
  { at: 13800, icon: 'door',   text: 'Beam & Vera held a breakout on form validation.' },
  { at: 18696, icon: 'eye',    text: 'Vera approved with one accessibility nit (diff v2).' },
  { at: 22400, icon: 'check',  text: 'Round complete — 3 artifacts shipped.' },
];
function meetingNotes(clock) {
  return NOTE_BEATS.filter((n) => n.at <= clock).sort((a, b) => a.at - b.at).map((n) => {
    const s = Math.floor(n.at / 1000);
    return { ...n, time: `00:${String(s).padStart(2, '0')}` };
  });
}

/* ---- Stage : scale the fixed room to fit --------------------------------- */
function RoomStage({ w, h, children }) {
  const wrapRef = useRef(null);
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  useEffect(() => {
    const el = wrapRef.current;
    const fit = () => {
      const cw = el.clientWidth, ch = el.clientHeight;
      const s = Math.min(cw / w, ch / h);
      setT({ s, x: (cw - w * s) / 2, y: (ch - h * s) / 2 });
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);
  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden',
      background: 'radial-gradient(120% 85% at 50% 0%, color-mix(in oklab, var(--surface) 32%, transparent), transparent 58%), linear-gradient(180deg, color-mix(in oklab, var(--surface) 45%, var(--bg)) 0%, var(--bg) 52%, color-mix(in oklab, var(--bg) 90%, #000 3%) 100%)' }}>
      <div style={{ position: 'absolute', width: w, height: h, left: 0, top: 0,
        transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, transformOrigin: '0 0' }}>
        {children}
      </div>
    </div>
  );
}

/* ---- Whiteboard : the live ARCHITECTURE SKETCH the team draws ------------ */
/* What a team actually sketches on a meeting board: the system they're
   building. Nodes light up as each piece ships. */
function ArchNode({ x, y, w, h, owner, title, sub, done, big }) {
  const c = owner ? owner.color : 'var(--text-faint)';
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: big ? 13 : 10,
      border: `${big ? 2 : 1.6}px ${done ? 'solid' : 'dashed'} ${done ? c : 'var(--border-strong)'}`,
      background: done ? tint(c, 9) : 'var(--surface)', padding: big ? '0 16px' : '0 12px',
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      boxShadow: done ? `0 2px 10px -4px ${alpha(c, 40)}` : 'none', transition: 'all .3s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {done ? <span style={{ width: big ? 16 : 15, height: big ? 16 : 15, borderRadius: '50%', background: c, flexShrink: 0,
          display: 'grid', placeItems: 'center' }}><Icon name="check" size={big ? 11 : 10} style={{ color: '#fff' }} /></span>
          : <span style={{ width: big ? 14 : 13, height: big ? 14 : 13, borderRadius: '50%', border: '1.5px solid var(--border-strong)', flexShrink: 0 }} />}
        <span style={{ fontSize: big ? 15 : 14.5, fontWeight: 700, color: done ? c : 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      </div>
      {sub && <div className="mono" style={{ fontSize: big ? 12 : 11.5, color: 'var(--text-faint)', marginTop: 4,
        marginLeft: big ? 23 : 22, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
    </div>
  );
}
function LiveRunBoard({ tasks, agents, w, h, big, run }) {
  const rows = uniqueTasksById(tasks || []).slice(0, 5);
  const ownerFor = (task) => {
    if (task.owner && agents[task.owner]) return agents[task.owner];
    const role = String(task.assignee || '').replace(/^@/, '');
    return Object.values(agents).find((a) => a.role === role && !a.pm) || agents.orchestrator;
  };
  const pending = run?.phase === 'planning';
  const completed = run?.phase === 'completed' || run?.dispatchStatus === 'completed';
  const running = run?.dispatchStatus === 'running' || run?.phase === 'running' || run?.phase === 'approved';
  const statusColor = completed ? 'var(--ok)' : 'var(--run)';
  const statusText = pending
    ? 'starting agent chain'
    : completed
    ? `result ready · ${run?.artifactCount || 0} artifacts`
    : 'dispatching agents';
  const stages = [
    { id: 'request', label: 'Request', state: 'done' },
    { id: 'plan', label: 'Planning', state: pending ? 'active' : 'done' },
    { id: 'handoff', label: 'Handoff', state: completed ? 'done' : running ? 'active' : 'todo' },
    { id: 'dispatch', label: 'Agents', state: completed ? 'done' : running ? 'active' : 'todo' },
    { id: 'work', label: 'Result', state: completed ? 'done' : 'todo' },
  ];
  return (
    <div style={{ position: 'absolute', top: 44, left: 20, width: w - 40, height: h - 62,
      display: 'grid', gridTemplateRows: 'auto auto 1fr', gap: big ? 13 : 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: statusColor,
          animation: !completed ? 'rt-pulse-ring 1.4s ease-out infinite' : 'none' }} />
        <span style={{ fontSize: big ? 16 : 13.5, fontWeight: 800, color: 'var(--text)' }}>Run board</span>
        <span className="mono" style={{ fontSize: big ? 11 : 9.5, color: statusColor, fontWeight: 700 }}>{statusText}</span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: big ? 10.5 : 9, color: 'var(--text-faint)' }}>{rows.length} queued tasks</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: big ? 8 : 5 }}>
        {stages.map((stage) => {
          const color = stage.state === 'done' ? 'var(--ok)' : stage.state === 'active' ? 'var(--run)' : stage.state === 'blocked' ? 'var(--warn)' : 'var(--text-faint)';
          return (
            <div key={stage.id} style={{ minWidth: 0, padding: big ? '8px 9px' : '6px 7px', borderRadius: 8,
              background: alpha(color, stage.state === 'todo' ? 6 : 12), border: `1px solid ${alpha(color, 28)}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color,
                  animation: stage.state === 'active' ? 'rt-blink 1s ease-in-out infinite' : 'none' }} />
                <span style={{ fontSize: big ? 11.5 : 9.5, fontWeight: 700, color, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stage.label}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.05fr .95fr', gap: big ? 12 : 8, minHeight: 0 }}>
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', gap: 7, minWidth: 0 }}>
          <div style={{ padding: big ? '10px 12px' : '8px 10px', borderRadius: 9, background: 'var(--surface)',
            border: '1px solid var(--border)' }}>
            <div style={{ fontSize: big ? 12 : 10.5, color: 'var(--text-faint)', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '.08em' }}>What this board means</div>
            <div style={{ marginTop: 4, fontSize: big ? 13.5 : 11.5, color: 'var(--text)', lineHeight: 1.35 }}>
              {pending
                ? 'Planning is running first. Its output becomes the handoff for the next agent.'
                : completed
                ? 'Agents finished the run. Open Files or Code/logs to inspect the website, code, and review output.'
                : 'Each agent receives the previous agent output and continues the chain.'}
            </div>
          </div>
          <div style={{ display: 'grid', gap: big ? 8 : 5, alignContent: 'start', minHeight: 0 }}>
            {rows.length === 0 && (
              <div style={{ padding: big ? '13px 12px' : '10px 9px', borderRadius: 8, border: '1px dashed var(--border-strong)',
                background: 'var(--surface)', color: 'var(--text-faint)', fontSize: big ? 12.5 : 10.5 }}>
                Waiting for the first agent output.
              </div>
            )}
            {rows.map((task) => {
              const owner = ownerFor(task);
              return (
                <div key={task.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 7, alignItems: 'center',
                  padding: big ? '8px 10px' : '6px 8px', borderRadius: 8, background: tint(owner.color, 7),
                  border: `1px solid ${alpha(owner.color, 24)}` }}>
                  <span className="mono" style={{ fontSize: big ? 10.5 : 9, color: owner.color, fontWeight: 800 }}>{task.id}</span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontSize: big ? 12.5 : 10.5, color: 'var(--text)', fontWeight: 650 }}>{task.title}</span>
                  <span className="mono" style={{ fontSize: big ? 10 : 8.5, color: 'var(--text-faint)' }}>{owner.displayName}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'grid', gap: big ? 8 : 6, alignContent: 'start' }}>
          {Object.values(agents).filter((agent) => !agent.pm).slice(0, 4).map((agent) => {
            const count = rows.filter((task) => ownerFor(task).agentId === agent.agentId).length;
            return (
              <div key={agent.agentId} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 7,
                padding: big ? '8px 10px' : '6px 8px', borderRadius: 8, background: 'var(--surface)',
                border: `1px solid ${alpha(agent.color, count ? 35 : 16)}` }}>
                <span style={{ width: big ? 10 : 8, height: big ? 10 : 8, borderRadius: '50%',
                  background: count ? agent.color : 'var(--text-faint)',
                  animation: count && running ? 'rt-blink 1.3s ease-in-out infinite' : 'none' }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontSize: big ? 12.5 : 10.5, fontWeight: 700, color: 'var(--text)' }}>{agent.displayName}</span>
                <span className="mono" style={{ fontSize: big ? 10 : 8.5, color: count ? agent.color : 'var(--text-faint)' }}>
                  {count ? (completed ? `${count} done` : `${count} queued`) : 'no task'}
                </span>
              </div>
            );
          })}
          <div style={{ padding: big ? '9px 10px' : '7px 8px', borderRadius: 8, background: alpha('var(--warn)', 9),
            border: `1px solid ${alpha('var(--warn)', 28)}`, color: 'var(--text-muted)', fontSize: big ? 11.5 : 9.5, lineHeight: 1.35 }}>
            Code/logs are opened from the table button. This board is only the live run map.
          </div>
        </div>
      </div>
    </div>
  );
}
function WhiteboardSurface({ tasks, agents, posted, w, h, big, live, run }) {
  const t = (id) => tasks.find((x) => x.id === id);
  const landingDone = t('T1') && t('T1').status === 'completed';
  const apiDone = t('T2') && t('T2').status === 'completed';
  const DW = w - 40, DH = h - 64;
  const nodeW = Math.min(big ? 360 : 300, DW * 0.47);
  const nodeH = big ? 72 : 70;
  const dbW = Math.min(big ? 380 : 320, DW * 0.54);
  const land = { x: 2, y: 4, w: nodeW, h: nodeH };
  const api = { x: DW - nodeW - 2, y: 4, w: nodeW, h: nodeH };
  const db = { x: (DW - dbW) / 2, y: DH - nodeH - 4, w: dbW, h: nodeH };
  const cx = (b) => b.x + b.w / 2;
  const labelStyle = {
    fontSize: big ? 12 : 10,
    fontFamily: 'var(--font-mono)',
    paintOrder: 'stroke',
    stroke: 'var(--surface)',
    strokeWidth: 5,
    strokeLinejoin: 'round',
  };
  return (
    <>
      <div style={{ position: 'absolute', top: 16, left: 22, right: 64, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Icon name="layers" size={big ? 16 : 14} style={{ color: 'var(--text-faint)' }} />
        <span className="mono" style={{ fontSize: big ? 12 : 10.5, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
          {live ? 'Workflow board' : 'Architecture'}</span>
        <span style={{ fontSize: big ? 14 : 12, fontWeight: 600, color: 'var(--text-muted)' }}>· {live ? 'current run' : 'waitlist app'}</span>
        <span style={{ flex: 1 }} />
        {posted && <span className="mono" style={{ fontSize: big ? 11 : 9.5, color: 'var(--text-faint)' }}>{live ? 'state map' : 'data flow →'}</span>}
      </div>
      {posted && live ? <LiveRunBoard tasks={tasks} agents={agents} w={w} h={h} big={big} run={run} /> : (
      <div style={{ position: 'absolute', top: 46, left: 20, width: DW, height: DH }}>
        {!posted ? (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--text-faint)', fontStyle: 'italic' }}>the team will sketch the system here…</span>
          </div>
        ) : (
          <>
            <svg width={DW} height={DH} className="rt-fade" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
              <defs><marker id="wbar" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">
                <path d="M0 0 L8 4.5 L0 9 z" fill="var(--text-faint)" /></marker></defs>
              {/* Landing → API (submit) */}
              <line x1={land.x + land.w} y1={land.y + land.h / 2} x2={api.x - 4} y2={api.y + api.h / 2}
                stroke="var(--text-faint)" strokeWidth="1.8" markerEnd="url(#wbar)" opacity={landingDone ? '.7' : '.3'} />
              {/* API → DB (insert) */}
              <line x1={cx(api)} y1={api.y + api.h} x2={cx(db) + 8} y2={db.y - 4}
                stroke="var(--text-faint)" strokeWidth="1.8" markerEnd="url(#wbar)" opacity={apiDone ? '.7' : '.3'} />
              <text x={(land.x + land.w + api.x) / 2} y={land.y + land.h + 18} textAnchor="middle"
                fill="var(--text-faint)" style={labelStyle}>submit</text>
              <text x={(cx(api) + cx(db)) / 2 + 14} y={(api.y + api.h + db.y) / 2} textAnchor="middle"
                fill="var(--text-faint)" style={labelStyle}>insert</text>
            </svg>
            <ArchNode {...land} owner={agents.atlas} title="Landing page" sub="page.tsx · email · size" done={landingDone} big={big} />
            <ArchNode {...api} owner={agents.beam} title="POST /api/waitlist" sub="route.ts · zod validate" done={apiDone} big={big} />
            <ArchNode {...db} owner={null} title="Postgres" sub={apiDone ? 'waitlist · persists rows' : 'waitlist table'} done={apiDone} big={big} />
          </>
        )}
      </div>
      )}
    </>
  );
}
/* a real conference-room board: aluminium frame, sheen, marker tray. */
function BoardFrame({ w, h, posted, tasks, agents, big, children }) {
  return (
    <>
      {/* wall cast shadow */}
      <div style={{ position: 'absolute', inset: '-3% -1.5% -8% -1.5%', borderRadius: 20,
        background: 'rgba(0,0,0,.20)', filter: 'blur(24px)', opacity: .55 }} />
      {/* aluminium frame */}
      <div style={{ position: 'absolute', inset: 0, borderRadius: 15, padding: 11,
        background: 'linear-gradient(152deg, color-mix(in oklab, var(--surface-3) 70%, #fff 30%), var(--border-strong) 54%, var(--surface-2))',
        boxShadow: '0 26px 54px -30px rgba(0,0,0,.55), inset 0 1.5px 0 color-mix(in oklab,#fff 55%,transparent), inset 0 -1.5px 0 rgba(0,0,0,.18)' }}>
        {/* writing surface */}
        <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 7, overflow: 'hidden',
          background: 'linear-gradient(180deg, color-mix(in oklab, var(--surface) 84%, #fff 16%), var(--surface) 70%)',
          boxShadow: 'inset 0 2px 7px rgba(0,0,0,.09), inset 0 0 0 1px color-mix(in oklab, var(--border) 60%, transparent)' }}>
          {/* faint dot grid */}
          <div style={{ position: 'absolute', inset: 0, opacity: .5, pointerEvents: 'none',
            backgroundImage: 'radial-gradient(color-mix(in oklab, var(--text-faint) 26%, transparent) 1px, transparent 1px)',
            backgroundSize: '22px 22px' }} />
          {/* diagonal sheen */}
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
            background: 'linear-gradient(118deg, transparent 34%, color-mix(in oklab,#fff 16%,transparent) 45%, transparent 54%)' }} />
          {children}
        </div>
      </div>
      {/* marker tray */}
      <div style={{ position: 'absolute', left: '50%', bottom: -9, transform: 'translateX(-50%)', width: '42%', height: 14,
        borderRadius: '0 0 7px 7px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
        background: 'linear-gradient(180deg, var(--border-strong), var(--surface-3))',
        boxShadow: '0 8px 12px -7px rgba(0,0,0,.45), inset 0 1px 0 color-mix(in oklab,#fff 35%,transparent)' }}>
        {['#e5687a', '#5eb0ef', '#4cc38a'].map((c) => (
          <span key={c} style={{ width: 28, height: 6, borderRadius: 3, marginTop: -5, background: c,
            boxShadow: '0 1px 2px rgba(0,0,0,.3)' }} />
        ))}
        <span style={{ width: 20, height: 9, borderRadius: 2, marginTop: -5, background: 'var(--text-faint)', opacity: .8 }} />
      </div>
    </>
  );
}
function Whiteboard({ tasks, agents, posted, onZoom, big, live, run }) {
  const b = L.WB;
  return (
    <div style={{ position: 'absolute', left: b.x - b.w / 2, top: b.y - b.h / 2, width: b.w, height: b.h, zIndex: 6 }}>
      <BoardFrame w={b.w} h={b.h}>
        <WhiteboardSurface tasks={tasks} agents={agents} posted={posted} w={b.w - 22} h={b.h - 22} big={big} live={live} run={run} />
      </BoardFrame>
      <button onClick={onZoom} title="Open whiteboard" style={{ position: 'absolute', top: 18, right: 18, zIndex: 5,
        display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 7, cursor: 'pointer',
        border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)' }}>
        <Icon name="expand" size={14} />
      </button>
    </div>
  );
}

/* ---- contribution beam (active speaker only) + breakout arc -------------- */
// Maps a task to the seat of the agent that owns it, so dependency arrows can be
// drawn between real seats. Mirrors the owner resolution used elsewhere.
function seatForTask(task, seats, agents) {
  const direct = task?.owner && seats.find((s) => s.agentId === task.owner);
  if (direct) return direct;
  const role = String(task?.assignee || '').replace(/^@/, '');
  const byRole = Object.values(agents).find((a) => a.role === role && !a.pm);
  return byRole ? seats.find((s) => s.agentId === byRole.agentId) : null;
}

// Dependency arrows: when a task is done, draw an arrow from its agent's seat to
// each of its dependencies' seats — "I depend on you" (Vera → Atlas). They appear
// progressively as tasks complete, building up the real dependency graph on the
// table. This is a static relationship, not an upstream→downstream flow.
function DependencyArrows({ scene, agents, seats }) {
  const tasks = uniqueTasksById(scene.tasks || []);
  if (tasks.length === 0) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const edges = [];
  for (const task of tasks) {
    if (task.status !== 'completed') continue; // only after this task is done
    const from = seatForTask(task, seats, agents);
    if (!from) continue;
    for (const depId of task.deps || []) {
      const dep = byId.get(depId);
      const to = seatForTask(dep, seats, agents);
      if (!to || to.angle === from.angle) continue;
      edges.push({ id: `${task.id}->${depId}`, from, to, color: (agents[task.owner] || {}).color || 'var(--accent)' });
    }
  }
  if (edges.length === 0) return null;
  return (
    <>
      {edges.map((e) => {
        const a = seatPos(e.from.angle), b = seatPos(e.to.angle);
        // Curve the arrow toward the table center so multiple edges fan out cleanly.
        const mx = (a.x + b.x) / 2 + (L.TBL.cx - (a.x + b.x) / 2) * 0.5;
        const my = (a.y + b.y) / 2 + (L.TBL.cy - (a.y + b.y) / 2) * 0.5;
        // Stop short of the target seat so the arrowhead sits beside it, not on it.
        const dx = b.x - mx, dy = b.y - my;
        const len = Math.hypot(dx, dy) || 1;
        const ex = b.x - (dx / len) * 26, ey = b.y - (dy / len) * 26;
        return (
          <path key={e.id} className="rt-fade" d={`M ${a.x} ${a.y} Q ${mx} ${my} ${ex} ${ey}`}
            fill="none" stroke={e.color} strokeWidth="2" strokeLinecap="round"
            markerEnd="url(#rt-dephead)" opacity=".7" />
        );
      })}
    </>
  );
}

function uniqueTasksById(tasks) {
  const byId = new Map();
  for (const task of tasks || []) byId.set(task.id, task);
  return [...byId.values()];
}

function Beams({ scene, agents, seats }) {
  const spk = scene.speech && (scene.speech.mode === 'working' || scene.speech.mode === 'speaking') ? scene.speech.agentId : null;
  const seat = spk && seats.find((s) => s.agentId === spk);
  let arc = null;
  if (scene.breakout) {
    const sa = seats.find((s) => s.agentId === scene.breakout.a), sb = seats.find((s) => s.agentId === scene.breakout.b);
    if (sa && sb) {
      const a = seatPos(sa.angle), b = seatPos(sb.angle);
      const mx = L.TBL.cx + 150, my = (a.y + b.y) / 2;
      arc = `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
    }
  }
  return (
    <svg width={L.W} height={L.H} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20 }}>
      <defs>
        <marker id="rt-dephead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"
          markerUnits="userSpaceOnUse">
          <path d="M0 0 L7 4 L0 8 z" fill="var(--text-muted)" />
        </marker>
      </defs>
      {seat && (() => { const p = seatPos(seat.angle); return (
        <line x1={p.x} y1={p.y} x2={L.TBL.cx} y2={L.TBL.cy} stroke={agents[spk].color} strokeWidth="2"
          strokeLinecap="round" strokeDasharray="1 9" opacity=".4" style={{ animation: 'rt-dash 1.1s linear infinite' }} />
      ); })()}
      {arc && <path d={arc} fill="none" stroke="var(--text-faint)" strokeWidth="1.4" strokeDasharray="4 6" opacity=".55" />}
      <DependencyArrows scene={scene} agents={agents} seats={seats} />
    </svg>
  );
}

/* ---- the table ----------------------------------------------------------- */
function TableBody() {
  const T = L.TBL;
  const E = (cy, extra) => ({ position: 'absolute', left: T.cx - T.rx, top: cy - T.ry,
    width: T.rx * 2, height: T.ry * 2, borderRadius: '50%', ...extra });
  return (
    <>
      <div style={E(T.cy + T.depth + 24, { filter: 'blur(26px)',
        background: 'radial-gradient(closest-side, rgba(0,0,0,.26), transparent 72%)', opacity: .5 })} />
      <div style={E(T.cy + T.depth, { background: 'color-mix(in oklab, var(--surface-3) 60%, #000 6%)' })} />
      <div style={E(T.cy, {
        background: 'radial-gradient(120% 120% at 50% 28%, color-mix(in oklab, var(--surface) 92%, #fff 8%), var(--surface-2))',
        boxShadow: 'inset 0 2px 10px color-mix(in oklab, var(--text) 8%, transparent), inset 0 -18px 36px -22px rgba(0,0,0,.4)',
        border: '1px solid var(--border)' })} />
      <div style={E(T.cy, { transform: 'scale(.74)', transformOrigin: 'center',
        border: '1px dashed color-mix(in oklab, var(--text-faint) 45%, transparent)', opacity: .45 })} />
    </>
  );
}

/* ---- Figure : a local portrait mark seated at the table -------------------
   Colored ring = the agent's identity color; keeps the head-glow, ground shadow,
   and the speaking halo. ---------------------------------------------------- */
function Figure({ agent, isUser, head, size, speaking }) {
  const color = isUser ? '#8076a0' : (agent.color || '#8076a0');
  const d = size;
  return (
    <div style={{ position: 'relative', width: d, height: d * 1.16, margin: '0 auto' }}>
      {head && <div style={{ position: 'absolute', left: '50%', top: -d * 0.2, transform: 'translateX(-50%)',
        width: d * 1.6, height: d * 1.6, borderRadius: '50%', zIndex: 0,
        background: `radial-gradient(circle, ${alpha(color, 24)} 0%, transparent 68%)` }} />}
      <div style={{ position: 'absolute', left: '50%', bottom: -3, transform: 'translateX(-50%)',
        width: d * 0.84, height: 11, borderRadius: '50%', background: 'rgba(40,40,70,.20)', filter: 'blur(5px)', zIndex: 0 }} />
      {speaking && <div className="rt-glow" style={{ position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)',
        width: d, height: d, borderRadius: '50%', '--glow-c': color, zIndex: 1 }} />}
      <div style={{ position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)',
        width: d, height: d, borderRadius: '50%', overflow: 'hidden', zIndex: 2, background: 'var(--surface)',
        boxShadow: `0 0 0 ${Math.max(2, d * 0.05)}px var(--surface), 0 0 0 ${Math.max(3, d * 0.075)}px ${alpha(color, 70)}, 0 ${d * 0.08}px ${d * 0.16}px -${d * 0.04}px rgba(40,40,70,.35)` }}>
        <AgentMark agent={agent || { displayName: 'You', color }} size={d} isUser={isUser} />
      </div>
    </div>
  );
}

/* ---- Speech / activity card --------------------------------------------- */
function SpeechCard({ agent, speech, aggregate, onAction, s, drop }) {
  const w = Math.round(364 * Math.max(0.94, s));
  const accent = agent.pm ? 'var(--pm)' : agent.color;
  const wrap = drop ? { top: '100%', transform: 'translate(-50%, 10px)' } : { top: -8, transform: 'translate(-50%, -100%)' };
  return (
    <div style={{ position: 'absolute', left: '50%', width: w, zIndex: 60, animation: 'rt-fadein .3s ease both', ...wrap }}>
      <div style={{ background: 'var(--surface)', borderRadius: 'var(--r-card)', border: '1px solid var(--border)',
        borderTop: `2.5px solid ${accent}`, boxShadow: 'var(--shadow-pop)', padding: '11px 13px', textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: accent }}>{agent.displayName}</span>
          {!agent.pm && <RoleTag agent={agent} />}
          {agent.pm && <span className="mono" style={{ fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase',
            color: 'var(--text-faint)' }}>facilitator</span>}
          {speech?.steps > 1 && (
            <span className="mono tnum" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-faint)',
              whiteSpace: 'nowrap' }}>{speech.step}/{speech.steps}</span>
          )}
        </div>
        {aggregate ? (
          <>
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, marginBottom: 10 }}>{aggregate.text}</div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {aggregate.actions.map((a) => (
                <button key={a.id} onClick={() => onAction(a.id)} style={{ display: 'inline-flex', alignItems: 'center',
                  gap: 6, padding: '7px 11px', borderRadius: 'var(--r-sm)', font: 'inherit', fontSize: 12, fontWeight: 500,
                  cursor: 'pointer', whiteSpace: 'nowrap', border: a.kind === 'primary' ? 'none' : '1px solid var(--border)',
                  background: a.kind === 'primary' ? 'var(--accent)' : 'var(--surface-2)',
                  color: a.kind === 'primary' ? '#fff' : 'var(--text)' }}>
                  <Icon name={a.icon} size={13} />{a.label}
                  {a.badge && <span className="tnum" style={{ fontSize: 10, fontWeight: 700, minWidth: 14, height: 14,
                    padding: '0 3px', borderRadius: 7, display: 'grid', placeItems: 'center',
                    background: a.kind === 'primary' ? 'rgba(255,255,255,.25)' : alpha('var(--warn)', 18),
                    color: a.kind === 'primary' ? '#fff' : 'var(--warn)' }}>{a.badge}</span>}
                </button>
              ))}
            </div>
          </>
        ) : speech.mode === 'thinking' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Icon name="sparkle" size={13} style={{ color: 'var(--text-faint)' }} />
            <span className="rt-shimmer" style={{ fontSize: 12.5, fontStyle: 'italic' }}>thinking…</span>
          </div>
        ) : speech.mode === 'working' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)' }}>
            <Spinner size={13} color={accent} /><span>{speech.tool?.name} is working…</span>
          </div>
        ) : (
          <div style={{ fontSize: 14.25, color: 'var(--text)', lineHeight: 1.62, whiteSpace: 'pre-wrap',
            maxHeight: 280, overflowY: 'auto', paddingRight: 3, scrollbarWidth: 'thin' }}>
            {speech.text}<span className="rt-caret" />
          </div>
        )}
      </div>
      <div style={{ position: 'absolute', left: '50%', width: 13, height: 13, transform: 'translateX(-50%) rotate(45deg)',
        background: 'var(--surface)', ...(drop ? { top: -7, borderLeft: '1px solid var(--border)', borderTop: '1px solid var(--border)' }
          : { bottom: -7, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }) }} />
    </div>
  );
}

/* ---- live "now doing" bubble --------------------------------------------- */
// Compact per-seat bubble for the live run: shows the agent's CURRENT step
// (latest transcript entry — tool use, thinking, or reply) while it works.
// Smaller than SpeechCard on purpose: several agents can work in parallel, so
// every working seat gets one of these instead of a single scripted speaker.
function NowDoingBubble({ agent, now, s }) {
  const accent = agent.pm ? 'var(--pm)' : agent.color;
  const text = (now.text || '').replace(/\s+/g, ' ').trim();
  const shown = text.length > 84 ? `${text.slice(0, 84)}…` : text;
  return (
    <div style={{ position: 'absolute', left: '50%', top: -6, transform: 'translate(-50%, -100%)',
      width: Math.round(210 * Math.max(0.94, s)), zIndex: 70, animation: 'rt-fadein .3s ease both' }}>
      <div style={{ background: 'var(--surface)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
        borderLeft: `2.5px solid ${accent}`, boxShadow: 'var(--shadow-card)', padding: '7px 9px', textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700,
          color: accent, marginBottom: shown ? 3 : 0 }}>
          {now.mode === 'thinking'
            ? <Icon name="sparkle" size={10} style={{ color: accent }} />
            : <Spinner size={10} color={accent} />}
          {now.mode === 'thinking' ? 'thinking' : now.tool ? `using ${now.tool}` : now.mode === 'starting' ? 'starting up' : 'working'}
          {now.steps > 1 && <span className="tnum" style={{ marginLeft: 'auto', fontWeight: 600,
            color: 'var(--text-faint)' }}>step {now.steps}</span>}
        </div>
        {shown && now.mode !== 'starting' && (
          <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--text-muted)', wordBreak: 'break-word' }}>{shown}</div>
        )}
      </div>
      <div style={{ position: 'absolute', left: '50%', bottom: -5, width: 10, height: 10,
        transform: 'translateX(-50%) rotate(45deg)', background: 'var(--surface)',
        borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }} />
    </div>
  );
}

/* ---- Seat ---------------------------------------------------------------- */
function speechPlacementForSeat(seat, speech) {
  const show = Boolean(speech && speech.agentId === seat.agentId);
  return { show, drop: Boolean(show && seat.head) };
}

function Seat({ seat, agents, scene, dim, onAction, onSeatClick, activity }) {
  const { x, y, s } = seatPos(seat.angle);
  const z = Math.round(200 + y);
  if (seat.empty) {
    return (
      <div style={{ position: 'absolute', left: x, top: y, transform: 'translate(-50%,-50%)', zIndex: z,
        opacity: dim ? 0.35 : 0.6, textAlign: 'center' }}>
        <div style={{ width: 50 * s, height: 50 * s, borderRadius: '50%', margin: '0 auto',
          border: '1.5px dashed var(--border-strong)', display: 'grid', placeItems: 'center',
          color: 'var(--text-faint)' }}><Icon name="plus" size={18 * s} /></div>
        <div style={{ marginTop: 6, fontSize: 10.5 * s, color: 'var(--text-faint)' }}>invite agent</div>
      </div>
    );
  }
  const isUser = seat.user;
  const agent = isUser ? null : agents[seat.agentId];
  const st = isUser ? 'idle' : scene.status[seat.agentId];
  const speaking = st === 'speaking' || st === 'working' || st === 'thinking';
  const speechPlacement = speechPlacementForSeat(seat, scene.speech);
  const showSpeech = speechPlacement.show;
  const raisingHand = scene.decision && scene.decision.agentId === seat.agentId;
  const figSize = Math.round((seat.head ? 56 : 60) * s);
  const clickable = !isUser && onSeatClick;
  const activityCount = activity?.count || 0;
  const nowDoing = !isUser && !seat.head && !showSpeech && activity?.now ? activity.now : null;

  return (
    <div onClick={clickable ? () => onSeatClick(seat.agentId) : undefined}
      title={clickable ? `Open ${agent.displayName} activity` : undefined}
      className={clickable ? 'rt-seat' : undefined}
      style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%,-50%) translateY(${speaking ? -7 : 0}px)`,
      zIndex: showSpeech ? 400 : nowDoing ? 350 : z, transition: 'transform .4s cubic-bezier(.2,.8,.3,1)', cursor: clickable ? 'pointer' : 'default',
      opacity: dim ? 0.5 : 1, filter: dim ? 'saturate(.7)' : 'none', textAlign: 'center' }}>

      {showSpeech && agent && (
        <SpeechCard agent={agent} speech={scene.speech} aggregate={null} onAction={onAction} s={s}
          drop={speechPlacement.drop} />
      )}
      {nowDoing && agent && (
        <NowDoingBubble agent={agent} now={nowDoing} s={s} />
      )}

      <div className={speaking ? '' : 'rt-bob'} style={{ animationDelay: `${(seat.angle % 360) / 90}s` }}>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          {raisingHand && (
            <span className="rt-rise" style={{ position: 'absolute', top: -18 * s, left: '50%', transform: 'translateX(-50%)',
              zIndex: 8, fontSize: 20 * s, filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.3))' }}>✋</span>
          )}
          <Figure agent={agent || {}} isUser={isUser} head={seat.head} size={figSize} speaking={speaking} />
          {clickable && (
            <span className="rt-seat-dm" style={{ position: 'absolute', left: -4, top: figSize * 0.05, width: 18 * s, height: 18 * s,
              borderRadius: '50%', display: 'none', placeItems: 'center', background: 'var(--accent)', color: '#fff',
              boxShadow: '0 0 0 2px var(--surface)', zIndex: 6 }}><Icon name="send" size={10 * s} /></span>
          )}
          {activityCount > 0 && (
            <span style={{ position: 'absolute', right: -9, top: -8, minWidth: 21 * s, height: 21 * s,
              padding: `0 ${5 * s}px`, borderRadius: 999, display: 'grid', placeItems: 'center',
              background: agent.color, color: '#fff', fontSize: 11 * s, fontWeight: 800,
              boxShadow: '0 0 0 2px var(--surface)', zIndex: 9 }}>
              {activityCount}
            </span>
          )}
          {!isUser && (
            <div style={{ position: 'absolute', right: -3, top: figSize * 0.05, width: 17 * s, height: 17 * s,
              borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--surface)',
              boxShadow: '0 0 0 2px var(--surface)', zIndex: 5 }}>
              {st === 'done' ? <Icon name="check" size={11 * s} style={{ color: 'var(--ok)' }} />
                : st === 'working' ? <Spinner size={12 * s} color={agent.color} />
                : st === 'thinking' ? <Icon name="sparkle" size={10 * s} style={{ color: 'var(--text-faint)' }} />
                : st === 'speaking' ? <span style={{ width: 7 * s, height: 7 * s, borderRadius: '50%', background: agent.color }} />
                : <span style={{ width: 7 * s, height: 7 * s, borderRadius: '50%', background: 'var(--text-faint)', opacity: .5 }} />}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 18 * s, fontWeight: 600, color: 'var(--text)' }}>{isUser ? 'You' : agent.displayName}</div>
        <div style={{ fontSize: 13.5 * s, color: 'var(--text-faint)' }}>{isUser ? 'chair' : agent.pm ? 'facilitator' : `@${agent.role}`}</div>
      </div>
    </div>
  );
}

/* ---- document tray on the table (opens the Files panel) ------------------ */
function DocTray({ placed, agents, onOpen }) {
  const items = [{ neutral: true }, ...placed];
  const top = items.slice(-3);
  return (
    <button onClick={onOpen} title="Open files" style={{ position: 'absolute', left: L.TBL.cx - 30, top: L.TBL.cy + L.TBL.ry * 0.32,
      transform: 'translate(-50%,-50%)', zIndex: 70, cursor: 'pointer', font: 'inherit', border: 'none', background: 'none',
      padding: 0, display: 'flex', alignItems: 'center', gap: 13 }}>
      <div style={{ position: 'relative', width: 76, height: 56, flexShrink: 0 }}>
        {top.map((it, i) => {
          const c = it.neutral ? 'var(--text-faint)' : agents[it.ownerAgentId].color;
          const off = top.length - 1 - i;
          return (
            <div key={i} className="rt-place" style={{ position: 'absolute', left: off * 8, top: off * 6, zIndex: i,
              width: 60, height: 48, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)',
              borderLeft: `3px solid ${c}`, boxShadow: '0 8px 16px -9px rgba(0,0,0,.55)', display: 'grid', placeItems: 'center' }}>
              <Icon name={it.neutral ? 'code' : 'code'} size={18} style={{ color: c }} />
            </div>
          );
        })}
      </div>
      <div style={{ textAlign: 'left' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>Code & logs</div>
        <div style={{ fontSize: 14, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4 }}>
          {items.length} records · open <Icon name="chevron" size={14} />
        </div>
      </div>
    </button>
  );
}

/* ---- Door : the persistent way into a side room (breakout) --------------- */
function Door({ active, onClick }) {
  const x = (L.DOOR && L.DOOR.x) || (L.WB.x + L.WB.w / 2 + 120), y = (L.DOOR && L.DOOR.y) || (L.WB.y + 18);
  return (
    <button onClick={onClick} title="Breakout rooms — pull people aside" style={{ position: 'absolute', left: x, top: y,
      transform: 'translate(-50%,-50%)', zIndex: 30, cursor: 'pointer', font: 'inherit', background: 'none', border: 'none',
      padding: 0, textAlign: 'center' }}>
      <div style={{ position: 'relative', width: 74, height: 108, margin: '0 auto',
        borderRadius: '11px 11px 4px 4px', background: 'linear-gradient(168deg, var(--surface), var(--surface-2))',
        border: '2px solid var(--border-strong)', boxShadow: '0 14px 28px -14px rgba(0,0,0,.5), inset 0 1px 0 color-mix(in oklab,#fff 30%,transparent)' }}>
        <div style={{ position: 'absolute', inset: '9px 10px', borderRadius: '6px 6px 3px 3px', border: '1.5px solid var(--border)' }} />
        <div style={{ position: 'absolute', right: 14, top: '50%', width: 7, height: 7, borderRadius: '50%',
          background: 'var(--accent)', transform: 'translateY(-50%)' }} />
        {active ? <span style={{ position: 'absolute', top: -9, right: -9, minWidth: 22, height: 22, borderRadius: 11,
          background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 700, display: 'grid', placeItems: 'center',
          boxShadow: '0 0 0 2px var(--surface)' }}>{active}</span> : null}
      </div>
      <div style={{ marginTop: 9, fontSize: 15, fontWeight: 600, color: 'var(--text-muted)' }}>Breakout</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>side room</div>
    </button>
  );
}

/* ---- Scene root ---------------------------------------------------------- */
function RoundtableScene({ agents, scene, memberIds, onOpenArtifact, onAction, onOpenBreakouts, onSeatClick, onOpenFiles, onOpenCodeLogs, onZoomWhiteboard, wide, activityByAgent }) {
  L = wide ? LAYOUTS.wide : LAYOUTS.stacked;     // set active layout for this render
  const seats = buildSeats(memberIds);
  const speaker = scene.speech ? scene.speech.agentId : null;
  return (
    <RoomStage w={L.W} h={L.H}>
      <Whiteboard tasks={scene.tasks} agents={agents} posted={scene.planPosted} onZoom={onZoomWhiteboard} big={wide} live={scene.live} run={scene.run} />
      <Door active={scene.breakout ? 1 : 0} onClick={onOpenBreakouts} />
      <TableBody />
      <Beams scene={scene} agents={agents} seats={seats} />
      <DocTray placed={scene.placed} agents={agents} onOpen={onOpenCodeLogs || onOpenFiles} />
      {seats.map((seat) => (
        <Seat key={seat.key} seat={seat} agents={agents} scene={scene} onAction={onAction} onSeatClick={onSeatClick}
          activity={seat.agentId ? activityByAgent?.[seat.agentId] : null}
          dim={!!speaker && speaker !== seat.agentId && !seat.user && !seat.head} />
      ))}
    </RoomStage>
  );
}

/* ---- WhiteboardZoom : full lightbox of the board ------------------------- */
function WhiteboardZoom({ tasks, agents, onClose, live, run, posted = true }) {
  const w = Math.min(940, window.innerWidth - 80), h = Math.round(w * 0.52);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 120, background: alpha('#000', 40),
      backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="rt-zoom" style={{ position: 'relative', width: w, height: h }}>
        <BoardFrame w={w} h={h}>
          <WhiteboardSurface tasks={tasks} agents={agents} posted={posted} live={live} run={run} w={w - 22} h={h - 22} big />
        </BoardFrame>
        <button onClick={onClose} style={{ position: 'absolute', top: 20, right: 20, display: 'grid', placeItems: 'center',
          width: 32, height: 32, borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)',
          color: 'var(--text-muted)', cursor: 'pointer', zIndex: 6 }}><Icon name="x" size={16} /></button>
      </div>
    </div>
  );
}

export {
  RoundtableScene,
  WhiteboardZoom,
  sceneAt,
  meetingNotes,
  buildSeats,
  seatPos,
  speechPlacementForSeat,
};
