/*
  Per-agent persistent memory, modeled on the Claude Code harness memory format:
  one fact per Markdown file with frontmatter (name/description/type/source),
  plus a MEMORY.md index with one line per fact. Plain files, no store coupling,
  so a memory folder can be exported and imported into another project.

  ONE scope, by deliberate product decision: memory lives in the project
  workspace (<workspace>/.roundtable/agents/<agentId>/memory/) and never leaves
  it on its own. There is no global store and no automatic cross-project
  sharing — moving memory between projects is an explicit export/import.

  Every file has a hard budget. Injection ALWAYS stays inside the prompt budget
  (deterministic truncation); files over their own budget are never rewritten by
  the system — instead the next CLI run receives a compaction directive so the
  agent itself merges/prunes them. The system only ever adds; it never destroys
  a memory the user could still want.

  The workspace scanner skips dot-directories, so nothing under .roundtable —
  including all of this — can ever appear in the Files panel.
*/

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProfile } from './agent-roster.js';
import { tokenizeForOverlap } from './text-overlap.js';

// File budgets. A fact is a note, not an essay; the plan is a working list.
export const MEMORY_LIMITS = {
  factMaxLines: 40,
  factMaxBytes: 4_096,
  indexMaxEntries: 40,
  storeMaxFacts: 40,
  storeMaxBytes: 64 * 1_024,
  planMaxLines: 120,
  injectMaxFacts: 8,
  injectMaxBytes: 6_000,
  injectPlanLines: 40,
} as const;

export type MemoryFactType = 'preference' | 'pattern' | 'project' | 'reference' | 'unreviewed' | 'note';

export type MemoryFact = {
  slug: string;
  description: string;
  // From frontmatter `type:`; 'unreviewed' marks auto-captured content (e.g.
  // quarantined stray docs) awaiting the architect's audit.
  type: MemoryFactType;
  text: string;
  lines: number;
  bytes: number;
  overLimit: boolean;
};

export type AgentMemory = {
  agentId: string;
  facts: MemoryFact[];
  plan: string | null;
  planLines: number;
  // Human-readable problems for the compaction directive, empty when healthy.
  compactionNeeds: string[];
};

export function projectMemoryDir(workspace: string, agentId: string): string {
  return join(workspace, '.roundtable', 'agents', sanitizeSegment(agentId), 'memory');
}

export function projectPlanPath(workspace: string, agentId: string): string {
  return join(workspace, '.roundtable', 'agents', sanitizeSegment(agentId), 'plan.md');
}

// Agent ids come from the roster, but they end up in filesystem paths — never
// let a crafted id escape the agents directory.
function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_@.-]/g, '_');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'unknown';
}

// The one slug normalizer for every write path into a memory store: lowercase
// latin/CJK/hyphen only, so a slug can never traverse out of its directory.
export function memorySlug(value: string, maxLength = 64): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength);
}

/*
  Every mutating operation on a memory directory is an unlocked
  read → capacity-check → write → rebuild-index sequence, and the scheduler can
  run two tasks for the SAME agent in one wave. Serialize writers per directory
  (in-process suffices: all writes flow through this one module in one server
  process). The map holds one settled promise per directory ever touched —
  bounded by agents × workspaces, a few dozen entries in practice.
*/
const dirLocks = new Map<string, Promise<unknown>>();

function withDirLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = dirLocks.get(dir) ?? Promise.resolve();
  const result = previous.then(run);
  // The stored tail never rejects, so one failed writer can't poison the queue.
  dirLocks.set(dir, result.catch(() => undefined));
  return result;
}

export async function loadAgentMemory(input: {
  // null → no chat workspace to read from; the memory is simply empty.
  workspace: string | null;
  agentId: string;
}): Promise<AgentMemory> {
  const [facts, plan] = await Promise.all([
    input.workspace ? readFactsFrom(projectMemoryDir(input.workspace, input.agentId)) : Promise.resolve([]),
    input.workspace ? readFileOrNull(projectPlanPath(input.workspace, input.agentId)) : Promise.resolve(null),
  ]);
  const planLines = plan ? plan.split('\n').length : 0;
  return {
    agentId: input.agentId,
    facts,
    plan,
    planLines,
    compactionNeeds: collectCompactionNeeds(facts, planLines),
  };
}

