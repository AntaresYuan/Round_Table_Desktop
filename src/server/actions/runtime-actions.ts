import { id, mutateData, nowIso, readData } from '../store.js';
import type {
  AgentEvent,
  AgentRuntimeConfig,
  AgentRuntimeConversation,
  AgentRuntimeDefaultConfig,
  AgentRuntimeEffort,
  AgentRuntimeInteractionMode,
  AgentRuntimeKind,
  Actor,
  ModelProviderKind,
} from '../types.js';
import { AGENT_ROSTER, type AgentProfile } from './agent-roster.js';
import {
  configuredRuntimeForAgent,
  mergedRuntimeConfigForAgent,
  normalizeRuntimeKind,
  RUNTIME_DEFINITIONS,
  runtimeConfigForAgent,
  runtimeDefaultConfigForKind,
} from './cli-runtimes/registry.js';
import {
  isModelProviderConfigured,
  MODEL_PROVIDER_DEFINITIONS,
  resolveDefaultAgentAdapterState,
  type AgentAdapterResolution,
} from './settings-actions.js';
import {
  executeCliRuntime,
  stopActiveRuntimeConversation,
  type RuntimeExecutionCallbacks,
  type RuntimeTranscriptEntry,
} from './cli-runtimes/runner.js';
import {
  clearCliSession,
  cliSessionFor,
  runtimeSupportsResume,
  saveCliSession,
} from './cli-runtimes/sessions.js';
import { probeRuntime, type RuntimeProbe } from './cli-runtimes/probe.js';

export type RuntimeState = {
  executionAdapter: string;
  executionAdapterSource: AgentAdapterResolution['source'];
  executionModelProvider: AgentAdapterResolution['modelProvider'];
  supported: Array<{
    kind: AgentRuntimeKind;
    label: string;
    description: string;
    binary: string | null;
    installHint: string | null;
    command: string | null;
    args: string[];
    model: string | null;
    modelProvider: ModelProviderKind | null;
    interactionMode: AgentRuntimeInteractionMode | null;
    effort: AgentRuntimeEffort | null;
    configured: boolean;
    configuredEnvKeys: string[];
    requiredEnvKeys: string[];
    ready: boolean;
    readyReason: string | null;
    commandPath: string | null;
    detectedVersion: string | null;
    authConfigured: boolean;
    authSources: string[];
  }>;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    runtime: AgentRuntimeKind;
    command: string | null;
    args: string[];
    model: string | null;
    modelProvider: ModelProviderKind | null;
    interactionMode: AgentRuntimeInteractionMode | null;
    effort: AgentRuntimeEffort | null;
    configured: boolean;
    ready: boolean;
    readyReason: string | null;
    detectedVersion: string | null;
    authConfigured: boolean;
    authSources: string[];
  }>;
  modelProviders: Array<{
    provider: ModelProviderKind;
    label: string;
    configured: boolean;
  }>;
  conversations: AgentRuntimeConversation[];
};

