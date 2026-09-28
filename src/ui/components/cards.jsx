/* ============================================================================
   Roundtable — cards.jsx
   TodoListCard · ArtifactRenderer (file/diff/preview) · HandoffCard · BreakoutChip
   Plus the shared OwnerCard chrome + a tiny syntax highlighter.
   ============================================================================ */

import React from 'react';
import { Avatar, RoleTag, StatusGlyph, Icon, Md, tint, alpha } from './primitives';
const { useState } = React;

/* ---- tiny TS/TSX highlighter --------------------------------------------- */
const HL_KW = new RegExp('\\b(import|from|export|default|function|return|const|let|var|async|await|if|else|for|while|new|class|interface|type|enum|extends|implements|public|private|of|in|as)\\b');
function highlightLine(line, key) {
  const re = new RegExp(
    '(\\/\\/.*$)' +                              // comment
    "|('(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\"|`(?:[^`\\\\]|\\\\.)*`)" + // string
    '|\\b(import|from|export|default|function|return|const|let|var|async|await|if|else|for|while|new|class|interface|type|enum|extends|implements|public|private|of|in|as)\\b' +
    '|\\b([A-Z][A-Za-z0-9_]*)\\b' +              // Type / Component
    '|\\b(\\d+)\\b', 'g');                        // number
  const out = []; let last = 0, m, k = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    let c = null;
    if (m[1]) c = 'var(--text-faint)';
    else if (m[2]) c = '#4cc38a';
    else if (m[3]) c = '#8b7cf6';
    else if (m[4]) c = 'var(--run)';
    else if (m[5]) c = 'var(--warn)';
    out.push(<span key={k++} style={{ color: c }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return <span key={key}>{out}</span>;
}
function CodeBlock({ code, max }) {
  const lines = code.split('\n');
  const shown = max ? lines.slice(0, max) : lines;
  return (
    <pre className="mono" style={{
      margin: 0, fontSize: 12.5, lineHeight: 1.62, overflowX: 'auto',
      padding: '14px 16px', color: 'var(--text)', tabSize: 2,
    }}>
      {shown.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 14 }}>
          <span style={{ color: 'var(--text-faint)', userSelect: 'none', textAlign: 'right',
            minWidth: 18, opacity: .7 }}>{i + 1}</span>
          <span style={{ whiteSpace: 'pre' }}>{highlightLine(l, i) || ' '}</span>
        </div>
      ))}
    </pre>
  );
}

/* ---- AgentEvent artifact normalization ----------------------------------- */
function ownerForArtifact(art, agents) {
  const ownerId = art.ownerAgentId || art.agentId || art.createdByAgentId;
  const direct = ownerId ? agents?.[ownerId] : null;
  if (direct) return direct;
  const byRole = ownerId
    ? Object.values(agents || {}).find((agent) => agent.role === ownerId)
    : null;
  if (byRole) return byRole;
  return {
    agentId: ownerId || 'agent',
    role: ownerId || 'agent',
    displayName: ownerId ? `@${ownerId}` : 'Agent',
    color: 'var(--text-muted)',
  };
}

function normalizeArtifactForDisplay(raw, fallback = {}) {
  if (!raw) return null;
  const kind = normalizeArtifactKind(raw.kind);
  const title = raw.title || raw.uri || raw.path || 'Untitled artifact';
  const preview = raw.preview ?? raw.code ?? raw.content ?? '';
  const ownerAgentId =
    raw.ownerAgentId || fallback.ownerAgentId || raw.createdByAgentId || raw.agentId || 'agent';
  return {
    ...raw,
    ...fallback,
    id: raw.id || fallback.id || `${kind}:${title}`,
    kind,
    title,
    ownerAgentId,
    version: raw.version ?? raw.currentVersion ?? fallback.version ?? 1,
    uri: raw.uri || raw.path || fallback.uri,
    preview,
    code: raw.code ?? preview,
    diff: normalizeDiff(raw.diff, title, ownerAgentId),
  };
}

