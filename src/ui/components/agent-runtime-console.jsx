'use client';

import React from 'react';
import { Avatar, Icon } from './primitives';

const { useEffect, useMemo, useState } = React;

const shell = {
  minHeight: '100vh',
  background: 'var(--bg)',
  color: 'var(--text)',
  display: 'flex',
  flexDirection: 'column',
};

const card = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  boxShadow: 'var(--shadow-card)',
};

const btn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--surface)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12,
  padding: '6px 9px',
  cursor: 'pointer',
};

const field = {
  height: 31,
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--surface-2)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12,
  padding: '0 8px',
  outline: 'none',
};

const badge = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 20,
  border: '1px solid var(--border)',
  borderRadius: 999,
  padding: '0 7px',
  fontSize: 10.5,
  color: 'var(--text-faint)',
  background: 'var(--surface)',
  whiteSpace: 'nowrap',
};

const interactionOptions = [
  { value: '', label: 'Confirm: runtime default' },
  { value: 'auto', label: 'Confirm: auto' },
  { value: 'manual', label: 'Confirm: manual' },
];

const runtimeInteractionOptions = [
  { value: '', label: 'Confirm: auto' },
  { value: 'auto', label: 'Confirm: auto' },
  { value: 'manual', label: 'Confirm: manual' },
];

const effortOptions = [
  { value: '', label: 'Effort: default' },
  { value: 'low', label: 'Effort: low' },
  { value: 'medium', label: 'Effort: medium' },
  { value: 'high', label: 'Effort: high' },
  { value: 'xhigh', label: 'Effort: xhigh' },
  { value: 'max', label: 'Effort: max' },
];

