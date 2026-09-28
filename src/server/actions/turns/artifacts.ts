import { nowIso } from '../../store.js';
import type { Artifact, DispatchRecord, Intake, LocalTurn, Plan, PlanTask, WorkingStyleSnapshot } from '../../types.js';
import { emptyWorkingStyle } from '../skill-actions.js';
import { lineChangeStats } from './diff-stats.js';
import { unresolvedFailureRecords } from './fix-loop.js';
import { formatWorkingStyleForPrompt } from './planning.js';
import type { ChangedWorkspaceFile } from './workspace-scan.js';

// Artifact identity is CHAT-scoped, not turn-scoped: a follow-up message in the
// same chat re-plans the same mission, and its intake/plan/report artifacts
// must REPLACE the previous turn's versions (with a version bump) instead of
// piling up near-duplicates in the Files panel.
function artifactScope(chatId: string | null, turnId: string): string {
  return chatId ?? turnId;
}

export function baseArtifacts(
  turnId: string,
  chatId: string,
  message: string,
  intake: Intake,
  plan: Plan,
  workingStyle: WorkingStyleSnapshot = emptyWorkingStyle(),
): Artifact[] {
  const createdAt = nowIso();
  const workingStyleText = formatWorkingStyleForPrompt(workingStyle);
  const scope = artifactScope(chatId, turnId);
  return [
    {
      id: `intake_${scope}`,
      chatId,
      kind: 'markdown',
      title: 'mission/intake.md',
      ownerAgentId: 'orchestrator',
      version: 1,
      uri: `turn://${turnId}/intake`,
      preview: [
        '# Intake',
        '',
        message,
        '',
        `Intent: ${intake.intentType}`,
        `Risk: ${intake.risk}`,
        workingStyleText ? `\n## Working style\n\n${workingStyleText}` : '',
      ].filter(Boolean).join('\n'),
      code: null,
      createdAt,
    },
    {
      id: `plan_${scope}`,
      chatId,
      kind: 'code',
      title: 'mission/plan.json',
      ownerAgentId: 'orchestrator',
      version: 1,
      uri: `turn://${turnId}/plan`,
      preview: JSON.stringify(plan, null, 2),
      code: JSON.stringify(plan, null, 2),
      createdAt,
    },
  ];
}

export function artifactFromRun(
  turn: LocalTurn,
  task: PlanTask,
  result: { text: string; path: string; kind: Artifact['kind'] },
): Artifact {
  return {
    id: `${task.id}_${artifactScope(turn.localChatId, turn.id)}`,
    chatId: turn.localChatId ?? `local-${turn.id}`,
    kind: result.kind,
    title: result.path,
    ownerAgentId: task.owner ?? task.assignee.replace('@', ''),
    version: 1,
    uri: `workspace://${result.path}`,
    preview: result.text,
    code: result.kind === 'code' ? result.text : null,
    createdAt: nowIso(),
  };
}

// All artifacts a task run produced: the task's own output (for CLI-backed
// agents that is the transcript log) plus one artifact per real workspace file
// the agent created or edited. `primary` is what downstream consumers (handoff
// context, the repair loop, the preview pane) should treat as THE deliverable:
// the built page when one exists, the task output otherwise.
export function artifactsFromRun(
  turn: LocalTurn,
  task: PlanTask,
  result: { text: string; path: string; kind: Artifact['kind']; files?: ChangedWorkspaceFile[] | undefined },
): { primary: Artifact; all: Artifact[] } {
  const base = artifactFromRun(turn, task, result);
  const scope = artifactScope(turn.localChatId, turn.id);
  const chatId = turn.localChatId ?? `local-${turn.id}`;
  const owner = task.owner ?? task.assignee.replace('@', '');
  const fileArtifacts: Artifact[] = (result.files ?? []).map((file) => ({
    // Keyed by PATH (not task): a later task or turn touching the same file
    // updates the same artifact instead of duplicating it.
    id: `file_${pathSlug(file.path)}_${scope}`,
    chatId,
    kind: file.kind,
    title: file.path,
    ownerAgentId: owner,
    version: 1,
    uri: `workspace://${file.path}`,
    preview: file.text,
    code: file.kind === 'code' ? file.text : null,
    createdAt: nowIso(),
    change: lineChangeStats('', file.text),
  }));
  const previews = fileArtifacts.filter((artifact) => artifact.kind === 'preview');
  const primary = previews.find((artifact) => /(^|\/)index\.html?$/i.test(artifact.title))
    ?? previews[0]
    ?? base;
  return { primary, all: [base, ...fileArtifacts] };
}

