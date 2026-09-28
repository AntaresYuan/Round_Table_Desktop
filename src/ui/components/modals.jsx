/* ============================================================================
   Roundtable — modals.jsx
   The product flows that make the workflow real: create a Task, create a
   Workbench from a workflow template (or build your own), add/manage agents.
   These embody the pitch: packaged + customizable agent workflows.
   ============================================================================ */
import React from 'react';
import { RT } from '../lib/rt';
import { Icon, Avatar, tint, alpha } from './primitives';
import { trpc } from '../lib/trpc';
import { useSession } from 'next-auth/react';
const { useState: useStateM } = React;
const iconBtn = { display: 'grid', placeItems: 'center', width: 30, height: 30, flexShrink: 0, borderRadius: 'var(--r-sm)',
  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer' };

/* ---- shared modal shell -------------------------------------------------- */
function Modal({ title, sub, icon, onClose, children, footer, width = 540 }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 120, background: alpha('#000', 38),
      backdropFilter: 'blur(3px)', overflowY: 'auto' }}>
      <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box' }}>
        <div onClick={(e) => e.stopPropagation()} className="rt-zoom" style={{ width: `min(${width}px, 100%)`,
          transformOrigin: 'center', background: 'var(--surface)', borderRadius: 'var(--r-card)',
          border: '1px solid var(--border)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--border)' }}>
            {icon && <span style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, borderRadius: 9,
              background: tint('var(--accent)', 14), color: 'var(--accent)' }}><Icon name={icon} size={17} /></span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
              {sub && <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>{sub}</div>}
            </div>
            <button onClick={onClose} style={iconBtn}><Icon name="x" size={16} /></button>
          </div>
          <div style={{ padding: 18 }}>{children}</div>
          {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, padding: '13px 18px',
            borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>{footer}</div>}
        </div>
      </div>
    </div>
  );
}
function Btn({ children, primary, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = primary ? '#6a59ab' : 'var(--surface-2)'; }}
      onMouseLeave={(e) => { if (!disabled) e.currentTarget.style.background = primary ? 'var(--accent)' : 'var(--surface)'; }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 13px', borderRadius: 'var(--r-sm)', font: 'inherit', fontSize: 13.5, fontWeight: 500,
      cursor: disabled ? 'default' : 'pointer', border: primary ? 'none' : '1px solid var(--border)',
      background: primary ? (disabled ? 'var(--surface-3)' : 'var(--accent)') : 'var(--surface)',
      color: primary ? (disabled ? 'var(--text-faint)' : '#fff') : 'var(--text)',
      boxShadow: primary ? 'none' : '0 1px 1px rgba(40,40,70,.04)', transition: 'background .12s' }}>{children}</button>
  );
}
const fieldStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text)', font: 'inherit', fontSize: 13.5, outline: 'none' };

/* ---- the workflow pipeline (a packaged, customizable process) ------------ */
function Pipeline({ steps, editable }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap' }}>
      {steps.map((s, i) => (
        <React.Fragment key={i}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 11px', borderRadius: 'var(--r-chip)',
            background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: 12, fontWeight: 500 }}>
            <Icon name={s.icon} size={13} style={{ color: 'var(--accent)' }} />{s.label}
          </div>
          {i < steps.length - 1 && <Icon name="chevron" size={13} style={{ color: 'var(--text-faint)', margin: '0 4px' }} />}
        </React.Fragment>
      ))}
      {editable && <button style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px',
        borderRadius: 'var(--r-chip)', border: '1px dashed var(--border-strong)', background: 'transparent',
        color: 'var(--text-faint)', font: 'inherit', fontSize: 12, cursor: 'pointer' }}><Icon name="plus" size={12} /> step</button>}
    </div>
  );
}

// Gallery cards are PROJECTIONS of the real BUILTIN_WORKFLOWS / user workflows
// (ADR-009 — one model, no stored second shape). See rt.js workflowToGalleryCard.

