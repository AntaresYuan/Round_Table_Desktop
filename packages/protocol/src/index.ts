import type {
  ApprovalId,
  ExecutionId,
  LocalAgentProvider,
  LocalExecutionState,
  MissionId,
  opaqueIdBrand,
  TaskId,
  TurnId,
  WorkspaceId,
} from '@roundtable/domain';
import { z } from 'zod';
import {
  MACOS_HOST_RUNTIME_V1_CORPUS,
  MACOS_HOST_RUNTIME_V1_CORPUS_SHA256,
} from './generated/macos-host-runtime-v1-contract.js';

export {
  MACOS_HOST_RUNTIME_V1_CORPUS,
  MACOS_HOST_RUNTIME_V1_CORPUS_SHA256,
};

export const PROTOCOL_VERSION = MACOS_HOST_RUNTIME_V1_CORPUS.version;
export const HOST_RUNTIME_STATE_SCHEMA_VERSION = MACOS_HOST_RUNTIME_V1_CORPUS.hostRuntimeStateSchemaVersion;
const hostRuntimeClientNonceSchema = z.string().regex(
  new RegExp(MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.clientNoncePattern, 'u'),
);
const hostRuntimeSessionNonceSchema = z.string().regex(
  new RegExp(MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.sessionNoncePattern, 'u'),
);

export const hostRuntimeSessionOpenRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  clientNonce: hostRuntimeClientNonceSchema,
}).strict();

export const hostRuntimeSessionOpenResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionNonce: hostRuntimeSessionNonceSchema,
}).strict();

export const hostRuntimeSessionOpenFailureSchema = z.object({
  error: z.enum([
    MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.versionMismatchError,
    MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.malformedRequestError,
  ]),
}).strict();

export type HostRuntimeSessionOpenRequest = z.infer<typeof hostRuntimeSessionOpenRequestSchema>;
export type HostRuntimeSessionOpenResponse = z.infer<typeof hostRuntimeSessionOpenResponseSchema>;
export type HostRuntimeSessionOpenFailure = z.infer<typeof hostRuntimeSessionOpenFailureSchema>;
export type ProtocolOpaqueIdBrand = typeof opaqueIdBrand;

const turnStreamRequestBase = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().regex(/^request_[A-Za-z0-9._:-]+$/u).max(128),
  sessionNonce: hostRuntimeSessionNonceSchema,
};
const turnStreamIdSchema = z.string().regex(/^turnstream_[A-Za-z0-9._:-]+$/u).max(128);
export const hostRuntimeTurnStreamRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...turnStreamRequestBase, action: z.literal('start'),
    goal: z.string().min(1).max(12_000),
    workflowTemplateId: z.string().regex(/^wf-[A-Za-z0-9._:-]+$/u).max(128) }).strict(),
  z.object({ ...turnStreamRequestBase, action: z.literal('poll'),
    streamId: turnStreamIdSchema, afterSequence: z.number().int().nonnegative() }).strict(),
  ...(['approve', 'accept', 'stop'] as const).map((action) => z.object({
    ...turnStreamRequestBase, action: z.literal(action), streamId: turnStreamIdSchema,
  }).strict()),
]);
const hostRuntimeTurnSnapshotSchema = z.object({
  id: z.string().min(1).max(128), message: z.string().min(1).max(12_000), status: z.string().min(1).max(80),
}).passthrough();
export const hostRuntimeTurnStreamResponseSchema = z.union([
  z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), requestId: z.string().max(128),
    ok: z.literal(false), error: z.string().min(1).max(100) }).strict(),
  z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), requestId: z.string().max(128),
    ok: z.literal(true), streamId: turnStreamIdSchema,
    awaiting: z.enum(MACOS_HOST_RUNTIME_V1_CORPUS.turnStream.gates).nullable(),
    terminal: z.boolean(), frames: z.array(z.object({
      sequence: z.number().int().positive(),
      gate: z.enum(MACOS_HOST_RUNTIME_V1_CORPUS.turnStream.gates).nullable(),
      turn: hostRuntimeTurnSnapshotSchema,
    }).strict()).max(MACOS_HOST_RUNTIME_V1_CORPUS.turnStream.maxFrames) }).strict(),
]);
export type HostRuntimeTurnStreamRequest = z.infer<typeof hostRuntimeTurnStreamRequestSchema>;
export type HostRuntimeTurnStreamResponse = z.infer<typeof hostRuntimeTurnStreamResponseSchema>;

const idSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/);
const opaqueIdSchema = <T extends string>() => idSchema.transform((value): T => value as T);

export const workspaceIdSchema = opaqueIdSchema<WorkspaceId>();
export const missionIdSchema = opaqueIdSchema<MissionId>();
export const turnIdSchema = opaqueIdSchema<TurnId>();
export const taskIdSchema = opaqueIdSchema<TaskId>();
export const executionIdSchema = opaqueIdSchema<ExecutionId>();
export const approvalIdSchema = opaqueIdSchema<ApprovalId>();

const timestampSchema = z.string().datetime({ offset: true });
const sourceSchema = z.enum([
  'renderer',
  'main',
  'runtime',
  'orchestrator',
  'storage',
  'web',
  'cli',
]);
const messageNameSchema = z.string()
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/);
const scopeSchema = z.object({
  workspaceId: workspaceIdSchema.optional(),
  missionId: missionIdSchema.optional(),
  turnId: turnIdSchema.optional(),
  taskId: taskIdSchema.optional(),
  executionId: executionIdSchema.optional(),
}).strict();
const commonEnvelopeShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: idSchema,
  correlationId: idSchema,
  causationId: idSchema.optional(),
  occurredAt: timestampSchema,
  source: sourceSchema,
  scope: scopeSchema,
};

/** Structural wire validation only. Receivers must inject trusted source/actor data. */
export const commandEnvelopeSchema = z.object({
  ...commonEnvelopeShape,
  kind: z.literal('command'),
  name: messageNameSchema,
  idempotencyKey: idSchema,
  payload: z.record(z.unknown()),
}).strict();

/** Structural wire validation only. Renderer-supplied envelopes are never authorization. */
export const eventEnvelopeSchema = z.object({
  ...commonEnvelopeShape,
  kind: z.literal('event'),
  name: messageNameSchema,
  aggregate: z.object({
    kind: z.enum(['workspace', 'mission', 'turn', 'task', 'execution', 'system']),
    id: idSchema,
    sequence: z.number().int().positive(),
  }).strict(),
  durability: z.enum(['durable', 'ephemeral']),
  payload: z.record(z.unknown()),
}).strict().superRefine((event, context) => {
  if (event.aggregate.kind === 'system') return;
  const scopeId = {
    workspace: event.scope.workspaceId,
    mission: event.scope.missionId,
    turn: event.scope.turnId,
    task: event.scope.taskId,
    execution: event.scope.executionId,
  }[event.aggregate.kind];
  if (scopeId !== event.aggregate.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Aggregate identity must match its scoped identity',
      path: ['aggregate', 'id'],
    });
  }
});

export const systemGetInfoQuerySchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  kind: z.literal('query'),
  name: z.literal('system.getInfo'),
  messageId: idSchema,
  correlationId: idSchema,
  occurredAt: timestampSchema,
  source: sourceSchema,
  payload: z.object({}).strict(),
}).strict();

export const systemGetInfoResultSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  kind: z.literal('result'),
  name: z.literal('system.getInfo'),
  messageId: idSchema,
  correlationId: idSchema,
  requestId: idSchema,
  occurredAt: timestampSchema,
  source: sourceSchema,
  payload: z.object({
    product: z.literal('roundtable'),
    applicationVersion: z.string().min(1).max(80),
    runtime: z.enum(['desktop-main', 'web', 'cli', 'test']),
    capabilities: z.array(messageNameSchema).max(100),
  }).strict(),
}).strict();

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type SystemGetInfoQuery = z.infer<typeof systemGetInfoQuerySchema>;
export type SystemGetInfoResult = z.infer<typeof systemGetInfoResultSchema>;

