/*
  memory-sim — end-to-end simulation of the agent memory + document governance
  pipeline against REAL runtime plumbing (runAgentTask → executeCliRuntime →
  workspace scan → doc policy), with a scripted Node process standing in for
  the coding CLI.

  Run: pnpm memory:sim   (or: npx tsx src/cli/memory-sim.ts)

  Memory is strictly per-project: nothing syncs anywhere on its own; the only
  way facts travel between projects is the explicit export → import exercised
  in scenario 5.

  Scenarios
  1. Mission in project A: agent ships code, leaves stray Markdown, writes one
     memory fact → deliverables kept, strays quarantined + folded as unreviewed,
     the deliberate fact persists in the project store.
  2. Second run in project A: the agent's prompt carries the fact from run 1
     (cross-run recall) and the document policy.
  3. Oversized memory file → the next prompt carries a compaction directive.
  4. Chat-model reply with a `## Memory` section → captured, stripped, stored.
  5. Export from project A → import into project B (deliberate portability).
*/

import './load-env.js';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAgentMemory,
  projectMemoryDir,
  writeProjectFact,
  MEMORY_LIMITS,
} from '../server/actions/agent-memory.js';
import { importMemoryBundleIntoWorkspace } from '../server/actions/agent-memory-actions.js';
import { runAgentTask } from '../server/actions/agent-runner.js';
import { extractMemorySection } from '../server/actions/memory-extract.js';
import { saveAgentRuntimeConfig } from '../server/actions/runtime-actions.js';
import { resetData } from '../server/store.js';
import type { PlanTask } from '../server/types.js';

const AGENT = 'atlas';

type Check = { name: string; ok: boolean; detail?: string };
const results: Array<{ scenario: string; checks: Check[] }> = [];

function check(checks: Check[], name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, ...(detail && !ok ? { detail } : {}) });
}

function task(id: string, overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id,
    title: 'Build the lens ranking page',
    assignee: '@atlas',
    owner: 'atlas',
    role: 'implementer',
    brief: 'Implement the ranking page with sortable lens scores.',
    deps: [],
    parallel: false,
    ...overrides,
  } as PlanTask;
}

// The fake coding agent: writes real deliverables, two stray Markdown files,
// and one deliberate memory fact — exactly what a chatty CLI model does.
const BUILDER_SCRIPT = `
const fs = require('node:fs');
fs.writeFileSync('index.html', '<!doctype html><html><head><title>Lens ranking</title></head><body>ok</body></html>');
fs.writeFileSync('styles.css', 'body { margin: 0; }');
fs.writeFileSync('NOTES.md', '# Working notes\\n\\nScoring uses sharpness 40%, bokeh 30%, value 30%.');
fs.writeFileSync('SUMMARY.md', '# What I did\\n\\nBuilt the page.');
fs.mkdirSync('.roundtable/agents/atlas/memory', { recursive: true });
fs.writeFileSync('.roundtable/agents/atlas/memory/lens-scoring-weights.md',
  '---\\nname: lens-scoring-weights\\ndescription: Lens ranking weights agreed with the user\\ntype: project\\nsource: sim\\n---\\n\\nSharpness 40%, bokeh 30%, value 30%.\\n');
fs.writeFileSync('.roundtable/agents/atlas/memory/MEMORY.md', '- [lens-scoring-weights](lens-scoring-weights.md) — ranking weights\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Built the ranking page.' }] } }) + '\\n');
`;

// The prompt spy: records the prompt it was launched with, produces nothing.
const ECHO_SCRIPT = `
const fs = require('node:fs');
fs.mkdirSync('.roundtable', { recursive: true });
fs.writeFileSync('.roundtable/prompt-capture.txt', process.argv[1] || '');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'inspected the prompt' }] } }) + '\\n');
`;

