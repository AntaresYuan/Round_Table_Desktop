/**
 * Narrow control protocol for a future dedicated-UID macOS service.
 *
 * This module does not implement the privileged service, XPC transport, audit
 * token verification, code-signing verification, or descriptor passing. A
 * production broker adapter must provide those OS-backed properties before the
 * capability evaluator can enable real-provider execution.
 */

import {
  MACOS_SERVICE_UID_V1_CORPUS,
  MACOS_SERVICE_UID_V1_CORPUS_SHA256,
} from './generated/macos-service-uid-v1-contract.js';

export { MACOS_SERVICE_UID_V1_CORPUS, MACOS_SERVICE_UID_V1_CORPUS_SHA256 };

export const MACOS_SERVICE_UID_BACKEND = MACOS_SERVICE_UID_V1_CORPUS.contract;
export const MACOS_SERVICE_UID_MACH_SERVICE =
  'com.roundtable.runtime.service-uid-v1' as const;
export const MACOS_SERVICE_UID_PROTOCOL_VERSION = MACOS_SERVICE_UID_V1_CORPUS.version;
export const MACOS_SERVICE_UID_MAX_CONCURRENCY = MACOS_SERVICE_UID_V1_CORPUS.maxConcurrency;
export const MACOS_SERVICE_UID_SECRET_TRANSPORT = MACOS_SERVICE_UID_V1_CORPUS.secretTransport;
export const MACOS_SERVICE_UID_SECRET_FD_XPC_KEY = 'secretChannelFd' as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}[A-Za-z0-9]$/u;
const SHORT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}[A-Za-z0-9]$/u;
const MAX_PROCESS_DESCRIPTOR = 2_147_483_647;

export type MacOsServiceUidDeployment = 'production' | 'development';

export type MacOsServiceUidWorkload =
  | {
    kind: 'provider';
    provider: 'codex' | 'claude-code';
  }
  | {
    kind: 'fixture';
    fixture: 'lifecycle-v1';
  };

export type MacOsServiceUidWorkspaceGrant = {
  grantId: string;
  revision: number;
};

export type MacOsServiceUidSecretChannel = {
  channelId: string;
  transport: 'inherited-fd';
  fdIndex: 0;
  consumption: 'once';
};

type BrokerRequestBase = {
  backend: typeof MACOS_SERVICE_UID_BACKEND;
  protocolVersion: typeof MACOS_SERVICE_UID_PROTOCOL_VERSION;
  requestId: string;
};

export type MacOsServiceUidPrepareRequest = BrokerRequestBase & {
  type: 'prepare';
  leaseId: string;
  executionId: string;
  workload: MacOsServiceUidWorkload;
  workspaceGrant: MacOsServiceUidWorkspaceGrant;
  secretChannel: MacOsServiceUidSecretChannel;
};

export type MacOsServiceUidStartRequest = BrokerRequestBase & {
  type: 'start';
  leaseId: string;
  executionId: string;
  preparationId: string;
};

export type MacOsServiceUidStopRequest = BrokerRequestBase & {
  type: 'stop';
  leaseId: string;
  executionId: string;
  reason: 'requested' | 'shutdown' | 'timeout';
};

export type MacOsServiceUidStatusRequest = BrokerRequestBase & {
  type: 'status';
};

export type MacOsServiceUidCleanupRequest = BrokerRequestBase & {
  type: 'cleanup';
  leaseId: string;
  executionId: string;
  disposition: 'terminate-and-scrub';
};

export type MacOsServiceUidBrokerRequest =
  | MacOsServiceUidPrepareRequest
  | MacOsServiceUidStartRequest
  | MacOsServiceUidStopRequest
  | MacOsServiceUidStatusRequest
  | MacOsServiceUidCleanupRequest;

/**
 * Descriptor numbers are transport metadata, not secret bytes. A production
 * adapter must transfer a duplicate out of band (for example with XPC descriptor
 * passing under `MACOS_SERVICE_UID_SECRET_FD_XPC_KEY`), close that duplicate
 * after the service consumes it, and never serialize the secret into the
 * request, argv, a plist, or a filesystem path.
 */
export type MacOsServiceUidBrokerTransfer = {
  kind: 'inherited-fd';
  channelId: string;
  descriptors: readonly [number];
};

