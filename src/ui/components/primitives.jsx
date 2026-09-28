/* ============================================================================
   Roundtable — primitives.jsx
   Shared atoms: color helpers, Avatar, RoleTag, StatusGlyph, Spinner, Icon,
   Md (markdown-lite). Exported to window for the other babel scripts.
   ============================================================================ */
import React from 'react';
const { useState, useEffect, useRef, useMemo } = React;

/* ---- color helpers -------------------------------------------------------- */
const tint = (color, pct, base = 'var(--surface)') =>
  `color-mix(in oklab, ${color} ${pct}%, ${base})`;
const alpha = (color, pct) =>
  `color-mix(in oklab, ${color} ${pct}%, transparent)`;

/* ---- Icon set (calm, 1.6px line) ----------------------------------------- */
function Icon({ name, size = 16, style }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
    strokeLinejoin: 'round', style, 'aria-hidden': true };
  switch (name) {
    case 'chevron':  return <svg {...p}><path d="M9 6l6 6-6 6"/></svg>;
    case 'chevdown': return <svg {...p}><path d="M6 9l6 6 6-6"/></svg>;
    case 'play':     return <svg {...p}><path d="M7 5l12 7-12 7V5z"/></svg>;
    case 'pause':    return <svg {...p}><path d="M8 5v14M16 5v14"/></svg>;
    case 'replay':   return <svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/></svg>;
    case 'wrench':   return <svg {...p}><path d="M21 4a5 5 0 0 1-6.5 6.5L6 19a2.1 2.1 0 0 1-3-3l8.5-8.5A5 5 0 0 1 18 3l-2.7 2.7 1.9 1.9L20 5z"/></svg>;
    case 'rocket':   return <svg {...p}><path d="M5 15c-1.5 1-2 4-2 4s3-.5 4-2M9 13l-3 3M9.5 9.5C13 6 18 5 20 5c0 2-1 7-4.5 10.5L13 18l-2-2z"/><circle cx="15" cy="9" r="1.4"/></svg>;
    case 'door':     return <svg {...p}><path d="M14 3H6a1 1 0 0 0-1 1v17h9M14 3l5 2v15l-5 1V3z"/><path d="M11.5 12h.01"/></svg>;
    case 'pin':      return <svg {...p}><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 16v5"/></svg>;
    case 'clip':     return <svg {...p}><path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 1 1-3-3l8-8"/></svg>;
    case 'expand':   return <svg {...p}><path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/></svg>;
    case 'edit':     return <svg {...p}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>;
    case 'check':    return <svg {...p}><path d="M5 12l5 5L20 6"/></svg>;
    case 'x':        return <svg {...p}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case 'code':     return <svg {...p}><path d="M9 18l-6-6 6-6M15 6l6 6-6 6"/></svg>;
    case 'eye':      return <svg {...p}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>;
    case 'sparkle':  return <svg {...p}><path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3z"/></svg>;
    case 'send':     return <svg {...p}><path d="M5 12l15-7-7 15-2.5-5.5L5 12z"/></svg>;
    case 'plus':     return <svg {...p}><path d="M12 5v14M5 12h14"/></svg>;
    case 'search':   return <svg {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>;
    case 'dot':      return <svg {...p} fill="currentColor" stroke="none"><circle cx="12" cy="12" r="4"/></svg>;
    case 'at':       return <svg {...p}><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>;
    case 'layers':   return <svg {...p}><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/></svg>;
    case 'sun':      return <svg {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>;
    case 'moon':     return <svg {...p}><path d="M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8z"/></svg>;
    case 'flask':    return <svg {...p}><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 14h9"/></svg>;
    default:         return <svg {...p}><circle cx="12" cy="12" r="9"/></svg>;
  }
}

/* ---- Avatar --------------------------------------------------------------- */
const AGENT_AVATARS = {
  orchestrator: '/avatars/planning.png',
  planning: '/avatars/planning.png',
  planner: '/avatars/planning.png',
  mira: '/avatars/mira.png',
  pm: '/avatars/mira.png',
  atlas: '/avatars/atlas.png',
  beam: '/avatars/beam.png',
  vera: '/avatars/vera.png',
  reviewer: '/avatars/vera.png',
  nova: '/avatars/nova.png',
  architect: '/avatars/nova.png',
  fixer: '/avatars/fixer.png',
  you: '/avatars/you.png',
  'you-user': '/avatars/you.png',
  user: '/avatars/you.png',
};

function avatarSrcFor(agent = {}, isUser = false) {
  if (isUser) return AGENT_AVATARS.you;
  const keys = [
    agent.agentId, agent.id, agent.mention, agent.displayName, agent.role,
  ].filter(Boolean).map((v) => String(v).toLowerCase());
  const key = keys.find((v) => AGENT_AVATARS[v]);
  return key ? AGENT_AVATARS[key] : null;
}

function AgentMark({ agent = {}, size = 28, isUser = false }) {
  const src = avatarSrcFor(agent, isUser);
  if (src) {
    return (
      <img src={src} alt="" width={size} height={size}
        style={{ width: size, height: size, objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />
    );
  }

  const label = (agent.displayName || agent.id || 'RT').slice(0, 1).toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ display: 'block' }}>
      <rect width="64" height="64" rx="32" fill="var(--surface-2)" />
      <circle cx="32" cy="24" r="11" fill="var(--text-faint)" opacity=".45" />
      <path d="M14 58c2.5-12 9-18 18-18s15.5 6 18 18" fill="var(--text-faint)" opacity=".28" />
      <text x="32" y="36" textAnchor="middle" fontFamily="var(--font-ui)" fontSize="22" fontWeight="700"
        fill="var(--text-muted)">{label}</text>
    </svg>
  );
}