async function configureRuntime(script: string): Promise<void> {
  await saveAgentRuntimeConfig({
    agentId: AGENT,
    runtime: 'claude-code',
    command: process.execPath,
    args: ['-e', script, '{prompt}'],
  });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function scenario1(workspaceA: string): Promise<void> {
  const checks: Check[] = [];
  await configureRuntime(BUILDER_SCRIPT);
  const result = await runAgentTask({
    adapter: 'agent-cli',
    workspace: workspaceA,
    message: 'Build a lens ranking website',
    task: task('task_sim_build'),
    turnId: 'turn-sim-1',
    chatId: 'chat-sim-a',
  });

  const filePaths = (result.files ?? []).map((file) => file.path);
  check(checks, 'run succeeds', result.ok, result.error ?? undefined);
  check(checks, 'deliverables kept (html+css)', filePaths.includes('index.html') && filePaths.includes('styles.css'), filePaths.join(', '));
  check(checks, 'stray markdown NOT captured as artifacts', !filePaths.some((path) => path.endsWith('.md')), filePaths.join(', '));
  check(checks, 'NOTES.md physically moved out of the workspace', !(await exists(join(workspaceA, 'NOTES.md'))));
  check(checks, 'stray docs relocated to quarantine',
    await exists(join(workspaceA, '.roundtable', 'quarantine', 'task_sim_build', 'NOTES.md'))
    && await exists(join(workspaceA, '.roundtable', 'quarantine', 'task_sim_build', 'SUMMARY.md')));
  check(checks, 'quarantine surfaced as an event',
    result.events.some((event) => event.type === 'text_delta' && event.delta.includes('Document policy')));

  const memory = await loadAgentMemory({ workspace: workspaceA, agentId: AGENT });
  check(checks, 'stray content folded into unreviewed memory',
    memory.facts.some((fact) => fact.slug === 'unreviewed-notes' && fact.type === 'unreviewed'));
  check(checks, 'deliberate fact persists in the project store',
    memory.facts.some((fact) => fact.slug === 'lens-scoring-weights'));
  results.push({ scenario: 'S1 project A: governance during a real run', checks });
}

async function scenario2(workspaceA: string): Promise<void> {
  const checks: Check[] = [];
  await configureRuntime(ECHO_SCRIPT);
  const result = await runAgentTask({
    adapter: 'agent-cli',
    workspace: workspaceA,
    message: 'Improve the lens ranking site scoring',
    task: task('task_sim_recall'),
    turnId: 'turn-sim-2',
    chatId: 'chat-sim-a',
  });
  const prompt = await readFile(join(workspaceA, '.roundtable', 'prompt-capture.txt'), 'utf8').catch(() => '');
  check(checks, 'run succeeds', result.ok, result.error ?? undefined);
  check(checks, 'prompt carries the memory block', prompt.includes('# Your memory (this project)'));
  check(checks, 'fact from the earlier run recalled', prompt.includes('lens-scoring-weights'));
  check(checks, 'fact BODY injected (relevance-selected)', prompt.includes('Sharpness 40%'));
  check(checks, 'document policy present', prompt.includes('# Document policy'));
  check(checks, 'no compaction directive when memory is healthy', !prompt.includes('# Memory maintenance'));
  results.push({ scenario: 'S2 project A: cross-run recall within the project', checks });
}

async function scenario3(workspaceB: string): Promise<void> {
  const checks: Check[] = [];
  const oversized = Array.from(
    { length: MEMORY_LIMITS.factMaxLines + 20 },
    (_, index) => `- lens ranking observation number ${index}`,
  ).join('\n');
  await mkdir(projectMemoryDir(workspaceB, AGENT), { recursive: true });
  await writeFile(
    join(projectMemoryDir(workspaceB, AGENT), 'sprawling-notes.md'),
    `---\nname: sprawling-notes\ndescription: too many observations\ntype: project\nsource: sim\n---\n\n${oversized}\n`,
    'utf8',
  );
  await configureRuntime(ECHO_SCRIPT);
  const result = await runAgentTask({
    adapter: 'agent-cli',
    workspace: workspaceB,
    message: 'Tune the ranking again',
    task: task('task_sim_compact'),
    turnId: 'turn-sim-3',
    chatId: 'chat-sim-b',
  });
  const prompt = await readFile(join(workspaceB, '.roundtable', 'prompt-capture.txt'), 'utf8').catch(() => '');
  check(checks, 'run succeeds', result.ok, result.error ?? undefined);
  check(checks, 'compaction directive issued', prompt.includes('# Memory maintenance'));
  check(checks, 'offending file named with its budget', prompt.includes('sprawling-notes.md') && prompt.includes(`${MEMORY_LIMITS.factMaxLines} lines`));
  results.push({ scenario: 'S3 oversized memory: compaction directive', checks });
}

async function scenario4(workspaceB: string): Promise<void> {
  const checks: Check[] = [];
  const reply = [
    '# Scoring tweaks',
    '',
    'Raised the sharpness weight after user feedback.',
    '',
    '## Memory',
    '- user-wants-sharpness-first: The user weighs sharpness above bokeh for ranking.',
  ].join('\n');
  const extraction = extractMemorySection(reply);
  check(checks, 'memory section stripped from the deliverable', !extraction.text.includes('## Memory'));
  check(checks, 'fact parsed from the reply', extraction.facts[0]?.slug === 'user-wants-sharpness-first');
  for (const fact of extraction.facts) {
    await writeProjectFact({
      workspace: workspaceB,
      agentId: AGENT,
      slug: fact.slug,
      description: fact.description,
      type: 'note',
      source: 'chat:task_sim_chat',
      body: fact.body,
    });
  }
  const memory = await loadAgentMemory({ workspace: workspaceB, agentId: AGENT });
  check(checks, 'chat-captured fact lands in the project store',
    memory.facts.some((fact) => fact.slug === 'user-wants-sharpness-first'));
  results.push({ scenario: 'S4 chat reply: ## Memory capture path', checks });
}

async function scenario5(workspaceA: string, workspaceB: string): Promise<void> {
  const checks: Check[] = [];
  const source = await loadAgentMemory({ workspace: workspaceA, agentId: AGENT });
  const bundle = source.facts.map((fact) => ({ path: `${AGENT}/${fact.slug}.md`, content: fact.text }));
  check(checks, 'export bundle contains project A facts', bundle.length >= 2, `got ${bundle.length}`);

  const imported = await importMemoryBundleIntoWorkspace(workspaceB, bundle);
  check(checks, 'bundle imports into project B', imported.imported.length === bundle.length, imported.skipped.join(', '));

  const target = await loadAgentMemory({ workspace: workspaceB, agentId: AGENT });
  check(checks, 'imported facts readable in project B',
    target.facts.some((fact) => fact.slug === 'lens-scoring-weights'));
  const indexExists = await exists(join(projectMemoryDir(workspaceB, AGENT), 'MEMORY.md'));
  check(checks, 'MEMORY.md index rebuilt on import', indexExists);

  // Nothing crossed on its own: project B only has what the import delivered.
  check(checks, 'no automatic cross-project leakage before import happened',
    !source.facts.some((fact) => fact.slug === 'user-wants-sharpness-first'));
  results.push({ scenario: 'S5 export/import: deliberate portability, no auto-sharing', checks });
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-memory-sim-'));
  process.env.ROUNDTABLE_DATA_PATH = join(root, 'data.json');
  process.env.ROUNDTABLE_WORKSPACE_ROOT = join(root, 'workspaces');
  await resetData();
  const workspaceA = join(root, 'project-a');
  const workspaceB = join(root, 'project-b');
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });

  // Keep a stuck external runtime from stalling the whole simulation: these
  // are fake CLIs that exit in milliseconds, so short timeouts are safe.
  process.env.ROUNDTABLE_AGENT_TIMEOUT_MS ||= '30000';
  process.env.ROUNDTABLE_AGENT_IDLE_TIMEOUT_MS ||= '20000';

  const scenarios: Array<[string, () => Promise<void>]> = [
    ['S1', () => scenario1(workspaceA)],
    ['S2', () => scenario2(workspaceA)],
    ['S3', () => scenario3(workspaceB)],
    ['S4', () => scenario4(workspaceB)],
    ['S5', () => scenario5(workspaceA, workspaceB)],
  ];
  try {
    for (const [name, run] of scenarios) {
      process.stderr.write(`[memory-sim] ${name} …\n`);
      await run();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  let failed = 0;
  for (const { scenario, checks } of results) {
    const bad = checks.filter((item) => !item.ok);
    failed += bad.length;
    process.stdout.write(`\n${bad.length === 0 ? '✅' : '❌'} ${scenario}\n`);
    for (const item of checks) {
      process.stdout.write(`   ${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}\n`);
    }
  }
  const total = results.reduce((sum, item) => sum + item.checks.length, 0);
  process.stdout.write(`\n${total - failed}/${total} checks passed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`memory-sim crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
