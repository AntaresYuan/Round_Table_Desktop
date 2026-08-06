import { afterEach, describe, expect, it } from 'vitest';
import { applyDevelopmentAuthUrl, authUrlFromRequest, googleProfileAllowsSignIn } from '../src/server/auth.js';

const originalNodeEnv = process.env.NODE_ENV;
const originalNextAuthUrl = process.env.NEXTAUTH_URL;

afterEach(() => {
  setEnv('NODE_ENV', originalNodeEnv);
  setEnv('NEXTAUTH_URL', originalNextAuthUrl);
});

describe('auth URL resolution', () => {
  it('uses the current local request host in development', () => {
    setEnv('NODE_ENV', 'development');
    setEnv('NEXTAUTH_URL', 'https://roundtable-gray.vercel.app');

    applyDevelopmentAuthUrl({ headers: { host: '127.0.0.1:3000' } });

    expect(process.env.NEXTAUTH_URL).toBe('http://127.0.0.1:3000');
  });

  it('keeps the configured production URL in production', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('NEXTAUTH_URL', 'https://roundtable-gray.vercel.app');

    applyDevelopmentAuthUrl({ headers: { host: '127.0.0.1:3000' } });

    expect(process.env.NEXTAUTH_URL).toBe('https://roundtable-gray.vercel.app');
  });

  it('rejects malformed host headers', () => {
    expect(authUrlFromRequest({ headers: { host: 'localhost:3000/path' } })).toBeNull();
  });
});

describe('Google sign-in profile checks', () => {
  it('accepts verified Google profiles when email_verified is a boolean or string', () => {
    expect(googleProfileAllowsSignIn({ email: 'user@example.com', email_verified: true })).toBe(true);
    expect(googleProfileAllowsSignIn({ email: 'user@example.com', email_verified: 'true' })).toBe(true);
  });

  it('rejects missing or unverified Google profiles', () => {
    expect(googleProfileAllowsSignIn({ email: 'user@example.com', email_verified: false })).toBe(false);
    expect(googleProfileAllowsSignIn({ email: 'user@example.com', email_verified: 'false' })).toBe(false);
    expect(googleProfileAllowsSignIn({ email_verified: true })).toBe(false);
  });
});

function setEnv(key: string, value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
}
