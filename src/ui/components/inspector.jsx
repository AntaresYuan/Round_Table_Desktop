'use client';
/* ============================================================================
   Roundtable — inspector.jsx
   The right-hand inspector panel and its tabs: artifact Drawer, the live message
   Thread, the Files list, and the structured meeting Notes. Extracted from
   app-root.jsx so the side panel is one module.
   ============================================================================ */

import React from 'react';
import { Avatar, RoleTag, Icon, Spinner, tint, alpha } from './primitives';
import { ArtifactRenderer, CodeBlock, VChip, HandoffCard, iconBtn, normalizeArtifactForDisplay } from './cards';
import { LocalLiveThread } from './live-turn';
import { Thread } from './stage-scene';
import { MemoryPanel } from './memory-panel';
import { sceneAt, meetingNotes } from './roundtable';
import { liveArtifactsFromTurns } from '../lib/live-scene';
import { bundlePreviewArtifacts, withBundledPreview } from '../lib/preview-html';
import { RT } from '../lib/rt';
import { trpc } from '../lib/trpc';

const { useState, useEffect, useRef } = React;

function Drawer({ art, agents, onClose }) {
  if (!art) return null;
  const displayArt = normalizeArtifactForDisplay(art);
  const owner = ownerForDrawer(displayArt, agents);
  const isPreview = displayArt.kind === 'preview';
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100,
      background: alpha('#000', 32), backdropFilter: 'blur(2px)', display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} className="rt-rise" style={{ width: 'min(620px, 92vw)',
        height: '100%', background: 'var(--surface)', borderLeft: '1px solid var(--border)',
        boxShadow: 'var(--shadow-pop)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px',
          borderBottom: '1px solid var(--border)' }}>
          <Avatar agent={owner} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{displayArt.title}</div>
            <div style={{ marginTop: 2 }}><RoleTag agent={owner} showName /></div>
          </div>
          <VChip v={displayArt.version} />
          <button onClick={onClose} style={iconBtn}><Icon name="x" size={16} /></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 18, background: 'var(--surface-2)' }}>
          {isPreview
            ? <div style={{ borderRadius: 'var(--r-card)', overflow: 'hidden', border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-card)' }}>
                <iframe title="preview" srcDoc={displayArt.preview} sandbox="allow-scripts"
                  style={{ width: '100%', height: 560, border: 'none', display: 'block', background: '#fff' }} />
              </div>
            : displayArt.kind === 'diff'
            ? <div style={{ borderRadius: 'var(--r-card)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                <ArtifactRenderer art={displayArt} agents={agents} /></div>
            : <div style={{ borderRadius: 'var(--r-card)', overflow: 'hidden', border: '1px solid var(--border)',
                background: 'var(--surface)' }}>
                <CodeBlock code={displayArt.code || displayArt.preview || displayArt.uri || ''} /></div>}
        </div>
      </div>
    </div>
  );
}

function ownerForDrawer(art, agents) {
  const ownerId = art.ownerAgentId;
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

/* ---- Aggregate quick actions --------------------------------------------- */

function LiveThread({ messages, handoffs, agents, onRewrite }) {
  const polish = trpc.ai.polish.useMutation();
  const [polishingId, setPolishingId] = React.useState(null);
  const [suggestions, setSuggestions] = React.useState({});

  const handleRewrite = async (m) => {
    setPolishingId(m.id);
    try {
      const result = await polish.mutateAsync({ text: m.content });
      setSuggestions(s => ({ ...s, [m.id]: result.text }));
    } finally {
      setPolishingId(null);
    }
  };
  const dismissSuggestion = (id) => setSuggestions(s => { const n = { ...s }; delete n[id]; return n; });

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {handoffs && handoffs.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              {handoffs.length} hand-off{handoffs.length > 1 ? 's' : ''} in this chat
            </div>
            {handoffs.map((h) => h.card && <HandoffCard key={h.id} ho={h.card} agents={agents} />)}
          </div>
        )}
        {messages.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>No messages yet.</div>
        )}
        {messages.map((m) => {
          const mine = m.authorType === 'user';
          const suggestion = suggestions[m.id];
          return (
            <div key={m.id}>
              <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                <div style={{ maxWidth: '80%', padding: '9px 12px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.5,
                  background: mine ? 'var(--accent)' : 'var(--surface-2)', color: mine ? '#fff' : 'var(--text)',
                  border: mine ? 'none' : '1px solid var(--border)' }}>
                  {!mine && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 2 }}>{m.authorId || m.authorType}</div>}
                  {m.content}
                </div>
              </div>
              {mine && !suggestion && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 3 }}>
                  <button onClick={() => handleRewrite(m)} disabled={polishingId === m.id} title="Rewrite with AI"
                    style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, borderRadius: 6,
                      border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-faint)',
                      opacity: 0.6 }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = 1; e.currentTarget.style.background = 'var(--surface-2)'; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = 0.6; e.currentTarget.style.background = 'transparent'; }}>
                    {polishingId === m.id ? <Spinner size={11} /> : <Icon name="sparkle" size={12} />}
                  </button>
                </div>
              )}
              {mine && suggestion && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                  <div style={{ maxWidth: '80%', padding: '8px 11px', borderRadius: 10, fontSize: 13,
                    background: 'var(--surface-2)', border: '1px solid var(--accent)', color: 'var(--text)', lineHeight: 1.5 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--accent)', fontWeight: 600, marginBottom: 4 }}>✦ AI rewrite</div>
                    <div style={{ marginBottom: 8 }}>{suggestion}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => { onRewrite && onRewrite(suggestion); dismissSuggestion(m.id); }}
                        style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 5, border: 'none',
                          background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>Resend</button>
                      <button onClick={() => dismissSuggestion(m.id)}
                        style={{ fontSize: 11.5, padding: '3px 9px', borderRadius: 5, border: '1px solid var(--border)',
                          background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>Dismiss</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
function FileRow({ art, agents, onOpen, activeChatId }) {
  const owner = agents[art.ownerAgentId];
  const icon = art.kind === 'preview' ? 'eye' : art.kind === 'diff' ? 'code' : art.kind === 'doc' ? 'clip' : 'code';
  const fromSiblingChat = activeChatId && art.createdInChatId && art.createdInChatId !== activeChatId;
  const scopeCopy = fromSiblingChat
    ? `project artifact · from chat ${art.createdInChatId.slice(0, 8)}`
    : art.workbenchId
      ? 'project artifact'
      : null;
  return (
    <button onClick={() => onOpen(art)} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)',
      color: 'var(--text)', font: 'inherit', cursor: 'pointer', marginBottom: 7 }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface)')}>
      <span style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 8, flexShrink: 0,
        background: tint(owner && !art.source.includes('upload') ? owner.color : 'var(--text-faint)', 14),
        color: owner && art.source !== 'uploaded' ? owner.color : 'var(--text-muted)' }}>
        <Icon name={icon} size={15} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {art.title.split('/').pop()}</div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
          {scopeCopy || (art.source === 'uploaded' ? 'you · uploaded' : owner ? owner.displayName + ' · ' + art.kind : art.kind)}
        </div>
      </div>
      <span className="mono tnum" style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 5,
        background: 'var(--surface-3)', color: 'var(--text-muted)', flexShrink: 0 }}>v{art.version}</span>
    </button>
  );
}
function InspectorPanel({ tab, setTab, clock, agents, scene, width, onOpenArtifact, onAction, onClose, authed, live, liveArtifacts, liveMessages, liveHandoffs, activeChatId, localTurns, allLocalTurns, localStatus, onApproveLocalTurn, localTurnActions, onRewrite, memory }) {
  const placed = sceneAt(clock).placed;
  const hasLocalTurns = localTurns && localTurns.length > 0;
  // Files aggregate across the WHOLE chat (allLocalTurns), not just the active
  // turn — a follow-up message must not "reset" the file list to its own
  // intake/plan snapshot while the previous turn's deliverables still exist.
  const artifactTurns = (allLocalTurns && allLocalTurns.length > 0) ? allLocalTurns : localTurns;
  const localArtifacts = hasLocalTurns ? liveArtifactsFromTurns(artifactTurns, agents, localStatus) : [];
  // P3.2: in live mode show the real chat's artifacts (empty until the orchestrator runs) —
  // never fall back to scripted fixtures, which would contradict the live center stage.
  const rawCreated = hasLocalTurns
    ? localArtifacts
    : live
    ? (liveArtifacts ?? []).map((a) => ({ ...a, version: a.currentVersion, source: a.source ?? 'generated' }))
    : placed.map((p) => p.art);
  const created = bundlePreviewArtifacts(rawCreated);
  // The fixture "brief" is demo-only — in live mode there are no user-provided artifacts yet.
  const provided = live || hasLocalTurns ? [] : [RT.ARTIFACTS.brief];
  const notes = meetingNotes(clock);
  const tabBtn = (id, label) => (
    <button onClick={() => setTab(id)} style={{ flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer', font: 'inherit',
      fontSize: 12.5, fontWeight: 600, background: 'transparent', color: tab === id ? 'var(--text)' : 'var(--text-faint)',
      borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}` }}>{label}</button>
  );
  return (
    <div style={{ width: width || 392, flexShrink: 0, borderLeft: '1px solid var(--border)', background: 'var(--surface)',
      display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px 0' }}>
        {tabBtn('chat', 'Chat')}
        {tabBtn('files', `Files · ${created.length + provided.length}`)}
        {tabBtn('notes', 'Notes')}
        {tabBtn('memory', 'Skills')}
        {tabBtn('agentMemory', 'Memory')}
        <button onClick={onClose} style={{ ...iconBtn, border: 'none', background: 'transparent' }}><Icon name="x" size={15} /></button>
      </div>
      <div style={{ borderBottom: '1px solid var(--border)' }} />

      {tab === 'chat' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>
          {hasLocalTurns
            ? <LocalLiveThread turns={localTurns} agents={agents} onApproveTurn={onApproveLocalTurn} turnActions={localTurnActions} />
            : live
            ? <LiveThread messages={liveMessages ?? []} handoffs={liveHandoffs} agents={agents} onRewrite={onRewrite} />
            : <Thread agents={agents} scene={scene} onOpenArtifact={onOpenArtifact} onAction={onAction} narrow />}
        </div>
      ) : tab === 'files' ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 24px' }}>
          {provided.length > 0 && (
            <>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
                color: 'var(--text-faint)', margin: '0 0 9px' }}>Provided by you</div>
              {provided.map((a) => <FileRow key={a.id} art={a} agents={agents} onOpen={onOpenArtifact} activeChatId={activeChatId} />)}
            </>
          )}
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
            color: 'var(--text-faint)', margin: provided.length > 0 ? '16px 0 9px' : '0 0 9px' }}>
            {hasLocalTurns ? 'Local model outputs' : live ? 'Project artifacts' : 'Created in this run'} · {created.length}
          </div>
          {created.length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic', padding: '4px 2px' }}>Nothing yet — artifacts land here as the team works.</div>
            : created.map((a) => <FileRow key={a.id} art={a} agents={agents} onOpen={(art) => onOpenArtifact(withBundledPreview(art, created))} activeChatId={activeChatId} />)}
        </div>
      ) : tab === 'memory' ? (
        <MemoryPanel memory={memory} />
      ) : tab === 'agentMemory' ? (
        <MemoryTab activeChatId={activeChatId} authed={authed} agents={agents} />
      ) : live || hasLocalTurns ? (
        <LiveNotes agents={agents} artifacts={created} handoffs={liveHandoffs} />
      ) : (
        <NotesContent clock={clock} agents={agents} notes={notes} />
      )}
    </div>
  );
}

/* ---- memory tab: this project's per-agent facts, with export -------------- */
function MemoryTab({ activeChatId, authed, agents }) {
  const overviewQ = trpc.agentMemory.overview.useQuery(
    { chatId: activeChatId || undefined },
    { enabled: !!authed, refetchInterval: 20000 },
  );
  const utils = trpc.useUtils();
  const [exporting, setExporting] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const importInputRef = useRef(null);
  const importMemory = trpc.agentMemory.import.useMutation({
    onSuccess: (result) => {
      setImportMessage(`Imported ${result.imported.length} fact${result.imported.length === 1 ? '' : 's'}.`);
      utils.agentMemory.overview.invalidate();
    },
    onError: (error) => setImportMessage(`Import failed: ${error.message}`),
  });
  const onExport = async () => {
    if (!activeChatId) return;
    setExporting(true);
    try {
      const bundle = await utils.agentMemory.export.fetch({ chatId: activeChatId });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `roundtable-memory-${bundle.exportedAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };
  const onImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !activeChatId) return;
    setImportMessage('');
    try {
      const bundle = JSON.parse(await file.text());
      if (!Array.isArray(bundle?.files) || bundle.files.length === 0) throw new Error('Bundle has no memory files.');
      await importMemory.mutateAsync({ chatId: activeChatId, files: bundle.files });
    } catch (error) {
      setImportMessage(`Import failed: ${error instanceof Error ? error.message : 'Invalid bundle.'}`);
    }
  };
  const overviews = overviewQ.data ?? [];
  // alpha() takes a 0-100 percentage, matching the rest of primitives.jsx.
  const badge = (label, color) => (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
      background: alpha(color, 12), color }}>{label}</span>
  );
  // `agents` is a map keyed by agent id (see FileRow: agents[art.ownerAgentId]).
  const profileFor = (agentId) => (agents || {})[agentId];
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 12px' }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
          Agent memory
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input ref={importInputRef} type="file" accept="application/json,.json" onChange={onImport}
            style={{ display: 'none' }} />
          <button onClick={() => importInputRef.current?.click()} disabled={!activeChatId || importMemory.isPending}
            title="Import a Roundtable memory bundle into this project"
            style={{ ...iconBtn, width: 'auto', padding: '0 9px', fontSize: 11.5, fontWeight: 600, gap: 5 }}>
            <Icon name="plus" size={13} /> {importMemory.isPending ? 'Importing…' : 'Import'}
          </button>
          <button onClick={onExport} disabled={exporting || overviews.length === 0 || !activeChatId}
            title="Download this project's agent memory as a portable bundle"
            style={{ ...iconBtn, width: 'auto', padding: '0 10px', fontSize: 11.5, fontWeight: 600, gap: 5,
              opacity: overviews.length === 0 || !activeChatId ? 0.5 : 1 }}>
            <Icon name="clip" size={13} /> {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
      {importMessage && (
        <div style={{ fontSize: 11.5, color: importMessage.startsWith('Import failed') ? 'var(--bad)' : 'var(--ok)',
          margin: '-5px 0 10px' }}>{importMessage}</div>
      )}
      {overviewQ.isLoading ? (
        <div style={{ padding: '8px 2px' }}><Spinner /></div>
      ) : overviews.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic', padding: '4px 2px' }}>
          No memory yet — agents write facts here as they work, and reuse them in later missions.
        </div>
      ) : overviews.map((agent) => (
        <div key={agent.agentId} style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 7px' }}>
            {profileFor(agent.agentId) && <Avatar agent={profileFor(agent.agentId)} size={22} />}
            <span style={{ fontSize: 13, fontWeight: 600 }}>{agent.displayName}</span>
            {profileFor(agent.agentId)
              ? <RoleTag agent={profileFor(agent.agentId)} />
              : <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>@{agent.role}</span>}
          </div>
          {agent.compactionNeeds.map((need, index) => (
            <div key={index} style={{ fontSize: 11.5, color: 'var(--warn, #b45309)', margin: '0 0 6px', lineHeight: 1.4 }}>
              ⚠ {need}
            </div>
          ))}
          {agent.facts.map((fact) => (
            <div key={fact.slug} style={{ display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '7px 9px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
              background: 'var(--surface-2)', marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--mono, monospace)' }}>{fact.slug}</span>
                  {fact.type !== 'note' && badge(fact.type, fact.type === 'unreviewed' ? '#b45309' : 'var(--text-faint)')}
                  {fact.overLimit && badge('over budget', '#dc2626')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2, lineHeight: 1.4 }}>{fact.description}</div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---- live notes: real deliverables + hand-offs for the selected chat ------ */
function LiveNotes({ agents, artifacts, handoffs }) {
  const arts = artifacts || [];
  const hos = handoffs || [];
  if (arts.length === 0 && hos.length === 0) {
    return (
      <div style={{ flex: 1, padding: '16px 16px 24px' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>
          Notes fill in as the team works — deliverables, hand-offs, and reviews land here once the orchestrator runs.</div>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px' }}>
      {hos.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
            color: 'var(--text-faint)', marginBottom: 8 }}>Activity</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              <Icon name="layers" size={13} style={{ color: 'var(--text-faint)', marginTop: 3, flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>
                {hos.length} hand-off{hos.length > 1 ? 's' : ''} coordinated by the facilitator</span>
            </div>
            {hos.map((h) => h.card && <HandoffCard key={h.id} ho={h.card} agents={agents} />)}
          </div>
        </div>
      )}
      {arts.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
            color: 'var(--text-faint)', marginBottom: 8 }}>Deliverables · {arts.length}</div>
          {arts.map((a) => {
            const ow = agents[a.ownerAgentId];
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
                <Avatar agent={ow} size={20} ring={false} />
                <span className="mono" style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.title.split('/').pop()}</span>
                <span className="mono tnum" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>v{a.version}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


function NotesContent({ clock, agents, notes }) {
  const placed = sceneAt(clock).placed;
  const Section = ({ label, children }) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
  const Item = ({ children, icon }) => (
    <div style={{ display: 'flex', gap: 9, marginBottom: 8, alignItems: 'flex-start' }}>
      <Icon name={icon || 'dot'} size={13} style={{ color: 'var(--text-faint)', marginTop: 3, flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>{children}</span>
    </div>
  );
  const decisions = clock >= 2900;
  const reviewed = clock >= 19000;
  const doneR = clock >= 22400;
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px' }}>
      {!decisions && <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>Notes fill in as decisions are made.</div>}
      {decisions && (
        <Section label="Decisions">
          <Item icon="check">Deploy target — <b>Vercel + Postgres</b></Item>
          <Item icon="check">Server-rendered form, no client JS for submit</Item>
          <Item icon="check">Work split into <b>3 parallel tasks</b></Item>
        </Section>
      )}
      {placed.length > 0 && (
        <Section label={`Deliverables · ${placed.length}`}>
          {placed.map((p) => {
            const ow = agents[p.ownerAgentId];
            return (
              <div key={p.art.id} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
                <Avatar agent={ow} size={20} ring={false} />
                <span className="mono" style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.art.title.split('/').pop()}</span>
                <span className="mono tnum" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>v{p.art.version}</span>
              </div>
            );
          })}
        </Section>
      )}
      {reviewed && (
        <Section label="Review">
          <Item icon="eye">1 accessibility nit — email field needs a label. <b style={{ color: 'var(--warn)' }}>fix available</b></Item>
        </Section>
      )}
      {doneR && (
        <Section label="Next steps">
          <Item icon="wrench">Apply the review fix (1)</Item>
          <Item icon="rocket">Deploy to Vercel</Item>
        </Section>
      )}
    </div>
  );
}

/* ---- Breakout room (a real side room you can sit in) --------------------- */

export { Drawer, InspectorPanel };