function Avatar({ agent = {}, size = 28, ring = true, dim = false }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0, overflow: 'hidden',
      position: 'relative', background: dim ? 'var(--surface-3)' : 'var(--surface)',
      boxShadow: ring ? `0 0 0 1.5px ${dim ? 'var(--border-strong)' : alpha(agent.color || '#8076a0', 55)} inset` : 'none',
      filter: dim ? 'grayscale(.6) opacity(.7)' : 'none',
    }}>
      <AgentMark agent={agent} size={size} />
    </div>
  );
}

/* ---- RoleTag -------------------------------------------------------------- */
function RoleTag({ agent, showName = false, size = 'sm' }) {
  const pad = size === 'sm' ? '2px 8px' : '3px 10px';
  const fz = size === 'sm' ? 11.5 : 12.5;
  return (
    <span className="mono" style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: pad, borderRadius: 4,
      background: tint(agent.color, 16), color: agent.color,
      fontSize: fz, fontWeight: 500, lineHeight: 1.4, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: agent.color }} />
      @{agent.role}{showName && <span style={{ opacity: .65, fontWeight: 500 }}>· {agent.displayName}</span>}
    </span>
  );
}

/* ---- StatusGlyph (todo rows) --------------------------------------------- */
function StatusGlyph({ status, size = 18 }) {
  const base = { width: size, height: size, borderRadius: '50%', flexShrink: 0,
    display: 'grid', placeItems: 'center' };
  if (status === 'completed')
    return <div style={{ ...base, background: alpha('var(--ok)', 16), color: 'var(--ok)' }}><Icon name="check" size={size * .66} /></div>;
  if (status === 'failed')
    return <div style={{ ...base, background: alpha('var(--bad)', 16), color: 'var(--bad)' }}><Icon name="x" size={size * .62} /></div>;
  if (status === 'running')
    return <Spinner size={size} color="var(--run)" />;
  return <div style={{ ...base, boxShadow: '0 0 0 1.5px var(--border-strong) inset' }} />;
}

/* ---- Spinner -------------------------------------------------------------- */
function Spinner({ size = 16, color = 'var(--accent)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke={alpha(color, 22)} strokeWidth="2.4" />
      <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={color} strokeWidth="2.4"
        strokeLinecap="round" style={{ transformOrigin: 'center', animation: 'rt-spin .8s linear infinite' }} />
    </svg>
  );
}

/* ---- Md : markdown-lite (bold, `code`, paragraphs, - lists) -------------- */
function mdInline(s) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*)/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[2] != null) out.push(<strong key={k++}>{m[2]}</strong>);
    else if (m[3] != null) out.push(<code key={k++} className="mono" style={{
      background: 'var(--surface-3)', padding: '1px 5px', borderRadius: 5,
      fontSize: '.88em' }}>{m[3]}</code>);
    else if (m[4] != null) out.push(<em key={k++}>{m[4]}</em>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function Md({ text, prose = true }) {
  const blocks = String(text).split(/\n{2,}/);
  return (
    <div style={{
      fontFamily: prose ? 'var(--font-prose)' : 'var(--font-ui)',
      fontSize: prose ? 'var(--prose-size)' : '1em',
      letterSpacing: prose ? 'var(--prose-tracking)' : 0,
      color: 'var(--text)',
    }}>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every(l => /^\s*[-•]\s/.test(l)))
          return <ul key={i} style={{ margin: '4px 0', paddingLeft: 20 }}>
            {lines.map((l, j) => <li key={j} style={{ marginBottom: 2 }}>{mdInline(l.replace(/^\s*[-•]\s/, ''))}</li>)}
          </ul>;
        return <p key={i} style={{ margin: i ? '0.55em 0 0' : 0 }}>
          {lines.map((l, j) => <React.Fragment key={j}>{j > 0 && <br />}{mdInline(l)}</React.Fragment>)}
        </p>;
      })}
    </div>
  );
}

/* ---- useTypewriter : reveal text over a duration ------------------------- */
function useTypewriter(full, active, dur = 1400) {
  const [n, setN] = useState(active ? 0 : full.length);
  useEffect(() => {
    if (!active) { setN(full.length); return; }
    setN(0);
    const start = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / dur);
      setN(Math.floor(p * full.length));
      if (p < 1) raf = requestAnimationFrame(tick); else setN(full.length);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [full, active, dur]);
  return full.slice(0, n);
}

/* ---- Pill / chip shell ---------------------------------------------------- */
function Chip({ children, onClick, color, active, style }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 7,
      padding: '6px 11px', borderRadius: 'var(--r-chip)',
      border: `1px solid ${active ? alpha(color || 'var(--accent)', 45) : 'var(--border)'}`,
      background: active ? tint(color || 'var(--accent)', 12) : 'var(--surface)',
      color: 'var(--text)', font: 'inherit', fontSize: 13, cursor: onClick ? 'pointer' : 'default',
      transition: 'all .16s ease', ...style,
    }}>{children}</button>
  );
}

export {
  tint, alpha, Icon, Avatar, AgentMark, RoleTag, StatusGlyph, Spinner, Md, mdInline,
  useTypewriter, Chip,
};
