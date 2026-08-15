import { mutateData, nowIso, readData, type RoundtableData } from '../store.js';
import type { A2ARemoteAgentConfig, ModelProviderConfig, ModelProviderKind } from '../types.js';
import { AGENT_ROSTER } from './agent-roster.js';

export type ModelProviderDefinition = {
  provider: ModelProviderKind;
  label: string;
  description: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
  defaultBaseUrl: string;
  defaultModel: string;
  presets: Array<{ label: string; baseUrl: string; model: string }>;
};

export type ResolvedModelProvider = {
  provider: ModelProviderKind;
  enabled: boolean;
  configured: boolean;
  label: string;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  source: 'settings' | 'env' | 'none';
};

export type AgentAdapterResolution = {
  value: string;
  source: 'settings' | 'env' | 'runtime-config' | 'model-provider' | 'built-in';
  modelProvider: ModelProviderKind | null;
};

export type SettingsState = {
  defaultAgentAdapter: string | null;
  effectiveAgentAdapter: string;
  effectiveAgentAdapterSource: AgentAdapterResolution['source'];
  effectiveModelProvider: ModelProviderKind | null;
  adapters: Array<{ value: string; label: string; description: string }>;
  a2aAgents: Array<{
    agentId: string;
    name: string;
    role: string;
    enabled: boolean;
    baseUrl: string;
    cardPath: string;
    tokenSet: boolean;
    tokenSource: 'settings' | 'env' | null;
  }>;
  providers: Array<{
    provider: ModelProviderKind;
    label: string;
    description: string;
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeySet: boolean;
    apiKeySource: 'settings' | 'env' | null;
    presets: Array<{ label: string; baseUrl: string; model: string }>;
  }>;
};

