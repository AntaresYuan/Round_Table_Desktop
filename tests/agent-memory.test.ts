import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEMORY_LIMITS,
  docPolicyFor,
  formatMemoryForPrompt,
  importProjectFacts,
  loadAgentMemory,
  memoryMaintenanceDirective,
  projectMemoryDir,
  projectPlanPath,
  selectMemoryForTask,
  writeProjectFact,
} from '../src/server/actions/agent-memory.js';
import { AGENT_ROSTER } from '../src/server/actions/agent-roster.js';

let tempDir = '';
let workspace = '';

const AGENT = 'nova';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-memory-'));
  workspace = join(tempDir, 'workspace');
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeFact(dir: string, slug: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${slug}.md`), body, 'utf8');
}

function fact(description: string, body: string): string {
  return `---\nname: x\ndescription: ${description}\ntype: pattern\n---\n\n${body}\n`;
}

describe('loadAgentMemory', () => {
  it('returns an empty memory when nothing was written', async () => {
    const memory = await loadAgentMemory({ workspace, agentId: AGENT });
    expect(memory.facts).toEqual([]);
    expect(memory.plan).toBeNull();
    expect(memory.compactionNeeds).toEqual([]);
  });

  it('returns an empty memory without a workspace (no chat)', async () => {
    const memory = await loadAgentMemory({ workspace: null, agentId: AGENT });
    expect(memory.facts).toEqual([]);
  });

  it('flags an over-budget fact and an over-budget plan for compaction', async () => {
    const longBody = Array.from({ length: MEMORY_LIMITS.factMaxLines + 20 }, (_, i) => `line ${i}`).join('\n');
    await writeFact(projectMemoryDir(workspace, AGENT), 'huge-fact', fact('too long', longBody));
    const longPlan = Array.from({ length: MEMORY_LIMITS.planMaxLines + 10 }, (_, i) => `- step ${i}`).join('\n');
    await mkdir(join(workspace, '.roundtable', 'agents', AGENT), { recursive: true });
    await writeFile(projectPlanPath(workspace, AGENT), longPlan, 'utf8');

    const memory = await loadAgentMemory({ workspace, agentId: AGENT });
    expect(memory.facts[0]?.overLimit).toBe(true);
    expect(memory.compactionNeeds.some((need) => need.includes('huge-fact'))).toBe(true);
    expect(memory.compactionNeeds.some((need) => need.includes('plan.md'))).toBe(true);

    const directive = memoryMaintenanceDirective(memory);
    expect(directive).toContain('Memory maintenance');
    expect(directive).toContain('huge-fact');
  });

  it('emits no maintenance directive when memory is healthy', async () => {
    await writeFact(projectMemoryDir(workspace, AGENT), 'small', fact('fine', 'short body'));
    const memory = await loadAgentMemory({ workspace, agentId: AGENT });
    expect(memoryMaintenanceDirective(memory)).toBe('');
  });
});

describe('selectMemoryForTask', () => {
  it('ranks the fact overlapping the task text first and drops unrelated ones', async () => {
    await writeFact(projectMemoryDir(workspace, AGENT), 'lens-ranking', fact('lens site ranking data model', 'The lens ranking site sorts Panasonic lenses by score.'));
    await writeFact(projectMemoryDir(workspace, AGENT), 'hotpot-menu', fact('hotpot restaurant menu', 'The hotpot page lists soup bases.'));

    const memory = await loadAgentMemory({ workspace, agentId: AGENT });
    const selected = selectMemoryForTask(memory, 'Build the Panasonic lens ranking website');
    expect(selected[0]?.slug).toBe('lens-ranking');
    expect(selected.some((item) => item.slug === 'hotpot-menu')).toBe(false);
  });

  it('truncates an over-budget fact for injection without touching the file', async () => {
    const longBody = Array.from({ length: MEMORY_LIMITS.factMaxLines + 30 }, () => 'lens ranking detail').join('\n');
    await writeFact(projectMemoryDir(workspace, AGENT), 'lens-notes', fact('lens notes', longBody));

    const memory = await loadAgentMemory({ workspace, agentId: AGENT });
    const selected = selectMemoryForTask(memory, 'lens ranking task');
    expect(selected[0]?.text.split('\n').length).toBeLessThanOrEqual(MEMORY_LIMITS.factMaxLines + 1);
    expect(selected[0]?.text).toContain('[truncated');

    const onDisk = await readFile(join(projectMemoryDir(workspace, AGENT), 'lens-notes.md'), 'utf8');
    expect(onDisk).not.toContain('[truncated');
  });

  it('never exceeds the injection budgets', async () => {
    for (let i = 0; i < MEMORY_LIMITS.injectMaxFacts + 4; i += 1) {
      await writeFact(projectMemoryDir(workspace, AGENT), `lens-fact-${i}`, fact(`lens fact ${i}`, 'lens ranking website note'));
    }
    const memory = await loadAgentMemory({ workspace, agentId: AGENT });
    const selected = selectMemoryForTask(memory, 'lens ranking website');
    expect(selected.length).toBeLessThanOrEqual(MEMORY_LIMITS.injectMaxFacts);
    const totalBytes = selected.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0);
    expect(totalBytes).toBeLessThanOrEqual(MEMORY_LIMITS.injectMaxBytes);
  });
});

describe('formatMemoryForPrompt', () => {
  it('returns an empty string when there is no memory at all', async () => {
    const memory = await loadAgentMemory({ workspace, agentId: AGENT });
    expect(formatMemoryForPrompt(memory, 'anything')).toBe('');
  });

  it('includes the index, the selected fact body, and the plan head', async () => {
    await writeFact(projectMemoryDir(workspace, AGENT), 'lens-ranking', fact('lens ranking model', 'Sort lenses by weighted score.'));
    await mkdir(join(workspace, '.roundtable', 'agents', AGENT), { recursive: true });
    await writeFile(projectPlanPath(workspace, AGENT), '- finish the compare table', 'utf8');

    const memory = await loadAgentMemory({ workspace, agentId: AGENT });
    const block = formatMemoryForPrompt(memory, 'lens ranking website');
    expect(block).toContain('# Your memory (this project)');
    expect(block).toContain('lens-ranking — lens ranking model');
    expect(block).toContain('Sort lenses by weighted score.');
    expect(block).toContain('finish the compare table');
  });
});

describe('importProjectFacts', () => {
  it('imports a bundle into this project and rebuilds the index', async () => {
    const result = await importProjectFacts({
      workspace,
      agentId: AGENT,
      files: [{ slug: 'lens-ranking', content: fact('lens ranking model', 'imported body') }],
    });
    expect(result.imported).toEqual(['lens-ranking']);
    expect(result.skipped).toEqual([]);

    const imported = await readFile(join(projectMemoryDir(workspace, AGENT), 'lens-ranking.md'), 'utf8');
    expect(imported).toContain('imported body');
    const index = await readFile(join(projectMemoryDir(workspace, AGENT), 'MEMORY.md'), 'utf8');
    expect(index).toContain('- [lens-ranking](lens-ranking.md) — lens ranking model');
  });

  it('updates existing slugs but skips NEW slugs when the store is full', async () => {
    for (let i = 0; i < MEMORY_LIMITS.storeMaxFacts; i += 1) {
      await writeFact(projectMemoryDir(workspace, AGENT), `old-${String(i).padStart(2, '0')}`, fact(`old ${i}`, 'old body'));
    }
    const result = await importProjectFacts({
      workspace,
      agentId: AGENT,
      files: [
        { slug: 'old-00', content: fact('old 0 updated', 'updated body') },
        { slug: 'brand-new', content: fact('new fact', 'new body') },
      ],
    });
    expect(result.imported).toContain('old-00');
    expect(result.skipped).toContain('brand-new');

    const updated = await readFile(join(projectMemoryDir(workspace, AGENT), 'old-00.md'), 'utf8');
    expect(updated).toContain('updated body');
  });
});

describe('concurrent writers (same agent, one scheduler wave)', () => {
  it('serializes writeProjectFact so capacity is never overshot and the index stays consistent', async () => {
    const results = await Promise.all(Array.from({ length: MEMORY_LIMITS.storeMaxFacts + 10 }, (_, i) =>
      writeProjectFact({
        workspace,
        agentId: AGENT,
        slug: `parallel-fact-${String(i).padStart(2, '0')}`,
        description: `fact ${i}`,
        type: 'note',
        source: 'test',
        body: `body ${i}`,
      })));

    const written = results.filter(Boolean).length;
    expect(written).toBe(MEMORY_LIMITS.storeMaxFacts);

    const memory = await loadAgentMemory({ workspace, agentId: AGENT });
    expect(memory.facts).toHaveLength(MEMORY_LIMITS.storeMaxFacts);

    const index = await readFile(join(projectMemoryDir(workspace, AGENT), 'MEMORY.md'), 'utf8');
    const indexLines = index.split('\n').filter((line) => line.startsWith('- ['));
    expect(indexLines).toHaveLength(MEMORY_LIMITS.storeMaxFacts);
  });
});

describe('docPolicyFor', () => {
  it('gives each role its deliverable rule and the two private slots', () => {
    const architect = AGENT_ROSTER.find((agent) => agent.id === 'nova')!;
    const policy = docPolicyFor(architect);
    expect(policy).toContain('docs/architecture.md');
    expect(policy).toContain(`.roundtable/agents/${architect.id}/`);
    expect(policy).toContain('plan.md');

    const reviewer = AGENT_ROSTER.find((agent) => agent.role === 'reviewer')!;
    expect(docPolicyFor(reviewer)).toContain('Do NOT create files');
  });
});
