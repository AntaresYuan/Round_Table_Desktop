import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerSession } from 'next-auth';
import { GET as getRuntimes } from '../src/app/api/agent-runtimes/route.js';
import { POST as postRuntimeConfig } from '../src/app/api/agent-runtimes/config/route.js';
import { POST as postRuntimeControl } from '../src/app/api/agent-runtimes/control/route.js';
import { POST as postRuntimeDefaults } from '../src/app/api/agent-runtimes/defaults/route.js';
import { POST as postRuntimeDirect } from '../src/app/api/agent-runtimes/direct/route.js';
import { GET as getDiagnostics } from '../src/app/api/orchestrator/diagnostics/route.js';
import { GET as getSettings, POST as postSettings } from '../src/app/api/settings/route.js';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

const mockedGetServerSession = vi.mocked(getServerSession);
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  mockedGetServerSession.mockReset();
  setNodeEnv(originalNodeEnv);
});

describe('production API auth gates', () => {
  it('requires a session for production settings and runtime endpoints', async () => {
    setNodeEnv('production');
    mockedGetServerSession.mockResolvedValue(null);

    const requests: Array<Promise<Response>> = [
      getSettings(),
      postSettings(jsonRequest({ defaultAgentAdapter: 'local-dispatch' })),
      getRuntimes(),
      postRuntimeConfig(jsonRequest({ agentId: 'atlas', runtime: 'codex' })),
      postRuntimeDefaults(jsonRequest({ runtime: 'codex' })),
      postRuntimeDirect(jsonRequest({ agentId: 'atlas', message: 'hello' })),
      postRuntimeControl(jsonRequest({ conversationId: 'conversation-1', action: 'stop' })),
      getDiagnostics(),
    ];

    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual(Array(requests.length).fill(401));
  });
});

function jsonRequest(body: unknown): Request {
  return new Request('http://roundtable.test/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setNodeEnv(value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}