async function readFactsFrom(dir: string): Promise<MemoryFact[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  // Read PAST the store cap (2x) so an overshot store is visible to capacity
  // checks and compaction detection instead of silently hiding the overflow;
  // the 2x bound still caps IO if someone dumps a huge folder here.
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md')
    .map((entry) => entry.name)
    .sort()
    .slice(0, MEMORY_LIMITS.storeMaxFacts * 2);
  const facts = await Promise.all(names.map(async (name) => {
    const raw = await readFileOrNull(join(dir, name));
    if (raw === null) return null;
    const slug = name.replace(/\.md$/, '');
    const lines = raw.split('\n').length;
    const bytes = Buffer.byteLength(raw, 'utf8');
    return {
      slug,
      description: factDescription(raw, slug),
      type: factType(raw),
      text: raw,
      lines,
      bytes,
      overLimit: lines > MEMORY_LIMITS.factMaxLines || bytes > MEMORY_LIMITS.factMaxBytes,
    };
  }));
  return facts.filter((fact): fact is MemoryFact => fact !== null);
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

const FACT_TYPES: ReadonlySet<string> = new Set(['preference', 'pattern', 'project', 'reference', 'unreviewed', 'note']);

function factType(raw: string): MemoryFactType {
  const match = raw.match(/^---\n[\s\S]*?\btype:\s*(\S+)\n[\s\S]*?\n---/);
  const value = match?.[1]?.trim().toLowerCase();
  return value && FACT_TYPES.has(value) ? (value as MemoryFactType) : 'note';
}

// description: from frontmatter when present, else the first content line.
function factDescription(raw: string, fallback: string): string {
  const fromFrontmatter = raw.match(/^---\n[\s\S]*?\bdescription:\s*(.+?)\n[\s\S]*?\n---/);
  if (fromFrontmatter?.[1]) return fromFrontmatter[1].trim().slice(0, 120);
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const firstLine = body.split('\n').find((line) => line.trim() && !line.startsWith('#'));
  return (firstLine ?? fallback).trim().slice(0, 120);
}

function collectCompactionNeeds(facts: MemoryFact[], planLines: number): string[] {
  const needs: string[] = [];
  for (const fact of facts.filter((item) => item.overLimit)) {
    needs.push(
      `${fact.slug}.md is ${fact.lines} lines / ${fact.bytes} bytes `
      + `(budget: ${MEMORY_LIMITS.factMaxLines} lines / ${MEMORY_LIMITS.factMaxBytes} bytes) — rewrite it tighter.`,
    );
  }
  if (facts.length > MEMORY_LIMITS.storeMaxFacts - 5) {
    needs.push(
      `you have ${facts.length} memory files (cap: ${MEMORY_LIMITS.storeMaxFacts}) — merge overlapping facts and delete stale ones.`,
    );
  }
  const totalBytes = facts.reduce((sum, fact) => sum + fact.bytes, 0);
  if (totalBytes > MEMORY_LIMITS.storeMaxBytes) {
    needs.push(
      `memory totals ${totalBytes} bytes (cap: ${MEMORY_LIMITS.storeMaxBytes}) — consolidate before adding more.`,
    );
  }
  if (planLines > MEMORY_LIMITS.planMaxLines) {
    needs.push(
      `plan.md is ${planLines} lines (cap: ${MEMORY_LIMITS.planMaxLines}) — drop finished items, keep only what is still ahead.`,
    );
  }
  return needs;
}

/*
  Recall: rank facts against the task text with the same overlap scorer the
  breakout rooms use, then take the best ones inside a hard byte budget. Facts
  over their own budget are truncated FOR INJECTION only — the file on disk is
  the agent's to compact.
*/
export function selectMemoryForTask(memory: AgentMemory, taskText: string): MemoryFact[] {
  const query = new Set(tokenizeForOverlap(taskText));
  const scored = memory.facts
    .map((fact, index) => {
      const overlap = tokenizeForOverlap(`${fact.slug} ${fact.description} ${fact.text}`)
        .filter((token) => query.has(token)).length;
      return { fact, overlap, score: overlap - index * 0.001 };
    })
    // A single shared token is noise ("the", one CJK bigram); require two,
    // matching the breakout classifier's relevance threshold.
    .filter((item) => item.overlap >= 2)
    .sort((a, b) => b.score - a.score);
  const selected: MemoryFact[] = [];
  let budget = MEMORY_LIMITS.injectMaxBytes;
  for (const { fact } of scored) {
    if (selected.length >= MEMORY_LIMITS.injectMaxFacts) break;
    const text = truncateForInjection(fact.text);
    const cost = Buffer.byteLength(text, 'utf8');
    if (cost > budget) continue;
    selected.push({ ...fact, text });
    budget -= cost;
  }
  return selected;
}

function truncateForInjection(text: string): string {
  const lines = text.split('\n');
  const capped = lines.length > MEMORY_LIMITS.factMaxLines
    ? [...lines.slice(0, MEMORY_LIMITS.factMaxLines), '… [truncated: over budget, compact this file]']
    : lines;
  const joined = capped.join('\n');
  if (Buffer.byteLength(joined, 'utf8') <= MEMORY_LIMITS.factMaxBytes) return joined;
  return `${joined.slice(0, MEMORY_LIMITS.factMaxBytes)}\n… [truncated: over budget, compact this file]`;
}

/*
  Prompt block: the full index (one line per fact — cheap) plus the selected
  fact bodies and the head of the agent's plan. Returns '' when there is
  nothing to say so callers can skip the section entirely.
*/
export function formatMemoryForPrompt(memory: AgentMemory, taskText: string): string {
  if (memory.facts.length === 0 && !memory.plan) return '';
  const selected = selectMemoryForTask(memory, taskText);
  const indexLines = memory.facts
    .slice(0, MEMORY_LIMITS.indexMaxEntries)
    .map((fact) => `- ${fact.slug} — ${fact.description}`);
  const planHead = memory.plan
    ? memory.plan.split('\n').slice(0, MEMORY_LIMITS.injectPlanLines).join('\n').trim()
    : '';
  return [
    '# Your memory (this project)',
    '',
    'Notes you wrote in earlier runs. They reflect the state when written — verify anything critical before relying on it.',
    '',
    ...(indexLines.length > 0 ? ['Index:', ...indexLines, ''] : []),
    ...(selected.length > 0
      ? selected.flatMap((fact) => [`## ${fact.slug}`, '', fact.text, ''])
      : []),
    ...(planHead ? ['## Your plan (plan.md)', '', planHead, ''] : []),
  ].join('\n').trim();
}

/*
  Maintenance directive for CLI agents: when any memory file is over budget the
  agent is told to compact it BEFORE the task. Deterministic detection, agent
  execution — the system never rewrites memory content itself.
*/
export function memoryMaintenanceDirective(memory: AgentMemory): string {
  if (memory.compactionNeeds.length === 0) return '';
  return [
    '# Memory maintenance (do this first, briefly)',
    '',
    'Some of your memory files are over budget. Before starting the task, compact them:',
    ...memory.compactionNeeds.map((need) => `- ${need}`),
    'Preserve real information by merging, not deleting blindly. Update MEMORY.md so it stays one line per fact. Then continue with the task.',
  ].join('\n');
}

/*
  Doc policy: what each role may write in the WORKSPACE (deliverable space).
  Private memory/plan slots live under .roundtable and are always allowed.
*/
export function docPolicyFor(agent: AgentProfile): string {
  const deliverableRule: Record<AgentProfile['role'], string> = {
    planner: 'Do NOT create Markdown files in the workspace. Your plan lives in your reply and in your private plan.md.',
    pm: 'The only workspace Markdown you may create is docs/requirements.md, and only when the task explicitly needs a requirements document. Update it in place; never create variants.',
    architect: 'The only workspace Markdown you may create is docs/architecture.md. Update it in place; never create architecture-v2.md or similar variants.',
    implementer: 'Create the code, HTML, CSS, and asset files the task needs. Do NOT create Markdown files unless the task itself is a documentation task.',
    reviewer: 'Do NOT create files. Your review is your reply text; it reaches the next agent automatically.',
    fixer: 'Edit existing files only. Do NOT create new Markdown files.',
  };
  return [
    '# Document policy',
    '',
    deliverableRule[agent.role],
    '',
    `You own exactly two private note slots under .roundtable/agents/${agent.id}/:`,
    `- memory/ — one fact per file (kebab-case slug .md, max ${MEMORY_LIMITS.factMaxLines} lines each) plus a MEMORY.md index with one line per fact: "- [slug](slug.md) — one-line hook". Update existing facts in place instead of writing near-duplicates.`,
    `- plan.md — your forward plan (max ${MEMORY_LIMITS.planMaxLines} lines). Keep only what is still ahead.`,
    'Write durable lessons, user preferences, and project facts there — NOT loose notes in the workspace root.',
  ].join('\n');
}

/*
  Import fact files into one agent's memory in THIS project — the receiving end
  of an exported bundle. Updates always land, new slugs need free capacity.
*/
export async function importProjectFacts(input: {
  workspace: string;
  agentId: string;
  files: Array<{ slug: string; content: string }>;
}): Promise<{ imported: string[]; skipped: string[] }> {
  const dir = projectMemoryDir(input.workspace, input.agentId);
  return withDirLock(dir, async () => {
    await mkdir(dir, { recursive: true });
    const existing = new Set((await readFactsFrom(dir)).map((fact) => fact.slug));
    const imported: string[] = [];
    const skipped: string[] = [];
    let capacity = MEMORY_LIMITS.storeMaxFacts - existing.size;
    for (const file of input.files) {
      const slug = memorySlug(file.slug);
      const content = file.content.trim();
      if (!slug || !content || Buffer.byteLength(content, 'utf8') > MEMORY_LIMITS.factMaxBytes * 2) {
        skipped.push(file.slug);
        continue;
      }
      const isUpdate = existing.has(slug);
      if (!isUpdate && capacity <= 0) {
        skipped.push(slug);
        continue;
      }
      await writeFile(join(dir, `${slug}.md`), `${content}\n`, 'utf8');
      imported.push(slug);
      if (!isUpdate) {
        existing.add(slug);
        capacity -= 1;
      }
    }
    await rebuildMemoryIndex(dir);
    return { imported, skipped };
  });
}

async function rebuildMemoryIndex(dir: string): Promise<void> {
  const facts = await readFactsFrom(dir);
  const index = facts.map((fact) => `- [${fact.slug}](${fact.slug}.md) — ${fact.description}`).join('\n');
  await writeFile(join(dir, 'MEMORY.md'), `${index}\n`, 'utf8');
}

/*
  System-side fact writer: keeps the file format (frontmatter + body + budgets)
  in one place for callers that capture memory on the agent's behalf — the
  chat-model `## Memory` extractor and the stray-doc quarantine fold. Returns
  false when the store is at capacity for a NEW slug (the caller keeps its
  source content; nothing is lost).
*/
export async function writeProjectFact(input: {
  workspace: string;
  agentId: string;
  slug: string;
  description: string;
  type: MemoryFactType;
  source: string;
  body: string;
}): Promise<boolean> {
  const dir = projectMemoryDir(input.workspace, input.agentId);
  const slug = memorySlug(input.slug) || 'fact';
  return withDirLock(dir, async () => {
    const existing = await readFactsFrom(dir);
    const isUpdate = existing.some((fact) => fact.slug === slug);
    if (!isUpdate && existing.length >= MEMORY_LIMITS.storeMaxFacts) return false;
    const body = Buffer.byteLength(input.body, 'utf8') > MEMORY_LIMITS.factMaxBytes
      ? `${input.body.slice(0, MEMORY_LIMITS.factMaxBytes - 64)}\n… [truncated at capture]`
      : input.body;
    const text = [
      '---',
      `name: ${slug}`,
      `description: ${input.description.replace(/\n/g, ' ').slice(0, 120)}`,
      `type: ${input.type}`,
      `source: ${input.source}`,
      '---',
      '',
      body,
      '',
    ].join('\n');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${slug}.md`), text, 'utf8');
    await rebuildMemoryIndex(dir);
    return true;
  });
}
