import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  SendMessageRequest,
  StreamResponse,
  Task,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type RequestOptions,
  type ServiceParameters,
} from '@a2a-js/sdk/client';
import type { A2ATaskBinding, HandoffCardV2, PlanTask } from '../../types.js';
import type { AgentRunResult } from '../agent-runner.js';
import type { ResolvedA2ARemoteAgentConfig } from '../a2a/config.js';
import {
  applyA2AStreamResponse,
  a2aStateName,
  buildA2ASendRequest,
  createA2AOutputAccumulator,
  isTerminalA2AState,
  materializableA2AParts,
  type A2ACollectedPart,
} from '../a2a/message-mapper.js';
import { finishA2ATaskBinding, upsertA2ATaskBinding } from '../a2a/task-store.js';
import { artifactKindForFile, type ChangedWorkspaceFile } from '../turns/workspace-scan.js';

const MAX_ARTIFACT_BYTES = 512 * 1024;

export interface A2AClientLike {
  readonly protocolVersion?: string;
  getAgentCard?(options?: RequestOptions): Promise<AgentCard>;
  sendMessageStream(
    request: SendMessageRequest,
    options?: RequestOptions,
  ): AsyncGenerator<StreamResponse, void, undefined>;
  getTask?(request: GetTaskRequest, options?: RequestOptions): Promise<Task>;
  cancelTask?(request: CancelTaskRequest, options?: RequestOptions): Promise<Task>;
}

export type CreatedA2AClient = {
  client: A2AClientLike;
  protocolVersion: string;
  tenant: string;
};

export class A2AUnavailableError extends Error {
  readonly code = 'a2a_unavailable';
  constructor(message = 'a2a_unavailable') {
    super(message);
    this.name = 'A2AUnavailableError';
  }
}

export class A2ARequestError extends Error {
  readonly code = 'a2a_request_failed';
  constructor(message: string) {
    super(message);
    this.name = 'A2ARequestError';
  }
}

export async function runOnA2A(
  input: {
    workspace: string;
    turnId: string;
    missionId: string;
    task: PlanTask;
    handoff: HandoffCardV2;
    handoffText: string;
    config: ResolvedA2ARemoteAgentConfig;
    timeoutMs?: number;
  },
  dependencies: {
    createClient?: (config: ResolvedA2ARemoteAgentConfig) => Promise<CreatedA2AClient>;
  } = {},
): Promise<AgentRunResult> {
  if (!input.config.enabled || !input.config.baseUrl) {
    throw new A2AUnavailableError(`a2a_remote_not_configured:${input.config.agentId}`);
  }
  const createClient = dependencies.createClient ?? createA2AClient;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? Number(process.env.ROUNDTABLE_AGENT_TIMEOUT_MS || 120_000),
  );
  const toolId = `tool_${input.task.id}`;
  try {
    const created = await createClient(input.config);
    if (created.protocolVersion !== '1.0') {
      throw new A2AUnavailableError('a2a_v1_interface_required');
    }
    const serviceParameters = authParameters(input.config.authToken);
    const request = buildA2ASendRequest({ handoff: input.handoff, handoffText: input.handoffText });
    request.tenant = created.tenant;
    let output = createA2AOutputAccumulator();
    for await (const event of created.client.sendMessageStream(request, {
      signal: controller.signal,
      serviceParameters,
    })) {
      output = applyA2AStreamResponse(output, event);
      if (output.remoteTaskId) {
        await upsertA2ATaskBinding({
          id: bindingId(input.turnId, input.task.id),
          missionId: input.missionId,
          turnId: input.turnId,
          planTaskId: input.task.id,
          agentId: input.config.agentId,
          agentBaseUrl: input.config.baseUrl,
          agentCardPath: input.config.cardPath,
          remoteTaskId: output.remoteTaskId,
          remoteContextId: output.remoteContextId,
          remoteTenant: created.tenant,
          protocolVersion: created.protocolVersion,
          state: output.state ?? 'working',
          error: output.error,
        });
      }
    }
    if (!isTerminalA2AState(output.state) && output.remoteTaskId && created.client.getTask) {
      const task = await created.client.getTask(
        { tenant: created.tenant, id: output.remoteTaskId, historyLength: 0 },
        { signal: controller.signal, serviceParameters },
      );
      output = applyA2AStreamResponse(output, { payload: { $case: 'task', value: task } });
    }
    if (output.remoteTaskId && output.state) {
      await finishA2ATaskBinding(input.turnId, input.task.id, output.state, output.error);
    }
    return materializeRunResult(input, output, created.protocolVersion, toolId);
  } catch (error) {
    if (error instanceof A2AUnavailableError) throw error;
    const message = controller.signal.aborted
      ? 'a2a_request_timeout'
      : sanitizeError(error, input.config.authToken);
    throw new A2ARequestError(message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function createA2AClient(
  config: ResolvedA2ARemoteAgentConfig,
): Promise<CreatedA2AClient> {
  const fetchImpl = authenticatedFetch(config.authToken);
  const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    transports: [
      new JsonRpcTransportFactory({ fetchImpl }),
      new RestTransportFactory({ fetchImpl }),
    ],
    preferredTransports: ['JSONRPC', 'HTTP+JSON'],
  });
  const client = await new ClientFactory(options).createFromUrl(
    config.baseUrl,
    config.cardPath ?? undefined,
  );
  const card = await client.getAgentCard({ serviceParameters: authParameters(config.authToken) });
  const selected = card.supportedInterfaces.find((item) =>
    item.protocolVersion === client.protocolVersion
    && (item.protocolBinding.toUpperCase() === 'JSONRPC' || item.protocolBinding.toUpperCase() === 'HTTP+JSON'),
  );
  if (!selected || client.protocolVersion !== '1.0') {
    throw new A2AUnavailableError('a2a_v1_interface_required');
  }
  return { client, protocolVersion: client.protocolVersion, tenant: selected.tenant || '' };
}