export type MacOsServiceUidPeerEvidence =
  | {
    backend: typeof MACOS_SERVICE_UID_BACKEND;
    protocolVersion: typeof MACOS_SERVICE_UID_PROTOCOL_VERSION;
    deployment: 'production';
    serviceInstanceId: string;
    brokerUid: number;
    executionUid: number;
    maxConcurrency: typeof MACOS_SERVICE_UID_MAX_CONCURRENCY;
    secretTransport: typeof MACOS_SERVICE_UID_SECRET_TRANSPORT;
    authentication: {
      kind: 'xpc-audit-token';
    };
    codeIdentity: {
      status: 'verified';
      teamIdentifier: string;
      designatedRequirement: string;
    };
  }
  | {
    backend: typeof MACOS_SERVICE_UID_BACKEND;
    protocolVersion: typeof MACOS_SERVICE_UID_PROTOCOL_VERSION;
    deployment: 'development';
    serviceInstanceId: string;
    brokerUid: number;
    executionUid: number;
    maxConcurrency: typeof MACOS_SERVICE_UID_MAX_CONCURRENCY;
    secretTransport: typeof MACOS_SERVICE_UID_SECRET_TRANSPORT;
    authentication: {
      kind: 'development-test-double';
    };
    codeIdentity: {
      status: 'unverified';
    };
  };

export type MacOsServiceUidRemoteSeat =
  | {
    state: 'idle';
    leaseId: null;
    executionId: null;
  }
  | {
    state: 'prepared';
    leaseId: string;
    executionId: string;
  }
  | {
    state: 'running';
    leaseId: string;
    executionId: string;
  }
  | {
    state: 'stopped';
    leaseId: string;
    executionId: string;
  }
  | {
    state: 'quarantined';
    leaseId: string;
    executionId: string;
  };

export type MacOsServiceUidBrokerErrorCode =
  | 'seat_busy'
  | 'lease_invalid'
  | 'workspace_grant_invalid'
  | 'workload_invalid'
  | 'secret_channel_invalid'
  | 'cleanup_unconfirmed'
  | 'internal_failure'
  | 'unauthorized'
  | 'invalid_request';

type BrokerResponseBase = {
  backend: typeof MACOS_SERVICE_UID_BACKEND;
  protocolVersion: typeof MACOS_SERVICE_UID_PROTOCOL_VERSION;
  requestId: string;
  serviceInstanceId: string;
  brokerUid: number;
  executionUid: number;
};

export type MacOsServiceUidBrokerFailure = BrokerResponseBase & {
  type: MacOsServiceUidBrokerRequest['type'];
  ok: false;
  error: MacOsServiceUidBrokerErrorCode;
  seat: MacOsServiceUidRemoteSeat;
};

export type MacOsServiceUidStatusSuccess = BrokerResponseBase & {
  type: 'status';
  ok: true;
  maxConcurrency: typeof MACOS_SERVICE_UID_MAX_CONCURRENCY;
  secretTransport: typeof MACOS_SERVICE_UID_SECRET_TRANSPORT;
  seat: MacOsServiceUidRemoteSeat;
};

/** The broker derives preparationId from the unique prepare requestId; callers
 * cannot choose or replay a second preparation handle. */
export type MacOsServiceUidPrepareSuccess = BrokerResponseBase & {
  type: 'prepare';
  ok: true;
  leaseId: string;
  executionId: string;
  preparationId: string;
  secretChannelState: 'consumed';
  seat: Extract<MacOsServiceUidRemoteSeat, { state: 'prepared' }>;
};

export type MacOsServiceUidStartSuccess = BrokerResponseBase & {
  type: 'start';
  ok: true;
  leaseId: string;
  executionId: string;
  runId: string;
  seat: Extract<MacOsServiceUidRemoteSeat, { state: 'running' }>;
};

/**
 * `seatUidProcessState` is a fact about the broker's fixed execution UID, never
 * a caller-selected UID. A seat may be reused only when both the tracked tree
 * and this outer UID-wide check are conclusive.
 */
export type MacOsServiceUidStopSuccess = BrokerResponseBase & {
  type: 'stop';
  ok: true;
  leaseId: string;
  executionId: string;
  treeTermination: 'confirmed' | 'failed';
  seatUidProcessState: 'empty' | 'nonempty-or-unknown';
  seat: Extract<MacOsServiceUidRemoteSeat, { state: 'stopped' | 'quarantined' }>;
};

