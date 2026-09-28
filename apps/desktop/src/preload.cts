import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type {
  DesktopBridge,
  DesktopSystemInfo,
  ExecutionGetInput,
  ExecutionStopInput,
  MissionApprovalPreview,
  MissionApproveInput,
  MissionExecutionAccepted,
  MissionPrepareInput,
  RuntimeCatalog,
  RuntimeArtifact,
  RuntimeExecutionEvent,
  RuntimeExecutionSnapshot,
  WorkspaceEntries,
  WorkspaceListEntriesInput,
  WorkspaceSelection,
  ApplyChallenge,
  ApplyChallengeInput,
  ReviewPrepareInput,
  ReviewExecutionInput,
  ReviewBundle,
} from '@roundtable/protocol';

// Sandboxed preload scripts cannot import arbitrary runtime modules. Keep this
// fixed, narrow channel table in the single-file preload and verify it in tests.
const channels = Object.freeze({
  systemGetInfo: 'roundtable:system:get-info',
  workspaceSelect: 'roundtable:workspace:select',
  workspaceListEntries: 'roundtable:workspace:list-entries',
  runtimeCatalog: 'roundtable:runtime:catalog',
  missionPrepare: 'roundtable:mission:prepare',
  missionApprove: 'roundtable:mission:approve',
  executionGet: 'roundtable:execution:get',
  executionStop: 'roundtable:execution:stop',
  reviewBegin: 'roundtable:review:begin',
  reviewInspect: 'roundtable:review:inspect',
  reviewPrepare: 'roundtable:review:prepare',
  applyAuthorize: 'roundtable:apply:authorize',
  applyReject: 'roundtable:apply:reject',
  executionEvent: 'roundtable:execution:event',
});

const desktopBridge: DesktopBridge = Object.freeze({
  getSystemInfo: () => (
    ipcRenderer.invoke(channels.systemGetInfo) as Promise<DesktopSystemInfo>
  ),
  selectWorkspace: () => (
    ipcRenderer.invoke(channels.workspaceSelect) as Promise<WorkspaceSelection>
  ),
  listWorkspaceEntries: async (input: WorkspaceListEntriesInput) => {
    const normalizedInput = normalizeWorkspaceListInput(input);
    return ipcRenderer.invoke(
      channels.workspaceListEntries,
      normalizedInput,
    ) as Promise<WorkspaceEntries>;
  },
  getRuntimeCatalog: () => (
    ipcRenderer.invoke(channels.runtimeCatalog) as Promise<RuntimeCatalog>
  ),
  prepareMission: (input: MissionPrepareInput) => (
    ipcRenderer.invoke(
      channels.missionPrepare,
      normalizeMissionPrepareInput(input),
    ) as Promise<MissionApprovalPreview>
  ),
  approveMission: (input: MissionApproveInput) => (
    ipcRenderer.invoke(
      channels.missionApprove,
      normalizeIdInput(input, 'approvalId', 'approval_'),
    ) as Promise<MissionExecutionAccepted>
  ),
  getExecution: (input: ExecutionGetInput) => (
    ipcRenderer.invoke(
      channels.executionGet,
      normalizeIdInput(input, 'executionId', 'execution_'),
    ) as Promise<RuntimeExecutionSnapshot>
  ),
  stopExecution: (input: ExecutionStopInput) => (
    ipcRenderer.invoke(
      channels.executionStop,
      normalizeIdInput(input, 'executionId', 'execution_'),
    ) as Promise<RuntimeExecutionSnapshot>
  ),
  beginReview: (input: ReviewExecutionInput) => (
    ipcRenderer.invoke(
      channels.reviewBegin,
      normalizeReviewExecutionInput(input),
    ) as Promise<{ started: true }>
  ),
  inspectReview: (input: ReviewExecutionInput) => (
    ipcRenderer.invoke(
      channels.reviewInspect,
      normalizeReviewExecutionInput(input),
    ) as Promise<ReviewBundle>
  ),
  prepareReview: (input: ReviewPrepareInput) => (
    ipcRenderer.invoke(channels.reviewPrepare, input) as Promise<ApplyChallenge>
  ),
  authorizeApply: (input: ApplyChallengeInput) => (
    ipcRenderer.invoke(
      channels.applyAuthorize,
      normalizeIdInput(input, 'applyId', 'apply_'),
    ) as Promise<{ applied: true }>
  ),
  rejectApply: (input: ApplyChallengeInput) => (
    ipcRenderer.invoke(
      channels.applyReject,
      normalizeIdInput(input, 'applyId', 'apply_'),
    ) as Promise<{ rejected: true }>
  ),
  onExecutionEvent: (listener: (event: RuntimeExecutionEvent) => void) => {
    if (typeof listener !== 'function') throw new Error('execution_listener_invalid');
    const handler = (_event: IpcRendererEvent, rawEvent: unknown) => {
      listener(normalizeExecutionEvent(rawEvent));
    };
    ipcRenderer.on(channels.executionEvent, handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      ipcRenderer.removeListener(channels.executionEvent, handler);
    };
  },
});