function artifactFromFileChangeEvent(event, fallback = {}) {
  const ownerAgentId = fallback.ownerAgentId || event.ownerAgentId || event.agentId || 'agent';
  return normalizeArtifactForDisplay({
    id: event.id || `diff:${event.path}:${event.kind}`,
    kind: 'diff',
    title: event.path,
    ownerAgentId,
    version: fallback.version || 1,
    uri: event.path,
    diff: parseUnifiedDiff(event.diff || '', ownerAgentId, event.path),
    preview: event.diff || '',
  });
}

function normalizeArtifactKind(kind) {
  if (kind === 'web_app' || kind === 'html') return 'preview';
  if (kind === 'code' || kind === 'markdown' || kind === 'spec') return 'file';
  return kind || 'file';
}

function normalizeDiff(diff, title, ownerAgentId) {
  if (!diff) return null;
  if (typeof diff === 'object' && Array.isArray(diff.lines)) return diff;
  return parseUnifiedDiff(String(diff), ownerAgentId, title);
}

function parseUnifiedDiff(diff, ownerAgentId, title) {
  const lines = diff.split('\n');
  const hunk = lines.find((line) => line.startsWith('@@')) || title || 'diff';
  return {
    file: title,
    hunk,
    lines: lines
      .filter((line) => !line.startsWith('diff --git') && !line.startsWith('index '))
      .map((line) => {
        if (line.startsWith('+++') || line.startsWith('---')) {
          return { t: 'ctx', text: line };
        }
        if (line.startsWith('+')) {
          return { t: 'add', text: line.slice(1), author: ownerAgentId };
        }
        if (line.startsWith('-')) {
          return { t: 'del', text: line.slice(1), author: ownerAgentId };
        }
        return { t: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
      }),
  };
}

/* ---- OwnerCard chrome (artifacts) ---------------------------------------- */
function OwnerCard({ owner, title, version, badge, children, onOpen, kindLabel, accentBar = true }) {
  return (
    <div className="rt-rise" style={{
      background: 'var(--surface)', borderRadius: 'var(--r-card)',
      border: '1px solid var(--border)',
      borderLeft: accentBar ? `2.5px solid ${owner.color}` : '1px solid var(--border)',
      boxShadow: 'var(--shadow-card)', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10,
        padding: '11px 13px', borderBottom: '1px solid var(--border)' }}>
        <Avatar agent={owner} size={26} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
            {version != null && <VChip v={version} />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3 }}>
            <RoleTag agent={owner} />
            {kindLabel && <span className="mono" style={{ fontSize: 10.5, letterSpacing: '.1em',
              textTransform: 'uppercase', color: 'var(--text-faint)' }}>{kindLabel}</span>}
            {badge}
          </div>
        </div>
        {onOpen && (
          <button onClick={onOpen} title="Open in drawer" style={iconBtn}>
            <Icon name="expand" size={15} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
const iconBtn = {
  display: 'grid', placeItems: 'center', width: 30, height: 30, flexShrink: 0,
  borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text-muted)', cursor: 'pointer', transition: 'all .15s ease',
};
function VChip({ v, changed }) {
  return <span className="mono tnum" style={{
    fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 5,
    background: changed ? alpha('var(--run)', 16) : 'var(--surface-3)',
    color: changed ? 'var(--run)' : 'var(--text-muted)',
    boxShadow: changed ? `0 0 0 1px ${alpha('var(--run)', 40)} inset` : 'none',
  }}>v{v}</span>;
}

/* ---- Dependency-changed banner (#72, specs/060) --------------------------- */
function DepChangedBanner({ notice, agents, onAskSync }) {
  const ownerId = notice?.upstream?.ownerAgentId;
  const owner = ownerId ? agents?.[ownerId] : null;
  const u = notice.upstream;
  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px',
        background: alpha('var(--bad)', 10),
        borderBottom: '1px solid ' + alpha('var(--bad)', 35),
        borderTop: '1px solid ' + alpha('var(--bad)', 35),
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--bad)', flexShrink: 0 }} />
      <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.4 }}>
        <div style={{ fontWeight: 600, color: 'var(--text)' }}>Dependency changed</div>
        <div style={{ color: 'var(--text-muted)' }}>
          <span className="mono" style={{ background: 'var(--surface-3)', padding: '1px 5px',
            borderRadius: 4, fontSize: 11.5 }}>{u.title || u.artifactId}</span>{' '}
          went <b>v{u.fromVersion}→v{u.toVersion}</b>
          {notice.kind ? <> via <i>{notice.kind}</i></> : null}.
        </div>
      </div>
      {onAskSync && (
        <button
          onClick={(e) => { e.stopPropagation(); onAskSync(notice); }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px',
            borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer',
            background: 'var(--bad)', color: '#fff', font: 'inherit', fontSize: 12, fontWeight: 500,
            flexShrink: 0,
          }}
          title={owner ? `Pre-fill a hand-off to @${owner.role || ownerId} to resync` : 'Open sync hand-off'}
        >
          <Icon name="door" size={12} /> Ask @{owner?.role || ownerId || 'owner'} to sync
        </button>
      )}
    </div>
  );
}