export const MODEL_PROVIDER_DEFINITIONS: ModelProviderDefinition[] = [
  {
    provider: 'minimax',
    label: 'MiniMax',
    description: 'Native MiniMax chat/completions adapter.',
    apiKeyEnv: 'MINIMAX_API_KEY',
    baseUrlEnv: 'MINIMAX_BASE_URL',
    modelEnv: 'MINIMAX_MODEL',
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M3',
    presets: [
      { label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
      { label: 'MiniMax fast', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2.7' },
    ],
  },
  {
    provider: 'openai-compatible',
    label: 'OpenAI-compatible',
    description: 'Any provider that exposes /chat/completions, including DeepSeek, OpenAI, Groq, Together, or local vLLM.',
    apiKeyEnv: 'ROUNDTABLE_OPENAI_API_KEY',
    baseUrlEnv: 'ROUNDTABLE_OPENAI_BASE_URL',
    modelEnv: 'ROUNDTABLE_OPENAI_MODEL',
    defaultBaseUrl: '',
    defaultModel: '',
    presets: [
      { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
      { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
      { label: 'Together', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
      { label: 'Local vLLM', baseUrl: 'http://localhost:8000/v1', model: 'local-model' },
    ],
  },
];

const ADAPTER_OPTIONS = [
  {
    value: 'local-dispatch',
    label: 'Local Dispatch',
    description: 'Deterministic built-in output for offline work and CI.',
  },
  {
    value: 'minimax',
    label: 'MiniMax',
    description: 'Use the MiniMax API provider for workflow agent output.',
  },
  {
    value: 'openai-compat',
    label: 'OpenAI-compatible',
    description: 'Use the configurable /chat/completions provider, such as DeepSeek or another compatible API.',
  },
  {
    value: 'agent-cli',
    label: 'Agent CLI',
    description: 'Use per-agent CLI runtimes configured in the Agent CLI console.',
  },
  {
    value: 'e2b',
    label: 'E2B',
    description: 'Run the task inside an E2B sandbox when credentials are configured.',
  },
  {
    value: 'a2a',
    label: 'A2A Remote Agents',
    description: 'Dispatch each seat to a configured A2A v1.0 agent.',
  },
];

export async function listSettingsState(): Promise<SettingsState> {
  const data = await readData();
  const effective = await resolveDefaultAgentAdapterState(data);
  return {
    defaultAgentAdapter: clean(data.settings.defaultAgentAdapter) ?? null,
    effectiveAgentAdapter: effective.value,
    effectiveAgentAdapterSource: effective.source,
    effectiveModelProvider: effective.modelProvider,
    adapters: ADAPTER_OPTIONS,
    a2aAgents: AGENT_ROSTER.map((agent) => a2aAgentState(agent.id, agent.displayName, agent.role, data)),
    providers: await Promise.all(MODEL_PROVIDER_DEFINITIONS.map(async (definition) => {
      const resolved = resolveModelProviderFromData(definition.provider, data);
      return {
        provider: definition.provider,
        label: resolved.label,
        description: definition.description,
        enabled: resolved.enabled,
        baseUrl: resolved.baseUrl,
        model: resolved.model,
        apiKeySet: Boolean(resolved.apiKey),
        apiKeySource: resolved.apiKey ? resolved.source === 'none' ? null : resolved.source : null,
        presets: definition.presets,
      };
    })),
  };
}

export async function saveSettings(input: {
  defaultAgentAdapter?: string | null | undefined;
  a2aAgents?: Array<{
    agentId: string;
    enabled?: boolean | undefined;
    baseUrl?: string | null | undefined;
    cardPath?: string | null | undefined;
    authToken?: string | null | undefined;
    clearAuthToken?: boolean | undefined;
  }> | undefined;
  providers?: Array<{
    provider: string;
    enabled?: boolean | undefined;
    label?: string | null | undefined;
    baseUrl?: string | null | undefined;
    model?: string | null | undefined;
    apiKey?: string | null | undefined;
    clearApiKey?: boolean | undefined;
  }> | undefined;
}): Promise<SettingsState> {
  const hasAdapterPatch = Object.prototype.hasOwnProperty.call(input, 'defaultAgentAdapter');
  const adapter = clean(input.defaultAgentAdapter ?? undefined);
  if (adapter && !ADAPTER_OPTIONS.some((option) => option.value === adapter)) {
    throw new SettingsActionError('unsupported_agent_adapter', 400);
  }

  await mutateData((data) => {
    const existing = data.settings.modelProviders;
    const providers = [...existing];
    for (const patch of input.providers ?? []) {
      const definition = providerDefinition(patch.provider);
      if (!definition) throw new SettingsActionError('unsupported_model_provider', 400);
      const current = providers.find((item) => item.provider === definition.provider);
      const next = normalizeProviderPatch(definition, current ?? null, patch);
      const index = providers.findIndex((item) => item.provider === definition.provider);
      if (index >= 0) providers[index] = next;
      else providers.push(next);
    }
    const a2aAgents = [...data.settings.a2aRemoteAgents];
    for (const patch of input.a2aAgents ?? []) {
      if (!AGENT_ROSTER.some((agent) => agent.id === patch.agentId)) {
        throw new SettingsActionError('a2a_agent_not_found', 404);
      }
      const current = a2aAgents.find((item) => item.agentId === patch.agentId) ?? null;
      const next = normalizeA2AAgentPatch(current, patch);
      const index = a2aAgents.findIndex((item) => item.agentId === patch.agentId);
      if (index >= 0) a2aAgents[index] = next;
      else a2aAgents.push(next);
    }
    data.settings = {
      ...data.settings,
      defaultAgentAdapter: hasAdapterPatch ? adapter ?? null : data.settings.defaultAgentAdapter,
      modelProviders: providers,
      a2aRemoteAgents: a2aAgents,
      updatedAt: nowIso(),
    };
  });
  return listSettingsState();
}

export async function resolveDefaultAgentAdapter(): Promise<string | null> {
  return (await resolveDefaultAgentAdapterState()).value;
}

export async function resolveDefaultAgentAdapterState(
  inputData?: RoundtableData,
): Promise<AgentAdapterResolution> {
  if (publicAiExecutionDisabled()) {
    return { value: 'local-dispatch', source: 'built-in', modelProvider: null };
  }

  const data = inputData ?? await readData();
  const fromSettings = normalizeAgentAdapter(data.settings.defaultAgentAdapter);
  if (fromSettings) return { value: fromSettings, source: 'settings', modelProvider: null };

  const fromEnv = normalizeAgentAdapter(process.env.ROUNDTABLE_AGENT_ADAPTER);
  if (fromEnv) return { value: fromEnv, source: 'env', modelProvider: null };

  if (hasConfiguredAgentCli(data)) {
    return { value: 'agent-cli', source: 'runtime-config', modelProvider: null };
  }

  const provider = firstConfiguredModelProvider(data);
  if (provider) {
    return {
      value: adapterForModelProvider(provider),
      source: 'model-provider',
      modelProvider: provider,
    };
  }

  return { value: 'local-dispatch', source: 'built-in', modelProvider: null };
}

export async function isModelProviderConfigured(provider: ModelProviderKind): Promise<boolean> {
  return (await resolveModelProvider(provider)).configured;
}

export async function defaultConfiguredModelProvider(): Promise<ModelProviderKind | null> {
  if (publicAiExecutionDisabled()) return null;
  return firstConfiguredModelProvider(await readData());
}

export async function resolveModelProvider(provider: ModelProviderKind): Promise<ResolvedModelProvider> {
  return resolveModelProviderFromData(provider, await readData());
}

export function publicAiExecutionDisabled(): boolean {
  return process.env.VERCEL === '1' && process.env.ROUNDTABLE_ENABLE_PUBLIC_AI !== '1';
}

export class SettingsActionError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

function resolveModelProviderFromData(
  provider: ModelProviderKind,
  data: RoundtableData,
): ResolvedModelProvider {
  const definition = providerDefinition(provider);
  if (!definition) throw new SettingsActionError('unsupported_model_provider', 400);
  const stored = data.settings.modelProviders.find((item) => item.provider === provider) ?? null;
  if (publicAiExecutionDisabled()) {
    return {
      provider,
      enabled: false,
      configured: false,
      label: stored?.label || definition.label,
      apiKey: null,
      baseUrl: stored?.baseUrl || definition.defaultBaseUrl,
      model: stored?.model || definition.defaultModel,
      source: 'none',
    };
  }

  const envApiKey = clean(process.env[definition.apiKeyEnv]) ?? null;
  const envBaseUrl = clean(process.env[definition.baseUrlEnv]) ?? null;
  const envModel = clean(process.env[definition.modelEnv]) ?? null;

  if (stored?.enabled === false) {
    return {
      provider,
      enabled: false,
      configured: false,
      label: stored.label || definition.label,
      apiKey: null,
      baseUrl: stored.baseUrl || envBaseUrl || definition.defaultBaseUrl,
      model: stored.model || envModel || definition.defaultModel,
      source: 'none',
    };
  }

  const settingsApiKey = clean(stored?.apiKey ?? undefined) ?? null;
  const apiKey = settingsApiKey || envApiKey;
  const baseUrl = clean(stored?.baseUrl ?? undefined) || envBaseUrl || definition.defaultBaseUrl;
  const model = clean(stored?.model ?? undefined) || envModel || definition.defaultModel;
  const enabled = stored?.enabled ?? true;
  const source = settingsApiKey ? 'settings' : envApiKey ? 'env' : 'none';
  return {
    provider,
    enabled,
    configured: enabled && Boolean(apiKey && baseUrl && model),
    label: clean(stored?.label ?? undefined) || definition.label,
    apiKey,
    baseUrl,
    model,
    source,
  };
}

function normalizeProviderPatch(
  definition: ModelProviderDefinition,
  current: ModelProviderConfig | null,
  patch: {
    enabled?: boolean | undefined;
    label?: string | null | undefined;
    baseUrl?: string | null | undefined;
    model?: string | null | undefined;
    apiKey?: string | null | undefined;
    clearApiKey?: boolean | undefined;
  },
): ModelProviderConfig {
  const apiKey = patch.clearApiKey
    ? null
    : patch.apiKey === undefined
      ? current?.apiKey ?? null
      : clean(patch.apiKey) ?? null;
  return {
    provider: definition.provider,
    enabled: patch.enabled ?? current?.enabled ?? true,
    label: clean(patch.label ?? undefined) || current?.label || definition.label,
    baseUrl: clean(patch.baseUrl ?? undefined) || current?.baseUrl || definition.defaultBaseUrl,
    model: clean(patch.model ?? undefined) || current?.model || definition.defaultModel,
    apiKey,
    updatedAt: nowIso(),
  };
}

function providerDefinition(provider: string): ModelProviderDefinition | null {
  return MODEL_PROVIDER_DEFINITIONS.find((definition) => definition.provider === provider) ?? null;
}

function firstConfiguredModelProvider(data: RoundtableData): ModelProviderKind | null {
  for (const provider of ['openai-compatible', 'minimax'] satisfies ModelProviderKind[]) {
    if (resolveModelProviderFromData(provider, data).configured) return provider;
  }
  return null;
}

function hasConfiguredAgentCli(data: RoundtableData): boolean {
  return [...data.agentRuntimeConfigs, ...data.agentRuntimeDefaults]
    .some((config) => config.runtime !== 'local-dispatch');
}

function adapterForModelProvider(provider: ModelProviderKind): string {
  return provider === 'minimax' ? 'minimax' : 'openai-compat';
}

function normalizeAgentAdapter(value: string | null | undefined): string | null {
  const raw = clean(value)?.toLowerCase();
  if (!raw) return null;
  if (raw === 'minimax') return 'minimax';
  if (raw === 'openai-compat' || raw === 'openai-compatible' || raw === 'openai' || raw === 'deepseek') return 'openai-compat';
  if (raw === 'agent-cli' || raw === 'external-cli' || raw === 'cli-runtime' || raw === 'runtime' || raw === 'cli') return 'agent-cli';
  if (raw === 'e2b') return 'e2b';
  if (raw === 'a2a' || raw === 'agent-to-agent') return 'a2a';
  if (raw === 'local' || raw === 'local-dispatch') return 'local-dispatch';
  return null;
}

function a2aAgentState(
  agentId: string,
  name: string,
  role: string,
  data: RoundtableData,
): SettingsState['a2aAgents'][number] {
  const stored = data.settings.a2aRemoteAgents.find((item) => item.agentId === agentId) ?? null;
  const envKey = agentId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  const envUrl = clean(process.env[`ROUNDTABLE_A2A_URL_${envKey}`]) ?? '';
  const envToken = clean(process.env[`ROUNDTABLE_A2A_TOKEN_${envKey}`]) ?? null;
  return {
    agentId,
    name,
    role,
    enabled: stored?.enabled ?? Boolean(envUrl),
    baseUrl: stored?.baseUrl || envUrl,
    cardPath: stored?.cardPath || clean(process.env[`ROUNDTABLE_A2A_CARD_PATH_${envKey}`]) || '/.well-known/agent-card.json',
    tokenSet: Boolean(stored?.authToken || envToken),
    tokenSource: stored?.authToken ? 'settings' : envToken ? 'env' : null,
  };
}

function normalizeA2AAgentPatch(
  current: A2ARemoteAgentConfig | null,
  patch: {
    agentId: string;
    enabled?: boolean | undefined;
    baseUrl?: string | null | undefined;
    cardPath?: string | null | undefined;
    authToken?: string | null | undefined;
    clearAuthToken?: boolean | undefined;
  },
): A2ARemoteAgentConfig {
  const baseUrl = clean(patch.baseUrl ?? undefined) ?? current?.baseUrl ?? '';
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new SettingsActionError('a2a_invalid_url', 400);
    }
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:' && loopback)) {
      throw new SettingsActionError('a2a_https_required', 400);
    }
  }
  const authToken = patch.clearAuthToken
    ? null
    : patch.authToken === undefined
      ? current?.authToken ?? null
      : clean(patch.authToken) ?? null;
  return {
    agentId: patch.agentId,
    enabled: patch.enabled ?? current?.enabled ?? true,
    baseUrl,
    cardPath: clean(patch.cardPath ?? undefined) ?? current?.cardPath ?? '/.well-known/agent-card.json',
    authToken,
    updatedAt: nowIso(),
  };
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}
