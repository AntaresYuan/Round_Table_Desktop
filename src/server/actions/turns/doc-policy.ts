/*
  Hard gate for stray Markdown: CLI agents love leaving NOTES.md / SUMMARY.md /
  plan-v2.md in the workspace root, and every one of them used to become a Files
  panel artifact. The prompt-level document policy (docPolicyFor) states the
  rules; this module ENFORCES them on the post-run workspace scan.

  Decision is a pure function (applyDocPolicy); the filesystem move is a
  separate side-effecting step (quarantineDocs) so the rules are trivially
  testable. Quarantined files are moved — not deleted — to
  .roundtable/quarantine/<taskId>/ and their content is folded into the agent's
  project memory as `type: unreviewed`, so real information survives for the
  architect's audit while the workspace and Files panel stay clean.
*/

import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Artifact, PlanTask } from '../../types.js';
import { AGENT_ROSTER } from '../agent-roster.js';
import type { AgentProfile } from '../agent-roster.js';
import { loadAgentMemory, memorySlug, writeProjectFact } from '../agent-memory.js';
import type { ChangedWorkspaceFile } from './workspace-scan.js';

export type QuarantinedDoc = {
  file: ChangedWorkspaceFile;
  reason: string;
};

export type DocPolicyDecision = {
  kept: ChangedWorkspaceFile[];
  quarantined: QuarantinedDoc[];
};

// Canonical, update-in-place doc each role may own in the workspace.
const CANONICAL_DOC_BY_ROLE: Partial<Record<AgentProfile['role'], string>> = {
  pm: 'docs/requirements.md',
  architect: 'docs/architecture.md',
};

// Fold at most this many stray docs into memory per run; the rest still land
// in quarantine but are not worth a memory slot each.
const MAX_MEMORY_FOLDS = 5;

export function applyDocPolicy(input: {
  task: PlanTask;
  agent: AgentProfile;
  files: ChangedWorkspaceFile[];
}): DocPolicyDecision {
  // A documentation task's Markdown IS the deliverable — everything passes.
  if (isDocsTask(input.task)) return { kept: input.files, quarantined: [] };

  const canonical = CANONICAL_DOC_BY_ROLE[input.agent.role];
  const kept: ChangedWorkspaceFile[] = [];
  const quarantined: QuarantinedDoc[] = [];
  for (const file of input.files) {
    if (!isMarkdown(file.path)) {
      kept.push(file);
      continue;
    }
    if (canonical && file.path === canonical) {
      kept.push(file);
      continue;
    }
    quarantined.push({
      file,
      reason: canonical
        ? `${input.agent.role} may only write ${canonical} (task is not a documentation task)`
        : `${input.agent.role} may not create Markdown deliverables (task is not a documentation task)`,
    });
  }
  return { kept, quarantined };
}

/*
  Move quarantined files out of the workspace tree and fold their content into
  the agent's project memory as unreviewed facts. Best-effort per file: one
  failed move must not lose the other files or fail a run that succeeded.
*/
export async function quarantineDocs(input: {
  workspace: string;
  taskId: string;
  agentId: string;
  quarantined: QuarantinedDoc[];
}): Promise<{ moved: string[]; folded: string[]; failed: string[] }> {
  const moved: string[] = [];
  const folded: string[] = [];
  const failed: string[] = [];
  for (const [index, item] of input.quarantined.entries()) {
    const target = join(input.workspace, '.roundtable', 'quarantine', input.taskId, item.file.path);
    try {
      await mkdir(dirname(target), { recursive: true });
      await moveFileToQuarantine({
        source: join(input.workspace, item.file.path),
        target,
        text: item.file.text,
      });
      moved.push(item.file.path);
    } catch {
      // Surfaced to the caller (and the task's event stream) instead of
      // silently vanishing — a systemic FS problem must stay visible.
      failed.push(item.file.path);
      continue;
    }
    if (index >= MAX_MEMORY_FOLDS) continue;
    const wrote = await writeProjectFact({
      workspace: input.workspace,
      agentId: input.agentId,
      slug: `unreviewed-${slugFromPath(item.file.path)}`,
      description: `Quarantined stray doc ${item.file.path} (${item.reason})`,
      type: 'unreviewed',
      source: `task:${input.taskId}`,
      body: item.file.text,
    }).catch(() => false);
    if (wrote) folded.push(item.file.path);
  }
  return { moved, folded, failed };
}

