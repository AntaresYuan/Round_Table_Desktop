import { RuntimeError } from './errors.js';
import type { RuntimeProvider } from './types.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

const MAX_PROMPT_BYTES = 128 * 1024;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

const OPENCODE_PERMISSIONS = {
  '*': 'deny',
  read: 'allow',
  edit: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'deny',
  external_directory: 'deny',
  lsp: 'deny',
  skill: 'deny',
  task: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
} as const;

const OPENCODE_PERMISSION_POLICY = JSON.stringify(OPENCODE_PERMISSIONS);
const OPENCODE_POLICY = JSON.stringify({
  share: 'disabled',
  autoupdate: false,
  plugin: [],
  permission: OPENCODE_PERMISSIONS,
  agent: {
    build: {
      permission: OPENCODE_PERMISSIONS,
    },
  },
});

const OPENCODE_FIXED_ENVIRONMENT = Object.freeze({
  OPENCODE_CONFIG_CONTENT: OPENCODE_POLICY,
  OPENCODE_PERMISSION: OPENCODE_PERMISSION_POLICY,
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
  OPENCODE_DISABLE_CLAUDE_CODE: 'true',
  OPENCODE_DISABLE_AUTOUPDATE: 'true',
  OPENCODE_AUTO_SHARE: 'false',
});

export type ProviderLaunchPlan = {
  args: string[];
  stdin: string;
  fixedEnvironment: Readonly<Record<string, string>>;
  disclosures: readonly ProviderDisclosure[];
};

export type ProviderDisclosure = 'prompt_visible_in_process_arguments';

export async function buildProviderLaunchPlan(
  provider: RuntimeProvider,
  workspaceRoot: string,
  prompt: string,
  model?: string,
  runtimeConfigDirectory?: string,
  hostHomeDirectory?: string,
): Promise<ProviderLaunchPlan> {
  validateWorkspaceRoot(workspaceRoot);
  validatePrompt(prompt);
  const selectedModel = validateModel(model);

  if (provider === 'codex') {
    return {
      args: [
        'exec',
        '--json',
        '--color',
        'never',
        '--ephemeral',
        '--sandbox',
        'workspace-write',
        '--ignore-user-config',
        '--ignore-rules',
        '--strict-config',
        '-C',
        workspaceRoot,
        '-c',
        'approval_policy="never"',
        '-c',
        'sandbox_workspace_write.network_access=false',
        '-c',
        'sandbox_workspace_write.exclude_slash_tmp=true',
        '-c',
        'sandbox_workspace_write.exclude_tmpdir_env_var=true',
        '-c',
        'shell_environment_policy.inherit="core"',
        '-c',
        'shell_environment_policy.ignore_default_excludes=false',
        '-c',
        'allow_login_shell=false',
        '-c',
        'agents.enabled=false',
        ...(selectedModel ? ['--model', selectedModel] : []),
        '-',
      ],
      stdin: prompt,
      fixedEnvironment: Object.freeze({}),
      disclosures: Object.freeze([]),
    };
  }

  if (provider === 'claude-code') {
    if (!runtimeConfigDirectory || !hostHomeDirectory) {
      throw new RuntimeError('execution_invalid');
    }
    validateWorkspaceRoot(hostHomeDirectory);
    const { settingsPath, mcpPath } = await writeClaudeSecurityConfig(
      runtimeConfigDirectory,
      workspaceRoot,
      hostHomeDirectory,
    );
    return {
      args: [
        '--print',
        '--input-format',
        'text',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--safe-mode',
        '--setting-sources',
        '',
        '--settings',
        settingsPath,
        '--strict-mcp-config',
        '--mcp-config',
        mcpPath,
        '--max-turns',
        '50',
        ...(selectedModel ? ['--model', selectedModel] : []),
      ],
      stdin: prompt,
      fixedEnvironment: Object.freeze({}),
      disclosures: Object.freeze([]),
    };
  }

  return {
    args: [
      '--pure',
      '--auto',
      'run',
      '--format',
      'json',
      '--dir',
      workspaceRoot,
      '--agent',
      'build',
      ...(selectedModel ? ['--model', selectedModel] : []),
      prompt,
    ],
    stdin: '',
    fixedEnvironment: OPENCODE_FIXED_ENVIRONMENT,
    disclosures: Object.freeze(['prompt_visible_in_process_arguments']),
  };
}

export function providerFixedEnvironment(
  provider: RuntimeProvider,
): Readonly<Record<string, string>> {
  return provider === 'opencode'
    ? OPENCODE_FIXED_ENVIRONMENT
    : Object.freeze({});
}

export function providerDisclosures(provider: RuntimeProvider): readonly ProviderDisclosure[] {
  return provider === 'opencode'
    ? Object.freeze(['prompt_visible_in_process_arguments'])
    : Object.freeze([]);
}

async function writeClaudeSecurityConfig(
  directory: string,
  workspaceRoot: string,
  hostHomeDirectory: string,
): Promise<{ settingsPath: string; mcpPath: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const configDirectory = await mkdtemp(join(directory, 'claude-config-'));
  const settingsPath = join(configDirectory, 'settings.json');
  const mcpPath = join(configDirectory, 'mcp.json');
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        denyRead: [
          hostHomeDirectory.endsWith(sep)
            ? hostHomeDirectory
            : `${hostHomeDirectory}${sep}`,
        ],
        allowRead: [workspaceRoot],
        allowWrite: [workspaceRoot],
        denyWrite: [],
      },
    },
    hooks: {},
    enabledPlugins: {},
    mcpServers: {},
  };
  await writePrivateFile(settingsPath, `${JSON.stringify(settings)}\n`);
  await writePrivateFile(mcpPath, '{"mcpServers":{}}\n');
  return { settingsPath, mcpPath };
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function validatePrompt(prompt: string): void {
  const byteLength = Buffer.byteLength(prompt, 'utf8');
  if (prompt.trim().length === 0 || prompt.includes('\u0000') || byteLength > MAX_PROMPT_BYTES) {
    throw new RuntimeError('execution_invalid');
  }
}

function validateWorkspaceRoot(workspaceRoot: string): void {
  if (!isAbsolute(workspaceRoot) || hasControlCharacters(workspaceRoot)) {
    throw new RuntimeError('execution_invalid');
  }
}

function validateModel(model: string | undefined): string | undefined {
  if (model === undefined || model === '') return undefined;
  if (!MODEL_PATTERN.test(model)) throw new RuntimeError('model_invalid');
  return model;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