/* ---- Review comments (specs/030 §ReviewCard, issue #6) ------------------- */
const SEVERITY_COLOR = {
  blocker: 'var(--bad)',
  major:   'var(--warn)',
  minor:   'var(--run)',
  info:    'var(--text-muted)',
};
const SEVERITY_LABEL = {
  blocker: 'BLOCKER',
  major:   'MAJOR',
  minor:   'MINOR',
  info:    'INFO',
};
function ReviewCommentList({ comments, agents, onApplyFix }) {
  if (!comments || comments.length === 0) return null;
  return (
    <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', padding: '10px 14px 4px' }}>
        Review · {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
      </div>
      <div style={{ display: 'grid' }}>
        {comments.map((c) => {
          const author = c.author ? agents?.[c.author] : null;
          const sevColor = SEVERITY_COLOR[c.severity] || SEVERITY_COLOR.info;
          return (
            <div key={c.id} style={{
              display: 'flex', gap: 10, padding: '10px 14px',
              borderTop: '1px solid var(--border)',
            }}>
              <span style={{
                alignSelf: 'flex-start', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em',
                padding: '2px 6px', borderRadius: 4, color: sevColor, flexShrink: 0,
                background: alpha(sevColor, 14), border: '1px solid ' + alpha(sevColor, 50),
              }}>
                {SEVERITY_LABEL[c.severity] || (c.severity || 'INFO').toUpperCase()}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
                  {author && (
                    <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: author.color }}>
                      @{author.role}
                    </span>
                  )}
                  {c.line !== undefined && (
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                      line {c.line}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.45 }}>{c.body}</div>
                {onApplyFix && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onApplyFix(c); }}
                    style={{
                      marginTop: 7, display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '5px 10px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
                      background: 'var(--surface-2)', color: 'var(--text)',
                      font: 'inherit', fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
                    }}
                    title="Propose a fix (fixer agent edits the file). Not an auto-commit."
                  >
                    <Icon name="edit" size={11} /> Apply review fix
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- File artifact -------------------------------------------------------- */
function FileArtifact({ art, owner, agents, notice, onAskSync, reviewComments, onApplyFix, onOpen }) {
  const [open, setOpen] = useState(false);
  const preview = art.preview || art.code || '';
  const lineCount = preview.split('\n').length;
  return (
    <OwnerCard
      owner={owner}
      title={art.title}
      version={art.version}
      kindLabel={art.lang || 'file'}
      onOpen={onOpen}
      badge={notice ? <span title="Upstream dependency changed" style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px',
        borderRadius: 5, background: alpha('var(--bad)', 18), color: 'var(--bad)',
        fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em' }}>
        ⚠ DEP CHANGED
      </span> : undefined}
    >
      {notice && <DepChangedBanner notice={notice} agents={agents} onAskSync={onAskSync} />}
      <div style={{ position: 'relative', background: 'var(--surface-2)' }}>
        <div style={{ maxHeight: open ? 'none' : 132, overflow: 'hidden' }}>
          <CodeBlock code={preview} />
        </div>
        {!open && lineCount > 7 && (
          <div style={{ position: 'absolute', inset: 'auto 0 0 0', height: 56, pointerEvents: 'none',
            background: 'linear-gradient(transparent, var(--surface-2))' }} />
        )}
      </div>
      <div style={{ padding: '8px 13px', borderTop: '1px solid var(--border)', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{lineCount} lines</span>
        {lineCount > 7 && (
          <button onClick={() => setOpen(o => !o)} style={textBtn}>
            {open ? 'Collapse' : `Show all ${lineCount} lines`}
            <Icon name={open ? 'chevdown' : 'chevron'} size={13} />
          </button>
        )}
      </div>
      <ReviewCommentList comments={reviewComments} agents={agents} onApplyFix={onApplyFix} />
    </OwnerCard>
  );
}
const textBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
  color: 'var(--accent)', font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', padding: 0,
};

/* ---- Diff artifact (multi-author tinting) -------------------------------- */
function DiffArtifact({ art, owner, agents, onOpen }) {
  const d = art.diff || normalizeDiff(art.preview || '', art.title, art.ownerAgentId);
  const authors = [...new Set(d.lines.filter(l => l.author).map(l => l.author))];
  return (
    <OwnerCard owner={owner} title={art.title} version={art.version} kindLabel="diff"
      onOpen={onOpen} badge={<VChip v={art.version} changed />}>
      <div style={{ background: 'var(--surface-2)' }}>
        <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)', padding: '7px 14px',
          borderBottom: '1px solid var(--border)' }}>{d.hunk}</div>
        <pre className="mono" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, overflowX: 'auto' }}>
          {d.lines.map((l, i) => {
            const a = l.author ? agents[l.author] : null;
            const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' ';
            const baseTint = l.t === 'add' ? 'var(--ok)' : l.t === 'del' ? 'var(--bad)' : null;
            const authorTint = a ? a.color : baseTint;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'stretch',
                background: l.t === 'ctx' ? 'transparent' : alpha(authorTint, 9),
                borderLeft: `2px solid ${l.t === 'ctx' ? 'transparent' : alpha(authorTint, 70)}` }}>
                <span style={{ width: 22, textAlign: 'center', color: 'var(--text-faint)',
                  userSelect: 'none', flexShrink: 0,
                  color: l.t === 'add' ? 'var(--ok)' : l.t === 'del' ? 'var(--bad)' : 'var(--text-faint)' }}>{sign}</span>
                <span style={{ whiteSpace: 'pre', padding: '1px 10px 1px 0', flex: 1 }}>{l.text || ' '}</span>
                {a && <span title={`${a.displayName} · @${a.role}`} style={{ alignSelf: 'center', marginRight: 8, display: 'inline-flex' }}>
                  <Avatar agent={a} size={16} /></span>}
              </div>
            );
          })}
        </pre>
      </div>
      <div style={{ padding: '8px 13px', borderTop: '1px solid var(--border)', display: 'flex',
        alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Lines tinted by author:</span>
        {authors.map(id => agents[id] && (
          <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5,
            color: 'var(--text-muted)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: agents[id].color }} />
            {agents[id].displayName}
          </span>
        ))}
      </div>
    </OwnerCard>
  );
}

