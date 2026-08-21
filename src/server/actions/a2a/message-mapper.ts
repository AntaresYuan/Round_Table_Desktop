import { randomUUID } from 'node:crypto';
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type SendMessageRequest,
  type StreamResponse,
} from '@a2a-js/sdk';
import type {
  A2ATaskBindingState,
  AgentEvent,
  HandoffCardV2,
} from '../../types.js';

export const A2A_OUTPUT_MODES = [
  'text/plain',
  'text/markdown',
  'text/html',
  'application/json',
];

export type A2ACollectedPart = {
  artifactId: string | null;
  filename: string;
  mediaType: string;
  kind: 'text' | 'data' | 'url' | 'raw';
  value: unknown;
};

export type A2AOutputAccumulator = {
  remoteTaskId: string | null;
  remoteContextId: string | null;
  state: A2ATaskBindingState | null;
  parts: A2ACollectedPart[];
  events: AgentEvent[];
  error: string | null;
};

export function buildA2ASendRequest(input: {
  handoff: HandoffCardV2;
  handoffText: string;
  messageId?: string;
}): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: input.messageId ?? randomUUID(),
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: 'text', value: input.handoffText },
          filename: '',
          mediaType: 'text/plain',
          metadata: undefined,
        },
        {
          content: { $case: 'data', value: input.handoff },
          filename: 'roundtable-handoff.json',
          mediaType: 'application/json',
          metadata: { schema: 'roundtable.handoff.v2' },
        },
      ],
      metadata: {
        roundtableMissionId: input.handoff.missionId,
        roundtablePlanTaskId: input.handoff.task.id,
        roundtableHandoffVersion: input.handoff.protocolVersion,
      },
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: A2A_OUTPUT_MODES,
      taskPushNotificationConfig: undefined,
      returnImmediately: false,
    },
    metadata: {},
  };
}

export function createA2AOutputAccumulator(): A2AOutputAccumulator {
  return {
    remoteTaskId: null,
    remoteContextId: null,
    state: null,
    parts: [],
    events: [],
    error: null,
  };
}

export function applyA2AStreamResponse(
  current: A2AOutputAccumulator,
  response: StreamResponse,
): A2AOutputAccumulator {
  const next: A2AOutputAccumulator = {
    ...current,
    parts: [...current.parts],
    events: [...current.events],
  };
  const payload = response.payload;
  if (!payload) return next;

  if (payload.$case === 'task') {
    next.remoteTaskId = payload.value.id || next.remoteTaskId;
    next.remoteContextId = payload.value.contextId || next.remoteContextId;
    for (const artifact of payload.value.artifacts) addArtifact(next, artifact, false);
    addMessage(next, payload.value.status?.message);
    applyState(next, payload.value.status?.state);
  } else if (payload.$case === 'artifactUpdate') {
    next.remoteTaskId = payload.value.taskId || next.remoteTaskId;
    next.remoteContextId = payload.value.contextId || next.remoteContextId;
    if (payload.value.artifact) addArtifact(next, payload.value.artifact, payload.value.append);
  } else if (payload.$case === 'statusUpdate') {
    next.remoteTaskId = payload.value.taskId || next.remoteTaskId;
    next.remoteContextId = payload.value.contextId || next.remoteContextId;
    addMessage(next, payload.value.status?.message);
    applyState(next, payload.value.status?.state);
  } else if (payload.$case === 'message') {
    next.remoteTaskId = payload.value.taskId || next.remoteTaskId;
    next.remoteContextId = payload.value.contextId || next.remoteContextId;
    addMessage(next, payload.value);
    if (!payload.value.taskId) applyState(next, TaskState.TASK_STATE_COMPLETED);
  }
  return next;
}

export function a2aStateName(state: TaskState | undefined): A2ATaskBindingState | null {
  if (state === TaskState.TASK_STATE_SUBMITTED) return 'submitted';
  if (state === TaskState.TASK_STATE_WORKING) return 'working';
  if (state === TaskState.TASK_STATE_COMPLETED) return 'completed';
  if (state === TaskState.TASK_STATE_FAILED) return 'failed';
  if (state === TaskState.TASK_STATE_CANCELED) return 'canceled';
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED) return 'input_required';
  if (state === TaskState.TASK_STATE_AUTH_REQUIRED) return 'auth_required';
  if (state === TaskState.TASK_STATE_REJECTED) return 'rejected';
  return null;
}

export function isTerminalA2AState(state: A2ATaskBindingState | null): boolean {
  return state === 'completed'
    || state === 'failed'
    || state === 'canceled'
    || state === 'input_required'
    || state === 'auth_required'
    || state === 'rejected';
}

export function materializableA2AParts(parts: A2ACollectedPart[]): A2ACollectedPart[] {
  return parts.filter((part) =>
    (part.kind === 'text' || part.kind === 'data')
    && A2A_OUTPUT_MODES.includes(part.mediaType),
  );
}

function addArtifact(output: A2AOutputAccumulator, artifact: Artifact, append: boolean): void {
  for (const part of artifact.parts) addPart(output, part, artifact.artifactId, artifact.name, append);
}

function addMessage(output: A2AOutputAccumulator, message: Message | undefined): void {
  if (!message) return;
  for (const part of message.parts) {
    addPart(output, part, null, part.filename || 'message.txt', false);
    if (part.content?.$case === 'text' && part.content.value.trim()) {
      output.events.push({ type: 'text_delta', delta: part.content.value });
    }
  }
}

function addPart(
  output: A2AOutputAccumulator,
  part: Part,
  artifactId: string | null,
  fallbackName: string,
  append: boolean,
): void {
  const content = part.content;
  if (!content) return;
  const collected: A2ACollectedPart = {
    artifactId,
    filename: safeFilename(part.filename || fallbackName, part.mediaType),
    mediaType: part.mediaType || defaultMediaType(content.$case),
    kind: content.$case,
    value: content.value,
  };
  const previous = append
    ? [...output.parts].reverse().find((item) =>
      item.artifactId === collected.artifactId
      && item.filename === collected.filename
      && item.mediaType === collected.mediaType
      && item.kind === collected.kind,
    )
    : null;
  if (previous && typeof previous.value === 'string' && typeof collected.value === 'string') {
    previous.value += collected.value;
    return;
  }
  output.parts.push(collected);
}

function applyState(output: A2AOutputAccumulator, state: TaskState | undefined): void {
  const named = a2aStateName(state);
  if (!named) return;
  output.state = named;
  if (!isTerminalA2AState(named)) return;
  if (output.events.some((event) => event.type === 'done' || event.type === 'error')) return;
  if (named === 'completed') {
    output.events.push({ type: 'done', finishReason: 'completed' });
  } else {
    output.error = `a2a_task_${named}`;
    output.events.push({
      type: 'error',
      message: output.error,
      recoverable: named === 'input_required' || named === 'auth_required',
    });
  }
}

function safeFilename(value: string, mediaType: string): string {
  const basename = value.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  const cleaned = basename.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned) return cleaned;
  if (mediaType === 'text/html') return 'result.html';
  if (mediaType === 'application/json') return 'result.json';
  if (mediaType === 'text/markdown') return 'result.md';
  return 'result.txt';
}

function defaultMediaType(kind: A2ACollectedPart['kind']): string {
  if (kind === 'data') return 'application/json';
  if (kind === 'text') return 'text/plain';
  return 'application/octet-stream';
}
