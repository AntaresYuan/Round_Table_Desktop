import React from 'react';
import { Icon } from './primitives';

const { useEffect, useState } = React;

const panelBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 11px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12.5,
  fontWeight: 500,
  cursor: 'pointer',
};
const panelField = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 10px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12.5,
  lineHeight: 1.45,
  outline: 'none',
};
const iconBtn = {
  display: 'grid',
  placeItems: 'center',
  width: 28,
  height: 28,
  flexShrink: 0,
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
};
const splitSkills = (value) =>
  value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

function ScopeBadge({ children }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 7px',
      borderRadius: 5, background: 'var(--surface-3)', color: 'var(--text-muted)', fontSize: 10.5,
      fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>
      {children}
    </span>
  );
}

function MemoryPanel({ memory }) {
  const profile = memory?.profile;
  const pins = memory?.pins || [];
  const [brief, setBrief] = useState('');
  const [skills, setSkills] = useState('');
  const [notes, setNotes] = useState('');
  const [newPin, setNewPin] = useState('');

  useEffect(() => {
    setBrief(profile?.defaultBrief || '');
    setSkills((profile?.defaultSkills || []).join('\n'));
    setNotes(profile?.notes || '');
  }, [profile]);

  if (!memory?.live) {
    return (
      <div style={{ flex: 1, padding: '16px 16px 24px' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>
          Sign in to manage user memory and project constraints.
        </div>
      </div>
    );
  }

  const saveProfile = () => memory.onSaveProfile({
    defaultBrief: brief.trim(),
    defaultSkills: splitSkills(skills),
    notes: notes.trim(),
  });
  const addPin = () => {
    const content = newPin.trim();
    if (!content) return;
    memory.onAddPin(content);
    setNewPin('');
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px', display: 'grid', gap: 16 }}>
      <section style={{ display: 'grid', gap: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ScopeBadge>User</ScopeBadge>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Default profile</div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.45 }}>
          Used when the facilitator prepares new hand-offs. Existing hand-offs stay unchanged.
        </div>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3}
          placeholder="Default brief the team should remember about how you work." style={panelField} />
        <textarea value={skills} onChange={(e) => setSkills(e.target.value)} rows={3}
          placeholder="Default skills, one per line or comma separated." style={panelField} />
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
          placeholder="Private notes for future task setup." style={panelField} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={saveProfile} disabled={memory.profileSaving} style={{
            ...panelBtn,
            background: memory.profileSaving ? 'var(--surface-3)' : 'var(--accent)',
            color: memory.profileSaving ? 'var(--text-faint)' : '#fff',
            border: 'none',
            cursor: memory.profileSaving ? 'default' : 'pointer',
          }}>
            <Icon name="check" size={13} /> {memory.profileSaving ? 'Saving' : 'Save profile'}
          </button>
          {memory.profileError && <span style={{ fontSize: 11.5, color: 'var(--bad)' }}>{memory.profileError}</span>}
        </div>
      </section>

      <section style={{ display: 'grid', gap: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ScopeBadge>Project</ScopeBadge>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>{memory.workbench?.name || 'Current workbench'} constraints</div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.45 }}>
          These pins travel with every task in this workbench.
        </div>
        <div style={{ display: 'grid', gap: 7 }}>
          {pins.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>
              No project constraints pinned yet.
            </div>
          ) : pins.map((pin) => (
            <div key={pin.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start',
              padding: '9px 10px', background: 'var(--surface-2)', borderRadius: 'var(--r-sm)',
              border: '1px solid var(--border)' }}>
              <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45 }}>{pin.content}</div>
              <button onClick={() => memory.onRemovePin(pin.id)} title="Remove project constraint"
                disabled={memory.pinSaving} style={iconBtn}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
        <textarea value={newPin} onChange={(e) => setNewPin(e.target.value)} rows={2}
          placeholder="Add a project rule or constraint." style={panelField} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={addPin} disabled={!newPin.trim() || memory.pinSaving || !memory.workbench?.id}
            style={{ ...panelBtn, cursor: newPin.trim() && !memory.pinSaving ? 'pointer' : 'default',
              opacity: newPin.trim() ? 1 : 0.55 }}>
            <Icon name="plus" size={13} /> Add constraint
          </button>
          {memory.pinError && <span style={{ fontSize: 11.5, color: 'var(--bad)' }}>{memory.pinError}</span>}
        </div>
      </section>
    </div>
  );
}

export { MemoryPanel };
