/*
  Actor-facing surface of the agent memory store, consumed by the tRPC router:
  overview for the Memory panel plus portable export/import bundles. Memory is
  strictly per-project; moving it between projects is an explicit export →
  import, never automatic.

  This layer owns auth and workspace resolution only; all file semantics
  (formats, budgets, capacity) live in agent-memory.ts.
*/

import type { Actor } from '../types.js';
import { importProjectFacts, loadAgentMemory } from './agent-memory.js';
import type { MemoryFact } from './agent-memory.js';
import { AGENT_ROSTER } from './agent-roster.js';
import { getChat } from './chat-actions.js';
import { workspacePathForChat } from './turns/workspace.js';

export type MemoryFactView = Pick<MemoryFact, 'slug' | 'description' | 'type' | 'lines' | 'bytes' | 'overLimit'>;

export type AgentMemoryOverview = {
  agentId: string;
  displayName: string;
  role: string;
  facts: MemoryFactView[];
  compactionNeeds: string[];
};

export type MemoryBundle = {
  exportedAt: string;
  files: Array<{ path: string; content: string }>;
};

// One call for the whole Memory panel: every roster agent that has memory.
export async function getAgentMemoryOverview(
  actor: Actor,
  input: { chatId?: string | undefined },
): Promise<AgentMemoryOverview[]> {
  const workspace = await resolveWorkspace(actor, input.chatId);
  const overviews = await Promise.all(AGENT_ROSTER.map(async (agent) => {
    const memory = await loadAgentMemory({ workspace, agentId: agent.id });
    return {
      agentId: agent.id,
      displayName: agent.displayName,
      role: agent.role,
      facts: memory.facts.map(factView),
      compactionNeeds: memory.compactionNeeds,
    };
  }));
  return overviews.filter((overview) => overview.facts.length > 0 || overview.compactionNeeds.length > 0);
}

/*
  Export = this project's memory folders as a portable JSON bundle of Markdown
  files. Paths are <agentId>/<slug>.md, so the bundle can be imported into
  another project (or unpacked anywhere) as a deliberate user action.
*/
export async function exportAgentMemory(
  actor: Actor,
  input: { chatId: string; agentId?: string | undefined },
): Promise<MemoryBundle> {
  const agents = input.agentId ? AGENT_ROSTER.filter((agent) => agent.id === input.agentId) : AGENT_ROSTER;
  if (agents.length === 0) throw new Error('unknown_agent');
  const workspace = await resolveWorkspace(actor, input.chatId);
  const perAgent = await Promise.all(agents.map(async (agent) => {
    const memory = await loadAgentMemory({ workspace, agentId: agent.id });
    return memory.facts.map((fact) => ({
      path: `${agent.id}/${fact.slug}.md`,
      content: fact.text,
    }));
  }));
  return {
    exportedAt: new Date().toISOString(),
    files: perAgent.flat(),
  };
}

// Receiving end of the exact export shape. The agent id and slug travel in the
// portable path, so a downloaded bundle can be imported without being
// rewritten or split by hand.
export async function importAgentMemory(
  actor: Actor,
  input: { chatId: string; files: MemoryBundle['files'] },
): Promise<{ imported: string[]; skipped: string[] }> {
  const workspace = await resolveWorkspace(actor, input.chatId);
  if (!workspace) throw new Error('chat_not_found');
  return importMemoryBundleIntoWorkspace(workspace, input.files);
}

export async function importMemoryBundleIntoWorkspace(
  workspace: string,
  bundleFiles: MemoryBundle['files'],
): Promise<{ imported: string[]; skipped: string[] }> {
  const byAgent = new Map<string, Array<{ slug: string; content: string }>>();
  for (const file of bundleFiles) {
    const match = /^([a-z0-9_-]+)\/([a-z0-9_-]+)\.md$/i.exec(file.path);
    if (!match) throw new Error('invalid_memory_bundle_path');
    const [, agentId, slug] = match;
    requireAgent(agentId!);
    const files = byAgent.get(agentId!) ?? [];
    files.push({ slug: slug!, content: file.content });
    byAgent.set(agentId!, files);
  }
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const [agentId, files] of byAgent) {
    const result = await importProjectFacts({ workspace, agentId, files });
    imported.push(...result.imported.map((slug) => `${agentId}/${slug}.md`));
    skipped.push(...result.skipped.map((slug) => `${agentId}/${slug}.md`));
  }
  return { imported, skipped };
}

function factView(fact: MemoryFact): MemoryFactView {
  return {
    slug: fact.slug,
    description: fact.description,
    type: fact.type,
    lines: fact.lines,
    bytes: fact.bytes,
    overLimit: fact.overLimit,
  };
}

function requireAgent(agentId: string): void {
  if (!AGENT_ROSTER.some((agent) => agent.id === agentId)) throw new Error('unknown_agent');
}

// Ownership check + path resolution. No chat → no workspace → empty memory.
async function resolveWorkspace(actor: Actor, chatId: string | undefined): Promise<string | null> {
  if (!chatId) return null;
  const chat = await getChat(actor, chatId);
  if (!chat) throw new Error('chat_not_found');
  return workspacePathForChat(chatId);
}