/* ---- New Workbench (workflow template gallery + custom) ------------------ */
function NewWorkbenchModal({ agents, onClose, onCreate }) {
  const [sel, setSel] = useStateM('wf-fullstack');
  const [name, setName] = useStateM('');
  const allTemplates = RT.BUILTIN_WORKFLOWS.concat(RT.workflows || []).map(RT.workflowToGalleryCard);
  const tpl = allTemplates.find((t) => t.id === sel);
  const roleColors = RT.ROLE_COLORS;
  return (
    <Modal title="New workbench" sub="A workbench is a fixed team + a workflow. Pick a proven one or build your own." icon="layers"
      onClose={onClose} width={680}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={!name.trim()} onClick={() => onCreate({ name, workflowId: tpl.id })}>Create workbench</Btn></>}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Name</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mobile Squad" style={fieldStyle} autoFocus />
      </div>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 9 }}>Start from a workflow</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
        {allTemplates.map((t) => {
          const active = sel === t.id;
          return (
            <button key={t.id} onClick={() => setSel(t.id)} style={{ textAlign: 'left', padding: '13px 14px', cursor: 'pointer',
              borderRadius: 'var(--r-card)', font: 'inherit', background: active ? tint('var(--accent)', 8) : 'var(--surface-2)',
              border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{t.name}</span>
                {t.tag && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 4,
                  background: tint('var(--accent)', 16), color: 'var(--accent)' }}>{t.tag}</span>}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45, marginBottom: 9 }}>{t.desc}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {t.roles.length ? t.roles.map((r, i) => (
                  <span key={i} title={'@' + r} style={{ display: 'inline-flex' }}><Avatar agent={{ id: r, color: roleColors[r] }} size={22} /></span>
                )) : <span style={{ fontSize: 11.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>empty — you choose</span>}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ padding: '14px 16px', borderRadius: 'var(--r-card)', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)' }}>Workflow</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>· runs automatically, fully customizable</span>
        </div>
        <Pipeline steps={tpl.pipe} editable={tpl.custom} />
      </div>
    </Modal>
  );
}

/* ---- New Mission --------------------------------------------------------- */
function NewTaskModal({ workbench, members, agents, suggestionContext, onClose, onCreate }) {
  const [goal, setGoal] = useStateM('');
  const [workflowTemplateId, setWorkflowTemplateId] = useStateM('wf-feature-builder');
  const polish = trpc.ai.polish.useMutation({ onSuccess: (r) => setGoal(r.text) });
  const { status: authStatus } = useSession();
  const suggestQ = trpc.ai.suggestTasks.useQuery({ context: suggestionContext || '' }, {
    retry: false,
    staleTime: 60_000,
  });
  const templatesQ = trpc.missions.templates.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const fallbackMissionTemplates = [
    {
      id: 'wf-feature-builder',
      name: 'Feature Builder',
      tag: 'Flagship',
      desc: 'Plan, build, review, and prepare a trusted delivery report.',
      pipe: [
        { icon: 'search', label: 'Clarify' },
        { icon: 'layers', label: 'Plan' },
        { icon: 'code', label: 'Build' },
        { icon: 'eye', label: 'Review' },
        { icon: 'rocket', label: 'Report' },
      ],
    },
    {
      id: 'wf-bug-fixer',
      name: 'Bug Fixer',
      tag: 'Diagnosis',
      desc: 'Diagnose, patch, verify, and summarize residual risk.',
      pipe: [
        { icon: 'search', label: 'Diagnose' },
        { icon: 'wrench', label: 'Patch' },
        { icon: 'eye', label: 'Verify' },
        { icon: 'rocket', label: 'Report' },
      ],
    },
    {
      id: 'wf-codebase-onboarding',
      name: 'Codebase Onboarding',
      tag: 'Discovery',
      desc: 'Map an unfamiliar repo and propose starter tasks.',
      pipe: [
        { icon: 'layers', label: 'Map' },
        { icon: 'eye', label: 'Check' },
        { icon: 'rocket', label: 'Next tasks' },
      ],
    },
  ];
  const missionTemplates = (templatesQ.data || fallbackMissionTemplates).map((template) => ({
    id: template.id,
    name: template.name,
    tag: template.tag,
    desc: template.desc,
    pipe: (template.pipe || template.stages?.filter((stage) => stage.kind !== 'intake').map((stage) => ({
      icon: stage.icon,
      label: stage.kind === 'ship' ? 'Delivery' : stage.name,
    })) || []),
  }));
  const selectedTemplate = missionTemplates.find((template) => template.id === workflowTemplateId) || missionTemplates[0];
  // Suggestion chips come from the server scene library, ranked by recent context.
  const examples = suggestQ.data ?? [
    { title: 'Pricing page', goal: 'Build a pricing page with monthly/annual billing toggle, plan comparison, FAQ, and conversion-focused CTA.' },
    { title: 'CSV export endpoint', goal: 'Build a REST endpoint for CSV export with filters, authorization checks, streaming response, and error handling.' },
    { title: 'Dark mode', goal: 'Add dark mode across the app with persisted preference, token updates, and visual regression review.' },
  ];
  return (
    <Modal title="New Mission" sub={`${workbench?.name} will run a real workflow from this goal`} icon="plus" onClose={onClose} width={680}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={!goal.trim()} onClick={() => onCreate({ goal, workflowTemplateId })}>Start Mission</Btn></>}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Mission goal</div>
      <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} autoFocus
        placeholder="Describe the outcome in plain language — Roundtable will create a Mission, plan it, and wait for approval." style={{ ...fieldStyle, resize: 'vertical' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button onClick={() => goal.trim() && polish.mutate({ text: goal.trim() })} disabled={!goal.trim() || polish.isPending}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 'var(--r-chip)',
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', font: 'inherit', fontSize: 12,
            cursor: goal.trim() && !polish.isPending ? 'pointer' : 'default', opacity: goal.trim() ? 1 : 0.5 }}>
          <Icon name="sparkle" size={13} style={{ color: 'var(--accent)' }} /> {polish.isPending ? 'Polishing…' : 'Polish with AI'}</button>
        {polish.error && <span style={{ fontSize: 11, color: 'var(--bad)' }}>{polish.error.message}</span>}
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 10 }}>
        {examples.map((ex) => (
          <button key={ex.goal} onClick={() => setGoal(ex.goal)} style={{ padding: '5px 10px', borderRadius: 'var(--r-chip)', cursor: 'pointer',
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', font: 'inherit', fontSize: 11.5 }}>{ex.title}</button>
        ))}
      </div>
      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 9 }}>Workflow template</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 9 }}>
          {missionTemplates.map((template) => {
            const active = workflowTemplateId === template.id;
            return (
              <button key={template.id} onClick={() => setWorkflowTemplateId(template.id)}
                style={{ textAlign: 'left', padding: '11px 12px', borderRadius: 'var(--r-card)', cursor: 'pointer',
                  font: 'inherit', background: active ? tint('var(--accent)', 8) : 'var(--surface-2)',
                  border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 750, color: 'var(--text)', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.name}</span>
                  {template.tag && <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--accent)',
                    background: tint('var(--accent)', 14), borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>{template.tag}</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.35 }}>{template.desc}</div>
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 10, padding: '11px 12px', borderRadius: 'var(--r-card)', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <Pipeline steps={selectedTemplate.pipe} />
        </div>
      </div>
      <div style={{ marginTop: 18, padding: '12px 14px', borderRadius: 'var(--r-card)', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 9, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)' }}>Mission team</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--text-faint)' }}>
            <Icon name="eye" size={11} /> routed by capabilities, then by role fallback
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(members || []).map((id) => agents[id] && (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 11px 4px 4px',
              borderRadius: 'var(--r-chip)', background: 'var(--surface)', border: `1px solid ${alpha(agents[id].color, 35)}` }}>
              <Avatar agent={agents[id]} size={20} ring={false} /><span style={{ fontSize: 12 }}>{agents[id].displayName}</span>
            </span>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ---- Add agent ----------------------------------------------------------- */
const ROLE_INFO = {
  architect: 'Shapes the approach and structure', planner: 'Breaks goals into tasks',
  implementer: 'Writes the code and builds', reviewer: 'Checks quality and correctness', fixer: 'Resolves failures and bugs',
};
const NAME_POOL = { architect: 'Nova', planner: 'Piper', implementer: 'Quill', reviewer: 'Vesper', fixer: 'Mendez' };
function AddAgentModal({ onClose, onAdd }) {
  const roleColors = RT.ROLE_COLORS;
  const [role, setRole] = useStateM('implementer');
  const [name, setName] = useStateM('Quill');
  return (
    <Modal title="Add an agent" sub="Compose the team for this workbench" icon="plus" onClose={onClose} width={500}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={!name.trim()} onClick={() => onAdd({ role, name: name.trim(), color: roleColors[role] })}>Add to workbench</Btn></>}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 18, padding: '14px', borderRadius: 'var(--r-card)',
        background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
        <Avatar agent={{ id: name || role, displayName: name, color: roleColors[role] }} size={44} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{name || 'New agent'}</div>
          <div className="mono" style={{ fontSize: 12, color: roleColors[role] }}>@{role}</div>
        </div>
      </div>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 7 }}>Role</div>
      <div style={{ display: 'grid', gap: 7, marginBottom: 16 }}>
        {Object.keys(ROLE_INFO).map((r) => (
          <button key={r} onClick={() => { setRole(r); setName(NAME_POOL[r]); }} style={{ display: 'flex', alignItems: 'center', gap: 11,
            padding: '10px 12px', borderRadius: 'var(--r-sm)', cursor: 'pointer', font: 'inherit', textAlign: 'left',
            background: role === r ? tint(roleColors[r], 8) : 'var(--surface-2)', border: `1.5px solid ${role === r ? roleColors[r] : 'var(--border)'}` }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: roleColors[r], flexShrink: 0 }} />
            <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: roleColors[r], minWidth: 92 }}>@{r}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ROLE_INFO[r]}</span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Name</div>
      <input value={name} onChange={(e) => setName(e.target.value)} style={fieldStyle} />
    </Modal>
  );
}

