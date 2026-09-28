import type { AgentRuntimeConfig, AgentRuntimeDefaultConfig, AgentRuntimeKind } from '../../types.js';
import type { AgentProfile } from '../agent-roster.js';

export type RuntimeDefinition = {
  kind: AgentRuntimeKind;
  label: string;
  description: string;
  binary: string | null;
  installHint: string | null;
  envKeys: string[];
  modelEnvKeys: string[];
  structured: boolean;
};

export const RUNTIME_DEFINITIONS: RuntimeDefinition[] = [
  {
    kind: 'local-dispatch',
    label: 'Local Dispatch',
    description: 'Deterministic built-in Roundtable output for tests and offline runs.',
    binary: null,
    installHint: null,
    envKeys: [],
    modelEnvKeys: [],
    structured: false,
  },
  {
    kind: 'claude-code',
    label: 'Claude Code',
    description: 'Anthropic Claude Code CLI using stream-json output.',
    binary: 'claude',
    installHint: 'npm install -g @anthropic-ai/claude-code, then run claude login or set ANTHROPIC_API_KEY.',
    envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    modelEnvKeys: ['CLAUDE_MODEL'],
    structured: true,
  },
  {
    kind: 'claude-code-router',
    label: 'Claude Code + API Router',
    description: 'Claude Code through claude-code-router, backed by a configured OpenAI-compatible API provider such as MiniMax.',
    binary: 'ccr',
    installHint: 'npm install -g @musistudio/claude-code-router, then choose a model API provider in Roundtable.',
    envKeys: [],
    modelEnvKeys: ['LLM_MODEL', 'OPENAI_MODEL'],
    structured: true,
  },
  {
    kind: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex CLI using codex exec --json.',
    binary: 'codex',
    installHint: 'npm install -g @openai/codex, then run codex login or set OPENAI_API_KEY.',
    envKeys: ['OPENAI_API_KEY'],
    modelEnvKeys: ['CODEX_MODEL', 'OPENAI_MODEL', 'LLM_MODEL'],
    structured: true,
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode CLI using opencode run --format json.',
    binary: 'opencode',
    installHint: 'npm install -g opencode-ai@1.17.11, then configure LLM_API_KEY and LLM_MODEL.',
    envKeys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'LLM_API_KEY'],
    modelEnvKeys: ['OPENCODE_MODEL', 'LLM_MODEL'],
    structured: true,
  },
];

export function runtimeDefinition(kind: AgentRuntimeKind): RuntimeDefinition {
  return RUNTIME_DEFINITIONS.find((item) => item.kind === kind) ?? RUNTIME_DEFINITIONS[0]!;
}

export function normalizeRuntimeKind(value: string | null | undefined): AgentRuntimeKind | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'local' || raw === 'local-dispatch') return 'local-dispatch';
  // The custom-cli runtime was removed: stored configs and env values that
  // still name it fold into the Claude Code default.
  if (raw === 'custom' || raw === 'custom-cli' || raw === 'agent-cli' || raw === 'external-cli') return 'claude-code';
  if (raw === 'claude-code-router' || raw === 'claude-router' || raw === 'ccr') return 'claude-code-router';
  if (raw === 'claude' || raw === 'claude-code' || raw === 'claude-cli') return 'claude-code';
  if (raw === 'codex' || raw === 'codex-cli' || raw === 'openai-codex') return 'codex';
  if (raw === 'opencode' || raw === 'open-code' || raw === 'opencode-cli') return 'opencode';
  return null;
}

export function configuredRuntimeForAgent(
  agent: AgentProfile,
  configs: AgentRuntimeConfig[],
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeKind {
  const byAgent = configs.find((config) => config.agentId === agent.id);
  // Stored configs can predate the removal of custom-cli; normalize them so a
  // legacy value degrades to a real runtime instead of leaking through.
  if (byAgent) return normalizeRuntimeKind(byAgent.runtime) ?? 'claude-code';

  const fromAgentEnv = normalizeRuntimeKind(env[`ROUNDTABLE_AGENT_RUNTIME_${envKey(agent.id)}`]);
  if (fromAgentEnv) return fromAgentEnv;

  const fromRoleEnv = normalizeRuntimeKind(env[`ROUNDTABLE_AGENT_RUNTIME_${envKey(agent.role)}`]);
  if (fromRoleEnv) return fromRoleEnv;

  const fromGlobalEnv = normalizeRuntimeKind(env.ROUNDTABLE_AGENT_RUNTIME);
  if (fromGlobalEnv) return fromGlobalEnv;

  if (agent.role === 'reviewer' && env.ROUNDTABLE_REVIEWER_PREFERS_OPENCODE === '1') return 'opencode';
  return 'claude-code';
}

export function runtimeConfigForAgent(
  agent: AgentProfile,
  configs: AgentRuntimeConfig[],
): AgentRuntimeConfig | null {
  return configs.find((config) => config.agentId === agent.id) ?? null;
}

export function runtimeDefaultConfigForKind(
  runtime: AgentRuntimeKind,
  defaults: AgentRuntimeDefaultConfig[],
): AgentRuntimeDefaultConfig | null {
  return defaults.find((config) => config.runtime === runtime) ?? null;
}

export function mergedRuntimeConfigForAgent(
  agent: AgentProfile,
  runtime: AgentRuntimeKind,
  configs: AgentRuntimeConfig[],
  defaults: AgentRuntimeDefaultConfig[] = [],
): AgentRuntimeConfig | null {
  const agentConfig = runtimeConfigForAgent(agent, configs);
  const defaultConfig = runtimeDefaultConfigForKind(runtime, defaults);
  if (!agentConfig && !defaultConfig) return null;
  return {
    agentId: agent.id,
    runtime,
    command: agentConfig?.command ?? defaultConfig?.command ?? null,
    args: agentConfig?.args.length ? agentConfig.args : defaultConfig?.args ?? [],
    env: { ...(defaultConfig?.env ?? {}), ...(agentConfig?.env ?? {}) },
    model: agentConfig?.model ?? defaultConfig?.model ?? null,
    modelProvider: agentConfig?.modelProvider ?? defaultConfig?.modelProvider ?? null,
    interactionMode: agentConfig?.interactionMode ?? defaultConfig?.interactionMode ?? null,
    effort: agentConfig?.effort ?? defaultConfig?.effort ?? null,
    updatedAt: agentConfig?.updatedAt ?? defaultConfig?.updatedAt ?? new Date(0).toISOString(),
  };
}

export function envKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}
