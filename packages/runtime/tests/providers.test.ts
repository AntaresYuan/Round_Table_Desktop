import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeError } from '../src/errors.js';
import { buildProviderLaunchPlan } from '../src/providers.js';

const workspace = '/authorized/workspace';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function configDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'roundtable-provider-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('fixed provider launch plans', () => {
  it('uses Codex workspace-write with never approval and no bypass', async () => {
    const plan = await buildProviderLaunchPlan('codex', workspace, 'Implement the task', 'gpt-5.6');
    const joined = plan.args.join(' ');

    expect(plan.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(plan.args).toContain('workspace-write');
    expect(plan.args).toContain('approval_policy="never"');
    expect(plan.args).toContain('sandbox_workspace_write.network_access=false');
    expect(plan.args).toContain('--ignore-user-config');
    expect(plan.args).toContain('--ignore-rules');
    expect(plan.args.at(-1)).toBe('-');
    expect(plan.stdin).toBe('Implement the task');
    expect(joined).not.toMatch(/dangerously|bypass|full-access|yolo/iu);
    expect(joined).not.toContain('Implement the task');
  });

  it('uses Claude safe mode and strict private settings with stdin', async () => {
    const plan = await buildProviderLaunchPlan(
      'claude-code',
      workspace,
      'Review the patch',
      undefined,
      await configDirectory(),
      homedir(),
    );
    const joined = plan.args.join(' ');
    const settingsPath = plan.args[plan.args.indexOf('--settings') + 1];
    const settings = JSON.parse(await readFile(settingsPath ?? '', 'utf8')) as {
      sandbox?: {
        enabled?: boolean;
        failIfUnavailable?: boolean;
        autoAllowBashIfSandboxed?: boolean;
        allowUnsandboxedCommands?: boolean;
        excludedCommands?: unknown[];
        filesystem?: {
          denyRead?: string[];
          allowRead?: string[];
          allowWrite?: string[];
          denyWrite?: string[];
        };
      };
      hooks?: Record<string, unknown>;
      enabledPlugins?: Record<string, unknown>;
      mcpServers?: Record<string, unknown>;
    };

    expect(joined).toContain('--safe-mode');
    expect(plan.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(plan.args).toEqual(expect.arrayContaining(['--setting-sources', '']));
    expect(plan.args).toContain('--strict-mcp-config');
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
    });
    expect(settings.sandbox?.filesystem?.denyRead?.[0]).toMatch(/[\\/]$/u);
    expect(settings.sandbox?.filesystem?.allowRead).toEqual([workspace]);
    expect(settings.sandbox?.filesystem?.allowWrite).toEqual([workspace]);
    expect(settings.sandbox?.filesystem?.denyWrite).toEqual([]);
    expect(settings.hooks).toEqual({});
    expect(settings.enabledPlugins).toEqual({});
    expect(settings.mcpServers).toEqual({});
    if (process.platform !== 'win32') {
      expect(Number((await stat(settingsPath ?? '')).mode & 0o777)).toBe(0o600);
    }
    expect(joined).not.toMatch(/bypass|dangerously/iu);
    expect(joined).not.toContain('Review the patch');
    expect(plan.stdin).toBe('Review the patch');
  });

  it('uses OpenCode pure mode, discloses argv prompt, and denies external directories', async () => {
    const plan = await buildProviderLaunchPlan('opencode', workspace, 'Make one edit', 'openai/gpt-5');
    const config = JSON.parse(plan.fixedEnvironment.OPENCODE_CONFIG_CONTENT ?? '{}') as {
      permission?: Record<string, unknown>;
    };

    expect(plan.args.slice(0, 3)).toEqual(['--pure', '--auto', 'run']);
    expect(plan.args).toEqual(expect.arrayContaining(['--dir', workspace]));
    expect(plan.args).toEqual(expect.arrayContaining(['--agent', 'build']));
    expect(config.permission?.['*']).toBe('deny');
    expect(config.permission?.read).toBe('allow');
    expect(config.permission?.edit).toBe('allow');
    expect(config.permission?.external_directory).toBe('deny');
    expect(config.permission?.bash).toBe('deny');
    expect(config.permission?.skill).toBe('deny');
    expect(config.permission?.lsp).toBe('deny');
    expect(plan.fixedEnvironment.OPENCODE_PERMISSION).toBe(JSON.stringify(config.permission));
    expect(plan.fixedEnvironment.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('true');
    expect(plan.fixedEnvironment.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe('true');
    expect(plan.fixedEnvironment.OPENCODE_DISABLE_CLAUDE_CODE).toBe('true');
    expect(plan.stdin).toBe('');
    expect(plan.disclosures).toEqual(['prompt_visible_in_process_arguments']);
  });

  it('rejects invalid prompt and model values', async () => {
    await expect(buildProviderLaunchPlan('codex', workspace, '   ')).rejects.toBeInstanceOf(RuntimeError);
    await expect(buildProviderLaunchPlan('codex', workspace, 'task', '--dangerous'))
      .rejects.toThrow('model_invalid');
  });
});