function AgentRuntimeConsole() {
  const [state, setState] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [runtimeDrafts, setRuntimeDrafts] = useState({});
  const [expandedRuntimes, setExpandedRuntimes] = useState({});
  const [message, setMessage] = useState({});
  const [saving, setSaving] = useState(null);
  const [savingRuntime, setSavingRuntime] = useState(null);
  const [activatingAgentCli, setActivatingAgentCli] = useState(false);
  const [error, setError] = useState('');

  const hasRunning = useMemo(
    () => (state?.conversations || []).some((conversation) => conversation.status === 'running'),
    [state],
  );

  const load = async () => {
    try {
      const res = await fetch('/api/agent-runtimes', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'runtime_state_failed');
      setState(data.state);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const agent of data.state.agents || []) {
          if (!next[agent.id]) {
            next[agent.id] = {
              runtime: agent.runtime,
              command: agent.command || '',
              model: agent.model || '',
              modelProvider: agent.modelProvider || '',
              interactionMode: agent.interactionMode || '',
              effort: agent.effort || '',
              argsText: (agent.args || []).join(' '),
            };
          }
        }
        return next;
      });
      setRuntimeDrafts((prev) => {
        const next = { ...prev };
        for (const runtime of data.state.supported || []) {
          if (!next[runtime.kind]) {
            next[runtime.kind] = {
              command: runtime.command || '',
              model: runtime.model || '',
              modelProvider: runtime.modelProvider || '',
              interactionMode: runtime.interactionMode || '',
              effort: runtime.effort || '',
              argsText: (runtime.args || []).join(' '),
              envText: '',
              clearEnv: false,
            };
          }
        }
        return next;
      });
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const timer = setInterval(load, hasRunning ? 2000 : 6000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const runtimeOptions = state?.supported || [];
  const modelProviderOptions = state?.modelProviders || [];
  const agents = state?.agents || [];
  const agentLookup = useMemo(
    () => Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const conversations = state?.conversations || [];
  const executionAdapter = state?.executionAdapter || 'local-dispatch';
  const executionSource = state?.executionAdapterSource || 'built-in';
  const executionModelProvider = state?.executionModelProvider || null;
  const workflowUsesAgentCli = executionAdapter === 'agent-cli';
  const workflowUsesModelApi = executionSource === 'model-provider' || executionAdapter === 'minimax' || executionAdapter === 'openai-compat';

  const updateDraft = (agentId, patch) => {
    setDrafts((prev) => ({ ...prev, [agentId]: { ...(prev[agentId] || {}), ...patch } }));
  };

  const updateRuntimeDraft = (runtimeKind, patch) => {
    setRuntimeDrafts((prev) => ({ ...prev, [runtimeKind]: { ...(prev[runtimeKind] || {}), ...patch } }));
  };

  const toggleRuntime = (runtimeKind) => {
    setExpandedRuntimes((prev) => ({ ...prev, [runtimeKind]: !prev[runtimeKind] }));
  };

  const save = async (agentId) => {
    const draft = drafts[agentId] || {};
    setSaving(agentId);
    try {
      const res = await fetch('/api/agent-runtimes/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          runtime: draft.runtime,
          command: draft.command || null,
          model: draft.model || null,
          modelProvider: draft.modelProvider || null,
          interactionMode: draft.interactionMode || null,
          effort: draft.effort || null,
          args: splitArgs(draft.argsText || ''),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'save_runtime_failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const saveRuntimeDefault = async (runtimeKind) => {
    const draft = runtimeDrafts[runtimeKind] || {};
    const env = parseEnvText(draft.envText || '');
    const body = {
      runtime: runtimeKind,
      command: draft.command || null,
      model: draft.model || null,
      modelProvider: draft.modelProvider || null,
      interactionMode: draft.interactionMode || null,
      effort: draft.effort || null,
      args: splitArgs(draft.argsText || ''),
      clearEnv: Boolean(draft.clearEnv),
    };
    if (Object.keys(env).length > 0) body.env = env;
    setSavingRuntime(runtimeKind);
    try {
      const res = await fetch('/api/agent-runtimes/defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'save_runtime_default_failed');
      setRuntimeDrafts((prev) => ({
        ...prev,
        [runtimeKind]: { ...(prev[runtimeKind] || {}), envText: '', clearEnv: false },
      }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRuntime(null);
    }
  };

  const activateAgentCli = async () => {
    setActivatingAgentCli(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultAgentAdapter: 'agent-cli' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'activate_agent_cli_failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivatingAgentCli(false);
    }
  };

  const clearExecutionOverride = async () => {
    setActivatingAgentCli(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultAgentAdapter: null }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'clear_agent_cli_failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivatingAgentCli(false);
    }
  };

  const sendDirect = async (agentId) => {
    const content = (message[agentId] || '').trim();
    if (!content) return;
    setMessage((prev) => ({ ...prev, [agentId]: '' }));
    try {
      const res = await fetch('/api/agent-runtimes/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, message: content }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'direct_runtime_failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async (conversationId) => {
    try {
      const res = await fetch('/api/agent-runtimes/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, action: 'stop' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'stop_runtime_failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main style={shell}>
      <header style={{ height: 54, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px',
        borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        <a href="/" style={{ ...btn, textDecoration: 'none' }}><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} /> Roundtable</a>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Agent CLI Console</h1>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{conversations.filter((item) => item.status === 'running').length} running</span>
        </div>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11.5, color: workflowUsesAgentCli || workflowUsesModelApi ? 'var(--ok)' : 'var(--warn)',
          padding: '6px 9px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          workflow: {executionAdapter} · {sourceLabel(executionSource, executionModelProvider)}
        </span>
        {workflowUsesAgentCli && (
          <button onClick={clearExecutionOverride} style={btn}>
            <Icon name="wrench" size={14} /> {activatingAgentCli ? 'Switching' : 'Use Auto'}
          </button>
        )}
        {!workflowUsesAgentCli && (
          <button onClick={activateAgentCli} style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none' }}>
            <Icon name="code" size={14} /> {activatingAgentCli ? 'Switching' : 'Use Agent CLI'}
          </button>
        )}
        <a href="/settings" style={{ ...btn, textDecoration: 'none' }}><Icon name="wrench" size={14} /> Settings</a>
        <button onClick={load} style={btn}><Icon name="search" size={14} /> Refresh</button>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 460px) minmax(0, 1fr)', gap: 12,
        padding: 12, flex: 1, minHeight: 0 }}>
        <section style={{ ...card, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={sectionHead}>Agent CLI Overrides</div>
          <div style={{ overflowY: 'auto', padding: 8, display: 'grid', gap: 7 }}>
            {agents.map((agent) => {
              const draft = drafts[agent.id] || {};
              return (
                <div key={agent.id} style={{ border: '1px solid var(--border)', borderRadius: 7, padding: 8,
                  background: 'var(--surface-2)', display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: agent.ready ? 'var(--ok)' : 'var(--bad)', flexShrink: 0 }} />
                    <Avatar agent={{ id: agent.id, displayName: agent.name, role: agent.role, color: roleColor(agent.role) }} size={24} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{agent.name}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{agent.id} · {agent.role}</div>
                      <div className="mono" style={{ marginTop: 2, fontSize: 10.5, color: agent.ready ? 'var(--text-faint)' : 'var(--bad)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {agent.ready ? agentRuntimeStatus(agent) : agent.readyReason}
                      </div>
                    </div>
                    <span style={{ ...badge, color: agent.configured ? 'var(--accent)' : 'var(--text-faint)' }}>
                      {agent.configured ? 'configured' : 'default'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
                    <select value={draft.runtime || agent.runtime} onChange={(e) => updateDraft(agent.id, { runtime: e.target.value })} style={field}>
                      {runtimeOptions.map((runtime) => (
                        <option key={runtime.kind} value={runtime.kind}>{runtime.label}</option>
                      ))}
                    </select>
                    <input value={draft.model || ''} onChange={(e) => updateDraft(agent.id, { model: e.target.value })}
                      placeholder="model" style={field} />
                    <select value={draft.interactionMode || ''} onChange={(e) => updateDraft(agent.id, { interactionMode: e.target.value })} style={field}>
                      {interactionOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <select value={draft.effort || ''} onChange={(e) => updateDraft(agent.id, { effort: e.target.value })} style={field}>
                      {effortOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <select value={draft.modelProvider || ''} onChange={(e) => updateDraft(agent.id, { modelProvider: e.target.value })} style={{ ...field, gridColumn: '1 / -1' }}>
                      <option value="">API provider: runtime default</option>
                      {modelProviderOptions.map((provider) => (
                        <option key={provider.provider} value={provider.provider}>
                          {provider.label}{provider.configured ? '' : ' (not configured)'}
                        </option>
                      ))}
                    </select>
                    <input value={draft.command || ''} onChange={(e) => updateDraft(agent.id, { command: e.target.value })}
                      placeholder="command override" style={{ ...field, gridColumn: '1 / -1' }} />
                    <input value={draft.argsText || ''} onChange={(e) => updateDraft(agent.id, { argsText: e.target.value })}
                      placeholder="args, use {prompt}" style={{ ...field, gridColumn: '1 / -1' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 7 }}>
                    <button onClick={() => save(agent.id)} style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none' }}>
                      <Icon name="check" size={13} /> {saving === agent.id ? 'Saving' : 'Save'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 7 }}>
                    <input value={message[agent.id] || ''} onChange={(e) => setMessage((prev) => ({ ...prev, [agent.id]: e.target.value }))}
                      placeholder={`Message ${agent.name}`} style={{ ...field, flex: 1 }} />
                    <button disabled={!agent.ready} onClick={() => sendDirect(agent.id)}
                      style={{ ...btn, opacity: agent.ready ? 1 : 0.45, cursor: agent.ready ? 'pointer' : 'not-allowed' }}>
                      <Icon name="send" size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', gap: 16, minHeight: 0 }}>
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={sectionHead}>CLI Runtime Overrides</div>
            <div style={{ display: 'grid', gap: 8, padding: 8 }}>
              {runtimeOptions.map((runtime) => {
                const draft = runtimeDrafts[runtime.kind] || {};
                const isLocal = runtime.kind === 'local-dispatch';
                const expanded = Boolean(expandedRuntimes[runtime.kind]);
                return (
                  <div key={runtime.kind} style={{ border: '1px solid var(--border)', borderRadius: 7,
                    background: runtime.ready ? 'var(--surface-2)' : 'color-mix(in oklab, var(--bad) 7%, var(--surface))',
                    overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px',
                      borderBottom: expanded && !isLocal ? '1px solid var(--border)' : 'none', minWidth: 0 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: runtime.ready ? 'var(--ok)' : 'var(--bad)', flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 760, whiteSpace: 'nowrap' }}>{runtime.label}</div>
                          <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{runtime.binary || runtime.kind}</span>
                          <span style={{ ...badge, color: runtime.ready ? 'var(--ok)' : 'var(--bad)' }}>
                            {runtime.ready ? 'ready' : 'missing'}
                          </span>
                          <span style={{ ...badge, color: runtime.configured ? 'var(--accent)' : 'var(--text-faint)' }}>
                            {runtime.configured ? 'configured' : 'default'}
                          </span>
                        </div>
                        <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr) minmax(100px, .55fr)', gap: 8 }}>
                          <RuntimeStatusCell
                            label="install"
                            ok={runtime.ready || Boolean(runtime.commandPath)}
                            value={runtimeInstallValue(runtime)}
                          />
                          <RuntimeStatusCell
                            label="login"
                            ok={runtime.authConfigured}
                            value={runtimeAuthValue(runtime)}
                          />
                          <RuntimeStatusCell
                            label="mode"
                            ok
                            value={runtimeModeValue(runtime)}
                          />
                        </div>
                      </div>
                      {!isLocal && (
                        <button onClick={() => toggleRuntime(runtime.kind)} style={{ ...btn, flexShrink: 0 }}>
                          <Icon name="wrench" size={13} /> {expanded ? 'Close' : 'Configure'}
                        </button>
                      )}
                    </div>

                    {!isLocal && expanded && (
                      <div style={{ padding: 10, display: 'grid', gap: 8 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 7 }}>
                          <input value={draft.command || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { command: e.target.value })}
                            placeholder={runtime.binary ? `command (${runtime.binary})` : 'command'} style={field} />
                          <input value={draft.model || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { model: e.target.value })}
                            placeholder="model" style={field} />
                          <select value={draft.interactionMode || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { interactionMode: e.target.value })} style={field}>
                            {runtimeInteractionOptions.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          <select value={draft.effort || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { effort: e.target.value })} style={field}>
                            {effortOptions.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          <select value={draft.modelProvider || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { modelProvider: e.target.value })} style={{ ...field, gridColumn: '1 / -1' }}>
                            <option value="">API provider: none</option>
                            {modelProviderOptions.map((provider) => (
                              <option key={provider.provider} value={provider.provider}>
                                {provider.label}{provider.configured ? '' : ' (not configured)'}
                              </option>
                            ))}
                          </select>
                          <input value={draft.argsText || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { argsText: e.target.value })}
                            placeholder="args, use {prompt}" style={{ ...field, gridColumn: '1 / -1' }} />
                          <textarea value={draft.envText || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { envText: e.target.value })}
                            placeholder="ENV_KEY=value" rows={3} style={{ ...field, height: 58, resize: 'vertical', paddingTop: 7, gridColumn: '1 / -1' }} />
                        </div>
                        <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                          <button onClick={() => saveRuntimeDefault(runtime.kind)}
                            style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none' }}>
                            <Icon name="check" size={13} /> {savingRuntime === runtime.kind ? 'Saving' : 'Save'}
                          </button>
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-faint)' }}>
                            <input type="checkbox" checked={Boolean(draft.clearEnv)}
                              onChange={(e) => updateRuntimeDraft(runtime.kind, { clearEnv: e.target.checked })} />
                            Clear env
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ ...card, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={sectionHead}>CLI Conversations</div>
            <div style={{ overflowY: 'auto', padding: 8, display: 'grid', gap: 7 }}>
              {conversations.length === 0 && (
                <div style={{ padding: 18, color: 'var(--text-faint)', fontSize: 13 }}>No runtime conversations yet.</div>
              )}
              {conversations.map((conversation) => (
                <ConversationCard key={conversation.id} conversation={conversation} agent={agentLookup[conversation.agentId]} onStop={stop} />
              ))}
            </div>
          </div>
        </section>
      </div>
      {error && <div style={{ position: 'fixed', right: 16, bottom: 16, maxWidth: 420, padding: '10px 12px',
        borderRadius: 8, background: 'var(--bad)', color: '#fff', fontSize: 12.5 }}>{error}</div>}
    </main>
  );
}

function ConversationCard({ conversation, agent, onStop }) {
  const latest = conversation.transcript.slice(-5);
  const agentName = agent?.name || conversation.agentId;
  const subtitle = [
    agentName,
    conversation.pid ? `pid ${conversation.pid}` : '',
    shortTime(conversation.startedAt),
  ].filter(Boolean).join(' · ');
  return (
    <article style={{ border: '1px solid var(--border)', borderRadius: 7, background: 'var(--surface-2)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(conversation.status) }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <strong style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversation.title}</strong>
            <span className="mono" style={{ ...badge, flexShrink: 0 }}>{compactRuntimeLabel(conversation.runtime)}</span>
            <span style={{ ...badge, color: statusColor(conversation.status), flexShrink: 0 }}>{conversation.status}</span>
          </div>
          <div className="mono" style={{ marginTop: 3, fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        </div>
        {conversation.status === 'running' && (
          <button onClick={() => onStop(conversation.id)} style={{ ...btn, color: 'var(--bad)' }}>
            <Icon name="x" size={13} /> Stop
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gap: 5, padding: 8 }}>
        {latest.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Waiting for output.</div>
        ) : latest.map((line) => (
          <div key={`${line.at}-${line.content.slice(0, 12)}`} style={{ display: 'grid', gridTemplateColumns: '68px minmax(0, 1fr)', gap: 8,
            padding: '5px 7px', background: 'var(--surface)', borderRadius: 5, borderLeft: `2px solid ${kindColor(line.kind)}` }}>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{line.kind}</div>
            <div style={{ fontSize: 12, lineHeight: 1.4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{line.content}</div>
          </div>
        ))}
      </div>
    </article>
  );
}

function RuntimeStatusCell({ label, ok = false, value }) {
  return (
    <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: ok ? 'var(--ok)' : 'var(--text-faint)', flexShrink: 0 }} />
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0 }}>
        {label}
      </span>
      <span className="mono" style={{ minWidth: 0, fontSize: 11, color: ok ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </span>
    </div>
  );
}

function splitArgs(raw) {
  return raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function parseEnvText(raw) {
  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && value) env[key] = value;
  }
  return env;
}

function runtimeInstallValue(runtime) {
  if (runtime.kind === 'local-dispatch') return 'built in';
  const command = runtime.command || runtime.binary || runtime.kind;
  const version = compactVersion(runtime.detectedVersion);
  if (runtime.commandPath) return [command, version].filter(Boolean).join(' · ');
  return runtime.readyReason || `missing ${command}`;
}

function runtimeAuthValue(runtime) {
  if (runtime.kind === 'local-dispatch') return 'built in';
  if (!runtime.authConfigured) return 'not detected';
  const sources = (runtime.authSources || []).filter((source) => source !== 'not-required');
  if (sources.length === 0) return 'not required';
  return sources.map(compactAuthSource).join(' · ');
}

function runtimeModeValue(runtime) {
  const confirm = runtime.interactionMode || 'auto';
  const effort = runtime.effort || 'default';
  return `${confirm} · ${effort}`;
}

function compactVersion(value) {
  if (!value) return '';
  const match = value.match(/\d+(?:\.\d+){1,3}/);
  return match ? match[0] : value.replace(/^v\s*/i, '').slice(0, 28);
}

function compactAuthSource(source) {
  return source
    .replace(/^~\/\.local\/share\/opencode\/auth\.json$/, 'opencode auth')
    .replace(/^~\/\.config\/opencode\/auth\.json$/, 'opencode config')
    .replace(/^~\/\.claude\.json$/, '~/.claude.json')
    .replace(/^~\/\.claude$/, '~/.claude')
    .replace(/^~\/\.codex$/, '~/.codex');
}

function agentRuntimeStatus(agent) {
  return [
    agent.runtime,
    agent.detectedVersion ? `v ${agent.detectedVersion}` : '',
    agent.authSources?.length ? agent.authSources.join(', ') : '',
  ].filter(Boolean).join(' · ');
}

function compactRuntimeLabel(runtime) {
  return {
    'local-dispatch': 'local',
    'claude-code': 'Claude',
    'claude-code-router': 'CCR',
    codex: 'Codex',
    opencode: 'OpenCode',
  }[runtime] || runtime;
}

function shortTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sourceLabel(source, modelProvider) {
  if (source === 'model-provider') return modelProvider || 'model API';
  return {
    settings: 'settings',
    env: 'env',
    'runtime-config': 'runtime config',
    'built-in': 'built in',
  }[source] || 'auto';
}

function roleColor(role) {
  return {
    planner: '#5f86b8',
    pm: '#b27858',
    architect: '#8b7cf6',
    implementer: '#4cc38a',
    reviewer: '#e6a23c',
    fixer: '#c47766',
  }[role] || '#938b7c';
}

function statusColor(status) {
  return {
    running: 'var(--run)',
    completed: 'var(--ok)',
    failed: 'var(--bad)',
    stopped: 'var(--warn)',
  }[status] || 'var(--text-faint)';
}

function kindColor(kind) {
  return {
    status: 'var(--accent)',
    thinking: 'var(--run)',
    response: 'var(--ok)',
    error: 'var(--bad)',
  }[kind] || 'var(--border-strong)';
}

const sectionHead = {
  height: 40,
  display: 'flex',
  alignItems: 'center',
  padding: '0 12px',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
  fontWeight: 750,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

export default AgentRuntimeConsole;
