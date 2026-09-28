import type { ClarifyAnswer, ClarifyQuestion } from '../types.js';
import { isMiniMaxConfigured, runOnMiniMax } from './adapters/minimax-adapter.js';

/* ============================================================================
   clarify-actions.ts — the planner's "ask before building" gate.

   The planner first judges how clear the request is. If it's too vague to plan
   a real (possibly full-stack) build, it returns up to N multiple-choice
   questions so a nocode user only has to pick options. Clear requests skip this
   entirely.

   The assessment is model-driven (MiniMax) when a key is configured; otherwise a
   deterministic heuristic keeps local-dispatch / CI working without network.
   ============================================================================ */

export type ClarityAssessment = {
  // 0..1; below the threshold means we ask before planning.
  clarity: number;
  needsClarification: boolean;
  questions: ClarifyQuestion[];
};

const DEFAULT_THRESHOLD = 0.6;
const MAX_QUESTIONS = 3;

function threshold(): number {
  const parsed = Number(process.env.ROUNDTABLE_CLARIFY_THRESHOLD);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_THRESHOLD;
}

function clarifyEnabled(): boolean {
  return process.env.ROUNDTABLE_CLARIFY_ENABLED !== 'false';
}

/**
 * Assess how clear a request is and, if vague, produce up to MAX_QUESTIONS
 * multiple-choice clarifying questions.
 */
export async function assessClarity(message: string): Promise<ClarityAssessment> {
  if (!clarifyEnabled()) {
    return { clarity: 1, needsClarification: false, questions: [] };
  }

  if (await isMiniMaxConfigured()) {
    const fromModel = await assessWithModel(message).catch(() => null);
    if (fromModel) return fromModel;
  }
  return assessHeuristic(message);
}

const SYSTEM_PROMPT = [
  'You are the planner on an AI build team that turns a request into a concrete,',
  'possibly full-stack, implementation plan. Before planning, judge whether the',
  'request is clear enough to build without guessing key decisions',
  '(tech stack, whether a backend/database is needed, deployment target, scope).',
  '',
  'Respond with ONLY a JSON object, no prose, no code fences:',
  '{',
  '  "clarity": <number 0..1>,',
  '  "questions": [',
  '    { "id": "q1", "question": "...", "options": [',
  '        { "id": "a", "label": "short choice", "description": "what it means" }',
  '    ] }',
  '  ]',
  '}',
  `Ask at most ${MAX_QUESTIONS} questions, each with 2-4 options. If the request`,
  'is clear, return high clarity and an empty questions array. Questions must be',
  'answerable by a nocode user just picking an option.',
].join('\n');

async function assessWithModel(message: string): Promise<ClarityAssessment | null> {
  const run = await runOnMiniMax({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Request: ${message}` },
    ],
    maxTokens: 1200,
    temperature: 0.2,
  });
  const parsed = parseAssessment(run.text);
  if (!parsed) return null;
  const clarity = clamp01(parsed.clarity);
  const questions = sanitizeQuestions(parsed.questions);
  const needsClarification = clarity < threshold() && questions.length > 0;
  return { clarity, needsClarification, questions: needsClarification ? questions : [] };
}

function parseAssessment(text: string): { clarity: number; questions: unknown } | null {
  // The model may wrap JSON in fences or prose despite instructions — extract
  // the first {...} block.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { clarity?: unknown; questions?: unknown };
    if (typeof obj.clarity !== 'number') return null;
    return { clarity: obj.clarity, questions: obj.questions };
  } catch {
    return null;
  }
}

function sanitizeQuestions(raw: unknown): ClarifyQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ClarifyQuestion[] = [];
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    if (!item || typeof item !== 'object') continue;
    const q = item as { id?: unknown; question?: unknown; options?: unknown };
    if (typeof q.question !== 'string' || !Array.isArray(q.options)) continue;
    const options = q.options
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .slice(0, 4)
      .map((o, i) => ({
        id: typeof o.id === 'string' ? o.id : `opt${i + 1}`,
        label: typeof o.label === 'string' ? o.label : `Option ${i + 1}`,
        description: typeof o.description === 'string' ? o.description : undefined,
      }))
      .filter((o) => o.label.trim().length > 0);
    if (options.length < 2) continue;
    out.push({
      id: typeof q.id === 'string' ? q.id : `q${out.length + 1}`,
      question: q.question,
      options,
    });
  }
  return out;
}

/**
 * Heuristic fallback: short, generic requests for an app/site/tool are treated
 * as vague and get a couple of standard scoping questions. Specific requests
 * pass through.
 */
export function assessHeuristic(message: string): ClarityAssessment {
  const trimmed = message.trim();
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const lower = trimmed.toLowerCase();
  const mentionsStack = /(next\.?js|react|vue|svelte|node|express|postgres|mysql|sqlite|static|html|tailwind|python|django|flask)/i.test(lower);
  const buildsApp = /(app|site|website|page|tool|dashboard|platform|系统|网站|应用|工具|平台)/i.test(lower);

  // Clear enough: detailed, or already names a stack. Naming a concrete stack is
  // a strong signal the user knows what they want, so a short request still passes.
  if (words >= 12 || (mentionsStack && words >= 4)) {
    return { clarity: 0.8, needsClarification: false, questions: [] };
  }
  // Vague build request → ask scoping questions.
  if (buildsApp) {
    return {
      clarity: 0.4,
      needsClarification: true,
      questions: SCOPING_QUESTIONS,
    };
  }
  // Otherwise treat as clear (e.g. a focused @mention task).
  return { clarity: 0.75, needsClarification: false, questions: [] };
}

const SCOPING_QUESTIONS: ClarifyQuestion[] = [
  {
    id: 'stack',
    question: 'What kind of build is this?',
    options: [
      { id: 'static', label: 'Static page', description: 'A single self-contained HTML/CSS/JS page, no backend.' },
      { id: 'frontend', label: 'Frontend app', description: 'A multi-page client app (e.g. React/Next.js), no custom backend.' },
      { id: 'fullstack', label: 'Full-stack app', description: 'Frontend + backend API + database.' },
    ],
  },
  {
    id: 'data',
    question: 'Does it need to store data?',
    options: [
      { id: 'none', label: 'No storage', description: 'Nothing is persisted.' },
      { id: 'db', label: 'Database', description: 'Persist data in a database (e.g. Postgres).' },
    ],
  },
];

/** Fold the user's choices back into a single enriched request for the planner. */
export function applyAnswers(message: string, questions: ClarifyQuestion[], answers: ClarifyAnswer[]): string {
  if (answers.length === 0) return message;
  const byQuestion = new Map(questions.map((q) => [q.id, q]));
  const lines = answers.map((a) => {
    const q = byQuestion.get(a.questionId);
    return `- ${q?.question ?? a.questionId}: ${a.label}`;
  });
  return `${message}\n\nClarified requirements:\n${lines.join('\n')}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