export const DESKTOP_IPC_CHANNELS = Object.freeze({
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

export type DesktopSystemInfo = {
  product: 'roundtable';
  applicationVersion: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  platform: 'darwin' | 'linux' | 'win32';
  architecture: 'arm64' | 'ia32' | 'x64';
  electronVersion: string;
  capabilities: string[];
};

export type WorkspaceSummary = {
  id: WorkspaceId;
  name: string;
};

export type WorkspaceSelection =
  | { selected: false }
  | { selected: true; workspace: WorkspaceSummary };

export type WorkspaceListEntriesInput = {
  workspaceId: WorkspaceId;
  relativePath: string;
};

export type WorkspaceEntry = {
  name: string;
  relativePath: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
};

export type WorkspaceEntries = {
  workspace: WorkspaceSummary;
  relativePath: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
};

export const desktopSystemInfoSchema = z.object({
  product: z.literal('roundtable'),
  applicationVersion: z.string().min(1).max(80),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  platform: z.enum(['darwin', 'linux', 'win32']),
  architecture: z.enum(['arm64', 'ia32', 'x64']),
  electronVersion: z.string().min(1).max(40),
  capabilities: z.array(messageNameSchema).max(100),
}).strict();

export const hostRuntimeAvailabilityStateSchema = z.enum(
  MACOS_HOST_RUNTIME_V1_CORPUS.runtimeAvailabilityStates,
);

export const hostRuntimeAvailabilityReasonSchema = z.enum(
  MACOS_HOST_RUNTIME_V1_CORPUS.runtimeAvailabilityReasons,
);

export const hostRuntimeAdmissionStateSchema = z.enum(
  MACOS_HOST_RUNTIME_V1_CORPUS.runtimeAdmissionStates,
);

export const hostRuntimeAvailabilitySchema = z.object({
  state: hostRuntimeAvailabilityStateSchema,
  reason: hostRuntimeAvailabilityReasonSchema,
  admission: hostRuntimeAdmissionStateSchema,
  supportedStateVersion: z.literal(HOST_RUNTIME_STATE_SCHEMA_VERSION),
}).strict().superRefine((availability, context) => {
  const tupleKey = `${availability.state}|${availability.reason}|${availability.admission}`;
  if (!MACOS_HOST_RUNTIME_V1_CORPUS.runtimeAvailabilityTupleKeys.some((allowed) => allowed === tupleKey)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Runtime availability state, reason, and admission must form a canonical tuple',
      path: ['state'],
    });
  }
});

export const hostRuntimeSystemStatusSchema = z.object({
  product: z.literal('roundtable'),
  applicationVersion: z.string().min(1).max(80),
  platform: z.enum(['darwin', 'linux', 'win32']),
  architecture: z.enum(['arm64', 'ia32', 'x64']),
  capabilities: z.array(messageNameSchema).max(100),
  runtimeAvailability: hostRuntimeAvailabilitySchema,
}).strict();

export type HostRuntimeAvailability = z.infer<typeof hostRuntimeAvailabilitySchema>;
export type HostRuntimeSystemStatus = z.infer<typeof hostRuntimeSystemStatusSchema>;

export const workspaceSummarySchema = z.object({
  id: workspaceIdSchema,
  name: z.string().min(1).max(255),
}).strict();

export const workspaceSelectionSchema = z.discriminatedUnion('selected', [
  z.object({ selected: z.literal(false) }).strict(),
  z.object({
    selected: z.literal(true),
    workspace: workspaceSummarySchema,
  }).strict(),
]);

export const workspaceRelativePathSchema = z.string().max(512).refine((value) => {
  if (value === '') return true;
  if (
    value.startsWith('/')
    || value.includes('\\')
    || value.includes(':')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return false;

  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}, 'Path must be a canonical POSIX workspace-relative path');

export const workspaceListEntriesInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  relativePath: workspaceRelativePathSchema,
}).strict();

export const workspaceEntryNameSchema = z.string().min(1).max(255).refine((value) => (
  value !== '.'
  && value !== '..'
  && !value.includes('/')
  && !value.includes('\\')
  && !value.includes(':')
  && !/[\u0000-\u001f\u007f]/u.test(value)
), 'Entry name must be one portable path component');

export const workspaceEntrySchema = z.object({
  name: workspaceEntryNameSchema,
  relativePath: workspaceRelativePathSchema,
  kind: z.enum(['directory', 'file', 'symlink', 'other']),
}).strict().superRefine((entry, context) => {
  const finalSegment = entry.relativePath.split('/').at(-1);
  if (finalSegment !== entry.name) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Entry name must match the final relative path segment',
      path: ['relativePath'],
    });
  }
});

