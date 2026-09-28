import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgentTask } from '../src/server/actions/agent-runner.js';
import { AGENT_ROSTER } from '../src/server/actions/agent-roster.js';
import { executeCliRuntime } from '../src/server/actions/cli-runtimes/runner.js';
import { probeRuntime } from '../src/server/actions/cli-runtimes/probe.js';
import {
  listRuntimeState,
  saveAgentRuntimeConfig,
  saveRuntimeDefaultConfig,
} from '../src/server/actions/runtime-actions.js';
import { saveSettings } from '../src/server/actions/settings-actions.js';
import { readData, resetData } from '../src/server/store.js';
import type { AgentRuntimeConfig, AgentRuntimeKind, PlanTask } from '../src/server/types.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-runtime-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_WORKSPACE_ROOT = join(tempDir, 'workspaces');
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_WORKSPACE_ROOT;
  delete process.env.ROUNDTABLE_AGENT_ADAPTER;
  delete process.env.ROUNDTABLE_AGENT_RUNTIME;
  delete process.env.ROUNDTABLE_CLAUDE_CODE_ARGS;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_BASE_URL;
  delete process.env.MINIMAX_MODEL;
  delete process.env.ROUNDTABLE_CODEX_ARGS;
  delete process.env.ROUNDTABLE_OPENCODE_ARGS;
  await rm(tempDir, { recursive: true, force: true });
});

