/* ============================================================================
   minimax-adapter.ts — opt-in real-model execution via MiniMax.

   Calls the MiniMax OpenAI-compatible chat/completions endpoint. Like the E2B
   adapter, this is opt-in and never a silent fallback: if no key is configured
   it throws MiniMaxUnavailableError, which the dispatch layer catches to fall
   back to local-dispatch (logged on the task, not console).

   MiniMax-M3 is a reasoning model that emits <think>…</think> blocks; we strip
   them so the artifact is the clean answer, and surface the reasoning length via
   the returned usage for observability.
   ============================================================================ */
import { isModelProviderConfigured, resolveModelProvider } from '../settings-actions.js';

export type MiniMaxMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type MiniMaxRunInput = {
  messages: MiniMaxMessage[];
  model?: string | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  timeoutMs?: number | undefined;
  // M3 emits <think> reasoning by default; disable it for clean deliverables.
  // Ignored by M2.x. Defaults to disabled.
  thinking?: boolean | undefined;
};

export type MiniMaxRunOutput = {
  text: string;
  reasoning?: string | undefined;
  raw: string;
  usage?: Record<string, unknown> | undefined;
  // 'length' means the output was cut at the token ceiling — callers can issue
  // a continuation request instead of shipping a truncated deliverable.
  finishReason?: string | undefined;
};

export class MiniMaxUnavailableError extends Error {
  readonly code = 'minimax_unavailable';
  constructor(message = 'minimax_unavailable') {
    super(message);
    this.name = 'MiniMaxUnavailableError';
  }
}

export class MiniMaxRequestError extends Error {
  readonly code = 'minimax_request_failed';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MiniMaxRequestError';
  }
}

export function isMiniMaxAvailable(): boolean {
  return Boolean(process.env.MINIMAX_API_KEY && process.env.MINIMAX_API_KEY.trim());
}

export function isMiniMaxConfigured(): Promise<boolean> {
  return isModelProviderConfigured('minimax');
}

export function miniMaxModel(): string {
  return process.env.MINIMAX_MODEL || 'MiniMax-M3';
}

export async function resolvedMiniMaxModel(): Promise<string> {
  return (await resolveModelProvider('minimax')).model || miniMaxModel();
}

/** Remove <think>…</think> reasoning blocks; return [clean, reasoning]. */
export function stripThink(content: string): [string, string | undefined] {
  const blocks: string[] = [];
  const clean = content
    .replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner: string) => {
      blocks.push(inner.trim());
      return '';
    })
    // An unterminated <think> (truncated output) — drop everything after it.
    .replace(/<think>[\s\S]*$/, '')
    .trim();
  return [clean, blocks.length > 0 ? blocks.join('\n\n') : undefined];
}

/**
 * Run a chat completion against MiniMax. Throws MiniMaxUnavailableError when no
 * key is configured, MiniMaxRequestError on a non-2xx / API-level error.
 */
export async function runOnMiniMax(input: MiniMaxRunInput): Promise<MiniMaxRunOutput> {
  const config = await resolveModelProvider('minimax');
  if (!config.configured || !config.apiKey) {
    throw new MiniMaxUnavailableError('MINIMAX_API_KEY is not set');
  }

  const controller = input.timeoutMs ? new AbortController() : null;
  const timer = controller && input.timeoutMs
    ? setTimeout(() => controller.abort(), input.timeoutMs)
    : null;
  let response: Response;
  try {
    const request: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model?.trim() || config.model,
        messages: input.messages,
        // Omit max_tokens unless explicitly configured: the provider's own
        // ceiling is usually higher than any hardcoded default, and truncation
        // is handled by continuation upstream.
        ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
        temperature: input.temperature ?? 0.7,
        stream: false,
        // Default to no reasoning so the deliverable comes back clean and fast;
        // also split any reasoning out of `content` as a belt-and-suspenders.
        thinking: { type: input.thinking ? 'adaptive' : 'disabled' },
        reasoning_split: true,
      }),
    };
    if (controller) request.signal = controller.signal;
    response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MiniMaxRequestError(`minimax_network_error: ${message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: Record<string, unknown>;
    base_resp?: { status_code?: number; status_msg?: string };
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new MiniMaxRequestError(data.error?.message || `http_${response.status}`, response.status);
  }
  // MiniMax surfaces app-level errors in base_resp even on HTTP 200.
  if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
    throw new MiniMaxRequestError(
      `minimax_${data.base_resp.status_code}: ${data.base_resp.status_msg ?? 'error'}`,
    );
  }

  const choice = data.choices?.[0];
  const raw = choice?.message?.content ?? '';
  const [text, reasoning] = stripThink(raw);
  return { text: text || raw, reasoning, raw, usage: data.usage, finishReason: choice?.finish_reason };
}
