'use client';

import React from 'react';
import { signOut, useSession } from 'next-auth/react';
import { Avatar, Icon } from './primitives';
import { trpc } from '../lib/trpc';

const { useEffect, useMemo, useState } = React;

const shell = {
  minHeight: '100vh',
  background: 'var(--bg)',
  color: 'var(--text)',
  display: 'flex',
  flexDirection: 'column',
};

const btn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--surface)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12.5,
  padding: '7px 11px',
  cursor: 'pointer',
  textDecoration: 'none',
};

const panel = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  boxShadow: 'var(--shadow-card)',
};

const field = {
  width: '100%',
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--surface-2)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12.5,
  lineHeight: 1.5,
  padding: '9px 10px',
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
};

function ProfileConsole() {
  const { data: session, status } = useSession();
  const authed = status === 'authenticated';
  const profileQ = trpc.userProfile.get.useQuery(undefined, { enabled: authed });
  const trpcUtils = trpc.useUtils();
  const saveProfile = trpc.userProfile.update.useMutation({
    onSuccess: () => trpcUtils.userProfile.get.invalidate(),
  });
  const [defaultBrief, setDefaultBrief] = useState('');
  const [notes, setNotes] = useState('');
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!profileQ.data) return;
    setDefaultBrief(profileQ.data.defaultBrief || '');
    setNotes(profileQ.data.notes || '');
  }, [profileQ.data]);

  const dirty = useMemo(() => {
    const profile = profileQ.data;
    if (!profile) return false;
    return defaultBrief !== (profile.defaultBrief || '') || notes !== (profile.notes || '');
  }, [defaultBrief, notes, profileQ.data]);

  const save = () => {
    saveProfile.mutate({
      defaultBrief: defaultBrief.trim(),
      notes: notes.trim(),
    });
  };

  const user = session?.user;
  const displayName = user?.name || user?.email || 'You';
  const email = user?.email || '';

  return (
    <main style={shell}>
      <header style={{ height: 54, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px',
        borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        <a href="/" style={btn}>
          <Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} /> Roundtable
        </a>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 15, fontWeight: 750 }}>Profile</h1>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>How Roundtable works with you</div>
        </div>
        <div style={{ flex: 1 }} />
        {authed && (
          <button disabled={!dirty || saveProfile.isPending} onClick={save}
            style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none',
              opacity: !dirty || saveProfile.isPending ? 0.65 : 1 }}>
            <Icon name="check" size={14} /> {saveProfile.isPending ? 'Saving' : 'Save'}
          </button>
        )}
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '220px minmax(0, 1fr)', gap: 16, padding: 16, flex: 1 }}>
        <aside style={{ ...panel, alignSelf: 'start', padding: 8, display: 'grid', gap: 4 }}>
          <NavItem active icon="at" label="Account" href="#account" />
          {authed && (
            <>
              <NavItem icon="sparkle" label="Collaboration" href="#collaboration" />
              <NavItem icon="layers" label="Skills location" href="#skills-location" />
            </>
          )}
        </aside>

        {!authed ? (
          <section id="account" style={{ ...panel, padding: 18, alignSelf: 'start', display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar agent={{ id: 'you-user', displayName: 'You', color: '#8076a0' }} size={38} />
              <div>
                <div style={{ fontSize: 15, fontWeight: 750 }}>Sign in to edit your profile</div>
                <div style={{ marginTop: 2, color: 'var(--text-muted)', fontSize: 12.5 }}>
                  Your profile keeps Roundtable's collaboration defaults tied to your account.
                </div>
              </div>
            </div>
            <div>
              <button onClick={() => { window.location.assign('/signin?callbackUrl=%2Fprofile'); }}
                style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none' }}>
                <Icon name="at" size={14} /> Sign in with Google
              </button>
            </div>
          </section>
        ) : (
          <section style={{ display: 'grid', gap: 16, minWidth: 0 }}>
            <div id="account" style={{ ...panel, overflow: 'hidden' }}>
              <SectionHead title="Account" />
              <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 13 }}>
                <Avatar agent={{ id: 'you-user', displayName, color: '#8076a0' }} size={42} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayName}
                  </div>
                  <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {email || 'Signed in'}
                  </div>
                </div>
                <button onClick={() => signOut({ callbackUrl: '/' })} style={btn}>
                  <Icon name="door" size={14} /> Sign out
                </button>
              </div>
            </div>

            <div id="collaboration" style={{ ...panel, overflow: 'hidden' }}>
              <SectionHead title="Collaboration profile" />
              <div style={{ padding: 14, display: 'grid', gap: 13 }}>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={labelStyle}>Default brief</span>
                  <textarea value={defaultBrief} onChange={(event) => setDefaultBrief(event.target.value)} rows={4}
                    placeholder="Context Roundtable should remember when preparing new hand-offs."
                    style={field} />
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={labelStyle}>Private notes</span>
                  <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4}
                    placeholder="Personal setup notes for future tasks."
                    style={field} />
                </label>
                {profileQ.isLoading && <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>Loading profile.</div>}
                {profileQ.error && <div style={{ color: 'var(--bad)', fontSize: 12.5 }}>{profileQ.error.message}</div>}
                {saveProfile.error && <div style={{ color: 'var(--bad)', fontSize: 12.5 }}>{saveProfile.error.message}</div>}
              </div>
            </div>

            <div id="skills-location" style={{ ...panel, overflow: 'hidden' }}>
              <SectionHead title="Skills" />
              <div style={{ padding: 14, display: 'grid', gap: 9 }}>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Skills stay in the mission panel so you can adjust agent guidance while working.
                </div>
                <a href="/" style={{ ...btn, width: 'fit-content' }}>
                  <Icon name="layers" size={14} /> Open Roundtable
                </a>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function SectionHead({ title }) {
  return (
    <div style={{ height: 40, display: 'flex', alignItems: 'center', padding: '0 12px',
      borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 800,
      letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{title}</div>
  );
}

function NavItem({ active, icon, label, href }) {
  return (
    <a href={href} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', borderRadius: 7,
      background: active ? 'var(--surface-2)' : 'transparent', color: active ? 'var(--text)' : 'var(--text-muted)',
      fontSize: 12.5, fontWeight: 650, textDecoration: 'none' }}>
      <Icon name={icon} size={14} /> {label}
    </a>
  );
}

const labelStyle = {
  fontSize: 11,
  fontWeight: 720,
  color: 'var(--text-muted)',
};

export default ProfileConsole;
