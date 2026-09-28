import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOnOpenAICompat } from '../src/server/actions/adapters/openai-compat-adapter.js';
import { normalizeAdapter } from '../src/server/actions/agent-runner.js';
import {
  listSettingsState,
  resolveDefaultAgentAdapter,
  saveSettings,
} from '../src/server/actions/settings-actions.js';
import { saveRuntimeDefaultConfig } from '../src/server/actions/runtime-actions.js';
import { readData, resetData } from '../src/server/store.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-settings-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_OPENAI_API_KEY;
  delete process.env.ROUNDTABLE_OPENAI_BASE_URL;
  delete process.env.ROUNDTABLE_OPENAI_MODEL;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_BASE_URL;
  delete process.env.MINIMAX_MODEL;
  delete process.env.ROUNDTABLE_AGENT_ADAPTER;
  delete process.env.ROUNDTABLE_ENABLE_PUBLIC_AI;
  delete process.env.VERCEL;
  vi.unstubAllGlobals();
  await rm(tempDir, { recursive: true, force: true });
});

describe('settings actions', () => {
  it('saves model provider config without returning the API key', async () => {
    const state = await saveSettings({
      defaultAgentAdapter: 'openai-compat',
      providers: [{
        provider: 'openai-compatible',
        enabled: true,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-test-secret',
      }],
    });
    const stored = (await readData()).settings.modelProviders.find((provider) => provider.provider === 'openai-compatible');
    const exposed = state.providers.find((provider) => provider.provider === 'openai-compatible');

    expect(await resolveDefaultAgentAdapter()).toBe('openai-compat');
    expect(normalizeAdapter(await resolveDefaultAgentAdapter())).toBe('openai-compat');
    expect(stored?.apiKey).toBe('sk-test-secret');
    expect(JSON.stringify(state)).not.toContain('sk-test-secret');
    expect(exposed?.apiKeySet).toBe(true);
    expect(exposed?.apiKeySource).toBe('settings');
  });

  it('uses the configured model API as the default workflow adapter when no override is set', async () => {
    const state = await saveSettings({
      providers: [{
        provider: 'openai-compatible',
        enabled: true,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'deepseek-secret',
      }],
    });

    expect(state.defaultAgentAdapter).toBeNull();
    expect(state.effectiveAgentAdapter).toBe('openai-compat');
    expect(state.effectiveAgentAdapterSource).toBe('model-provider');
    expect(state.effectiveModelProvider).toBe('openai-compatible');
    expect(await resolveDefaultAgentAdapter()).toBe('openai-compat');
  });

  it('keeps explicit and env adapter overrides ahead of configured model APIs', async () => {
    await saveSettings({
      providers: [{
        provider: 'minimax',
        enabled: true,
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M3',
        apiKey: 'mini-secret',
      }],
    });

    process.env.ROUNDTABLE_AGENT_ADAPTER = 'local-dispatch';
    expect(await resolveDefaultAgentAdapter()).toBe('local-dispatch');

    await saveSettings({ defaultAgentAdapter: 'agent-cli' });
    expect(await resolveDefaultAgentAdapter()).toBe('agent-cli');
  });

  it('uses configured CLI runtimes before model APIs in auto mode', async () => {
    await saveSettings({
      providers: [{
        provider: 'minimax',
        enabled: true,
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M3',
        apiKey: 'mini-secret',
      }],
    });
    expect(await resolveDefaultAgentAdapter()).toBe('minimax');

    await saveRuntimeDefaultConfig({
      runtime: 'claude-code',
      command: process.execPath,
      interactionMode: 'auto',
    });

    const state = await listSettingsState();
    expect(await resolveDefaultAgentAdapter()).toBe('agent-cli');
    expect(state.effectiveAgentAdapter).toBe('agent-cli');
    expect(state.effectiveAgentAdapterSource).toBe('runtime-config');
  });

  it('keeps existing keys when saving a provider with an empty key field', async () => {
    await saveSettings({
      providers: [{
        provider: 'minimax',
        apiKey: 'mini-secret',
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M3',
      }],
    });
    await saveSettings({
      providers: [{
        provider: 'minimax',
        baseUrl: 'https://alt.minimax.example/v1',
        model: 'MiniMax-M2.7',
      }],
    });

    const stored = (await readData()).settings.modelProviders.find((provider) => provider.provider === 'minimax');
    expect(stored?.apiKey).toBe('mini-secret');
    expect(stored?.baseUrl).toBe('https://alt.minimax.example/v1');
    expect(stored?.model).toBe('MiniMax-M2.7');
  });

  it('runs OpenAI-compatible requests using saved settings instead of env vars', async () => {
    await saveSettings({
      providers: [{
        provider: 'openai-compatible',
        enabled: true,
        baseUrl: 'https://settings-model.test/v1',
        model: 'settings-model',
        apiKey: 'settings-key',
      }],
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'settings response' }, finish_reason: 'stop' }],
      usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runOnOpenAICompat({
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 1_000,
    });
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    expect(result.text).toBe('settings response');
    expect(url).toBe('https://settings-model.test/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer settings-key' });
    expect(JSON.parse(String(init.body)).model).toBe('settings-model');
  });

  it('lists env-backed provider state without exposing the env key', async () => {
    process.env.ROUNDTABLE_OPENAI_API_KEY = 'env-secret';
    process.env.ROUNDTABLE_OPENAI_BASE_URL = 'https://env-model.test/v1';
    process.env.ROUNDTABLE_OPENAI_MODEL = 'env-model';

    const state = await listSettingsState();
    const openai = state.providers.find((provider) => provider.provider === 'openai-compatible');

    expect(openai?.apiKeySet).toBe(true);
    expect(openai?.apiKeySource).toBe('env');
    expect(openai?.baseUrl).toBe('https://env-model.test/v1');
    expect(JSON.stringify(state)).not.toContain('env-secret');
  });

  it('disables shared AI providers on Vercel unless explicitly enabled', async () => {
    process.env.VERCEL = '1';
    process.env.ROUNDTABLE_OPENAI_API_KEY = 'env-secret';
    process.env.ROUNDTABLE_OPENAI_BASE_URL = 'https://env-model.test/v1';
    process.env.ROUNDTABLE_OPENAI_MODEL = 'env-model';
    await saveSettings({
      defaultAgentAdapter: 'openai-compat',
      providers: [{
        provider: 'openai-compatible',
        enabled: true,
        baseUrl: 'https://settings-model.test/v1',
        model: 'settings-model',
        apiKey: 'settings-secret',
      }],
    });

    const state = await listSettingsState();
    const openai = state.providers.find((provider) => provider.provider === 'openai-compatible');

    expect(await resolveDefaultAgentAdapter()).toBe('local-dispatch');
    expect(state.effectiveAgentAdapter).toBe('local-dispatch');
    expect(openai?.enabled).toBe(false);
    expect(openai?.apiKeySet).toBe(false);
    expect(openai?.apiKeySource).toBeNull();
    expect(JSON.stringify(state)).not.toContain('env-secret');
    expect(JSON.stringify(state)).not.toContain('settings-secret');
  });
});