function pathSlug(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

export function finalReportArtifact(
  turn: LocalTurn,
  artifacts: Artifact[],
  records: DispatchRecord[],
): Artifact {
  const reviewerArtifacts = artifacts.filter((artifact) =>
    artifact.ownerAgentId === 'vera' || artifact.ownerAgentId === 'reviewer',
  );
  const failedRecords = unresolvedFailureRecords(records);
  const testsObserved = artifacts.some((artifact) => /test|spec|review|verify/i.test(`${artifact.title}\n${artifact.preview ?? ''}`));
  const report = [
    `# Final Delivery Report`,
    '',
    `Goal: ${turn.message}`,
    '',
    `Recommendation: accept`,
    `Reviewer confidence: ${failedRecords.length > 0 ? 'blocked' : reviewerArtifacts.length > 0 ? 'pass' : 'warning'}`,
    '',
    `## What changed`,
    '',
    ...artifacts.map((artifact) => `- ${artifact.title} (${artifact.kind}) by ${artifact.ownerAgentId}`),
    '',
    `## Review`,
    '',
    reviewerArtifacts.length > 0
      ? reviewerArtifacts.map((artifact) => `- Reviewed in ${artifact.title}`).join('\n')
      : '- No dedicated reviewer artifact was produced.',
    '',
    `## Tests`,
    '',
    testsObserved
      ? '- Test or verification evidence was mentioned in generated artifacts.'
      : '- No explicit test command output was captured; treat this as a remaining verification gap.',
    '',
    `## Risks`,
    '',
    failedRecords.length > 0
      ? failedRecords.map((record) => `- ${record.taskId}: ${record.error ?? record.status}`).join('\n')
      : '- No blocking task failures recorded.',
  ].join('\n');
  return {
    id: `final_report_${artifactScope(turn.localChatId, turn.id)}`,
    chatId: turn.localChatId ?? `local-${turn.id}`,
    kind: 'markdown',
    title: 'reports/final-delivery.md',
    ownerAgentId: 'orchestrator',
    version: 1,
    uri: `turn://${turn.id}/final-report`,
    preview: report,
    code: null,
    createdAt: nowIso(),
  };
}

export function reviewerSummaryArtifact(
  turn: LocalTurn,
  artifacts: Artifact[],
  records: DispatchRecord[],
): Artifact {
  const failedRecords = unresolvedFailureRecords(records);
  const reviewerArtifacts = artifacts.filter((artifact) =>
    artifact.ownerAgentId === 'vera' || artifact.ownerAgentId === 'reviewer',
  );
  const testsObserved = artifacts.some((artifact) => /test|spec|review|verify/i.test(`${artifact.title}\n${artifact.preview ?? ''}`));
  const summary = {
    goal: turn.message,
    confidence: failedRecords.length > 0 ? 'blocked' : reviewerArtifacts.length > 0 ? 'pass' : 'warning',
    recommendation: failedRecords.length > 0 ? 'repair' : 'accept',
    testsObserved,
    risks: failedRecords.map((record) => `${record.taskId}: ${record.error ?? record.status}`),
  };
  return {
    id: `review_summary_${artifactScope(turn.localChatId, turn.id)}`,
    chatId: turn.localChatId ?? `local-${turn.id}`,
    kind: 'spec',
    title: 'reports/review-summary.json',
    ownerAgentId: 'vera',
    version: 1,
    uri: `turn://${turn.id}/review-summary`,
    preview: JSON.stringify(summary, null, 2),
    code: JSON.stringify(summary, null, 2),
    createdAt: nowIso(),
  };
}

// Replace-by-identity with version bumps: an incoming artifact that matches an
// existing id/chatId REPLACES it, bumping the version only when the content
// actually changed. This is what keeps a multi-turn chat at one plan, one
// report, one artifact per file — versioned — instead of an ever-growing list.
// A bump also records line-change stats against the replaced version and makes
// the incoming ownerAgentId the last editor, so the UI can answer "who changed
// what, and by how much" per file.
export function upsertArtifacts(target: Artifact[], artifacts: Artifact[]): void {
  for (const artifact of artifacts) {
    const index = target.findIndex((item) => item.id === artifact.id && item.chatId === artifact.chatId);
    if (index === -1) {
      target.push(artifact);
      continue;
    }
    const existing = target[index]!;
    const changed = (existing.preview ?? '') !== (artifact.preview ?? '')
      || (existing.code ?? '') !== (artifact.code ?? '');
    target[index] = {
      ...artifact,
      version: changed ? existing.version + 1 : existing.version,
      change: changed
        ? lineChangeStats(existing.code ?? existing.preview ?? '', artifact.code ?? artifact.preview ?? '')
        : existing.change ?? null,
    };
  }
}
