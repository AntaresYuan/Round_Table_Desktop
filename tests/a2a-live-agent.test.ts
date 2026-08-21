import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetData } from '../src/server/store.js';
import type { HandoffCardV2, PlanTask } from '../src/server/types.js';
import { createA2AClient, runOnA2A } from '../src/server/actions/adapters/a2a-adapter.js';
import { A2AUnavailableError } from '../src/server/actions/a2a/errors.js';
import { assertAllowedA2AUrl, resolveA2ARemoteAgentConfig } from '../src/server/actions/a2a/config.js';
import { saveSettings } from '../src/server/actions/settings-actions.js';
import { readData } from '../src/server/store.js';
import {
  TEST_AGENT_DELIVERABLE,
  startBlackHole,
  startTestA2AAgent,
} from './helpers/a2a-test-agent.js';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'roundtable-a2a-live-'));
  process.env.ROUNDTABLE_DATA_PATH = join(workspace, 'data.json');
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  await rm(workspace, { recursive: true, force: true });
});

const task = {
  id: 'task-1', title: 'Write the brief', assignee: '@pm', role: 'pm',
  status: 'pending', dependsOn: [], artifactKind: 'markdown',
} as unknown as PlanTask;

const handoff = {
  protocolVersion: 'v2', missionId: 'mission-1', task,
  goal: 'demo', context: [], acceptance: [],
} as unknown as HandoffCardV2;

function config(baseUrl: string, authToken: string | null = null) {
  return {
    agentId: 'mira', enabled: true, baseUrl,
    cardPath: '/.well-known/agent-card.json',
    authToken, source: 'settings' as const,
  };
}

function run(baseUrl: string, extra: { turnId?: string; authToken?: string | null; timeoutMs?: number } = {}) {
  return runOnA2A({
    workspace,
    turnId: extra.turnId ?? 'turn-1',
    missionId: 'mission-1',
    task,
    handoff,
    handoffText: 'Please write the brief.',
    config: config(baseUrl, extra.authToken ?? null),
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
  });
}

const artifactDir = () => join(workspace, '.roundtable/runs/a2a/task-1');

describe('A2A adapter against a real SDK-backed agent', () => {
  it('negotiates a v1.0 interface and materializes the deliverable', async () => {
    const agent = await startTestA2AAgent();
    try {
      const created = await createA2AClient(config(agent.url));
      expect(created.protocolVersion).toBe('1.0');

      const result = await run(agent.url);
      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.text).toBe(TEST_AGENT_DELIVERABLE);
      expect(result.path).toBe('.roundtable/runs/a2a/task-1/result.md');
      expect(await readdir(artifactDir())).toEqual(['result.md']);
    } finally { await agent.close(); }
  });

  it('accepts a media type carrying parameters', async () => {
    const agent = await startTestA2AAgent({ artifactMediaType: 'text/markdown; charset=utf-8' });
    try {
      const result = await run(agent.url);
      expect(result.ok).toBe(true);
      // Must be the real deliverable, not the "no supported artifact" placeholder.
      expect(result.text).toBe(TEST_AGENT_DELIVERABLE);
      expect(await readdir(artifactDir())).toEqual(['result.md']);
    } finally { await agent.close(); }
  });

  it('keeps interim status narration out of the workspace', async () => {
    const agent = await startTestA2AAgent({ narrate: true });
    try {
      const result = await run(agent.url);
      expect(result.ok).toBe(true);
      expect(result.text).toBe(TEST_AGENT_DELIVERABLE);

      // Narration belongs in the event stream …
      const narration = result.events.filter((e) => e.type === 'text_delta').map((e) => e.delta);
      expect(narration).toContain('Reading the handoff…');
      expect(narration).toContain('Drafting the deliverable…');

      // … and nowhere near the deliverables.
      expect(await readdir(artifactDir())).toEqual(['result.md']);
      const paths = (result.files ?? []).map((file) => file.path);
      expect(paths).toEqual([...new Set(paths)]);
      expect(paths.some((p) => p.includes('message'))).toBe(false);
      expect(await readFile(join(artifactDir(), 'result.md'), 'utf8')).toBe(TEST_AGENT_DELIVERABLE);
    } finally { await agent.close(); }
  });

  it('withholds the bearer token from a host the agent card names', async () => {
    const elsewhere = await startTestA2AAgent();
    const agent = await startTestA2AAgent({ advertisedUrlOverride: elsewhere.url });
    try {
      await run(agent.url, { authToken: 'super-secret-token' }).catch(() => null);
      // The configured origin may see the token; the card-named origin never does.
      expect(elsewhere.requestsWithToken('super-secret-token')).toBe(0);
      expect(elsewhere.requests.length).toBeGreaterThan(0);
    } finally { await agent.close(); await elsewhere.close(); }
  });

  it('applies the configured timeout to agent card discovery', async () => {
    const black = await startBlackHole();
    try {
      const started = Date.now();
      await expect(run(black.url, { timeoutMs: 1000 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally { black.close(); }
  }, 30_000);
});

describe('A2A configuration hardening', () => {
  it('treats IPv6 loopback like any other loopback host', () => {
    for (const url of ['http://localhost:41241', 'http://127.0.0.1:41241', 'http://[::1]:41241']) {
      expect(() => assertAllowedA2AUrl(url, 'development')).not.toThrow();
    }
    expect(() => assertAllowedA2AUrl('http://example.com', 'development')).toThrow(/a2a_https_required/);
  });

  it('raises a fallbackable error when a stored URL is invalid for the environment', async () => {
    await saveSettings({ a2aAgents: [{ agentId: 'mira', enabled: true, baseUrl: 'http://localhost:41241' }] });
    const previous = process.env.NODE_ENV;
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'production', configurable: true, writable: true, enumerable: true,
    });
    try {
      // dispatch.ts only falls back for A2AUnavailableError / A2ARequestError;
      // anything else takes the whole turn down.
      await expect(resolveA2ARemoteAgentConfig('mira')).rejects.toBeInstanceOf(A2AUnavailableError);
    } finally {
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: previous, configurable: true, writable: true, enumerable: true,
      });
    }
  });

  it('stores a bearer token longer than 500 characters intact', async () => {
    const token = `header.${'x'.repeat(700)}.signature`;
    await saveSettings({
      a2aAgents: [{ agentId: 'mira', enabled: true, baseUrl: 'https://agent.example', authToken: token }],
    });
    const stored = (await readData()).settings.a2aRemoteAgents.find((item) => item.agentId === 'mira');
    expect(stored?.authToken).toBe(token);
  });
});
