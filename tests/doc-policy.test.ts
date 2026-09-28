import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentMemory } from '../src/server/actions/agent-memory.js';
import { AGENT_ROSTER } from '../src/server/actions/agent-roster.js';
import type { AgentProfile } from '../src/server/actions/agent-roster.js';
import { applyDocPolicy, moveFileToQuarantine, quarantineDocs } from '../src/server/actions/turns/doc-policy.js';
import type { ChangedWorkspaceFile } from '../src/server/actions/turns/workspace-scan.js';
import type { PlanTask } from '../src/server/types.js';

let tempDir = '';
let workspace = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-docpolicy-'));
  workspace = join(tempDir, 'workspace');
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function agent(id: string): AgentProfile {
  const found = AGENT_ROSTER.find((item) => item.id === id);
  if (!found) throw new Error(`unknown agent ${id}`);
  return found;
}

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 'task_1',
    title: 'Build the ranking page',
    brief: 'Implement the lens ranking page',
    assignee: '@atlas',
    role: 'implementer',
    stageId: 'build',
    deps: [],
    status: 'pending',
    artifactIds: [],
    ...overrides,
  } as PlanTask;
}

function file(path: string, text = 'content'): ChangedWorkspaceFile {
  return { path, text, kind: path.endsWith('.html') ? 'preview' : path.endsWith('.md') ? 'markdown' : 'code' };
}

describe('applyDocPolicy', () => {
  it('keeps code and html, quarantines stray markdown for an implementer', () => {
    const decision = applyDocPolicy({
      task: task(),
      agent: agent('atlas'),
      files: [file('index.html'), file('js/app.js'), file('NOTES.md'), file('SUMMARY.md')],
    });
    expect(decision.kept.map((item) => item.path)).toEqual(['index.html', 'js/app.js']);
    expect(decision.quarantined.map((item) => item.file.path)).toEqual(['NOTES.md', 'SUMMARY.md']);
  });

  it('lets the architect keep exactly docs/architecture.md and nothing else in Markdown', () => {
    const decision = applyDocPolicy({
      task: task({ role: 'architect', assignee: '@nova', title: 'Design the system' }),
      agent: agent('nova'),
      files: [file('docs/architecture.md'), file('architecture-v2.md')],
    });
    expect(decision.kept.map((item) => item.path)).toEqual(['docs/architecture.md']);
    expect(decision.quarantined[0]?.file.path).toBe('architecture-v2.md');
    expect(decision.quarantined[0]?.reason).toContain('docs/architecture.md');
  });

  it('keeps all markdown when the task itself is a documentation task', () => {
    const decision = applyDocPolicy({
      task: task({ title: 'Write the project README', brief: 'Add usage documentation' }),
      agent: agent('atlas'),
      files: [file('README.md'), file('docs/usage.md')],
    });
    expect(decision.quarantined).toEqual([]);
    expect(decision.kept).toHaveLength(2);
  });

  it('recognizes Chinese documentation tasks', () => {
    const decision = applyDocPolicy({
      task: task({ title: '写一份使用说明', brief: '面向新用户的中文文档' }),
      agent: agent('atlas'),
      files: [file('使用说明.md')],
    });
    expect(decision.quarantined).toEqual([]);
  });

  it('quarantines reviewer markdown — the review is transcript text, not a file', () => {
    const decision = applyDocPolicy({
      task: task({ role: 'reviewer', assignee: '@vera', title: 'Review the build' }),
      agent: agent('vera'),
      files: [file('review-notes.md')],
    });
    expect(decision.kept).toEqual([]);
    expect(decision.quarantined).toHaveLength(1);
  });
});

describe('quarantineDocs', () => {
  it('moves the file out of the workspace and folds it into unreviewed memory', async () => {
    await writeFile(join(workspace, 'NOTES.md'), '# Notes\n\nUseful stray detail about lens scoring.', 'utf8');
    const decision = applyDocPolicy({
      task: task(),
      agent: agent('atlas'),
      files: [file('NOTES.md', '# Notes\n\nUseful stray detail about lens scoring.')],
    });

    const result = await quarantineDocs({
      workspace,
      taskId: 'task_1',
      agentId: 'atlas',
      quarantined: decision.quarantined,
    });
    expect(result.moved).toEqual(['NOTES.md']);
    expect(result.folded).toEqual(['NOTES.md']);

    await expect(access(join(workspace, 'NOTES.md'))).rejects.toThrow();
    const relocated = await readFile(join(workspace, '.roundtable', 'quarantine', 'task_1', 'NOTES.md'), 'utf8');
    expect(relocated).toContain('lens scoring');

    const memory = await loadAgentMemory({ workspace, agentId: 'atlas' });
    const fact = memory.facts.find((item) => item.slug === 'unreviewed-notes');
    expect(fact?.type).toBe('unreviewed');
    expect(fact?.text).toContain('lens scoring');
  });

  it('removes the source when rename falls back to copy across filesystems', async () => {
    const source = join(workspace, 'SUMMARY.md');
    const target = join(workspace, '.roundtable', 'quarantine', 'task_1', 'SUMMARY.md');
    await writeFile(source, '# Summary\n\nKeep this detail.', 'utf8');
    await mkdir(join(workspace, '.roundtable', 'quarantine', 'task_1'), { recursive: true });

    await moveFileToQuarantine(
      { source, target, text: '# Summary\n\nKeep this detail.' },
      { rename: async () => { throw new Error('EXDEV'); } },
    );

    await expect(access(source)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toContain('Keep this detail.');
  });
});

describe('buildDocsAuditContext', () => {
  it('lists markdown artifacts and memory health for the architect audit', async () => {
    const { writeProjectFact } = await import('../src/server/actions/agent-memory.js');
    await writeProjectFact({
      workspace,
      agentId: 'atlas',
      slug: 'unreviewed-notes',
      description: 'quarantined notes',
      type: 'unreviewed',
      source: 'task:task_1',
      body: 'stray content',
    });
    const { buildDocsAuditContext } = await import('../src/server/actions/turns/doc-policy.js');
    const context = await buildDocsAuditContext({
      workspace,
      artifacts: [
        { id: 'a1', kind: 'markdown', title: 'docs/architecture.md', ownerAgentId: 'nova' },
        { id: 'a2', kind: 'preview', title: 'index.html', ownerAgentId: 'atlas' },
        { id: 'a3', kind: 'markdown', title: 'docs/architecture.md', ownerAgentId: 'nova' },
      ],
    });
    expect(context).toContain('Docs & memory audit');
    expect(context.match(/docs\/architecture\.md/g)).toHaveLength(1);
    expect(context).not.toContain('index.html');
    expect(context).toContain('Atlas (atlas): 1 fact(s), 1 unreviewed');
  });
});