export type MacOsServiceUidCleanupSuccess = BrokerResponseBase & {
  type: 'cleanup';
  ok: true;
  leaseId: string;
  executionId: string;
  treeTermination: 'confirmed' | 'failed';
  seatUidProcessState: 'empty' | 'nonempty-or-unknown';
  secretResidue: 'absent' | 'unknown';
  seat: MacOsServiceUidRemoteSeat;
};

export type MacOsServiceUidBrokerSuccess =
  | MacOsServiceUidStatusSuccess
  | MacOsServiceUidPrepareSuccess
  | MacOsServiceUidStartSuccess
  | MacOsServiceUidStopSuccess
  | MacOsServiceUidCleanupSuccess;

export type MacOsServiceUidBrokerResponse =
  | MacOsServiceUidBrokerFailure
  | MacOsServiceUidBrokerSuccess;

export type MacOsServiceUidBroker = {
  /**
   * Production evidence MUST be derived from the connected peer's audit token
   * and code requirement by the transport adapter. A JSON response is not peer
   * attestation. No production adapter exists in this package yet.
   */
  attestPeer(): Promise<unknown>;
  request(
    request: MacOsServiceUidBrokerRequest,
    transfer?: MacOsServiceUidBrokerTransfer,
  ): Promise<unknown>;
};

export function parseMacOsServiceUidPeerEvidence(
  value: unknown,
): MacOsServiceUidPeerEvidence {
  const input = objectRecord(value);
  const deployment = enumValue(input.deployment, ['production', 'development'] as const);
  exactKeys(input, [
    'backend',
    'protocolVersion',
    'deployment',
    'serviceInstanceId',
    'brokerUid',
    'executionUid',
    'maxConcurrency',
    'secretTransport',
    'authentication',
    'codeIdentity',
  ]);
  assertCommonServiceFields(input);
  if (deployment === 'production') {
    const authentication = objectRecord(input.authentication);
    exactKeys(authentication, ['kind']);
    literal(authentication.kind, 'xpc-audit-token');
    const codeIdentity = objectRecord(input.codeIdentity);
    exactKeys(codeIdentity, [
      'status',
      'teamIdentifier',
      'designatedRequirement',
    ]);
    literal(codeIdentity.status, 'verified');
    return {
      backend: MACOS_SERVICE_UID_BACKEND,
      protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
      deployment,
      serviceInstanceId: identifier(input.serviceInstanceId),
      brokerUid: uid(input.brokerUid),
      executionUid: uid(input.executionUid),
      maxConcurrency: MACOS_SERVICE_UID_MAX_CONCURRENCY,
      secretTransport: MACOS_SERVICE_UID_SECRET_TRANSPORT,
      authentication: { kind: 'xpc-audit-token' },
      codeIdentity: {
        status: 'verified',
        teamIdentifier: shortIdentifier(codeIdentity.teamIdentifier),
        designatedRequirement: boundedText(codeIdentity.designatedRequirement, 1_024),
      },
    };
  }

  const authentication = objectRecord(input.authentication);
  exactKeys(authentication, ['kind']);
  literal(authentication.kind, 'development-test-double');
  const codeIdentity = objectRecord(input.codeIdentity);
  exactKeys(codeIdentity, ['status']);
  literal(codeIdentity.status, 'unverified');
  return {
    backend: MACOS_SERVICE_UID_BACKEND,
    protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
    deployment,
    serviceInstanceId: identifier(input.serviceInstanceId),
    brokerUid: uid(input.brokerUid),
    executionUid: uid(input.executionUid),
    maxConcurrency: MACOS_SERVICE_UID_MAX_CONCURRENCY,
    secretTransport: MACOS_SERVICE_UID_SECRET_TRANSPORT,
    authentication: { kind: 'development-test-double' },
    codeIdentity: { status: 'unverified' },
  };
}