export async function listRuntimeState(): Promise<RuntimeState> {
  const data = await readData();
  const execution = await resolveDefaultAgentAdapterState(data);
  const supported = await Promise.all(RUNTIME_DEFINITIONS.map(async (definition) => {
    const defaultConfig = runtimeDefaultConfigForKind(definition.kind, data.agentRuntimeDefaults);
    const readiness = await runtimeReadiness(definition.kind, defaultConfig);
    return {
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      binary: definition.binary,
      installHint: definition.installHint,
      command: defaultConfig?.command ?? null,
      args: defaultConfig?.args ?? [],
      model: defaultConfig?.model ?? null,
      modelProvider: defaultConfig?.modelProvider ?? null,
      interactionMode: defaultConfig?.interactionMode ?? null,
      effort: defaultConfig?.effort ?? null,
      configured: defaultConfig !== null,
      configuredEnvKeys: Object.keys(defaultConfig?.env ?? {}).sort(),
      requiredEnvKeys: definition.envKeys,
      ready: readiness.ready,
      readyReason: readiness.reason,
      commandPath: readiness.commandPath,
      detectedVersion: readiness.detectedVersion,
      authConfigured: readiness.authConfigured,
      authSources: readiness.authSources,
    };
  }));
  const agents = await Promise.all(AGENT_ROSTER.map(async (agent) => {
    const config = runtimeConfigForAgent(agent, data.agentRuntimeConfigs);
    const runtime = config?.runtime ?? configuredRuntimeForAgent(agent, data.agentRuntimeConfigs);
    const merged = mergedRuntimeConfigForAgent(
      agent,
      runtime,
      data.agentRuntimeConfigs,
      data.agentRuntimeDefaults,
    );
    const readiness = await runtimeReadiness(runtime, merged);
    return {
      id: agent.id,
      name: agent.displayName,
      role: agent.role,
      runtime,
      command: merged?.command ?? null,
      args: merged?.args ?? [],
      model: merged?.model ?? null,
      modelProvider: merged?.modelProvider ?? null,
      interactionMode: merged?.interactionMode ?? null,
      effort: merged?.effort ?? null,
      configured: config !== null,
      ready: readiness.ready,
      readyReason: readiness.reason,
      detectedVersion: readiness.detectedVersion,
      authConfigured: readiness.authConfigured,
      authSources: readiness.authSources,
    };
  }));
  const modelProviders = await Promise.all(MODEL_PROVIDER_DEFINITIONS.map(async (definition) => ({
    provider: definition.provider,
    label: definition.label,
    configured: await isModelProviderConfigured(definition.provider),
  })));
  return {
    executionAdapter: execution.value,
    executionAdapterSource: execution.source,
    executionModelProvider: execution.modelProvider,
    supported,
    agents,
    modelProviders,
    conversations: [...data.agentRuntimeConversations]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 80),
  };
}

export async function saveAgentRuntimeConfig(input: {
  agentId: string;
  runtime: string;
  command?: string | null | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  model?: string | null | undefined;
  modelProvider?: string | null | undefined;
  interactionMode?: string | null | undefined;
  effort?: string | null | undefined;
  actor?: Actor | null | undefined;
}): Promise<AgentRuntimeConfig> {
  const agent = agentById(input.agentId);
  const runtime = normalizeRuntimeKind(input.runtime);
  if (!agent) throw new RuntimeActionError('agent_not_found', 404);
  if (!runtime) throw new RuntimeActionError('runtime_not_supported', 400);
  const config: AgentRuntimeConfig = {
    agentId: agent.id,
    runtime,
    command: clean(input.command) ?? null,
    args: input.args?.map((arg) => arg.trim()).filter(Boolean) ?? [],
    env: sanitizeEnv(input.env ?? {}),
    model: clean(input.model) ?? null,
    modelProvider: normalizeModelProvider(input.modelProvider),
    interactionMode: normalizeInteractionMode(input.interactionMode),
    effort: normalizeEffort(input.effort),
    updatedAt: nowIso(),
  };
  await mutateData((data) => {
    data.agentRuntimeConfigs = [
      config,
      ...data.agentRuntimeConfigs.filter((item) => item.agentId !== config.agentId),
    ];
  });
  return config;
}

export async function saveRuntimeDefaultConfig(input: {
  runtime: string;
  command?: string | null | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  clearEnv?: boolean | undefined;
  model?: string | null | undefined;
  modelProvider?: string | null | undefined;
  interactionMode?: string | null | undefined;
  effort?: string | null | undefined;
  actor?: Actor | null | undefined;
}): Promise<AgentRuntimeDefaultConfig> {
  const runtime = normalizeRuntimeKind(input.runtime);
  if (!runtime) throw new RuntimeActionError('runtime_not_supported', 400);
  let saved: AgentRuntimeDefaultConfig | null = null;
  await mutateData((data) => {
    const existing = runtimeDefaultConfigForKind(runtime, data.agentRuntimeDefaults);
    const env = input.clearEnv
      ? {}
      : input.env === undefined
        ? existing?.env ?? {}
        : sanitizeEnv(input.env);
    saved = {
      runtime,
      command: clean(input.command) ?? null,
      args: input.args?.map((arg) => arg.trim()).filter(Boolean) ?? [],
      env,
      model: clean(input.model) ?? null,
      modelProvider: normalizeModelProvider(input.modelProvider),
      interactionMode: normalizeInteractionMode(input.interactionMode),
      effort: normalizeEffort(input.effort),
      updatedAt: nowIso(),
    };
    data.agentRuntimeDefaults = [
      saved,
      ...data.agentRuntimeDefaults.filter((item) => item.runtime !== runtime),
    ];
  });
  if (!saved) throw new RuntimeActionError('runtime_default_not_saved', 500);
  return saved;
}

