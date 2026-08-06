'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getProviders, signIn } from 'next-auth/react';

type AuthMode = 'signin' | 'signup';

type AuthPageProps = {
  mode: AuthMode;
  callbackUrl?: string | undefined;
  authError?: string | undefined;
};

const agents = [
  { src: '/avatars/planning.png', ring: '#8076a0', name: 'Planning' },
  { src: '/avatars/mira.png', ring: '#c47766', name: 'Mira' },
  { src: '/avatars/atlas.png', ring: '#5f86b8', name: 'Atlas' },
  { src: '/avatars/beam.png', ring: '#5a9e8c', name: 'Beam' },
];

export function AuthPage({ mode, callbackUrl = '/', authError }: AuthPageProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('Product Squad');
  const initialAuthError = useMemo(() => messageForAuthError(authError), [authError]);
  const [error, setError] = useState(initialAuthError);
  const [pending, setPending] = useState(false);
  const [providers, setProviders] = useState<Record<string, { id: string; name: string }> | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0, active: false });
  const isSignup = mode === 'signup';
  const target = useMemo(() => {
    if (!callbackUrl || callbackUrl.startsWith('/api/auth')) return '/';
    // Only allow same-origin relative paths so callbackUrl can't drive an
    // open redirect to an external site after sign-in.
    if (!callbackUrl.startsWith('/') || callbackUrl.startsWith('//')) return '/';
    return callbackUrl;
  }, [callbackUrl]);
  const hasGoogle = Boolean(providers?.google);
  const hasDev = Boolean(providers?.dev);

  useEffect(() => {
    setError(initialAuthError);
  }, [initialAuthError]);

  useEffect(() => {
    getProviders()
      .then((items) => {
        if (!items) {
          setProviders({});
          setError('Could not load sign-in options. Check the deployed auth configuration.');
          return;
        }
        setProviders(items as Record<string, { id: string; name: string }>);
      })
      .catch(() => {
        setProviders({});
        setError('Could not load sign-in options. Please refresh and try again.');
      });
  }, []);

  const continueWithGoogle = async () => {
    setError('');
    if (isSignup) {
      window.localStorage.setItem('roundtable.pendingWorkbenchName', workspaceName.trim() || 'Product Squad');
    }
    setPending(true);
    try {
      await signIn('google', { callbackUrl: target });
    } catch {
      setPending(false);
      setError('Could not open Google sign-in. Please refresh and try again.');
    }
  };

  const submitDev = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setPending(true);
    const result = await signIn('dev', {
      email,
      name: isSignup ? name : undefined,
      callbackUrl: target,
      redirect: false,
    });
    setPending(false);

    if (result?.error) {
      setError(isSignup ? 'Could not create that account.' : 'Could not sign in with that email.');
      return;
    }
    if (isSignup) {
      window.localStorage.setItem('roundtable.pendingWorkbenchName', workspaceName.trim() || 'Product Squad');
    }
    router.push(result?.url || target);
  };

  const moveStage = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({
      x: ((event.clientX - rect.left) / rect.width - 0.5) * 2,
      y: ((event.clientY - rect.top) / rect.height - 0.5) * 2,
      active: true,
    });
  };

  return (
    <main style={{
      minHeight: '100vh', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)',
      background: 'radial-gradient(circle at 50% 0%, color-mix(in oklab, var(--accent) 14%, transparent), transparent 38%), var(--bg)',
      color: 'var(--text)', padding: 18,
    }}>
      <div style={{
        width: 'min(1080px, 100%)', margin: 'auto', display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.05fr) minmax(340px, .8fr)', gap: 18,
      }}>
        <section
          onMouseMove={moveStage}
          onMouseLeave={() => setPointer({ x: 0, y: 0, active: false })}
          style={{
          minHeight: 560, border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
          background: 'color-mix(in oklab, var(--surface) 82%, transparent)',
          boxShadow: 'var(--shadow-pop)', overflow: 'hidden', position: 'relative',
        }}>
          <style>{authMotionStyles}</style>
          <div style={{ position: 'absolute', inset: 0, background:
            'linear-gradient(145deg, color-mix(in oklab, var(--surface) 90%, transparent), color-mix(in oklab, var(--surface-2) 86%, transparent))' }} />
          <div style={{ position: 'relative', height: '100%', padding: 26, display: 'flex', flexDirection: 'column' }}>
            <Link href="/" style={{
              display: 'inline-flex', alignItems: 'center', gap: 9, width: 'fit-content',
              color: 'var(--text)', textDecoration: 'none', fontWeight: 700,
            }}>
              <span style={{
                width: 24, height: 14, borderRadius: '50%', background: 'var(--text)',
                boxShadow: 'inset 0 -5px 0 color-mix(in oklab, var(--text) 38%, var(--surface))',
              }} />
              Roundtable
            </Link>

            <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
              <div style={{ position: 'relative', width: 'min(520px, 88vw)', aspectRatio: '1.2 / 1' }}>
                <div style={{
                  position: 'absolute', left: '18%', right: '18%', top: '56%', height: '15%',
                  borderRadius: '50%', background: 'rgba(40,40,70,.20)',
                  filter: 'blur(26px)', opacity: .55,
                  transform: `translate(${pointer.x * 5}px, ${pointer.y * 4}px)`,
                  transition: 'transform .18s ease-out',
                }} />
                <div style={{
                  position: 'absolute', left: '18%', right: '18%', top: '39%', height: '26%',
                  borderRadius: '50%',
                  background: 'linear-gradient(180deg, color-mix(in oklab, var(--surface-3) 74%, #fff 10%), color-mix(in oklab, var(--surface-3) 82%, #000 7%))',
                  boxShadow: 'inset 0 -18px 26px -23px rgba(40,40,70,.52)',
                }} />
                <div style={{
                  position: 'absolute', left: '17%', right: '17%', top: '32%', height: '28%',
                  borderRadius: '50%',
                  background: `radial-gradient(circle at ${48 + pointer.x * 13}% ${35 + pointer.y * 10}%, color-mix(in oklab, var(--accent) ${pointer.active ? 13 : 7}%, #fff), color-mix(in oklab, var(--surface) 96%, #fff 4%) 44%, var(--surface-2) 100%)`,
                  border: '1px solid color-mix(in oklab, var(--border-strong) 72%, transparent)',
                  boxShadow: `inset ${pointer.x * -10}px ${pointer.y * -6}px 24px -24px rgba(40,40,70,.55), inset 0 -16px 28px -26px rgba(40,40,70,.58), 0 18px 48px -36px rgba(40,40,70,.52)`,
                  transition: 'background .18s ease, box-shadow .18s ease',
                }} />
                <div style={{
                  position: 'absolute', left: '29%', right: '29%', top: '40%', height: '12%',
                  borderRadius: '50%',
                  border: '1px dashed color-mix(in oklab, var(--text-faint) 44%, transparent)',
                  boxShadow: 'inset 0 1px 12px color-mix(in oklab, var(--accent) 6%, transparent)',
                }} />
                <div style={{
                  position: 'absolute', left: '41%', right: '41%', top: '61%', height: '10%',
                  borderRadius: '50%',
                  background: 'linear-gradient(180deg, color-mix(in oklab, var(--surface-3) 78%, #fff 7%), color-mix(in oklab, var(--surface-3) 76%, #000 10%))',
                  opacity: .48,
                  filter: 'blur(.2px)',
                }} />
                {agents.map((agent, index) => {
                  const positions = [
                    { left: '43%', top: '8%', zIndex: 4 },
                    { left: '78%', top: '31%', zIndex: 8 },
                    { left: '44%', top: '69%', zIndex: 12 },
                    { left: '9%', top: '32%', zIndex: 8 },
                  ];
                  return (
                    <div key={agent.name} className="auth-agent" style={{
                      position: 'absolute', ...positions[index], width: 86, textAlign: 'center',
                      transform: `translate(calc(-50% + ${pointer.x * (7 + index * 1.4)}px), ${pointer.y * (5 - index * .45)}px) rotate(${pointer.x * (2.3 - index * .25)}deg)`,
                      transition: 'transform .16s ease-out',
                    }}>
                      <div className="auth-avatar" style={{
                        width: 56, height: 56, margin: '0 auto 9px', borderRadius: '50%',
                        background: 'var(--surface)', overflow: 'hidden',
                        boxShadow: `0 0 0 3px var(--surface), 0 0 0 5px ${agent.ring}, 0 12px 28px -18px rgba(40,40,70,.55)`,
                      }}>
                        <img src={agent.src} alt="" width={56} height={56}
                          className="auth-avatar-img"
                          style={{ display: 'block', width: 56, height: 56, objectFit: 'cover',
                            transform: `translate(${pointer.x * (1.5 + index * .3)}px, ${pointer.y * 1.2}px) scale(1.04)` }} />
                        <span className="auth-blink" style={{ animationDelay: `${index * 1.25}s` }} />
                      </div>
                      <div style={{ fontSize: 12.5, fontWeight: 700 }}>{agent.name}</div>
                    </div>
                  );
                })}
                <div style={{
                  position: 'absolute', left: '50%', top: '43%',
                  transform: `translate(calc(-50% + ${pointer.x * 4}px), calc(-50% + ${pointer.y * 3}px))`,
                  padding: '7px 12px', borderRadius: 'var(--r-sm)',
                  background: 'color-mix(in oklab, var(--surface) 72%, var(--surface-2))',
                  border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 12.5,
                  boxShadow: '0 1px 0 rgba(255,255,255,.65) inset, var(--shadow-card)',
                  transition: 'transform .16s ease-out',
                }}>
                  Product Squad
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              color: 'var(--text-faint)', fontSize: 12 }}>
              <span>Plan</span>
              <span>Build</span>
              <span>Review</span>
              <span>Ship</span>
            </div>
          </div>
        </section>

        <section style={{
          minHeight: 560, border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
          background: 'var(--surface)', boxShadow: 'var(--shadow-pop)', padding: 30,
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}>
          <div style={{ display: 'inline-flex', padding: 3, borderRadius: 'var(--r-sm)',
            background: 'var(--surface-2)', border: '1px solid var(--border)', width: 'fit-content', marginBottom: 24 }}>
            <Link href={`/signin?callbackUrl=${encodeURIComponent(target)}`} style={tabStyle(!isSignup)}>Sign in</Link>
            <Link href={`/signup?callbackUrl=${encodeURIComponent(target)}`} style={tabStyle(isSignup)}>Sign up</Link>
          </div>

          <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.12, letterSpacing: 0 }}>
            {isSignup ? 'Create your Roundtable account' : 'Welcome back to Roundtable'}
          </h1>
          <p style={{ margin: '11px 0 24px', color: 'var(--text-muted)', fontSize: 14.5, lineHeight: 1.55 }}>
            {isSignup
              ? 'Continue with Google. Your verified work email keeps your workspace, missions, and agent history tied to you.'
              : 'Continue with the Google account connected to your Roundtable workspace.'}
          </p>

          <div style={{ display: 'grid', gap: 13 }}>
            {isSignup && (
              <label style={{ display: 'grid', gap: 7, fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)' }}>
                Workspace name
                <input
                  type="text"
                  autoComplete="organization"
                  required
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="Product Squad"
                  style={inputStyle}
                />
              </label>
            )}

            {error && <div style={{
              padding: '9px 11px', borderRadius: 'var(--r-sm)',
              background: 'color-mix(in oklab, var(--bad) 10%, var(--surface))',
              border: '1px solid color-mix(in oklab, var(--bad) 28%, var(--border))',
              color: 'var(--bad)', fontSize: 13,
            }}>{error}</div>}

            {hasGoogle ? (
              <button type="button" disabled={pending} onClick={continueWithGoogle} style={{
                height: 44, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)',
                color: 'var(--text)', font: 'inherit', fontSize: 13.5, fontWeight: 800,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                cursor: pending ? 'default' : 'pointer', opacity: pending ? .72 : 1, boxShadow: 'var(--shadow-card)',
              }}>
                <GoogleMark />
                {pending ? 'Opening Google...' : 'Continue with Google'}
              </button>
            ) : providers === null ? (
              <div style={{ height: 44, display: 'grid', placeItems: 'center', color: 'var(--text-faint)', fontSize: 12.5 }}>
                Loading sign-in options...
              </div>
            ) : (
              <div style={{
                padding: '10px 11px', borderRadius: 'var(--r-sm)',
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.45,
              }}>
                Google OAuth is not configured for this environment.
              </div>
            )}

            {hasDev && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '3px 0' }}>
                  <span style={{ height: 1, background: 'var(--border)', flex: 1 }} />
                  <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.08em' }}>Developer only</span>
                  <span style={{ height: 1, background: 'var(--border)', flex: 1 }} />
                </div>
                <form onSubmit={submitDev} style={{ display: 'grid', gap: 11 }}>
                  {isSignup && (
                    <label style={{ display: 'grid', gap: 7, fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)' }}>
                      Name
                      <input
                        type="text"
                        autoComplete="name"
                        required
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Peitong Qi"
                        style={inputStyle}
                      />
                    </label>
                  )}
                  <label style={{ display: 'grid', gap: 7, fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)' }}>
                    Dev email
                    <input
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@company.com"
                      style={inputStyle}
                    />
                  </label>
                  <button type="submit" disabled={pending} style={{
                    height: 40, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                    background: 'var(--surface-2)', color: 'var(--text-muted)',
                    font: 'inherit', fontSize: 12.5, fontWeight: 750,
                    cursor: pending ? 'default' : 'pointer', opacity: pending ? .72 : 1,
                  }}>
                    {pending ? 'Continuing...' : isSignup ? 'Continue in dev mode' : 'Sign in in dev mode'}
                  </button>
                </form>
              </>
            )}
          </div>

          <div style={{
            marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)',
            color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.5,
          }}>
            {isSignup ? (
              <>Already have an account? <Link href={`/signin?callbackUrl=${encodeURIComponent(target)}`} style={linkStyle}>Sign in</Link></>
            ) : (
              <>New to Roundtable? <Link href={`/signup?callbackUrl=${encodeURIComponent(target)}`} style={linkStyle}>Create an account</Link></>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function tabStyle(active: boolean) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 86,
    height: 32,
    padding: '0 13px',
    borderRadius: 'calc(var(--r-sm) - 2px)',
    color: active ? 'var(--text)' : 'var(--text-muted)',
    background: active ? 'var(--surface)' : 'transparent',
    boxShadow: active ? 'var(--shadow-card)' : 'none',
    textDecoration: 'none',
    fontSize: 13,
    fontWeight: 700,
  };
}

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 19.4-8 19.4-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4c-7.7 0-14.3 4.3-17.7 10.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.5-5.3l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.8L6.2 33.2C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4 5.5l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function messageForAuthError(error: string | undefined): string {
  if (!error) return '';
  switch (error) {
    case 'OAuthSignin':
    case 'OAuthCallback':
    case 'OAuthCreateAccount':
    case 'OAuthAccountNotLinked':
    case 'google':
      return 'Google sign-in could not complete. Check the OAuth client and callback URL configuration.';
    case 'AccessDenied':
      return 'Google did not return a verified email for this account.';
    case 'Configuration':
      return 'Sign-in is not configured correctly for this deployment.';
    case 'SessionRequired':
      return 'Please sign in to continue.';
    default:
      return 'Sign-in failed. Please try again.';
  }
}