contextBridge.exposeInMainWorld('roundtableDesktop', desktopBridge);

function normalizeWorkspaceListInput(input: WorkspaceListEntriesInput): WorkspaceListEntriesInput {
  if (!input || typeof input !== 'object') throw new Error('workspace_request_invalid');
  const workspaceId: unknown = input.workspaceId;
  const relativePath: unknown = input.relativePath;
  if (
    typeof workspaceId !== 'string'
    || workspaceId.length < 1
    || workspaceId.length > 128
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/u.test(workspaceId)
    || typeof relativePath !== 'string'
    || relativePath.length > 512
    || !isCanonicalRelativePath(relativePath)
  ) {
    throw new Error('workspace_request_invalid');
  }
  return { workspaceId: workspaceId as WorkspaceListEntriesInput['workspaceId'], relativePath };
}

function normalizeReviewExecutionInput(input: ReviewExecutionInput): ReviewExecutionInput {
  if (!isPlainRecord(input)
    || !hasExactKeys(input, ['executionId', 'workspaceId'])
    || !isOpaqueId(input.executionId, 'execution_')
    || !isOpaqueId(input.workspaceId, 'workspace_')) {
    throw new Error('review_request_invalid');
  }
  return {
    executionId: input.executionId as ReviewExecutionInput['executionId'],
    workspaceId: input.workspaceId as ReviewExecutionInput['workspaceId'],
  };
}

function normalizeMissionPrepareInput(input: MissionPrepareInput): MissionPrepareInput {
  if (!isPlainRecord(input) || !hasExactKeys(input, ['workspaceId', 'provider', 'prompt'])) {
    throw new Error('mission_request_invalid');
  }
  const workspaceId = input.workspaceId;
  const provider = input.provider;
  const prompt = input.prompt;
  if (
    !isOpaqueId(workspaceId, 'workspace_')
    || !['codex', 'claude-code', 'opencode'].includes(provider)
    || typeof prompt !== 'string'
    || prompt.trim().length < 1
    || prompt.trim().length > 12_000
  ) {
    throw new Error('mission_request_invalid');
  }
  return { workspaceId, provider, prompt };
}

function normalizeIdInput<T extends 'approvalId' | 'executionId' | 'applyId'>(
  input: unknown,
  key: T,
  prefix: string,
): Record<T, string> {
  if (!isPlainRecord(input) || !hasExactKeys(input, [key])) {
    throw new Error('execution_request_invalid');
  }
  const value = input[key];
  if (!isOpaqueId(value, prefix)) throw new Error('execution_request_invalid');
  return { [key]: value } as Record<T, string>;
}

