import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { E2BUnavailableError, isE2BAvailable, runOnE2B } from '../src/server/actions/adapters/e2b-adapter.js';
import { normalizeAdapter } from '../src/server/actions/agent-runner.js';

const original = process.env.E2B_API_KEY;
const originalAdapter = process.env.ROUNDTABLE_AGENT_ADAPTER;

beforeEach(() => {
  delete process.env.E2B_API_KEY;
  delete process.env.ROUNDTABLE_AGENT_ADAPTER;
});

afterEach(() => {
  if (original === undefined) delete process.env.E2B_API_KEY;
  else process.env.E2B_API_KEY = original;
  if (originalAdapter === undefined) delete process.env.ROUNDTABLE_AGENT_ADAPTER;
  else process.env.ROUNDTABLE_AGENT_ADAPTER = originalAdapter;
});

describe('e2b-adapter — availability', () => {
  it('isE2BAvailable is false without a key', () => {
    expect(isE2BAvailable()).toBe(false);
  });

  it('isE2BAvailable is true with a non-empty key', () => {
    process.env.E2B_API_KEY = 'e2b_test_key';
    expect(isE2BAvailable()).toBe(true);
  });

  it('isE2BAvailable is false for a whitespace-only key', () => {
    process.env.E2B_API_KEY = '   ';
    expect(isE2BAvailable()).toBe(false);
  });
});

describe('e2b-adapter — opt-in selection', () => {
  it('normalizeAdapter returns e2b when explicitly requested', () => {
    expect(normalizeAdapter('e2b')).toBe('e2b');
  });

  it('normalizeAdapter honors the env default', () => {
    process.env.ROUNDTABLE_AGENT_ADAPTER = 'e2b';
    expect(normalizeAdapter(undefined)).toBe('e2b');
  });
});

describe('e2b-adapter — runOnE2B', () => {
  it('throws E2BUnavailableError when no key is set', async () => {
    await expect(runOnE2B({ prompt: 'echo hi' })).rejects.toBeInstanceOf(E2BUnavailableError);
  });
});
