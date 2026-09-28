import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import type {
  AgentRuntimeConfig,
  AgentRuntimeDefaultConfig,
  AgentRuntimeKind,
} from '../../types.js';
import { runtimeDefinition } from './registry.js';
import { defaultConfiguredModelProvider } from '../settings-actions.js';

export type RuntimeProbe = {
  ready: boolean;
  reason: string | null;
  command: string | null;
  commandPath: string | null;
  detectedVersion: string | null;
  authConfigured: boolean;
  authSources: string[];
};

type RuntimeProbeConfig = AgentRuntimeConfig | AgentRuntimeDefaultConfig | null;

const MACOS_CODEX_APP_COMMAND = '/Applications/Codex.app/Contents/Resources/codex';

export async function probeRuntime(
  kind: AgentRuntimeKind,
  config: RuntimeProbeConfig = null,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeProbe> {
  if (kind === 'local-dispatch') {
    return {
      ready: true,
      reason: null,
      command: null,
      commandPath: null,
      detectedVersion: null,
      authConfigured: true,
      authSources: ['built-in'],
    };
  }

  const definition = runtimeDefinition(kind);
  const command = configuredCommand(kind, config, runtimeEnv);
  if (!command) {
    return missingProbe(null, definition.installHint ?? 'Set a runtime command.');
  }

  const commandPath = await resolveRuntimeCommand(kind, command, runtimeEnv);
  if (!commandPath) return missingProbe(command, `Missing command: ${command}`);

  const env = { ...runtimeEnv, ...(config?.env ?? {}) };
  const compatibility = await runtimeCompatibilityStatus(kind, commandPath, env);
  if (!compatibility.compatible) {
    return {
      ready: false,
      reason: compatibility.reason,
      command,
      commandPath,
      detectedVersion: await detectVersion(kind, commandPath, runtimeEnv),
      authConfigured: false,
      authSources: [],
    };
  }

  const auth = await runtimeAuthStatus(kind, commandPath, env);
  if (!auth.configured) {
    return {
      ready: false,
      reason: auth.reason,
      command,
      commandPath,
      detectedVersion: await detectVersion(kind, commandPath, runtimeEnv),
      authConfigured: false,
      authSources: [],
    };
  }

  return {
    ready: true,
    reason: null,
    command,
    commandPath,
    detectedVersion: await detectVersion(kind, commandPath, runtimeEnv),
    authConfigured: true,
    authSources: auth.sources,
  };
}

export async function assertRuntimeReady(
  kind: AgentRuntimeKind,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const commandPath = await resolveRuntimeCommand(kind, command, env);
  if (!commandPath) throw new Error(`runtime_not_ready:Missing command: ${command}`);

  const compatibility = await runtimeCompatibilityStatus(kind, commandPath, env);
  if (!compatibility.compatible) throw new Error(`runtime_not_ready:${compatibility.reason}`);

  const auth = await runtimeAuthStatus(kind, commandPath, env);
  if (!auth.configured) throw new Error(`runtime_not_ready:${auth.reason}`);
  return commandPath;
}

export function runtimeEnvName(runtime: AgentRuntimeKind): string {
  return runtime.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

export async function resolveRuntimeCommand(
  kind: AgentRuntimeKind,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const candidates = await resolveCommandCandidates(kind, command, env);
  if (kind !== 'codex' || !usesNativeRuntimeCommand(kind, command)) return candidates[0] ?? null;

  for (const candidate of candidates) {
    if (await codexSupportsExecJson(candidate, env)) return candidate;
  }
  return candidates[0] ?? null;
}

function configuredCommand(
  kind: AgentRuntimeKind,
  config: RuntimeProbeConfig,
  runtimeEnv: NodeJS.ProcessEnv,
): string | null {
  const definition = runtimeDefinition(kind);
  return config?.command
    || runtimeEnv[`ROUNDTABLE_${runtimeEnvName(kind)}_COMMAND`]
    || definition.binary;
}

function missingProbe(command: string | null, reason: string): RuntimeProbe {
  return {
    ready: false,
    reason,
    command,
    commandPath: null,
    detectedVersion: null,
    authConfigured: false,
    authSources: [],
  };
}

async function runtimeAuthStatus(
  kind: AgentRuntimeKind,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ configured: boolean; sources: string[]; reason: string | null }> {
  if (!usesNativeRuntimeCommand(kind, command)) {
    return { configured: true, sources: ['custom-command'], reason: null };
  }

  const sources: string[] = [];
  if (kind === 'claude-code') {
    if (env.ANTHROPIC_API_KEY) sources.push('ANTHROPIC_API_KEY');
    if (env.ANTHROPIC_AUTH_TOKEN) sources.push('ANTHROPIC_AUTH_TOKEN');
    if (env.CLAUDE_CODE_OAUTH_TOKEN) sources.push('CLAUDE_CODE_OAUTH_TOKEN');
    if (await pathExists(join(homeFromEnv(env), '.claude'))) sources.push('~/.claude');
    if (await pathExists(join(homeFromEnv(env), '.claude.json'))) sources.push('~/.claude.json');
    return sources.length
      ? { configured: true, sources, reason: null }
      : {
        configured: false,
        sources,
        reason: 'Missing Claude Code credentials: run `claude login` or set ANTHROPIC_API_KEY.',
      };
  }

  if (kind === 'claude-code-router') {
    // The router only works when Roundtable generates a per-run config from a
    // model provider, or the user maintains a global router config themselves.
    // Without either, `ccr code` hangs on interactive setup and dies (exit 1).
    if (env.ROUNDTABLE_CCR_PROVIDER) {
      sources.push(`model-provider:${env.ROUNDTABLE_CCR_PROVIDER}`);
    } else {
      const provider = await defaultConfiguredModelProvider();
      if (provider) sources.push(`model-provider:${provider}`);
    }
    if (await pathExists(join(homeFromEnv(env), '.claude-code-router', 'config.json'))) {
      sources.push('~/.claude-code-router/config.json');
    }
    return sources.length
      ? { configured: true, sources, reason: null }
      : {
        configured: false,
        sources,
        reason: 'claude-code-router has no backing model API: enable a model provider (with API key) in Settings, or create ~/.claude-code-router/config.json.',
      };
  }

  if (kind === 'codex') {
    if (env.OPENAI_API_KEY) sources.push('OPENAI_API_KEY');
    if (env.CODEX_API_KEY) sources.push('CODEX_API_KEY');
    if (await pathExists(join(homeFromEnv(env), '.codex'))) sources.push('~/.codex');
    return sources.length
      ? { configured: true, sources, reason: null }
      : {
        configured: false,
        sources,
        reason: 'Missing Codex credentials: run `codex login` or set OPENAI_API_KEY.',
      };
  }

  if (kind === 'opencode') {
    if (env.LLM_API_KEY) sources.push('LLM_API_KEY');
    if (env.OPENAI_API_KEY) sources.push('OPENAI_API_KEY');
    if (env.ANTHROPIC_API_KEY) sources.push('ANTHROPIC_API_KEY');
    const home = homeFromEnv(env);
    if (await pathExists(join(home, '.config', 'opencode', 'auth.json'))) sources.push('~/.config/opencode/auth.json');
    if (await pathExists(join(home, '.local', 'share', 'opencode', 'auth.json'))) {
      sources.push('~/.local/share/opencode/auth.json');
    }
    return sources.length
      ? { configured: true, sources, reason: null }
      : {
        configured: false,
        sources,
        reason: 'Missing OpenCode credentials: configure opencode auth or set LLM_API_KEY.',
      };
  }

  return { configured: true, sources: ['not-required'], reason: null };
}

async function runtimeCompatibilityStatus(
  kind: AgentRuntimeKind,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ compatible: boolean; reason: string | null }> {
  if (kind !== 'codex' || !usesNativeRuntimeCommand(kind, command)) {
    return { compatible: true, reason: null };
  }

  if (await codexSupportsExecJson(command, env)) return { compatible: true, reason: null };
  return {
    compatible: false,
    reason: 'Unsupported Codex CLI: expected `codex exec --json`. Configure the official Codex CLI command.',
  };
}

function usesNativeRuntimeCommand(kind: AgentRuntimeKind, command: string): boolean {
  const binary = runtimeDefinition(kind).binary;
  if (!binary) return false;
  const lower = basename(command).toLowerCase();
  return lower === binary.toLowerCase() || lower === `${binary.toLowerCase()}.cmd`;
}

async function detectVersion(
  kind: AgentRuntimeKind,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!usesNativeRuntimeCommand(kind, command)) return null;
  const args = versionArgs(kind);
  if (!args) return null;
  try {
    const result = await runCommand(command, args, env, 3_000);
    if (result.exitCode !== 0) return null;
    return firstMeaningfulLine(result.stdout || result.stderr);
  } catch {
    return null;
  }
}

function versionArgs(kind: AgentRuntimeKind): string[] | null {
  if (kind === 'claude-code' || kind === 'codex' || kind === 'opencode') return ['--version'];
  if (kind === 'claude-code-router') return ['-v'];
  return null;
}

async function resolveCommandCandidates(
  kind: AgentRuntimeKind,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  if (command.includes('/')) return (await pathExists(command)) ? [command] : [];

  const candidates: string[] = [];
  const pathValue = env.PATH || process.env.PATH || '';
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command);
    if (await pathExists(candidate)) candidates.push(candidate);
  }
  if (kind === 'codex' && command === 'codex' && process.platform === 'darwin' && await pathExists(MACOS_CODEX_APP_COMMAND)) {
    if (env.PATH === process.env.PATH && candidates.length > 0) {
      candidates.splice(1, 0, MACOS_CODEX_APP_COMMAND);
    } else {
      candidates.push(MACOS_CODEX_APP_COMMAND);
    }
  }
  return [...new Set(candidates)];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function homeFromEnv(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

function firstMeaningfulLine(value: string): string | null {
  const line = value.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line ? line.slice(0, 160) : null;
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('version_probe_timeout'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

async function codexSupportsExecJson(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const result = await runCommand(command, ['exec', '--help'], env, 3_000);
    if (result.exitCode !== 0) return false;
    return /--json\b/.test(`${result.stdout}\n${result.stderr}`);
  } catch {
    return false;
  }
}