export async function cancelA2ABinding(
  binding: A2ATaskBinding,
  config: ResolvedA2ARemoteAgentConfig,
  dependencies: {
    createClient?: (config: ResolvedA2ARemoteAgentConfig) => Promise<CreatedA2AClient>;
  } = {},
): Promise<void> {
  const createClient = dependencies.createClient ?? createA2AClient;
  const boundConfig = {
    ...config,
    baseUrl: binding.agentBaseUrl,
    cardPath: binding.agentCardPath,
  };
  const created = await createClient(boundConfig);
  if (!created.client.cancelTask) throw new A2ARequestError('a2a_cancel_not_supported');
  const task = await created.client.cancelTask({
    tenant: binding.remoteTenant,
    id: binding.remoteTaskId,
    metadata: { roundtableTurnId: binding.turnId },
  }, {
    serviceParameters: authParameters(config.authToken),
  });
  const state = a2aStateName(task.status?.state) ?? 'canceled';
  await finishA2ATaskBinding(binding.turnId, binding.planTaskId, state, null);
}

function materializeRunResult(
  input: {
    workspace: string;
    task: PlanTask;
    config: ResolvedA2ARemoteAgentConfig;
  },
  output: ReturnType<typeof createA2AOutputAccumulator>,
  protocolVersion: string,
  toolId: string,
): Promise<AgentRunResult> {
  return materialize();

  async function materialize(): Promise<AgentRunResult> {
    const parts = materializableA2AParts(output.parts).sort((a, b) => partPriority(a) - partPriority(b));
    const selected = parts[0] ?? {
      artifactId: null,
      filename: 'result.md',
      mediaType: 'text/markdown',
      kind: 'text' as const,
      value: output.error ? `# A2A task failed\n\n${output.error}` : '# A2A task returned no supported artifact',
    };
    const base = `.roundtable/runs/a2a/${safeSegment(input.task.id)}`;
    const files: ChangedWorkspaceFile[] = [];
    for (const part of parts.length > 0 ? parts : [selected]) {
      const text = partText(part);
      if (Buffer.byteLength(text, 'utf8') > MAX_ARTIFACT_BYTES) {
        throw new A2ARequestError('a2a_artifact_too_large');
      }
      const path = `${base}/${safeSegment(part.filename)}`;
      await writeText(input.workspace, path, text);
      files.push({ path, text, kind: artifactKindForFile(path) });
    }
    const selectedPath = `${base}/${safeSegment(selected.filename)}`;
    const selectedText = partText(selected);
    const ok = output.state === 'completed';
    const events = [
      { type: 'thinking_delta' as const, delta: `Dispatching ${input.task.title} over A2A.` },
      {
        type: 'tool_use' as const,
        id: toolId,
        name: 'a2a_remote_agent',
        input: { agentId: input.config.agentId, baseUrl: input.config.baseUrl },
      },
      {
        type: 'tool_result' as const,
        id: toolId,
        output: { taskId: output.remoteTaskId, contextId: output.remoteContextId, state: output.state },
        isError: !ok,
      },
      ...output.events,
    ];
    return {
      text: selectedText,
      path: selectedPath,
      kind: artifactKindForFile(selectedPath),
      files: files.filter((file) => file.path !== selectedPath),
      events,
      ok,
      error: ok ? null : output.error ?? 'a2a_stream_ended_without_result',
      ...(output.remoteTaskId ? {
        remote: {
          protocol: 'a2a' as const,
          taskId: output.remoteTaskId,
          contextId: output.remoteContextId,
          protocolVersion,
          agentBaseUrl: input.config.baseUrl,
        },
      } : {}),
    };
  }
}

function partPriority(part: A2ACollectedPart): number {
  return ['text/html', 'text/markdown', 'application/json', 'text/plain'].indexOf(part.mediaType);
}

function partText(part: A2ACollectedPart): string {
  if (typeof part.value === 'string') return part.value;
  return JSON.stringify(part.value, null, 2);
}

function safeSegment(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'result';
}

async function writeText(workspace: string, relativePath: string, text: string): Promise<void> {
  const target = join(workspace, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

function authParameters(token: string | null): ServiceParameters {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function authenticatedFetch(token: string | null): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

function sanitizeError(error: unknown, token: string | null): string {
  const raw = error instanceof Error ? error.message : String(error);
  return token ? raw.replaceAll(token, '[redacted]') : raw;
}

function bindingId(turnId: string, taskId: string): string {
  return `a2a_${safeSegment(turnId)}_${safeSegment(taskId)}`;
}