export const workspaceEntriesSchema = z.object({
  workspace: workspaceSummarySchema,
  relativePath: workspaceRelativePathSchema,
  entries: z.array(workspaceEntrySchema).max(500),
  truncated: z.boolean(),
}).strict().superRefine((listing, context) => {
  listing.entries.forEach((entry, index) => {
    const expectedPath = listing.relativePath === ''
      ? entry.name
      : `${listing.relativePath}/${entry.name}`;
    if (entry.relativePath !== expectedPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Entry relative path must be a direct child of the listed directory',
        path: ['entries', index, 'relativePath'],
      });
    }
  });
});

export const localAgentProviderSchema = z.enum(['codex', 'claude-code', 'opencode']);
export const localExecutionStateSchema = z.enum([
  'queued',
  'starting',
  'running',
  'stopping',
  'succeeded',
  'failed',
  'stopped',
  'timed_out',
]);
export const runtimeSandboxLevelSchema = z.enum([
  'workspace-os-sandbox',
  'provider-permissions',
]);

export const runtimeProviderPolicySchema = z.object({
  adapterVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,39}$/u),
  sandbox: runtimeSandboxLevelSchema,
  workspaceWrite: z.literal(true),
  externalFileAccess: z.enum(['os-denied', 'provider-denied', 'not-guaranteed']),
  projectCustomizations: z.enum(['enabled', 'disabled']),
  network: z.enum(['provider-required', 'provider-and-tools']),
  secrets: z.literal('provider-scoped'),
  timeoutMs: z.number().int().min(1_000).max(7_200_000),
}).strict();

export const runtimeCatalogEntrySchema = z.object({
  provider: localAgentProviderSchema,
  label: z.string().min(1).max(80),
  available: z.boolean(),
  version: z.string().min(1).max(160).nullable(),
  installHint: z.string().min(1).max(500),
  policy: runtimeProviderPolicySchema,
  warnings: z.array(z.string().min(1).max(500)).max(10),
}).strict();

export const runtimeCatalogSchema = z.object({
  providers: z.array(runtimeCatalogEntrySchema).length(3),
}).strict().superRefine((catalog, context) => {
  const providers = new Set(catalog.providers.map((entry) => entry.provider));
  if (providers.size !== catalog.providers.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Runtime catalog providers must be unique',
      path: ['providers'],
    });
  }
});

export const missionPrepareInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  provider: localAgentProviderSchema,
  prompt: z.string().trim().min(1).max(12_000),
}).strict();

export const missionApprovalPreviewSchema = z.object({
  approvalId: approvalIdSchema,
  missionId: missionIdSchema,
  workspace: workspaceSummarySchema,
  provider: localAgentProviderSchema,
  prompt: z.string().min(1).max(12_000),
  policy: runtimeProviderPolicySchema,
  warnings: z.array(z.string().min(1).max(500)).max(10),
  expiresAt: timestampSchema,
}).strict();

export const missionApproveInputSchema = z.object({
  approvalId: approvalIdSchema,
}).strict();

const workspaceIdentitySchema = z.object({
  root: z.string().min(1).max(4096),
  device: z.string().regex(/^[0-9]+$/u),
  inode: z.string().regex(/^[0-9]+$/u),
}).strict();

const reviewHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const reviewEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('directory'),
    mode: z.number().int().nonnegative().max(0o7777),
  }).strict(),
  z.object({
    kind: z.literal('file'),
    mode: z.number().int().nonnegative().max(0o7777),
    size: z.number().int().nonnegative().max(2 * 1024 * 1024),
    sha256: reviewHashSchema,
  }).strict(),
]);
export const reviewBundleSchema = z.object({
  version: z.literal(1),
  bundleId: idSchema.regex(/^review_[a-f0-9]{32}$/u),
  executionId: executionIdSchema,
  workspaceId: workspaceIdSchema,
  workspace: workspaceIdentitySchema,
  staging: workspaceIdentitySchema,
  protectedDirectoryNames: z.array(workspaceEntryNameSchema).max(32),
  protectedPaths: z.array(workspaceRelativePathSchema).max(512),
  baselineHash: reviewHashSchema,
  resultHash: reviewHashSchema,
  changes: z.array(z.object({
    relativePath: workspaceRelativePathSchema,
    change: z.enum(['created', 'modified', 'deleted']),
    before: reviewEntrySchema.nullable(),
    after: reviewEntrySchema.nullable(),
  }).strict().superRefine((change, context) => {
    const validShape = change.change === 'created'
      ? change.before === null && change.after !== null
      : change.change === 'deleted'
        ? change.before !== null && change.after === null
        : change.before !== null && change.after !== null;
    if (!validShape) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Review change must match its before/after shape',
        path: ['change'],
      });
    }
  })).max(5_000),
  contentHash: reviewHashSchema,
}).strict();

export const applyChallengeSchema = z.object({
  applyId: idSchema.regex(/^apply_[A-Za-z0-9._:-]+$/u),
  bundleId: idSchema.regex(/^review_[a-f0-9]{32}$/u),
  executionId: executionIdSchema,
  workspaceId: workspaceIdSchema,
  baselineHash: reviewHashSchema,
  contentHash: reviewHashSchema,
  expiresAt: timestampSchema,
}).strict();

export const reviewPrepareInputSchema = z.object({
  bundle: reviewBundleSchema,
}).strict();
export const reviewExecutionInputSchema = z.object({
  executionId: executionIdSchema,
  workspaceId: workspaceIdSchema,
}).strict();
export const applyChallengeInputSchema = z.object({
  applyId: idSchema.regex(/^apply_[A-Za-z0-9._:-]+$/u),
}).strict();

export const executionGetInputSchema = z.object({
  executionId: executionIdSchema,
}).strict();

export const executionStopInputSchema = executionGetInputSchema;

export const runtimeArtifactSchema = z.object({
  relativePath: workspaceRelativePathSchema.refine((value) => value.length > 0),
  change: z.enum(['created', 'modified', 'deleted']),
  size: z.number().int().nonnegative().max(1_000_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  scanStatus: z.literal('scanned'),
  provenance: z.literal('runtime-workspace-scan'),
}).strict().superRefine((artifact, context) => {
  if (artifact.change === 'deleted' && (artifact.size !== 0 || artifact.sha256 !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Deleted artifacts must not claim current content metadata',
      path: ['change'],
    });
  }
  if (artifact.change !== 'deleted' && artifact.sha256 === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Created and modified artifacts require a complete content hash',
      path: ['sha256'],
    });
  }
});

export const runtimeLogEntrySchema = z.object({
  sequence: z.number().int().positive(),
  occurredAt: timestampSchema,
  stream: z.enum(['status', 'stdout', 'stderr']),
  text: z.string().min(1).max(8_192),
}).strict();

export const processTreeTerminationSchema = z.enum([
  'not-required',
  'pending',
  'confirmed',
  'failed',
]);

export const runtimeExecutionSnapshotSchema = z.object({
  missionId: missionIdSchema,
  executionId: executionIdSchema,
  workspace: workspaceSummarySchema,
  provider: localAgentProviderSchema,
  state: localExecutionStateSchema,
  sequence: z.number().int().nonnegative(),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  error: z.string().min(1).max(500).nullable(),
  summary: z.string().max(16_000),
  treeTermination: processTreeTerminationSchema,
  logs: z.array(runtimeLogEntrySchema).max(256),
  artifacts: z.array(runtimeArtifactSchema).max(200),
}).strict().superRefine((snapshot, context) => {
  const terminal = ['succeeded', 'failed', 'stopped', 'timed_out'].includes(snapshot.state);
  if (terminal !== (snapshot.finishedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only terminal executions have a finishedAt timestamp',
      path: ['finishedAt'],
    });
  }
  if (snapshot.logs.some((entry) => entry.sequence > snapshot.sequence)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Log sequence cannot exceed the snapshot sequence',
      path: ['logs'],
    });
  }
  if (snapshot.state === 'stopping' && snapshot.treeTermination !== 'pending') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stopping executions must have pending tree termination',
      path: ['treeTermination'],
    });
  }
  if (
    snapshot.state === 'stopped'
    && !['confirmed', 'failed'].includes(snapshot.treeTermination)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stopped executions require an explicit tree termination result',
      path: ['treeTermination'],
    });
  }
});