/* ---- Preview artifact ----------------------------------------------------- */
function PreviewArtifact({ art, owner, onOpen }) {
  const [mode, setMode] = useState('preview'); // preview | code
  const preview = art.preview || art.code || '';
  return (
    <OwnerCard owner={owner} title={art.title} version={art.version} kindLabel="preview" onOpen={onOpen}>
      <div style={{ display: 'flex', gap: 4, padding: '8px 11px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface-2)' }}>
        <Seg active={mode === 'preview'} onClick={() => setMode('preview')} icon="eye">Preview</Seg>
        <Seg active={mode === 'code'} onClick={() => setMode('code')} icon="code">View code</Seg>
        <div style={{ flex: 1 }} />
        <button onClick={onOpen} style={textBtn}>Open in drawer <Icon name="expand" size={13} /></button>
      </div>
      {mode === 'preview' ? (
        <div style={{ background: 'var(--surface-3)', padding: 12 }}>
          <div style={{ borderRadius: 'var(--r-sm)', overflow: 'hidden', border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-card)', background: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
              background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
              {['#e5687a', 'var(--warn)', '#4cc38a'].map(c =>
                <span key={c} style={{ width: 9, height: 9, borderRadius: '50%', background: c, opacity: .8 }} />)}
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 6 }}>localhost:3000</span>
            </div>
            <iframe title={art.title} srcDoc={preview} sandbox="allow-scripts"
              style={{ width: '100%', height: 318, border: 'none', display: 'block', background: '#fff' }} />
          </div>
        </div>
      ) : (
        <div style={{ background: 'var(--surface-2)', maxHeight: 318, overflow: 'auto' }}>
          <CodeBlock code={art.code || preview} />
        </div>
      )}
    </OwnerCard>
  );
}
function Seg({ active, onClick, icon, children }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px',
      borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12.5,
      fontWeight: 500, transition: 'all .15s ease',
      background: active ? 'var(--surface)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--text-muted)',
      boxShadow: active ? 'var(--shadow-card)' : 'none',
    }}>
      <Icon name={icon} size={14} />{children}
    </button>
  );
}