export async function moveFileToQuarantine(
  input: { source: string; target: string; text: string },
  overrides: Partial<{
    rename: typeof rename;
    writeFile: typeof writeFile;
    unlink: typeof unlink;
  }> = {},
): Promise<void> {
  const move = overrides.rename ?? rename;
  try {
    await move(input.source, input.target);
  } catch {
    // Cross-device and unusual mounts cannot rename atomically. A fallback is
    // only a successful move once the original has also been removed.
    await (overrides.writeFile ?? writeFile)(input.target, input.text, 'utf8');
    await (overrides.unlink ?? unlink)(input.source);
  }
}

/*
  Docs + memory audit context for the architect's delivery-gate review. The
  architect is the doc steward: it sees every Markdown artifact in the run and
  each agent's memory health, and reports doc sprawl with the same severity
  vocabulary the review→fix loop already gates on.
*/
export async function buildDocsAuditContext(input: {
  workspace: string;
  artifacts: Array<Pick<Artifact, 'id' | 'kind' | 'title' | 'ownerAgentId'>>;
}): Promise<string> {
  const seen = new Set<string>();
  const docs = input.artifacts
    .filter((artifact) => artifact.kind === 'markdown' || /\.(md|markdown)$/i.test(artifact.title))
    .filter((artifact) => (seen.has(artifact.title) ? false : (seen.add(artifact.title), true)))
    .slice(0, 20);
  const memoryHealth = await Promise.all(AGENT_ROSTER.map(async (agent) => {
    const memory = await loadAgentMemory({ workspace: input.workspace, agentId: agent.id })
      .catch(() => null);
    if (!memory || memory.facts.length === 0) return null;
    const unreviewed = memory.facts.filter((fact) => fact.type === 'unreviewed').length;
    const overLimit = memory.facts.filter((fact) => fact.overLimit).length;
    return `- ${agent.displayName} (${agent.id}): ${memory.facts.length} fact(s)`
      + (unreviewed > 0 ? `, ${unreviewed} unreviewed` : '')
      + (overLimit > 0 ? `, ${overLimit} over budget` : '');
  }));
  const health = memoryHealth.filter((line): line is string => line !== null);
  return [
    '# Docs & memory audit (you are the document steward)',
    '',
    'Beyond the code review, audit the documentation landscape of this run:',
    docs.length > 0
      ? `Markdown artifacts in scope:\n${docs.map((doc) => `- ${doc.title} (by ${doc.ownerAgentId})`).join('\n')}`
      : 'Markdown artifacts in scope: none.',
    '',
    health.length > 0 ? `Agent memory health:\n${health.join('\n')}` : 'Agent memory health: no memory written yet.',
    '',
    'Flag with your normal severity labels: duplicated or overlapping documents (High), documents that restate what a canonical doc already covers (Medium), and unreviewed memory that should be either rewritten as a typed fact or discarded (Medium). Name the exact files to merge, keep, or drop. If the doc landscape is clean, say so explicitly.',
  ].join('\n');
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

// Is Markdown the point of this task? Checks the task's own text — title and
// brief carry the planner's intent (EN + 中文 vocabulary).
function isDocsTask(task: PlanTask): boolean {
  const text = `${task.title} ${task.brief}`;
  return /\breadme\b|\bdocs?\b|\bdocumentation\b|\bchangelog\b|\bguide\b|文档|说明书|使用说明|指南/i.test(text);
}

function slugFromPath(path: string): string {
  return memorySlug(path.replace(/\.(md|markdown)$/i, ''), 48) || 'doc';
}