export function parseMacOsServiceUidBrokerRequest(
  value: unknown,
): MacOsServiceUidBrokerRequest {
  const input = objectRecord(value);
  assertRequestBase(input);
  const type = enumValue(input.type, [
    'prepare',
    'start',
    'stop',
    'status',
    'cleanup',
  ] as const);

  if (type === 'status') {
    exactKeys(input, ['backend', 'protocolVersion', 'requestId', 'type']);
    return requestBase(input, type);
  }
  if (type === 'prepare') {
    exactKeys(input, [
      'backend',
      'protocolVersion',
      'requestId',
      'type',
      'leaseId',
      'executionId',
      'workload',
      'workspaceGrant',
      'secretChannel',
    ]);
    return {
      ...requestBase(input, type),
      leaseId: identifier(input.leaseId),
      executionId: identifier(input.executionId),
      workload: parseWorkload(input.workload),
      workspaceGrant: parseWorkspaceGrant(input.workspaceGrant),
      secretChannel: parseSecretChannel(input.secretChannel),
    };
  }
  if (type === 'start') {
    exactKeys(input, [
      'backend',
      'protocolVersion',
      'requestId',
      'type',
      'leaseId',
      'executionId',
      'preparationId',
    ]);
    return {
      ...requestBase(input, type),
      leaseId: identifier(input.leaseId),
      executionId: identifier(input.executionId),
      preparationId: identifier(input.preparationId),
    };
  }
  if (type === 'stop') {
    exactKeys(input, [
      'backend',
      'protocolVersion',
      'requestId',
      'type',
      'leaseId',
      'executionId',
      'reason',
    ]);
    return {
      ...requestBase(input, type),
      leaseId: identifier(input.leaseId),
      executionId: identifier(input.executionId),
      reason: enumValue(input.reason, ['requested', 'shutdown', 'timeout'] as const),
    };
  }

  exactKeys(input, [
    'backend',
    'protocolVersion',
    'requestId',
    'type',
    'leaseId',
    'executionId',
    'disposition',
  ]);
  literal(input.disposition, 'terminate-and-scrub');
  return {
    ...requestBase(input, type),
    leaseId: identifier(input.leaseId),
    executionId: identifier(input.executionId),
    disposition: 'terminate-and-scrub',
  };
}

export function parseMacOsServiceUidBrokerTransfer(
  value: unknown,
): MacOsServiceUidBrokerTransfer {
  const input = objectRecord(value);
  exactKeys(input, ['kind', 'channelId', 'descriptors']);
  literal(input.kind, 'inherited-fd');
  if (!Array.isArray(input.descriptors) || input.descriptors.length !== 1) {
    throw new Error('macos_service_uid_protocol_invalid');
  }
  const descriptor = input.descriptors[0];
  if (
    !Number.isSafeInteger(descriptor)
    || typeof descriptor !== 'number'
    || descriptor < 3
    || descriptor > MAX_PROCESS_DESCRIPTOR
  ) throw new Error('macos_service_uid_protocol_invalid');
  return {
    kind: 'inherited-fd',
    channelId: identifier(input.channelId),
    descriptors: [descriptor],
  };
}