/* ---- Edit hand-off (specs/030 §HandoffCard, issue #13) ------------------- */
function EditHandoffModal({ ho, onClose, onSave }) {
  const [userIntent, setUserIntent] = useStateM(ho.userIntent || '');
  const [taskBrief, setTaskBrief] = useStateM(ho.taskBrief || '');
  const [pinned, setPinned] = useStateM(ho.pinnedMessages || []);
  const dirty =
    userIntent !== ho.userIntent ||
    taskBrief !== ho.taskBrief ||
    JSON.stringify(pinned) !== JSON.stringify(ho.pinnedMessages || []);

  const updatePinned = (idx, content) => setPinned((arr) =>
    arr.map((p, i) => (i === idx ? { ...p, content } : p)),
  );
  const removePinned = (idx) => setPinned((arr) => arr.filter((_, i) => i !== idx));
  const addPinned = () =>
    setPinned((arr) => [...arr, { id: `p-${Date.now()}`, content: '', pinnedBy: 'user' }]);

  const save = () => {
    onSave({
      ...ho,
      userIntent: userIntent.trim(),
      taskBrief: taskBrief.trim(),
      pinnedMessages: pinned.filter((p) => p.content.trim()),
    });
    onClose();
  };

  return (
    <Modal
      title="Edit hand-off"
      sub={`Mutating context for @${(ho.to || '').replace(/^@/, '')} — re-dispatches on save`}
      icon="edit"
      onClose={onClose}
      width={620}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary disabled={!dirty || !taskBrief.trim()} onClick={save}>
            Save & re-dispatch
          </Btn>
        </>
      }
    >
      <FieldLabel>User intent</FieldLabel>
      <textarea
        value={userIntent}
        onChange={(e) => setUserIntent(e.target.value)}
        style={{ ...fieldStyle, minHeight: 64, resize: 'vertical', fontFamily: 'inherit' }}
      />

      <FieldLabel>Task brief</FieldLabel>
      <textarea
        value={taskBrief}
        onChange={(e) => setTaskBrief(e.target.value)}
        style={{ ...fieldStyle, minHeight: 110, resize: 'vertical', fontFamily: 'inherit' }}
      />

      <FieldLabel>📌 Pinned constraints</FieldLabel>
      <div style={{ display: 'grid', gap: 7, marginBottom: 8 }}>
        {pinned.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>
            No pinned constraints. Add one to carry it into the brief.
          </div>
        )}
        {pinned.map((p, idx) => (
          <div key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <input
              value={p.content}
              onChange={(e) => updatePinned(idx, e.target.value)}
              placeholder="e.g. Brand: calm, document-like."
              style={{ ...fieldStyle, flex: 1 }}
            />
            <button
              onClick={() => removePinned(idx)}
              style={{ ...iconBtn, color: 'var(--bad)' }}
              title="Remove pin"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={addPinned}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 11px',
          borderRadius: 'var(--r-sm)', border: '1px dashed var(--border-strong)', background: 'transparent',
          color: 'var(--text-muted)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}
      >
        <Icon name="plus" size={12} /> Add pinned constraint
      </button>
    </Modal>
  );
}

function FieldLabel({ children }) {
  return (
    <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase',
      color: 'var(--text-faint)', margin: '14px 0 6px' }}>
      {children}
    </div>
  );
}

export { Modal, Btn, Pipeline, NewWorkbenchModal, NewTaskModal, AddAgentModal, EditHandoffModal };