/* ---- Artifact dispatcher -------------------------------------------------- */
function ArtifactRenderer({ art, agents, notice, onAskSync, reviewComments, onApplyFix, onOpen }) {
  const displayArt = normalizeArtifactForDisplay(art);
  if (!displayArt) return null;
  const owner = ownerForArtifact(displayArt, agents);
  const open = () => onOpen && onOpen(displayArt);
  switch (displayArt.kind) {
    case 'file':    return <FileArtifact art={displayArt} owner={owner} agents={agents} notice={notice} onAskSync={onAskSync} reviewComments={reviewComments} onApplyFix={onApplyFix} onOpen={open} />;
    case 'diff':    return <DiffArtifact art={displayArt} owner={owner} agents={agents} onOpen={open} />;
    case 'preview': return <PreviewArtifact art={displayArt} owner={owner} onOpen={open} />;
    default:        return (
      <OwnerCard owner={owner} title={displayArt.title} version={displayArt.version} kindLabel={displayArt.kind} onOpen={open}>
        <div style={{ padding: '13px 15px' }}><Md text={displayArt.preview || ''} /></div>
      </OwnerCard>
    );
  }
}

/* ---- TodoListCard --------------------------------------------------------- */
function TodoListCard({ plan, agents, onRetry }) {
  const tasks = plan.tasks;
  const done = tasks.filter(t => t.status === 'completed').length;
  const running = tasks.filter(t => t.status === 'running');
  const parallelRunning = running.length > 1;
  const pm = agents.orchestrator;
  return (
    <div className="rt-rise" style={{
      background: 'var(--surface)', borderRadius: 'var(--r-card)', border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-card)', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 15px',
        borderBottom: '1px solid var(--border)' }}>
        <Avatar agent={pm} size={26} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Here’s the plan</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Posted by PM · updates in place</div>
        </div>
        {parallelRunning && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500,
            color: 'var(--run)', padding: '4px 9px', borderRadius: 'var(--r-chip)',
            background: alpha('var(--run)', 12) }}>
            <span style={{ display: 'flex', gap: 2 }}>
              <i style={parBar(0)} /><i style={parBar(1)} />
            </span>
            2 running in parallel
          </span>
        )}
        <span className="mono tnum" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{done}/{tasks.length}</span>
      </div>
      <div style={{ padding: '6px 0' }}>
        {tasks.map((t, i) => {
          const owner = agents[t.owner];
          const sibParallel = t.parallel && tasks.some((o, j) => j !== i && o.parallel);
          return (
            <div key={t.id} style={{ position: 'relative', display: 'flex', gap: 11, alignItems: 'flex-start',
              padding: '10px 15px 10px', }}>
              {sibParallel && <span style={{ position: 'absolute', left: 7, top: i === 0 || !tasks[i-1]?.parallel ? 16 : 0,
                bottom: tasks[i+1]?.parallel ? 0 : 16, width: 2, borderRadius: 2,
                background: alpha('var(--run)', 35) }} />}
              <StatusGlyph status={t.status} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>{t.id}</span>
                  <RoleTag agent={owner} showName />
                  {t.status === 'running' && <span className="rt-shimmer mono" style={{ fontSize: 11 }}>working…</span>}
                </div>
                <div style={{ marginTop: 4, fontSize: 13.5, color: t.status === 'completed' ? 'var(--text-muted)' : 'var(--text)',
                  textDecoration: t.status === 'completed' ? 'none' : 'none' }}>{t.title}</div>
                <div style={{ display: 'flex', gap: 12, marginTop: 5 }}>
                  {t.deps.length > 0 && (
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)',
                      display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                      <Icon name="chevron" size={11} style={{ transform: 'rotate(180deg)' }} />
                      waits on {t.deps.join(', ')}
                    </span>
                  )}
                  {sibParallel && <span className="mono" style={{ fontSize: 11, color: 'var(--run)' }}>∥ parallel</span>}
                </div>
                {t.status === 'failed' && (
                  <button onClick={() => onRetry && onRetry(t.id)} style={{ ...textBtn, color: 'var(--bad)', marginTop: 7 }}>
                    <Icon name="replay" size={13} /> Retry {t.id}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
const parBar = (i) => ({ width: 3, height: 11, borderRadius: 2, background: 'var(--run)',
  animation: `rt-blink 1.1s ease-in-out ${i * .25}s infinite` });

/* ---- HandoffCard ---------------------------------------------------------- */
const SCENARIO_LABEL = {
  dispatch: { verb: 'hand-off', glyph: '🔄' },
  agent_handoff: { verb: 'agent → agent', glyph: '↪️' },
  join_group: { verb: 'joining group', glyph: '➕' },
  cross_chat: { verb: 'cross-chat', glyph: '🪟' },
};
function scenarioLabel(scenario) {
  return SCENARIO_LABEL[scenario] || SCENARIO_LABEL.dispatch;
}
const CONTEXT_SCOPE_LABEL = {
  user: 'User memory',
  workbench: 'Project memory',
  chat: 'Chat context',
  artifact: 'Artifacts',
  review: 'Review notes',
  handoff: 'Prior hand-offs',
};
function sourceStatus(source) {
  if (!source.included) return { label: 'omitted', color: 'var(--text-faint)' };
  if (source.compacted) return { label: 'compacted', color: 'var(--warn)' };
  return { label: 'included', color: 'var(--run)' };
}
function ContextAudit({ audit }) {
  if (!audit) return null;
  const grouped = (audit.sources || []).reduce((acc, source) => {
    const scope = source.scope || 'chat';
    if (!acc[scope]) acc[scope] = [];
    acc[scope].push(source);
    return acc;
  }, {});
  const budget = audit.budget || {};
  return (
    <Field label="Context sources">
      <div style={{ display: 'grid', gap: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="mono tnum" style={{ fontSize: 11.5, color: 'var(--text-muted)',
            padding: '3px 8px', borderRadius: 5, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            {budget.usedChars ?? 0}/{budget.maxChars ?? 0} chars
          </span>
          {budget.compacted && (
            <span style={{ fontSize: 11.5, color: 'var(--warn)', padding: '3px 8px',
              borderRadius: 5, background: alpha('var(--warn)', 12), border: '1px solid ' + alpha('var(--warn)', 35) }}>
              compacted to fit
            </span>
          )}
        </div>
        {Object.keys(grouped).length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>
            No context source audit recorded for this hand-off.
          </div>
        ) : Object.entries(grouped).map(([scope, sources]) => (
          <div key={scope} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
            overflow: 'hidden', background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 10px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
                {CONTEXT_SCOPE_LABEL[scope] || scope}
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                {sources.length} source{sources.length === 1 ? '' : 's'}
              </span>
            </div>
            <div style={{ display: 'grid' }}>
              {sources.map((source) => {
                const status = sourceStatus(source);
                return (
                  <div key={`${source.scope}-${source.kind}-${source.id}`} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
                    borderTop: '1px solid var(--border)',
                  }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {source.label}
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                      {source.kind}
                    </span>
                    <span className="mono tnum" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                      {source.chars} chars
                    </span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: status.color,
                      padding: '2px 6px', borderRadius: 4, background: alpha(status.color, 12) }}>
                      {status.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Field>
  );
}
function HandoffCard({ ho, agents, onEdit }) {
  const [open, setOpen] = useState(false);
  const to = ho.to.replace('@', '');
  const toAgent = Object.values(agents).find(a => a.role === to) || agents.atlas;
  const label = scenarioLabel(ho.scenario);
  const v2 = ho.handoffV2;
  return (
    <div className="rt-rise" style={{
      background: 'var(--surface)', borderRadius: 'var(--r-card)',
      border: `1px dashed ${alpha(toAgent.color, 50)}`,
      borderLeft: `2.5px solid ${toAgent.color}`,
      overflow: 'hidden', boxShadow: open ? 'var(--shadow-card)' : 'none',
    }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px',
        background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', color: 'var(--text)', textAlign: 'left',
      }}>
        <span style={{ fontSize: 15 }}>{label.glyph}</span>
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{label.verb}</span>
        <Icon name="chevron" size={13} style={{ color: 'var(--text-faint)' }} />
        <RoleTag agent={toAgent} />
        <span style={{ fontSize: 12.5, color: 'var(--text-faint)', flex: 1, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ho.taskBrief.split('(')[0]}</span>
        <span className="mono" style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase',
          color: 'var(--text-faint)' }}>{ho.scenario}</span>
        <Icon name={open ? 'chevdown' : 'chevron'} size={15}
          style={{ color: 'var(--text-muted)', transform: open ? 'none' : 'rotate(90deg)', transition: 'transform .2s' }} />
      </button>

      {open && (
        <div style={{ padding: '4px 16px 16px', display: 'grid', gap: 14 }}>
          <Field label="User intent"><Md text={ho.userIntent} prose={false} /></Field>
          <Field label="Task brief"><Md text={ho.taskBrief} prose={false} /></Field>

          {v2 && (
            <Field label="Protocol layer">
              <div style={{ display: 'grid', gap: 8, padding: '9px 11px', borderRadius: 'var(--r-sm)',
                background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {v2.protocolVersion} · {v2.cardId}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 7 }}>
                  {[
                    ['mission', v2.missionId],
                    ['task', v2.task?.id],
                    ['from', v2.fromAgent],
                    ['to', v2.toAgent],
                  ].map(([k, val]) => (
                    <span key={k} className="mono" style={{ fontSize: 11, color: 'var(--text-faint)',
                      padding: '4px 7px', borderRadius: 5, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                      {k}: <span style={{ color: 'var(--text-muted)' }}>{val}</span>
                    </span>
                  ))}
                </div>
                {v2.contextPackage?.summary && (
                  <Md text={v2.contextPackage.summary} prose={false} />
                )}
                {v2.provenance?.selectionReason && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {v2.provenance.selectionReason}
                  </div>
                )}
                {(v2.risks || []).length > 0 && (
                  <div style={{ display: 'grid', gap: 5 }}>
                    {v2.risks.map((risk, i) => (
                      <div key={i} style={{ fontSize: 12, color: 'var(--text-muted)' }}>- {risk}</div>
                    ))}
                  </div>
                )}
              </div>
            </Field>
          )}

          <Field label="📌 Pinned constraints">
            <div style={{ display: 'grid', gap: 6 }}>
              {ho.pinnedMessages.map(p => (
                <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13,
                  padding: '7px 11px', background: 'var(--surface-2)', borderRadius: 'var(--r-sm)',
                  borderLeft: '2px solid var(--warn)' }}>
                  <span style={{ flex: 1 }}>{p.content}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{p.pinnedBy}</span>
                </div>
              ))}
            </div>
          </Field>

          <Field label="Role roster">
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {ho.rolesInGroup.map(a => (
                <span key={a.agentId} style={{ display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '4px 10px 4px 4px', borderRadius: 'var(--r-chip)', background: 'var(--surface-2)',
                  border: `1px solid ${alpha(a.color, 35)}` }}>
                  <Avatar agent={a} size={20} ring={false} />
                  <span style={{ fontSize: 12.5 }}>{a.displayName}</span>
                  <span className="mono" style={{ fontSize: 11, color: a.color }}>@{a.role}</span>
                </span>
              ))}
            </div>
          </Field>

          {ho.previousAgent && (
            <Field label="Previous agent">
              <Md text={ho.previousAgent.summary} prose={false} />
            </Field>
          )}

          <Field label="📎 Relevant artifacts (refs only)">
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {ho.relevantArtifacts.map(r => (
                <span key={r.id} className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '5px 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
                  border: '1px solid var(--border)', fontSize: 12 }}>
                  <Icon name="clip" size={12} style={{ color: 'var(--text-faint)' }} />{r.title}
                </span>
              ))}
            </div>
          </Field>

          <ContextAudit audit={ho.contextAudit} />

          <div style={{ display: 'flex', gap: 8, paddingTop: 2 }}>
            <button
              style={ghostBtn}
              onClick={(e) => { e.stopPropagation(); onEdit && onEdit(ho); }}
              disabled={!onEdit}
              title={onEdit ? 'Edit the hand-off context before re-dispatch' : 'Edit handler not wired in this view'}
            >
              <Icon name="edit" size={13} /> Edit hand-off
            </button>
            <button style={ghostBtn}><Icon name="layers" size={13} /> Expand full history</button>
          </div>
        </div>
      )}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase',
        color: 'var(--text-faint)', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}
const ghostBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 'var(--r-sm)',
  border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)',
  font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
};

/* ---- BreakoutChip (a door, not a toggle) --------------------------------- */
function BreakoutChip({ data, agents }) {
  const [peek, setPeek] = useState(false);
  const a = agents[data.a], b = agents[data.b];
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setPeek(p => !p)} className="rt-breakout" style={{
        display: 'inline-flex', alignItems: 'center', gap: 9, padding: '8px 14px 8px 11px',
        borderRadius: 'var(--r-chip)', cursor: 'pointer', font: 'inherit',
        background: 'var(--surface)', color: 'var(--text)',
        border: '1px dashed var(--border-strong)',
        backgroundImage: `linear-gradient(90deg, ${alpha(a.color, 10)}, ${alpha(b.color, 10)})`,
        transition: 'transform .15s ease, box-shadow .15s ease',
      }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: 7,
          background: 'var(--surface-2)', color: 'var(--text-muted)' }}><Icon name="door" size={15} /></span>
        <span style={{ display: 'flex', marginRight: 2 }}>
          <span style={{ marginRight: -6, zIndex: 1 }}><Avatar agent={a} size={20} /></span>
          <Avatar agent={b} size={20} />
        </span>
        <span style={{ fontSize: 13 }}>
          <b style={{ fontWeight: 600 }}>{a.displayName}</b> &amp; <b style={{ fontWeight: 600 }}>{b.displayName}</b>
          <span style={{ color: 'var(--text-faint)' }}> talked {data.turns} turns</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 600,
          color: 'var(--accent)' }}>Enter <Icon name="chevron" size={13} /></span>
      </button>

      {peek && (
        <div className="rt-rise" style={{ position: 'absolute', zIndex: 30, top: 'calc(100% + 8px)', left: 0,
          width: 360, maxWidth: '78vw', background: 'var(--surface)', borderRadius: 'var(--r-card)',
          border: '1px solid var(--border)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
          <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', display: 'flex',
            alignItems: 'center', gap: 8 }}>
            <Icon name="door" size={15} style={{ color: 'var(--text-muted)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Breakout room</span>
            <span className="mono" style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 5,
              background: 'var(--surface-3)', color: 'var(--text-faint)' }}>{data.turns} turns</span>
          </div>
          <div style={{ padding: '12px 14px', display: 'grid', gap: 11 }}>
            {data.transcript.map((t, i) => {
              const ag = agents[t.agentId];
              return (
                <div key={i} style={{ display: 'flex', gap: 9 }}>
                  <Avatar agent={ag} size={22} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11.5, color: ag.color, fontWeight: 600 }}>{ag.displayName}</div>
                    <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.45 }}>{t.text}</div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ padding: '11px 14px', borderTop: '1px solid var(--border)', display: 'flex',
            alignItems: 'center', gap: 10, background: 'var(--surface-2)' }}>
            <button style={{ ...ghostBtn, background: 'var(--accent)', color: '#fff', border: 'none',
              fontWeight: 500 }}><Icon name="door" size={14} /> Step into room</button>
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Full room arrives in a later batch</span>
          </div>
        </div>
      )}
    </div>
  );
}

export {
  TodoListCard, ArtifactRenderer, HandoffCard, BreakoutChip, OwnerCard, CodeBlock, VChip, iconBtn,
  DepChangedBanner, ReviewCommentList, normalizeArtifactForDisplay, artifactFromFileChangeEvent,
};
