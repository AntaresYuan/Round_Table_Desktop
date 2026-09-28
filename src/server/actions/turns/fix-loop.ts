import { nowIso } from '../../store.js';
import type { Artifact, DispatchRecord, PlanTask } from '../../types.js';
import { AGENT_ROSTER } from '../agent-roster.js';
import { describeFindings, type SafetyFinding } from '../safety.js';
import type { ScheduledTask } from '../scheduler.js';

export function maxFixRounds(): number {
  const parsed = Number(process.env.ROUNDTABLE_MAX_FIX_ROUNDS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

// Whether a reviewer that reports blocking issues should trigger a fix pass.
// On by default; set ROUNDTABLE_REVIEW_TRIGGERS_FIX=false to disable.
export function reviewRequestsFix(): boolean {
  return process.env.ROUNDTABLE_REVIEW_TRIGGERS_FIX !== 'false';
}

export function shouldAttemptFix(error: { message: string }): boolean {
  return !isRuntimeInfrastructureFailure(error.message);
}

export function isRuntimeInfrastructureFailure(message: string): boolean {
  return /\b(runtime_(exit|timeout|idle_timeout)|runtime_not_ready|model_provider_not_configured|model_provider_missing_model)\b/i.test(message)
    || /Service startup timeout|Missing command:|Missing API provider key/i.test(message)
    || /API Error:\s*(401|402|403|429|5\d\d)\b/i.test(message)
    || /Error from provider\([^)]*:\s*(401|402|403|429|5\d\d)\)/i.test(message)
    || /Insufficient Balance|quota|rate limit|unauthorized|forbidden/i.test(message);
}

// Tasks whose report gates delivery through the review→fix loop: the quality
// reviewer, and the architect's post-build check (role architect in a
// review-kind stage — its upfront design task in the plan stage is NOT a
// gate). stageKind survives custom templates that rename stage ids; stageId
// is the fallback for tasks planned before stageKind existed.
export function isReviewGateTask(
  task: { role?: string | undefined; stageId?: string | undefined; stageKind?: string | undefined },
): boolean {
  if (task.role === 'reviewer') return true;
  return task.role === 'architect' && (task.stageKind ?? task.stageId) === 'review';
}

// Parse a reviewer's Markdown report for severity signals. Counts Critical/High
// (blocking) mentions across EN + 中文 wording. Heuristic by design: reviewers
// write prose, and a count > 0 is enough to decide "this needs a fix pass".
export function reviewSeverities(report: string): { blocking: number; label: string } {
  const critical = countMatches(report, /(^|\n)\s*(#{1,6}\s*)?(\[?\s*)?(critical|blocker|severe)(\s*\]?)?\s*[:：-]|🔴|严重问题|致命|阻断/gi);
  const high = countMatches(report, /(^|\n)\s*(#{1,6}\s*)?(\[?\s*)?high(\s*\]?)?\s*[:：-]|🟠|高危|高优先级/gi);
  // "If it is solid, say so" — an explicit all-clear shouldn't trigger a fix.
  const allClear = /\b(no (issues|blockers)|looks good|lgtm|ship it|solid)\b|没有(发现)?问题|可以(直接)?交付|无明显问题/i.test(report);
  const blockingSignals = critical + high;
  const blocking = blockingSignals > 0 ? blockingSignals : allClear ? 0 : 0;
  const label = `${critical} critical · ${high} high`;
  return { blocking, label };
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) || []).length;
}

// Derive a fixer task when a task fails (agent error or blocking safety finding).
// The scheduler wires deps + lineage; we only define what the fixer should do.
export function makeFixerTask(
  failed: ScheduledTask,
  error: { message: string; scan?: SafetyFinding[] | undefined; review?: string | undefined },
): PlanTask {
  const fixer = AGENT_ROSTER.find((agent) => agent.role === 'fixer') ?? AGENT_ROSTER[0]!;
  const round = (failed.fixRound ?? 0) + 1;
  const fromReview = isReviewGateTask(failed);
  // A failed planning task must be repaired by RE-PLANNING, not by implementing:
  // a fixer with full tool access would otherwise "repair the plan" by building
  // the product in the shared workspace before the plan stage even completes.
  // The flag rides on the derived task so chained fix rounds stay constrained.
  const fromPlanning = failed.role === 'planner' || failed.replanOnly === true;
  const findingsText = error.scan && error.scan.length > 0
    ? `\n\nSafety findings:\n${describeFindings(error.scan)}`
    : '';
  const reviewText = error.review ? `\n\nReview report to address:\n\n${error.review}` : '';
  // Inherit the failed task's deps so the fixer receives the same upstream
  // outputs (e.g. the reviewed HTML) — a fixer that can't see the deliverable it
  // is repairing can only regenerate blind. A task that ran has all its ordinary
  // deps completed; the one exception is its own repair edge (producedFor, only
  // set on fixer tasks), which points at a FAILED task and would block a chained
  // fixer forever if inherited as an ordinary dep.
  const inheritedDeps = failed.deps.filter((dep) => dep !== failed.producedFor);
  return {
    id: `fix_${failed.id}_r${round}`,
    // A review-driven fix reads better as "Apply review fixes" than "Fix Review …".
    title: fromReview
      ? `Apply review fixes (round ${round})`
      : fromPlanning
        ? `Re-plan: ${failed.title} (round ${round})`
        : `Fix ${failed.title}`,
    assignee: fixer.assignee,
    owner: fixer.id,
    role: fixer.role,
    stageId: 'repair',
    requiredCapabilities: fixer.capabilities,
    brief: fromReview
      ? `The reviewer found blocking issues (${error.message}). Apply focused fixes to the `
        + `implementer's deliverable so each Critical/High issue is resolved, and output the `
        + `corrected deliverable plus a short summary of what changed.${reviewText}`
      : fromPlanning
        ? `The planning task "${failed.title}" (${failed.id}) failed. `
          + `Error: ${error.message}.${findingsText}${reviewText}\n\n`
          + `Recover by RE-PLANNING ONLY: produce the corrected technical plan — goal, task `
          + `breakdown with owners and dependencies, and risks. Do NOT create, modify, or `
          + `delete any source or product files; do not run build or scaffolding commands. `
          + `Implementation belongs to the build stage, which runs after this plan is in place.`
        : `Repair the failure from "${failed.title}" (${failed.id}). `
          + `Error: ${error.message}.${findingsText}${reviewText}\n\n`
          + `Apply a focused fix and summarize the changed files.`,
    deps: [failed.id, ...inheritedDeps],
    parallel: false,
    ...(fromPlanning ? { replanOnly: true } : {}),
  };
}

// If the fixer's output is a complete deliverable (a full HTML document), fold
// it back into the artifact it repaired: same id, bumped version, new content.
// The UI previews the FIRST artifact with kind 'preview', so updating in place
// is what makes the fix actually visible. Returns null when the output is prose
// (a summary, not a deliverable) — in that case the original artifact stands.
export function repairedTargetArtifact(original: Artifact, fixedText: string): Artifact | null {
  if (!/^\s*(<!doctype html|<html)/i.test(fixedText)) return null;
  return {
    ...original,
    preview: fixedText,
    code: original.code !== null ? fixedText : null,
    version: original.version + 1,
    createdAt: nowIso(),
  };
}

// Failed/blocked records whose failure was not repaired by a completed fixer in
// their producedFor lineage (a completed final-delivery repair clears them all).
export function unresolvedFailureRecords(records: DispatchRecord[]): DispatchRecord[] {
  const failed = records.filter((record) => record.status === 'failed' || record.status === 'blocked');
  const completedFinalRepair = records.some((record) =>
    record.status === 'completed' && record.taskId.startsWith('repair_final_'),
  );
  if (completedFinalRepair) return [];

  const byTaskId = new Map(records.map((record) => [record.taskId, record]));
  const repaired = new Set<string>();
  for (const record of records) {
    if (record.status === 'completed' && record.producedFor) {
      let cursor: string | undefined = record.producedFor;
      while (cursor) {
        repaired.add(cursor);
        cursor = byTaskId.get(cursor)?.producedFor;
      }
    }
  }
  return failed.filter((record) => !repaired.has(record.taskId));
}
