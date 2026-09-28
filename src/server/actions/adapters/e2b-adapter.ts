/* ============================================================================
   e2b-adapter.ts — opt-in E2B sandbox execution for agent tasks.

   Per the agreed design, only the agent's code execution runs inside E2B; the
   scheduler, safety layer, and orchestration stay in the Node backend.

   Opt-in contract:
   - Active only when ROUNDTABLE_AGENT_ADAPTER=e2b AND E2B_API_KEY is set.
   - If selected but unavailable, throw E2BUnavailableError — NOT a silent
     fallback. The dispatch layer catches it and falls back to local-dispatch so
     a misconfiguration is logged rather than hidden.

   The @e2b/code-interpreter SDK is loaded lazily so the package stays an
   optional dependency: nothing imports it unless an E2B run is actually
   requested with a key present.
   ============================================================================ */

export type AgentRunInput = {
  // Either pass a `prompt` (run via `sh -c <prompt>`) or an explicit
  // `command` + `args`. At least one form must produce something to execute.
  prompt?: string | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  timeoutMs?: number | undefined;
};

export type AgentRunOutput = {
  summary: string;
  code?: string | undefined;
  raw?: string | undefined;
  exitCode: number;
};

export class E2BUnavailableError extends Error {
  readonly code = 'e2b_unavailable';
  constructor(message = 'e2b_unavailable') {
    super(message);
    this.name = 'E2BUnavailableError';
  }
}

/** True when an E2B API key is configured. */
export function isE2BAvailable(): boolean {
  return Boolean(process.env.E2B_API_KEY && process.env.E2B_API_KEY.trim());
}

/**
 * Run a command inside a fresh E2B sandbox and return its output. Throws
 * E2BUnavailableError if no key is configured, or if the SDK cannot be loaded.
 */
export async function runOnE2B(input: AgentRunInput): Promise<AgentRunOutput> {
  if (!isE2BAvailable()) {
    throw new E2BUnavailableError('E2B_API_KEY is not set');
  }

  let Sandbox: typeof import('@e2b/code-interpreter').Sandbox;
  try {
    ({ Sandbox } = await import('@e2b/code-interpreter'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new E2BUnavailableError(`@e2b/code-interpreter not installed: ${message}`);
  }

  const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY! });
  try {
    const command = input.command ?? 'sh';
    const args = input.args ?? ['-c', input.prompt ?? ''];
    // exactOptionalPropertyTypes: only include keys that actually have a value.
    const runOpts: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number } = {};
    if (input.cwd) runOpts.cwd = input.cwd;
    if (input.env) runOpts.envs = input.env;
    if (input.timeoutMs) runOpts.timeoutMs = input.timeoutMs;
    const result = await sandbox.commands.run([command, ...args].join(' '), runOpts);
    const stdout = (result.stdout ?? '').trim();
    const stderr = (result.stderr ?? '').trim();
    const summary = stdout || stderr || 'E2B run produced no output.';
    return {
      summary,
      raw: stdout,
      code: stderr || undefined,
      exitCode: result.exitCode ?? 0,
    };
  } finally {
    await sandbox.kill();
  }
}