export async function createRuntimeConversation(input: {
  agent: AgentProfile;
  runtime: AgentRuntimeKind;
  title: string;
  workspacePath: string;
  turnId?: string | null | undefined;
  taskId?: string | null | undefined;
}): Promise<AgentRuntimeConversation> {
  const now = nowIso();
  const conversation: AgentRuntimeConversation = {
    id: id('runtime'),
    agentId: input.agent.id,
    role: input.agent.role,
    runtime: input.runtime,
    title: input.title,
    turnId: input.turnId ?? null,
    taskId: input.taskId ?? null,
    workspacePath: input.workspacePath,
    cwd: input.workspacePath,
    command: 'starting',
    pid: null,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    events: [],
    transcript: [],
    error: null,
    sessionId: null,
  };
  await mutateData((data) => {
    data.agentRuntimeConversations = [conversation, ...data.agentRuntimeConversations].slice(0, 200);
  });
  return conversation;
}

export function runtimeConversationCallbacks(conversationId: string): RuntimeExecutionCallbacks {
  return {
    onCommand: (command, pid) => updateRuntimeConversation(conversationId, {
      command,
      pid,
      updatedAt: nowIso(),
    }),
    onEvent: (event, transcript) => appendRuntimeConversationEvent(conversationId, event, transcript),
  };
}

export async function finishRuntimeConversation(
  conversationId: string,
  status: 'completed' | 'failed' | 'stopped',
  error: string | null,
  sessionId?: string | null,
): Promise<void> {
  const now = nowIso();
  await updateRuntimeConversation(conversationId, {
    status,
    error,
    ...(sessionId !== undefined ? { sessionId } : {}),
    updatedAt: now,
    finishedAt: now,
  });
}

export async function stopRuntimeConversation(conversationId: string): Promise<AgentRuntimeConversation | null> {
  const stopped = stopActiveRuntimeConversation(conversationId);
  const now = nowIso();
  let updated: AgentRuntimeConversation | null = null;
  await mutateData((data) => {
    data.agentRuntimeConversations = data.agentRuntimeConversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      updated = {
        ...conversation,
        status: conversation.status === 'running' ? 'stopped' : conversation.status,
        error: stopped ? 'stopped_by_user' : conversation.error,
        updatedAt: now,
        finishedAt: conversation.finishedAt ?? now,
      };
      return updated;
    });
  });
  return updated;
}

export async function startDirectRuntimeConversation(input: {
  agentId: string;
  message: string;
  workspacePath?: string | undefined;
}): Promise<AgentRuntimeConversation> {
  const agent = agentById(input.agentId);
  if (!agent) throw new RuntimeActionError('agent_not_found', 404);
  const data = await readData();
  const runtime = configuredRuntimeForAgent(agent, data.agentRuntimeConfigs);
  if (runtime === 'local-dispatch') throw new RuntimeActionError('local_runtime_not_directly_runnable', 400);
  const config = mergedRuntimeConfigForAgent(
    agent,
    runtime,
    data.agentRuntimeConfigs,
    data.agentRuntimeDefaults,
  );
  const workspace = input.workspacePath?.trim() || process.cwd();
  // Only persist/resume CLI sessions for an explicit workspace: the fallback
  // cwd is the app source tree, which must not grow session sidecar files.
  const sessionsEnabled = Boolean(input.workspacePath?.trim());
  const storedSession = sessionsEnabled && runtimeSupportsResume(runtime)
    ? await cliSessionFor(workspace, runtime, agent.id)
    : null;
  const conversation = await createRuntimeConversation({
    agent,
    runtime,
    title: input.message.slice(0, 80) || `Direct message to ${agent.displayName}`,
    workspacePath: workspace,
  });
  const prompt = [
    'You are running as a Roundtable CLI-backed agent outside a workflow.',
    `Agent: ${agent.displayName} (${agent.id})`,
    `Role: ${agent.role}`,
    'Treat the user message as a direct terminal/chat instruction.',
    'Work in the current working directory and summarize what you did.',
    '',
    `User message:\n${input.message}`,
  ].join('\n\n');

  void executeCliRuntime({
    conversationId: conversation.id,
    runtime,
    agent,
    config,
    workspace,
    prompt,
    timeoutMs: runtimeTimeoutMs(),
    idleTimeoutMs: runtimeIdleTimeoutMs(),
    callbacks: runtimeConversationCallbacks(conversation.id),
    resumeSessionId: storedSession ?? undefined,
    sessionScopeId: `direct_${agent.id}`,
  }).then(async (result) => {
    if (sessionsEnabled) {
      // Keep the registry honest: a successful run stores the (possibly forked)
      // session; a failed resume drops the stale entry so the next message
      // starts cold instead of failing the same way again.
      if (result.ok && result.sessionId) await saveCliSession(workspace, runtime, agent.id, result.sessionId);
      else if (!result.ok && storedSession) await clearCliSession(workspace, runtime, agent.id);
    }
    await finishRuntimeConversation(conversation.id, result.ok ? 'completed' : 'failed', result.error, result.sessionId);
  }).catch((error: unknown) => (
    finishRuntimeConversation(conversation.id, 'failed', error instanceof Error ? error.message : String(error))
  ));

  return conversation;
}