const runtimeExecutionEventBase = {
  missionId: missionIdSchema,
  executionId: executionIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: timestampSchema,
};

export const runtimeExecutionEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...runtimeExecutionEventBase,
    type: z.literal('state'),
    state: localExecutionStateSchema,
    error: z.string().min(1).max(500).nullable(),
    treeTermination: processTreeTerminationSchema,
  }).strict(),
  z.object({
    ...runtimeExecutionEventBase,
    type: z.literal('output'),
    stream: z.enum(['status', 'stdout', 'stderr']),
    text: z.string().min(1).max(8_192),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    ...runtimeExecutionEventBase,
    type: z.literal('artifact'),
    artifact: runtimeArtifactSchema,
  }).strict(),
]);

export const missionExecutionAcceptedSchema = z.object({
  missionId: missionIdSchema,
  executionId: executionIdSchema,
  state: localExecutionStateSchema,
}).strict();

export type RuntimeCatalog = z.infer<typeof runtimeCatalogSchema>;
export type RuntimeCatalogEntry = z.infer<typeof runtimeCatalogEntrySchema>;
export type MissionPrepareInput = z.infer<typeof missionPrepareInputSchema>;
export type MissionApprovalPreview = z.infer<typeof missionApprovalPreviewSchema>;
export type MissionApproveInput = z.infer<typeof missionApproveInputSchema>;
export type ReviewBundle = z.infer<typeof reviewBundleSchema>;
export type ApplyChallenge = z.infer<typeof applyChallengeSchema>;
export type ReviewPrepareInput = z.infer<typeof reviewPrepareInputSchema>;
export type ReviewExecutionInput = z.infer<typeof reviewExecutionInputSchema>;
export type ApplyChallengeInput = z.infer<typeof applyChallengeInputSchema>;
export type MissionExecutionAccepted = z.infer<typeof missionExecutionAcceptedSchema>;
export type ExecutionGetInput = z.infer<typeof executionGetInputSchema>;
export type ExecutionStopInput = z.infer<typeof executionStopInputSchema>;
export type RuntimeArtifact = z.infer<typeof runtimeArtifactSchema>;
export type RuntimeLogEntry = z.infer<typeof runtimeLogEntrySchema>;
export type RuntimeExecutionSnapshot = z.infer<typeof runtimeExecutionSnapshotSchema>;
export type RuntimeExecutionEvent = z.infer<typeof runtimeExecutionEventSchema>;
export type RuntimeProviderPolicy = z.infer<typeof runtimeProviderPolicySchema>;

// Keep the domain aliases visible at the protocol boundary without creating a
// second set of provider/state literals.
export type ProtocolLocalAgentProvider = LocalAgentProvider;
export type ProtocolLocalExecutionState = LocalExecutionState;

export type DesktopBridge = {
  getSystemInfo(): Promise<DesktopSystemInfo>;
  selectWorkspace(): Promise<WorkspaceSelection>;
  listWorkspaceEntries(input: WorkspaceListEntriesInput): Promise<WorkspaceEntries>;
  getRuntimeCatalog(): Promise<RuntimeCatalog>;
  prepareMission(input: MissionPrepareInput): Promise<MissionApprovalPreview>;
  approveMission(input: MissionApproveInput): Promise<MissionExecutionAccepted>;
  getExecution(input: ExecutionGetInput): Promise<RuntimeExecutionSnapshot>;
  stopExecution(input: ExecutionStopInput): Promise<RuntimeExecutionSnapshot>;
  onExecutionEvent(listener: (event: RuntimeExecutionEvent) => void): () => void;
  beginReview?(input: ReviewExecutionInput): Promise<{ started: true }>;
  inspectReview?(input: ReviewExecutionInput): Promise<ReviewBundle>;
  prepareReview?(input: ReviewPrepareInput): Promise<ApplyChallenge>;
  authorizeApply?(input: ApplyChallengeInput): Promise<{ applied: true }>;
  rejectApply?(input: ApplyChallengeInput): Promise<{ rejected: true }>;
};