const linkStyle = {
  color: 'var(--accent)',
  fontWeight: 700,
  textDecoration: 'none',
};

const inputStyle = {
  height: 44,
  width: '100%',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  padding: '0 13px',
  font: 'inherit',
  fontSize: 14,
  outline: 'none',
};

const authMotionStyles = `
  .auth-agent {
    will-change: transform;
  }

  .auth-avatar {
    position: relative;
    transition: transform .18s ease, box-shadow .18s ease;
    animation: auth-float 5.8s ease-in-out infinite;
    will-change: transform;
  }

  .auth-agent:hover .auth-avatar {
    transform: translateY(-5px) scale(1.055);
  }

  .auth-avatar-img {
    transition: transform .16s ease-out;
    will-change: transform;
  }

  .auth-blink {
    position: absolute;
    left: 18%;
    right: 18%;
    top: 42%;
    height: 0;
    border-radius: 999px;
    background: color-mix(in oklab, var(--surface) 88%, #fff 12%);
    box-shadow: 0 0 0 1px rgba(255,255,255,.45);
    opacity: 0;
    pointer-events: none;
    animation: auth-blink 6.2s infinite;
  }

  @keyframes auth-float {
    0%, 100% { translate: 0 0; }
    50% { translate: 0 -3px; }
  }

  @keyframes auth-blink {
    0%, 90%, 100% { opacity: 0; height: 0; transform: scaleY(.2); }
    92% { opacity: .86; height: 13px; transform: scaleY(1); }
    94% { opacity: .86; height: 2px; transform: scaleY(.28); }
    96% { opacity: 0; height: 0; transform: scaleY(.2); }
  }

  @media (prefers-reduced-motion: reduce) {
    .auth-avatar,
    .auth-blink {
      animation: none;
    }
    .auth-agent,
    .auth-avatar,
    .auth-avatar-img {
      transition: none;
    }
  }
`;