export class RuntimeActionError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

async function appendRuntimeConversationEvent(
  conversationId: string,
  event: AgentEvent,
  transcript?: RuntimeTranscriptEntry | undefined,
): Promise<void> {
  const now = nowIso();
  await mutateData((data) => {
    data.agentRuntimeConversations = data.agentRuntimeConversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      return {
        ...conversation,
        events: [...conversation.events, event].slice(-400),
        transcript: transcript
          ? [...conversation.transcript, { at: now, ...transcript }].slice(-200)
          : conversation.transcript,
        updatedAt: now,
      };
    });
  });
}

async function updateRuntimeConversation(
  conversationId: string,
  patch: Partial<AgentRuntimeConversation>,
): Promise<void> {
  await mutateData((data) => {
    data.agentRuntimeConversations = data.agentRuntimeConversations.map((conversation) =>
      conversation.id === conversationId ? { ...conversation, ...patch } : conversation,
    );
  });
}

function agentById(agentId: string): AgentProfile | null {
  return AGENT_ROSTER.find((agent) => agent.id === agentId) ?? null;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeModelProvider(value: string | null | undefined): ModelProviderKind | null {
  const raw = clean(value)?.toLowerCase();
  if (!raw || raw === 'none') return null;
  if (raw === 'minimax') return 'minimax';
  if (raw === 'openai-compatible' || raw === 'openai-compat' || raw === 'openai' || raw === 'deepseek') {
    return 'openai-compatible';
  }
  throw new RuntimeActionError('model_provider_not_supported', 400);
}

function normalizeInteractionMode(value: string | null | undefined): AgentRuntimeInteractionMode | null {
  const raw = clean(value)?.toLowerCase();
  if (!raw || raw === 'none' || raw === 'default') return null;
  if (raw === 'auto' || raw === 'automatic') return 'auto';
  if (raw === 'manual' || raw === 'ask' || raw === 'confirm') return 'manual';
  throw new RuntimeActionError('interaction_mode_not_supported', 400);
}

function normalizeEffort(value: string | null | undefined): AgentRuntimeEffort | null {
  const raw = clean(value)?.toLowerCase();
  if (!raw || raw === 'none' || raw === 'default') return null;
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max') return raw;
  throw new RuntimeActionError('effort_not_supported', 400);
}

function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const normalized = key.trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) continue;
    if (!value.trim()) continue;
    out[normalized] = value.trim();
  }
  return out;
}

async function runtimeReadiness(
  kind: AgentRuntimeKind,
  config: AgentRuntimeConfig | AgentRuntimeDefaultConfig | null = null,
): Promise<RuntimeProbe> {
  const probe = await probeRuntime(kind, config);
  if (!probe.ready) return probe;
  if (config?.modelProvider && !(await isModelProviderConfigured(config.modelProvider))) {
    return {
      ...probe,
      ready: false,
      reason: `Missing API provider key: ${config.modelProvider}`,
    };
  }
  return probe;
}

function runtimeTimeoutMs(): number | undefined {
  const parsed = Number(process.env.ROUNDTABLE_AGENT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function runtimeIdleTimeoutMs(): number | undefined {
  const parsed = Number(process.env.ROUNDTABLE_AGENT_IDLE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
}