export function parseMacOsServiceUidBrokerResponse(
  value: unknown,
  request: MacOsServiceUidBrokerRequest,
): MacOsServiceUidBrokerResponse {
  const input = objectRecord(value);
  const type = enumValue(input.type, [
    'prepare',
    'start',
    'stop',
    'status',
    'cleanup',
  ] as const);
  if (type !== request.type) throw new Error('macos_service_uid_protocol_invalid');
  const ok = booleanValue(input.ok);

  if (!ok) {
    const base = responseBase(input, request, type);
    exactKeys(input, [
      'backend',
      'protocolVersion',
      'requestId',
      'serviceInstanceId',
      'brokerUid',
      'executionUid',
      'type',
      'ok',
      'error',
      'seat',
    ]);
    return {
      ...base,
      ok: false,
      error: enumValue(input.error, [
        'seat_busy',
        'lease_invalid',
        'workspace_grant_invalid',
        'workload_invalid',
        'secret_channel_invalid',
        'cleanup_unconfirmed',
        'internal_failure',
        'unauthorized',
        'invalid_request',
      ] as const),
      seat: parseRemoteSeat(input.seat),
    };
  }

  if (type === 'status') {
    const base = responseBase(input, request, 'status');
    exactKeys(input, [
      'backend',
      'protocolVersion',
      'requestId',
      'serviceInstanceId',
      'brokerUid',
      'executionUid',
      'type',
      'ok',
      'maxConcurrency',
      'secretTransport',
      'seat',
    ]);
    literal(input.maxConcurrency, MACOS_SERVICE_UID_MAX_CONCURRENCY);
    literal(input.secretTransport, MACOS_SERVICE_UID_SECRET_TRANSPORT);
    return {
      ...base,
      ok: true,
      maxConcurrency: MACOS_SERVICE_UID_MAX_CONCURRENCY,
      secretTransport: MACOS_SERVICE_UID_SECRET_TRANSPORT,
      seat: parseRemoteSeat(input.seat),
    };
  }
  if (type === 'prepare') {
    const base = responseBase(input, request, 'prepare');
    exactKeys(input, [
      'backend',
      'protocolVersion',
      'requestId',
      'serviceInstanceId',
      'brokerUid',
      'executionUid',
      'type',
      'ok',
      'leaseId',
      'executionId',
      'preparationId',
      'secretChannelState',
      'seat',
    ]);
    literal(input.secretChannelState, 'consumed');
    return {
      ...base,
      ok: true,
      leaseId: identifier(input.leaseId),
      executionId: identifier(input.executionId),
      preparationId: identifier(input.preparationId),
      secretChannelState: 'consumed',
      seat: remoteSeatInState(input.seat, ['prepared']),
    };
  }
  if (type === 'start') {
    const base = responseBase(input, request, 'start');
    exactKeys(input, [
      'backend',
      'protocolVersion',
      'requestId',
      'serviceInstanceId',
      'brokerUid',
      'executionUid',
      'type',
      'ok',
      'leaseId',
      'executionId',
      'runId',
      'seat',
    ]);
    return {
      ...base,
      ok: true,
      leaseId: identifier(input.leaseId),
      executionId: identifier(input.executionId),
      runId: identifier(input.runId),
      seat: remoteSeatInState(input.seat, ['running']),
    };
  }
  if (type === 'stop') {
    const base = responseBase(input, request, 'stop');
    exactKeys(input, [
      'backend',
      'protocolVersion',
      'requestId',
      'serviceInstanceId',
      'brokerUid',
      'executionUid',
      'type',
      'ok',
      'leaseId',
      'executionId',
      'treeTermination',
      'seatUidProcessState',
      'seat',
    ]);
    return {
      ...base,
      ok: true,
      leaseId: identifier(input.leaseId),
      executionId: identifier(input.executionId),
      treeTermination: enumValue(input.treeTermination, ['confirmed', 'failed'] as const),
      seatUidProcessState: enumValue(
        input.seatUidProcessState,
        ['empty', 'nonempty-or-unknown'] as const,
      ),
      seat: remoteSeatInState(input.seat, ['stopped', 'quarantined']),
    };
  }

  const base = responseBase(input, request, 'cleanup');
  exactKeys(input, [
    'backend',
    'protocolVersion',
    'requestId',
    'serviceInstanceId',
    'brokerUid',
    'executionUid',
    'type',
    'ok',
    'leaseId',
    'executionId',
    'treeTermination',
    'seatUidProcessState',
    'secretResidue',
    'seat',
  ]);
  return {
    ...base,
    ok: true,
    leaseId: identifier(input.leaseId),
    executionId: identifier(input.executionId),
    treeTermination: enumValue(input.treeTermination, ['confirmed', 'failed'] as const),
    seatUidProcessState: enumValue(
      input.seatUidProcessState,
      ['empty', 'nonempty-or-unknown'] as const,
    ),
    secretResidue: enumValue(input.secretResidue, ['absent', 'unknown'] as const),
    seat: parseRemoteSeat(input.seat),
  };
}

function requestBase<T extends MacOsServiceUidBrokerRequest['type']>(
  input: Record<string, unknown>,
  type: T,
): BrokerRequestBase & { type: T } {
  return {
    backend: MACOS_SERVICE_UID_BACKEND,
    protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
    requestId: identifier(input.requestId),
    type,
  };
}

function responseBase<T extends MacOsServiceUidBrokerRequest['type']>(
  input: Record<string, unknown>,
  request: MacOsServiceUidBrokerRequest,
  type: T,
): BrokerResponseBase & { type: T } {
  literal(input.backend, MACOS_SERVICE_UID_BACKEND);
  literal(input.protocolVersion, MACOS_SERVICE_UID_PROTOCOL_VERSION);
  if (identifier(input.requestId) !== request.requestId) {
    throw new Error('macos_service_uid_protocol_invalid');
  }
  return {
    backend: MACOS_SERVICE_UID_BACKEND,
    protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
    requestId: request.requestId,
    serviceInstanceId: identifier(input.serviceInstanceId),
    brokerUid: uid(input.brokerUid),
    executionUid: uid(input.executionUid),
    type,
  };
}

