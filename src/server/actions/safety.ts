/* ============================================================================
   safety.ts — static safety scan for agent-produced artifacts.

   Pure, dependency-free pattern matching. The scheduler stays unaware of safety;
   the dispatch layer wraps each task's runner so that a blocking finding turns
   the task into an error, which then feeds the normal review→fix loop.

   Rules are intentionally simple and append-only: add a row to RULES and it is
   picked up everywhere the scanner runs (including fixer output).
   ============================================================================ */

export type SafetySeverity = 'low' | 'medium' | 'high';

export type SafetyFinding = {
  rule: string;
  severity: SafetySeverity;
  excerpt: string;
  offset: number;
};

type SafetyRule = {
  name: string;
  severity: SafetySeverity;
  pattern: RegExp;
};

// Order is not significant; each rule scans independently. Patterns use the
// global flag so every occurrence is reported.
const RULES: SafetyRule[] = [
  { name: 'secret_openai_key', severity: 'high', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'secret_anthropic_key', severity: 'high', pattern: /sk-ant-[A-Za-z0-9-]{20,}/g },
  { name: 'secret_github_token', severity: 'high', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'dangerous_rm_rf', severity: 'high', pattern: /rm\s+-rf?\s+\//g },
  { name: 'dangerous_drop_table', severity: 'high', pattern: /DROP\s+TABLE\s+/gi },
  { name: 'dangerous_eval', severity: 'medium', pattern: /\beval\s*\(/g },
  {
    name: 'dangerous_outbound_http',
    severity: 'low',
    pattern: /fetch\(\s*['"]https?:\/\/(?!localhost|127\.0\.0\.1|10\.)/g,
  },
];

const EXCERPT_MAX = 80;

/**
 * Scan text for all configured rules. Returns one finding per match, with a
 * short excerpt and byte offset for surfacing in the UI / fix brief.
 */
export function scanArtifact(text: string): SafetyFinding[] {
  if (!text) return [];
  const findings: SafetyFinding[] = [];
  for (const rule of RULES) {
    // Reset lastIndex defensively — RULES regexes are module-level and stateful
    // with the global flag.
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      findings.push({
        rule: rule.name,
        severity: rule.severity,
        excerpt: match[0].slice(0, EXCERPT_MAX),
        offset: match.index,
      });
      // Guard against zero-width matches looping forever.
      if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
    }
  }
  return findings;
}

/** True if any finding is high severity — the threshold that blocks a task. */
export function hasBlockingFinding(findings: SafetyFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'high');
}

/** Whether the safety layer is enabled (default on; opt out for tests). */
export function safetyEnabled(): boolean {
  return process.env.ROUNDTABLE_SAFETY_ENABLED !== 'false';
}

/** A compact, human-readable summary of findings for a fix brief. */
export function describeFindings(findings: SafetyFinding[]): string {
  return findings
    .map((finding) => `- [${finding.severity}] ${finding.rule}: "${finding.excerpt}" @${finding.offset}`)
    .join('\n');
}