function normalizeExecutionEvent(rawEvent: unknown): RuntimeExecutionEvent {
  if (!isPlainRecord(rawEvent)) throw new Error('execution_event_invalid');
  const commonKeys = ['missionId', 'executionId', 'sequence', 'occurredAt', 'type'];
  if (
    !isOpaqueId(rawEvent.missionId, 'mission_')
    || !isOpaqueId(rawEvent.executionId, 'execution_')
    || !Number.isSafeInteger(rawEvent.sequence)
    || (rawEvent.sequence as number) < 1
    || typeof rawEvent.occurredAt !== 'string'
    || !Number.isFinite(Date.parse(rawEvent.occurredAt))
  ) {
    throw new Error('execution_event_invalid');
  }

  const base = {
    missionId: rawEvent.missionId,
    executionId: rawEvent.executionId,
    sequence: rawEvent.sequence,
    occurredAt: rawEvent.occurredAt,
  };
  if (rawEvent.type === 'state') {
    if (
      !hasExactKeys(rawEvent, [...commonKeys, 'state', 'error', 'treeTermination'])
      || ![
        'queued', 'starting', 'running', 'stopping', 'succeeded', 'failed', 'stopped', 'timed_out',
      ].includes(rawEvent.state as string)
      || !(rawEvent.error === null || (
        typeof rawEvent.error === 'string' && rawEvent.error.length >= 1 && rawEvent.error.length <= 500
      ))
      || !['not-required', 'pending', 'confirmed', 'failed']
        .includes(rawEvent.treeTermination as string)
    ) {
      throw new Error('execution_event_invalid');
    }
    return Object.freeze({
      ...base,
      type: 'state' as const,
      state: rawEvent.state as Extract<RuntimeExecutionEvent, { type: 'state' }>['state'],
      error: rawEvent.error as string | null,
      treeTermination: rawEvent.treeTermination as Extract<RuntimeExecutionEvent, { type: 'state' }>['treeTermination'],
    }) as RuntimeExecutionEvent;
  }
  if (rawEvent.type === 'output') {
    if (
      !hasExactKeys(rawEvent, [...commonKeys, 'stream', 'text', 'truncated'])
      || !['status', 'stdout', 'stderr'].includes(rawEvent.stream as string)
      || typeof rawEvent.text !== 'string'
      || rawEvent.text.length < 1
      || rawEvent.text.length > 8_192
      || typeof rawEvent.truncated !== 'boolean'
    ) {
      throw new Error('execution_event_invalid');
    }
    return Object.freeze({
      ...base,
      type: 'output' as const,
      stream: rawEvent.stream,
      text: rawEvent.text,
      truncated: rawEvent.truncated,
    }) as RuntimeExecutionEvent;
  }
  if (rawEvent.type === 'artifact') {
    if (!hasExactKeys(rawEvent, [...commonKeys, 'artifact'])) {
      throw new Error('execution_event_invalid');
    }
    const artifact = normalizeRuntimeArtifact(rawEvent.artifact);
    return Object.freeze({
      ...base,
      type: 'artifact' as const,
      artifact,
    }) as RuntimeExecutionEvent;
  }
  throw new Error('execution_event_invalid');
}

function normalizeRuntimeArtifact(rawArtifact: unknown): RuntimeArtifact {
  if (
    !isPlainRecord(rawArtifact)
    || !hasExactKeys(rawArtifact, [
      'relativePath', 'change', 'size', 'sha256', 'scanStatus', 'provenance',
    ])
    || typeof rawArtifact.relativePath !== 'string'
    || rawArtifact.relativePath.length < 1
    || !isCanonicalRelativePath(rawArtifact.relativePath)
    || !['created', 'modified', 'deleted'].includes(rawArtifact.change as string)
    || !Number.isSafeInteger(rawArtifact.size)
    || (rawArtifact.size as number) < 0
    || (rawArtifact.size as number) > 1_000_000_000
    || !(rawArtifact.sha256 === null || (
      typeof rawArtifact.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(rawArtifact.sha256)
    ))
    || rawArtifact.scanStatus !== 'scanned'
    || rawArtifact.provenance !== 'runtime-workspace-scan'
    || (rawArtifact.change === 'deleted' && (
      rawArtifact.size !== 0 || rawArtifact.sha256 !== null
    ))
    || (rawArtifact.change !== 'deleted' && rawArtifact.sha256 === null)
  ) {
    throw new Error('execution_event_invalid');
  }
  return Object.freeze({
    relativePath: rawArtifact.relativePath,
    change: rawArtifact.change,
    size: rawArtifact.size,
    sha256: rawArtifact.sha256,
    scanStatus: 'scanned',
    provenance: 'runtime-workspace-scan',
  }) as RuntimeArtifact;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function isOpaqueId(value: unknown, prefix: string): value is string {
  return typeof value === 'string'
    && value.startsWith(prefix)
    && value.length <= 128
    && /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/u.test(value);
}

function isCanonicalRelativePath(value: string): boolean {
  if (value === '') return true;
  if (
    value.startsWith('/')
    || value.includes('\\')
    || value.includes(':')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return false;
  return value.split('/').every((segment) => (
    segment.length > 0 && segment !== '.' && segment !== '..'
  ));
}