describe('CLI runtime runner', () => {
  it('parses Claude Code stream-json assistant text', async () => {
    const result = await executeCliRuntime({
      conversationId: 'claude-test',
      runtime: 'claude-code',
      agent: agent('atlas'),
      config: runtimeConfig('atlas', 'claude-code', [
        '-e',
        'process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"hello from claude"}]}})+"\\n")',
      ]),
      workspace: tempDir,
      prompt: 'ignored prompt',
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('hello from claude');
    expect(result.events.some((event) => event.type === 'thinking_delta' && event.delta === 'hello from claude')).toBe(true);
  });

  it('runs Codex with prompt on stdin and parses jsonl agent messages', async () => {
    const result = await executeCliRuntime({
      conversationId: 'codex-test',
      runtime: 'codex',
      agent: agent('atlas'),
      config: runtimeConfig('atlas', 'codex', [
        '-e',
        [
          'let input="";',
          'process.stdin.on("data",(chunk)=>input+=chunk);',
          'process.stdin.on("end",()=>process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"codex:"+input.trim()}})+"\\n"));',
        ].join(''),
      ]),
      workspace: tempDir,
      prompt: 'hello codex',
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('codex:hello codex');
  });

  it('skips incompatible Codex wrappers and executes a Codex CLI that supports exec json', async () => {
    const badDir = join(tempDir, 'bad-bin');
    const goodDir = join(tempDir, 'good-bin');
    await mkdir(badDir, { recursive: true });
    await mkdir(goodDir, { recursive: true });
    await writeCodexFixture(join(badDir, 'codex'), false);
    await writeCodexFixture(join(goodDir, 'codex'), true);

    const result = await executeCliRuntime({
      conversationId: 'codex-path-test',
      runtime: 'codex',
      agent: agent('atlas'),
      config: null,
      workspace: tempDir,
      prompt: 'hello codex',
      timeoutMs: 2_000,
      envSnapshot: {
        ...process.env,
        PATH: `${badDir}:${goodDir}:${process.env.PATH ?? ''}`,
        OPENAI_API_KEY: 'test-key',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.command.startsWith(join(goodDir, 'codex'))).toBe(true);
    expect(result.text).toBe('good:hello codex');
  });

  it('surfaces stderr in failure text and error detail when a runtime exits non-zero', async () => {
    const result = await executeCliRuntime({
      conversationId: 'stderr-test',
      runtime: 'claude-code',
      agent: agent('atlas'),
      config: runtimeConfig('atlas', 'claude-code', [
        '-e',
        [
          'process.stdout.write("Service not running, starting service...");',
          'process.stderr.write("Service startup timeout, please manually run ccr start\\n");',
          'process.exit(1)',
        ].join(''),
      ]),
      workspace: tempDir,
      prompt: 'ignored prompt',
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain('Service not running, starting service...');
    expect(result.text).toContain('Service startup timeout');
    expect(result.error).toContain('runtime_exit_1');
    expect(result.error).toContain('Service startup timeout');
    const errorEvent = result.events.find((event) => event.type === 'error');
    expect(errorEvent && 'message' in errorEvent ? errorEvent.message : '').toContain('Service startup timeout');
  });

  it('fails a runtime only after the idle window has no output', async () => {
    const result = await executeCliRuntime({
      conversationId: 'idle-timeout-test',
      runtime: 'claude-code',
      agent: agent('atlas'),
      config: runtimeConfig('atlas', 'claude-code', [
        '-e',
        [
          'process.stdout.write("started\\n");',
          'setTimeout(()=>process.stdout.write("still alive\\n"), 50);',
          'setInterval(()=>{}, 1_000);',
        ].join(''),
      ]),
      workspace: tempDir,
      prompt: 'ignored prompt',
      idleTimeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain('started');
    expect(result.text).toContain('still alive');
    expect(result.error).toContain('runtime_idle_timeout');
  });

  it('parses concatenated OpenCode JSON objects', async () => {
    const result = await executeCliRuntime({
      conversationId: 'opencode-test',
      runtime: 'opencode',
      agent: agent('vera'),
      config: runtimeConfig('vera', 'opencode', [
        '-e',
        [
          'process.stdout.write(JSON.stringify({type:"part",part:{type:"text",text:"open"}}));',
          'process.stdout.write(JSON.stringify({type:"part",part:{type:"text",text:"code"}}));',
        ].join(''),
      ]),
      workspace: tempDir,
      prompt: 'ignored prompt',
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('open\ncode');
  });
});

describe('runtime config and workflow dispatch integration', () => {
  it('persists per-agent runtime config and exposes it in runtime state', async () => {
    await saveAgentRuntimeConfig({
      agentId: 'atlas',
      runtime: 'codex',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("configured")'],
      model: 'gpt-5-codex',
      env: { LLM_API_KEY: 'test-key', invalidKey: 'ignored' },
    });

    const state = await listRuntimeState();
    const atlas = state.agents.find((item) => item.id === 'atlas');
    const stored = (await readData()).agentRuntimeConfigs[0];

    expect(atlas?.runtime).toBe('codex');
    expect(atlas?.configured).toBe(true);
    expect(stored?.env).toEqual({ LLM_API_KEY: 'test-key' });
  });

  it('exposes the effective workflow execution adapter for the Agent CLI console', async () => {
    process.env.ROUNDTABLE_AGENT_ADAPTER = 'deepseek';
    expect(await listRuntimeState()).toMatchObject({
      executionAdapter: 'openai-compat',
      executionAdapterSource: 'env',
    });

    delete process.env.ROUNDTABLE_AGENT_ADAPTER;
    await saveSettings({
      providers: [{
        provider: 'openai-compatible',
        enabled: true,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'deepseek-secret',
      }],
    });

    expect(await listRuntimeState()).toMatchObject({
      executionAdapter: 'openai-compat',
      executionAdapterSource: 'model-provider',
      executionModelProvider: 'openai-compatible',
    });

    await saveSettings({ defaultAgentAdapter: 'agent-cli' });

    expect(await listRuntimeState()).toMatchObject({
      executionAdapter: 'agent-cli',
      executionAdapterSource: 'settings',
    });
  });

  it('persists runtime defaults without exposing saved env values in runtime state', async () => {
    await saveRuntimeDefaultConfig({
      runtime: 'claude-code',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("default")'],
      model: 'claude-test',
      env: { ANTHROPIC_API_KEY: 'secret-key', invalidKey: 'ignored' },
    });

    const state = await listRuntimeState();
    const claude = state.supported.find((item) => item.kind === 'claude-code');
    const stored = (await readData()).agentRuntimeDefaults[0];

    expect(claude).toMatchObject({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("default")'],
      model: 'claude-test',
      configured: true,
      configuredEnvKeys: ['ANTHROPIC_API_KEY'],
      ready: true,
      commandPath: process.execPath,
      detectedVersion: null,
      authConfigured: true,
      authSources: ['custom-command'],
    });
    expect(JSON.stringify(state)).not.toContain('secret-key');
    expect(stored?.env).toEqual({ ANTHROPIC_API_KEY: 'secret-key' });
  });

  it('marks runtimes not ready when the configured command is missing', async () => {
    await saveRuntimeDefaultConfig({
      runtime: 'claude-code',
      command: join(tempDir, 'missing-claude'),
    });

    const state = await listRuntimeState();
    const claude = state.supported.find((item) => item.kind === 'claude-code');

    expect(claude).toMatchObject({
      ready: false,
      readyReason: `Missing command: ${join(tempDir, 'missing-claude')}`,
      commandPath: null,
      authConfigured: false,
    });
  });

  it('marks claude-code-router not ready without a model provider or global router config', async () => {
    const ccrPath = join(tempDir, 'ccr');
    await writeFile(ccrPath, '#!/bin/sh\nexit 0\n');
    await chmod(ccrPath, 0o755);

    const probe = await probeRuntime(
      'claude-code-router',
      { ...runtimeConfig('atlas', 'claude-code-router', []), command: ccrPath },
      { ...process.env, HOME: tempDir },
    );

    expect(probe.ready).toBe(false);
    expect(probe.reason).toContain('claude-code-router has no backing model API');
  });

  it('marks claude-code-router ready once a model provider is configured', async () => {
    const ccrPath = join(tempDir, 'ccr');
    await writeFile(ccrPath, '#!/bin/sh\nexit 0\n');
    await chmod(ccrPath, 0o755);
    await saveSettings({
      providers: [{
        provider: 'minimax',
        enabled: true,
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M3',
        apiKey: 'mini-secret',
      }],
    });

    const probe = await probeRuntime(
      'claude-code-router',
      { ...runtimeConfig('atlas', 'claude-code-router', []), command: ccrPath },
      { ...process.env, HOME: tempDir },
    );

    expect(probe.ready).toBe(true);
    expect(probe.authSources).toContain('model-provider:minimax');
  });

  it('configures Claude Code Router with a saved MiniMax provider without exposing the key', async () => {
    await saveSettings({
      providers: [{
        provider: 'minimax',
        enabled: true,
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M2.7',
        apiKey: 'mini-secret',
      }],
    });
    await saveRuntimeDefaultConfig({
      runtime: 'claude-code-router',
      command: process.execPath,
      modelProvider: 'minimax',
    });
    await saveAgentRuntimeConfig({
      agentId: 'atlas',
      runtime: 'claude-code-router',
    });

    const state = await listRuntimeState();
    const router = state.supported.find((item) => item.kind === 'claude-code-router');
    const atlas = state.agents.find((item) => item.id === 'atlas');

    expect(router).toMatchObject({
      command: process.execPath,
      modelProvider: 'minimax',
      configured: true,
      ready: true,
    });
    expect(atlas).toMatchObject({
      runtime: 'claude-code-router',
      modelProvider: 'minimax',
      configured: true,
    });
    expect(state.modelProviders.find((provider) => provider.provider === 'minimax')).toMatchObject({
      configured: true,
    });
    expect(JSON.stringify(state)).not.toContain('mini-secret');
  });

  it('persists CLI interaction defaults and exposes them through inherited agent config', async () => {
    await saveRuntimeDefaultConfig({
      runtime: 'claude-code',
      command: process.execPath,
      interactionMode: 'manual',
      effort: 'high',
    });
    await saveAgentRuntimeConfig({
      agentId: 'atlas',
      runtime: 'claude-code',
    });

    const state = await listRuntimeState();
    const claude = state.supported.find((item) => item.kind === 'claude-code');
    const atlas = state.agents.find((item) => item.id === 'atlas');

    expect(claude).toMatchObject({
      interactionMode: 'manual',
      effort: 'high',
    });
    expect(atlas).toMatchObject({
      runtime: 'claude-code',
      interactionMode: 'manual',
      effort: 'high',
    });
  });

  it('dispatches an agent task through the saved CLI runtime and records the conversation', async () => {
    await saveAgentRuntimeConfig({
      agentId: 'atlas',
      runtime: 'claude-code',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("custom runtime ok")'],
    });

    const result = await runAgentTask({
      adapter: 'agent-cli',
      workspace: tempDir,
      message: 'Build a small UI.',
      task: atlasTask(),
      turnId: 'turn-runtime-test',
    });
    const conversations = (await readData()).agentRuntimeConversations;

    expect(result.ok).toBe(true);
    expect(result.text).toBe('custom runtime ok');
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      agentId: 'atlas',
      runtime: 'claude-code',
      taskId: 'task_atlas_runtime',
      turnId: 'turn-runtime-test',
      status: 'completed',
    });
  });

  it('dispatches through a runtime default when an agent only selects the runtime', async () => {
    await saveRuntimeDefaultConfig({
      runtime: 'claude-code',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("default runtime ok")'],
    });
    await saveAgentRuntimeConfig({
      agentId: 'atlas',
      runtime: 'claude-code',
    });

    const result = await runAgentTask({
      adapter: 'agent-cli',
      workspace: tempDir,
      message: 'Use the default runtime.',
      task: atlasTask(),
      turnId: 'turn-runtime-default-test',
    });
    const conversations = (await readData()).agentRuntimeConversations;

    expect(result.ok).toBe(true);
    expect(result.text).toBe('default runtime ok');
    expect(conversations[0]).toMatchObject({
      agentId: 'atlas',
      runtime: 'claude-code',
      status: 'completed',
    });
  }, 10_000);

  it('fails before spawning when a runtime command is unavailable', async () => {
    await expect(executeCliRuntime({
      conversationId: 'missing-command-test',
      runtime: 'claude-code',
      agent: agent('atlas'),
      config: {
        ...runtimeConfig('atlas', 'claude-code', []),
        command: join(tempDir, 'missing-claude'),
      },
      workspace: tempDir,
      prompt: 'ignored prompt',
      timeoutMs: 2_000,
    })).rejects.toThrow(`runtime_not_ready:Missing command: ${join(tempDir, 'missing-claude')}`);
  });
});

function agent(id: string) {
  const found = AGENT_ROSTER.find((item) => item.id === id);
  if (!found) throw new Error(`missing test agent ${id}`);
  return found;
}

function runtimeConfig(agentId: string, runtime: AgentRuntimeKind, args: string[]): AgentRuntimeConfig {
  return {
    agentId,
    runtime,
    command: process.execPath,
    args,
    env: {},
    model: null,
    modelProvider: null,
    interactionMode: null,
    effort: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function atlasTask(): PlanTask {
  return {
    id: 'task_atlas_runtime',
    title: 'Build runtime fixture',
    assignee: '@atlas',
    owner: 'atlas',
    role: 'implementer',
    brief: 'Use the saved runtime config.',
    deps: [],
    parallel: false,
  };
}

async function writeCodexFixture(path: string, supportsExecJson: boolean): Promise<void> {
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(${JSON.stringify(supportsExecJson ? 'codex-cli 0.142.5' : 'codex-tui 0.0.0')});
  process.exit(0);
}
if (args[0] === 'exec' && args.includes('--help')) {
  console.log(${JSON.stringify(supportsExecJson ? 'Run Codex non-interactively\\n      --json' : 'Usage: codex <PROMPT>')});
  process.exit(0);
}
if (args[0] === 'exec' && ${JSON.stringify(supportsExecJson)}) {
  const input = fs.readFileSync(0, 'utf8').trim();
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'good:' + input } }));
  process.exit(0);
}
console.error('unsupported codex fixture');
process.exit(2);
`;
  await writeFile(path, source);
  await chmod(path, 0o755);
}
