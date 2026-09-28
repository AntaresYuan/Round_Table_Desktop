/* ============================================================================
   openai-compat-adapter.ts — opt-in real-model execution via ANY OpenAI-compatible
   chat-completions API (DeepSeek, MiniMax, Together, Groq, a local vLLM, …).

   Swapping models is a config change, not a code change: point the env at any
   provider that speaks the OpenAI /chat/completions shape.

     ROUNDTABLE_OPENAI_BASE_URL   e.g. https://api.deepseek.com/v1
     ROUNDTABLE_OPENAI_MODEL      e.g. deepseek-v4-flash
     ROUNDTABLE_OPENAI_API_KEY    the bearer token

   Like the other real adapters this is opt-in and never a silent fallback: with
   no key it throws OpenAICompatUnavailableError, which the dispatch layer catches
   to fall back to local-dispatch (surfaced on the task, not hidden).

   Reasoning models (DeepSeek V4, MiniMax M-series, …) return the final answer in
   the standard `content` field and keep chain-of-thought in `reasoning_content`;
   we read `content` and surface reasoning length for observability only.
   ============================================================================ */
import { isModelProviderConfigured, resolveModelProvider } from '../settings-actions.js';

export type OpenAICompatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type OpenAICompatRunInput = {
  messages: OpenAICompatMessage[];
  model?: string | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  timeoutMs?: number | undefined;
};

export type OpenAICompatRunOutput = {
  text: string;
  reasoning?: string | undefined;
  raw: string;
  usage?: Record<string, unknown> | undefined;
  // 'length' means the output was cut at the token ceiling — callers can issue
  // a continuation request instead of shipping a truncated deliverable.
  finishReason?: string | undefined;
};

export class OpenAICompatUnavailableError extends Error {
  readonly code = 'openai_compat_unavailable';
  constructor(message = 'openai_compat_unavailable') {
    super(message);
    this.name = 'OpenAICompatUnavailableError';
  }
}

export class OpenAICompatRequestError extends Error {
  readonly code = 'openai_compat_request_failed';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenAICompatRequestError';
  }
}

function apiKey(): string | undefined {
  const key = process.env.ROUNDTABLE_OPENAI_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

export function isOpenAICompatAvailable(): boolean {
  return Boolean(apiKey() && process.env.ROUNDTABLE_OPENAI_BASE_URL && process.env.ROUNDTABLE_OPENAI_MODEL);
}

export function isOpenAICompatConfigured(): Promise<boolean> {
  return isModelProviderConfigured('openai-compatible');
}

export function openAICompatModel(): string {
  return process.env.ROUNDTABLE_OPENAI_MODEL || 'unknown-model';
}

export async function resolvedOpenAICompatModel(): Promise<string> {
  return (await resolveModelProvider('openai-compatible')).model || openAICompatModel();
}

/**
 * Run a chat completion against the configured OpenAI-compatible endpoint.
 * Throws OpenAICompatUnavailableError when unconfigured, OpenAICompatRequestError
 * on a non-2xx / API-level error.
 */
export async function runOnOpenAICompat(input: OpenAICompatRunInput): Promise<OpenAICompatRunOutput> {
  const config = await resolveModelProvider('openai-compatible');
  if (!config.configured || !config.apiKey) {
    throw new OpenAICompatUnavailableError(
      'ROUNDTABLE_OPENAI_BASE_URL / _MODEL / _API_KEY are not all set',
    );
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
      }),
    };
    if (controller) request.signal = controller.signal;
    response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenAICompatRequestError(`openai_compat_network_error: ${message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
    usage?: Record<string, unknown>;
    error?: { message?: string };
    // Some providers (e.g. MiniMax) surface app-level errors on HTTP 200.
    base_resp?: { status_code?: number; status_msg?: string };
  };

  if (!response.ok) {
    throw new OpenAICompatRequestError(data.error?.message || `http_${response.status}`, response.status);
  }
  if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
    throw new OpenAICompatRequestError(
      `provider_${data.base_resp.status_code}: ${data.base_resp.status_msg ?? 'error'}`,
    );
  }

  const choice = data.choices?.[0];
  const raw = choice?.message?.content ?? '';
  const reasoning = choice?.message?.reasoning_content?.trim() || undefined;
  return { text: raw.trim(), reasoning, raw, usage: data.usage, finishReason: choice?.finish_reason };
}
