import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentRuntimeKind } from '../../types.js';

// CLI session registry for a workspace. Workspaces are chat-scoped, so keying
// sessions by (runtime, agent) inside the workspace gives every chat its own
// continuous CLI conversation: the next turn resumes where the last one ended
// instead of starting a fresh process with no memory. Stored as a sidecar file
// (not in the app store) because the session only means anything next to the
// CLI state on this machine — it must not survive a workspace wipe or migrate
// to another host through the database.
export type CliSessionEntry = {
  sessionId: string;
  updatedAt: string;
};

type CliSessionFile = Record<string, CliSessionEntry>;

const SESSIONS_FILE = join('.roundtable', 'cli-sessions.json');

// Runtimes whose CLI accepts resuming a previous session id. Codex and OpenCode
// session ids are still captured and stored for observability, but their resume
// flags are not wired yet.
export function runtimeSupportsResume(runtime: AgentRuntimeKind): boolean {
  return runtime === 'claude-code' || runtime === 'claude-code-router';
}

export async function cliSessionFor(
  workspace: string,
  runtime: AgentRuntimeKind,
  agentId: string,
): Promise<string | null> {
  const sessions = await readSessions(workspace);
  return sessions[sessionKey(runtime, agentId)]?.sessionId ?? null;
}

export async function saveCliSession(
  workspace: string,
  runtime: AgentRuntimeKind,
  agentId: string,
  sessionId: string,
): Promise<void> {
  const sessions = await readSessions(workspace);
  await writeSessions(workspace, {
    ...sessions,
    [sessionKey(runtime, agentId)]: { sessionId, updatedAt: new Date().toISOString() },
  });
}

export async function clearCliSession(
  workspace: string,
  runtime: AgentRuntimeKind,
  agentId: string,
): Promise<void> {
  const sessions = await readSessions(workspace);
  const key = sessionKey(runtime, agentId);
  if (!(key in sessions)) return;
  const { [key]: _removed, ...rest } = sessions;
  await writeSessions(workspace, rest);
}

function sessionKey(runtime: AgentRuntimeKind, agentId: string): string {
  return `${runtime}:${agentId}`;
}

async function readSessions(workspace: string): Promise<CliSessionFile> {
  try {
    const raw = await readFile(join(workspace, SESSIONS_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, CliSessionEntry] => {
        const value = entry[1];
        return typeof value === 'object' && value !== null
          && typeof (value as CliSessionEntry).sessionId === 'string'
          && (value as CliSessionEntry).sessionId.length > 0;
      });
    return Object.fromEntries(entries);
  } catch {
    // Missing or corrupt file simply means "no resumable sessions yet".
    return {};
  }
}

async function writeSessions(workspace: string, sessions: CliSessionFile): Promise<void> {
  const target = join(workspace, SESSIONS_FILE);
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');
  } catch {
    // Session persistence is an optimization; a write failure must never fail
    // the agent run itself — the next turn simply starts a fresh session.
  }
}
