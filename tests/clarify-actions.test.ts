import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyAnswers,
  assessClarity,
  assessHeuristic,
} from '../src/server/actions/clarify-actions.js';
import { resetData } from '../src/server/store.js';
import type { ClarifyQuestion } from '../src/server/types.js';

const originalKey = process.env.MINIMAX_API_KEY;
const originalEnabled = process.env.ROUNDTABLE_CLARIFY_ENABLED;
let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-clarify-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  // Force the deterministic heuristic path (no network) for these unit tests.
  delete process.env.MINIMAX_API_KEY;
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  await resetData();
});

afterEach(async () => {
  if (originalKey === undefined) delete process.env.MINIMAX_API_KEY;
  else process.env.MINIMAX_API_KEY = originalKey;
  if (originalEnabled === undefined) delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  else process.env.ROUNDTABLE_CLARIFY_ENABLED = originalEnabled;
  delete process.env.ROUNDTABLE_DATA_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

describe('clarify — heuristic assessment', () => {
  it('asks scoping questions for a vague build request', () => {
    const a = assessHeuristic('make a website');
    expect(a.needsClarification).toBe(true);
    expect(a.questions.length).toBeGreaterThan(0);
    expect(a.questions.length).toBeLessThanOrEqual(3);
    expect(a.questions[0]?.options.length).toBeGreaterThanOrEqual(2);
  });

  it('passes through a detailed request without asking', () => {
    const a = assessHeuristic(
      'Build a Next.js waitlist page with a Postgres database, email validation, and deploy to Vercel.',
    );
    expect(a.needsClarification).toBe(false);
    expect(a.questions).toEqual([]);
  });

  it('passes through when a stack is already named', () => {
    const a = assessHeuristic('build a react dashboard');
    expect(a.needsClarification).toBe(false);
  });

  it('does not clarify a focused non-app request', () => {
    const a = assessHeuristic('fix the typo in the header');
    expect(a.needsClarification).toBe(false);
  });
});

describe('clarify — assessClarity respects the disable flag', () => {
  it('skips entirely when disabled', async () => {
    process.env.ROUNDTABLE_CLARIFY_ENABLED = 'false';
    const a = await assessClarity('make a website');
    expect(a.needsClarification).toBe(false);
    expect(a.clarity).toBe(1);
  });

  it('uses the heuristic when no model key is present', async () => {
    const a = await assessClarity('make an app');
    expect(a.needsClarification).toBe(true);
  });
});

describe('clarify — applyAnswers', () => {
  const questions: ClarifyQuestion[] = [
    {
      id: 'stack',
      question: 'What kind of build is this?',
      options: [
        { id: 'static', label: 'Static page' },
        { id: 'fullstack', label: 'Full-stack app' },
      ],
    },
  ];

  it('folds the chosen labels into the request', () => {
    const enriched = applyAnswers('make a website', questions, [
      { questionId: 'stack', optionId: 'fullstack', label: 'Full-stack app' },
    ]);
    expect(enriched).toContain('make a website');
    expect(enriched).toContain('Clarified requirements');
    expect(enriched).toContain('Full-stack app');
  });

  it('returns the original message when there are no answers', () => {
    expect(applyAnswers('hello', questions, [])).toBe('hello');
  });
});