function assertRequestBase(input: Record<string, unknown>): void {
  literal(input.backend, MACOS_SERVICE_UID_BACKEND);
  literal(input.protocolVersion, MACOS_SERVICE_UID_PROTOCOL_VERSION);
  identifier(input.requestId);
}

function assertCommonServiceFields(input: Record<string, unknown>): void {
  literal(input.backend, MACOS_SERVICE_UID_BACKEND);
  literal(input.protocolVersion, MACOS_SERVICE_UID_PROTOCOL_VERSION);
  identifier(input.serviceInstanceId);
  uid(input.brokerUid);
  uid(input.executionUid);
  literal(input.maxConcurrency, MACOS_SERVICE_UID_MAX_CONCURRENCY);
  literal(input.secretTransport, MACOS_SERVICE_UID_SECRET_TRANSPORT);
}

function parseWorkload(value: unknown): MacOsServiceUidWorkload {
  const input = objectRecord(value);
  const kind = enumValue(input.kind, ['provider', 'fixture'] as const);
  if (kind === 'provider') {
    exactKeys(input, ['kind', 'provider']);
    return {
      kind,
      provider: enumValue(input.provider, ['codex', 'claude-code'] as const),
    };
  }
  exactKeys(input, ['kind', 'fixture']);
  literal(input.fixture, 'lifecycle-v1');
  return { kind, fixture: 'lifecycle-v1' };
}

function parseWorkspaceGrant(value: unknown): MacOsServiceUidWorkspaceGrant {
  const input = objectRecord(value);
  exactKeys(input, ['grantId', 'revision']);
  if (
    typeof input.revision !== 'number'
    || !Number.isSafeInteger(input.revision)
    || input.revision < 1
    || input.revision > 2_147_483_647
  ) throw new Error('macos_service_uid_protocol_invalid');
  return {
    grantId: identifier(input.grantId),
    revision: input.revision,
  };
}

function parseSecretChannel(value: unknown): MacOsServiceUidSecretChannel {
  const input = objectRecord(value);
  exactKeys(input, ['channelId', 'transport', 'fdIndex', 'consumption']);
  literal(input.transport, 'inherited-fd');
  literal(input.fdIndex, 0);
  literal(input.consumption, 'once');
  return {
    channelId: identifier(input.channelId),
    transport: 'inherited-fd',
    fdIndex: 0,
    consumption: 'once',
  };
}

function parseRemoteSeat(value: unknown): MacOsServiceUidRemoteSeat {
  const input = objectRecord(value);
  exactKeys(input, ['state', 'leaseId', 'executionId']);
  const state = enumValue(input.state, [
    'idle',
    'prepared',
    'running',
    'stopped',
    'quarantined',
  ] as const);
  if (state === 'idle') {
    literal(input.leaseId, null);
    literal(input.executionId, null);
    return { state, leaseId: null, executionId: null };
  }
  return {
    state,
    leaseId: identifier(input.leaseId),
    executionId: identifier(input.executionId),
  };
}

function remoteSeatInState<
  T extends Exclude<MacOsServiceUidRemoteSeat['state'], 'idle'>,
>(
  value: unknown,
  states: readonly T[],
): Extract<MacOsServiceUidRemoteSeat, { state: T }> {
  const seat = parseRemoteSeat(value);
  if (seat.state === 'idle' || !states.includes(seat.state as T)) {
    throw new Error('macos_service_uid_protocol_invalid');
  }
  return seat as Extract<MacOsServiceUidRemoteSeat, { state: T }>;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('macos_service_uid_protocol_invalid');
  }
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('macos_service_uid_protocol_invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new Error('macos_service_uid_protocol_invalid');
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error('macos_service_uid_protocol_invalid');
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw new Error('macos_service_uid_protocol_invalid');
  }
}

function exactKeys(input: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(input).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) throw new Error('macos_service_uid_protocol_invalid');
}

function literal<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) throw new Error('macos_service_uid_protocol_invalid');
  return expected;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error('macos_service_uid_protocol_invalid');
  }
  return value as T[number];
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('macos_service_uid_protocol_invalid');
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error('macos_service_uid_protocol_invalid');
  }
  return value;
}

function shortIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !SHORT_IDENTIFIER_PATTERN.test(value)) {
    throw new Error('macos_service_uid_protocol_invalid');
  }
  return value;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error('macos_service_uid_protocol_invalid');
  return value;
}

function uid(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > 2_147_483_647
  ) throw new Error('macos_service_uid_protocol_invalid');
  return value;
}
