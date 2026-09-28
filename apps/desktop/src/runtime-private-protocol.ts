import { isAbsolute } from 'node:path';

import {
  runtimeCatalogEntrySchema,
  runtimeCatalogSchema,
  runtimeExecutionEventSchema,
  type RuntimeCatalog,
  type RuntimeCatalogEntry,
  type RuntimeExecutionEvent,
} from '@roundtable/protocol';
import type {
  RuntimeCredential,
  RuntimeProvider,
  WorkspaceIdentity,
} from '@roundtable/runtime';

export const PRIVATE_RUNTIME_PROTOCOL_VERSION = 1 as const;

type RuntimeRequestBase = {
  protocolVersion: typeof PRIVATE_RUNTIME_PROTOCOL_VERSION;
  bootEpoch: string;
  requestId: string;
};

export type RuntimeChildRequest = RuntimeRequestBase & (
  | { type: 'catalog'; hostHomeDirectory: string; searchDirectories: string[] }
  | {
    type: 'prepare';
    provider: RuntimeProvider;
    missionId: string;
    promptDigest: string;
    hostHomeDirectory: string;
    workspaceId: string;
    workspace: WorkspaceIdentity;
    grantRevision: number;
    searchDirectories: string[];
  }
  | {
    type: 'launch';
    preparationToken: string;
    missionId: string;
    executionId: string;
    workspaceId: string;
    workspace: WorkspaceIdentity;
    grantRevision: number;
    provider: RuntimeProvider;
    prompt: string;
    timeoutMs: number;
    environment: {
      homeDirectory: string;
      temporaryDirectory: string;
      hostHomeDirectory: string;
      credential?: RuntimeCredential;
      redactionSecrets?: string[];
    };
  }
  | { type: 'stop'; executionId: string }
  | { type: 'shutdown' }
);

export type RuntimeChildResult =
  | { operation: 'catalog'; catalog: RuntimeCatalog }
  | {
    operation: 'prepare';
    preparationToken: string;
    missionId: string;
    promptDigest: string;
    provider: RuntimeProvider;
    catalogEntry: RuntimeCatalogEntry;
  }
  | {
    operation: 'launch';
    accepted: true;
    missionId: string;
    executionId: string;
  }
  | { operation: 'stop'; event: RuntimeExecutionEvent }
  | { operation: 'shutdown'; shutdown: true };

export type RuntimeChildMessage =
  | {
    protocolVersion: typeof PRIVATE_RUNTIME_PROTOCOL_VERSION;
    bootEpoch: string;
    type: 'ready';
  }
  | {
    protocolVersion: typeof PRIVATE_RUNTIME_PROTOCOL_VERSION;
    bootEpoch: string;
    type: 'heartbeat';
    occurredAt: string;
  }
  | {
    protocolVersion: typeof PRIVATE_RUNTIME_PROTOCOL_VERSION;
    bootEpoch: string;
    type: 'response';
    requestId: string;
    ok: true;
    result: RuntimeChildResult;
  }
  | {
    protocolVersion: typeof PRIVATE_RUNTIME_PROTOCOL_VERSION;
    bootEpoch: string;
    type: 'response';
    requestId: string;
    ok: false;
    code: string;
  }
  | {
    protocolVersion: typeof PRIVATE_RUNTIME_PROTOCOL_VERSION;
    bootEpoch: string;
    type: 'event';
    event: RuntimeExecutionEvent;
  }
  | {
    protocolVersion: typeof PRIVATE_RUNTIME_PROTOCOL_VERSION;
    bootEpoch: string;
    type: 'process';
    executionId: string;
    pid: number;
  };

export function parseRuntimeChildRequest(value: unknown): RuntimeChildRequest {
  const record = requiredRecord(value, 'runtime_private_request_invalid');
  assertBase(record);
  const common = {
    protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
    bootEpoch: requiredOpaqueString(record.bootEpoch, 128),
    requestId: requiredOpaqueString(record.requestId, 128),
  };

  if (record.type === 'catalog') {
    assertExactKeys(record, [
      'protocolVersion', 'bootEpoch', 'requestId', 'type', 'hostHomeDirectory',
      'searchDirectories',
    ]);
    return {
      ...common,
      type: 'catalog',
      hostHomeDirectory: parseAbsoluteDirectory(record.hostHomeDirectory),
      searchDirectories: parseSearchDirectories(record.searchDirectories),
    };
  }
  if (record.type === 'prepare') {
    assertExactKeys(record, [
      'protocolVersion', 'bootEpoch', 'requestId', 'type', 'provider', 'workspace',
      'missionId', 'promptDigest', 'hostHomeDirectory', 'workspaceId', 'grantRevision',
      'searchDirectories',
    ]);
    if (!Number.isSafeInteger(record.grantRevision) || (record.grantRevision as number) < 1) {
      throw new Error('runtime_private_request_invalid');
    }
    return {
      ...common,
      type: 'prepare',
      provider: parseProvider(record.provider),
      missionId: requiredPrefixedId(record.missionId, 'mission_'),
      promptDigest: requiredSha256(record.promptDigest),
      hostHomeDirectory: parseAbsoluteDirectory(record.hostHomeDirectory),
      workspaceId: requiredPrefixedId(record.workspaceId, 'workspace_'),
      workspace: parseWorkspace(record.workspace),
      grantRevision: record.grantRevision as number,
      searchDirectories: parseSearchDirectories(record.searchDirectories),
    };
  }
  if (record.type === 'launch') {
    assertExactKeys(record, [
      'protocolVersion', 'bootEpoch', 'requestId', 'type', 'preparationToken', 'missionId',
      'executionId', 'workspaceId', 'workspace', 'grantRevision', 'provider', 'prompt',
      'timeoutMs', 'environment',
    ]);
    if (
      !Number.isSafeInteger(record.grantRevision)
      || (record.grantRevision as number) < 1
      || !Number.isSafeInteger(record.timeoutMs)
      || (record.timeoutMs as number) < 1_000
      || (record.timeoutMs as number) > 7_200_000
      || typeof record.prompt !== 'string'
      || record.prompt.trim().length < 1
      || record.prompt.length > 12_000
    ) throw new Error('runtime_private_request_invalid');
    return {
      ...common,
      type: 'launch',
      preparationToken: requiredOpaqueString(record.preparationToken, 128),
      missionId: requiredPrefixedId(record.missionId, 'mission_'),
      executionId: requiredPrefixedId(record.executionId, 'execution_'),
      workspaceId: requiredPrefixedId(record.workspaceId, 'workspace_'),
      workspace: parseWorkspace(record.workspace),
      grantRevision: record.grantRevision as number,
      provider: parseProvider(record.provider),
      prompt: record.prompt,
      timeoutMs: record.timeoutMs as number,
      environment: parseEnvironment(record.environment),
    };
  }
  if (record.type === 'stop') {
    assertExactKeys(record, ['protocolVersion', 'bootEpoch', 'requestId', 'type', 'executionId']);
    return {
      ...common,
      type: 'stop',
      executionId: requiredPrefixedId(record.executionId, 'execution_'),
    };
  }
  if (record.type === 'shutdown') {
    assertExactKeys(record, ['protocolVersion', 'bootEpoch', 'requestId', 'type']);
    return { ...common, type: 'shutdown' };
  }
  throw new Error('runtime_private_request_invalid');
}

export function parseRuntimeChildMessage(value: unknown): RuntimeChildMessage {
  const record = requiredRecord(value, 'runtime_private_message_invalid');
  if (record.protocolVersion !== PRIVATE_RUNTIME_PROTOCOL_VERSION) {
    throw new Error('runtime_private_message_invalid');
  }
  const bootEpoch = requiredOpaqueString(record.bootEpoch, 128);
  if (record.type === 'ready') {
    assertExactKeys(record, ['protocolVersion', 'bootEpoch', 'type']);
    return { protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION, bootEpoch, type: 'ready' };
  }
  if (record.type === 'heartbeat') {
    assertExactKeys(record, ['protocolVersion', 'bootEpoch', 'type', 'occurredAt']);
    const occurredAt = requiredTimestamp(record.occurredAt);
    return {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      type: 'heartbeat',
      occurredAt,
    };
  }
  if (record.type === 'response') {
    const requestId = requiredOpaqueString(record.requestId, 128);
    if (record.ok === true) {
      assertExactKeys(record, [
        'protocolVersion', 'bootEpoch', 'type', 'requestId', 'ok', 'result',
      ]);
      return {
        protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
        bootEpoch,
        type: 'response',
        requestId,
        ok: true,
        result: parseRuntimeChildResult(record.result),
      };
    }
    if (record.ok === false) {
      assertExactKeys(record, [
        'protocolVersion', 'bootEpoch', 'type', 'requestId', 'ok', 'code',
      ]);
      return {
        protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
        bootEpoch,
        type: 'response',
        requestId,
        ok: false,
        code: requiredStableCode(record.code),
      };
    }
  }
  if (record.type === 'event') {
    assertExactKeys(record, ['protocolVersion', 'bootEpoch', 'type', 'event']);
    return {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      type: 'event',
      event: runtimeExecutionEventSchema.parse(record.event),
    };
  }
  if (record.type === 'process') {
    assertExactKeys(record, [
      'protocolVersion', 'bootEpoch', 'type', 'executionId', 'pid',
    ]);
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
      throw new Error('runtime_private_message_invalid');
    }
    return {
      protocolVersion: PRIVATE_RUNTIME_PROTOCOL_VERSION,
      bootEpoch,
      type: 'process',
      executionId: requiredPrefixedId(record.executionId, 'execution_'),
      pid: record.pid as number,
    };
  }
  throw new Error('runtime_private_message_invalid');
}

function parseRuntimeChildResult(value: unknown): RuntimeChildResult {
  const record = requiredRecord(value, 'runtime_private_message_invalid');
  if (record.operation === 'catalog') {
    assertExactKeys(record, ['operation', 'catalog']);
    return { operation: 'catalog', catalog: runtimeCatalogSchema.parse(record.catalog) };
  }
  if (record.operation === 'prepare') {
    assertExactKeys(record, [
      'operation', 'preparationToken', 'missionId', 'promptDigest', 'provider',
      'catalogEntry',
    ]);
    return {
      operation: 'prepare',
      preparationToken: requiredOpaqueString(record.preparationToken, 128),
      missionId: requiredPrefixedId(record.missionId, 'mission_'),
      promptDigest: requiredSha256(record.promptDigest),
      provider: parseProvider(record.provider),
      catalogEntry: runtimeCatalogEntrySchema.parse(record.catalogEntry),
    };
  }
  if (record.operation === 'launch') {
    assertExactKeys(record, ['operation', 'accepted', 'missionId', 'executionId']);
    if (record.accepted !== true) throw new Error('runtime_private_message_invalid');
    return {
      operation: 'launch',
      accepted: true,
      missionId: requiredPrefixedId(record.missionId, 'mission_'),
      executionId: requiredPrefixedId(record.executionId, 'execution_'),
    };
  }
  if (record.operation === 'stop') {
    assertExactKeys(record, ['operation', 'event']);
    return { operation: 'stop', event: runtimeExecutionEventSchema.parse(record.event) };
  }
  if (record.operation === 'shutdown') {
    assertExactKeys(record, ['operation', 'shutdown']);
    if (record.shutdown !== true) throw new Error('runtime_private_message_invalid');
    return { operation: 'shutdown', shutdown: true };
  }
  throw new Error('runtime_private_message_invalid');
}

function assertBase(record: Record<string, unknown>): void {
  if (record.protocolVersion !== PRIVATE_RUNTIME_PROTOCOL_VERSION) {
    throw new Error('runtime_private_request_invalid');
  }
  requiredOpaqueString(record.bootEpoch, 128);
  requiredOpaqueString(record.requestId, 128);
}

function parseWorkspace(value: unknown): WorkspaceIdentity {
  const record = requiredRecord(value, 'runtime_private_request_invalid');
  assertExactKeys(record, ['root', 'device', 'inode']);
  if (
    typeof record.root !== 'string'
    || !isAbsolute(record.root)
    || hasControlCharacters(record.root)
    || !isDecimalIdentity(record.device)
    || !isDecimalIdentity(record.inode)
  ) throw new Error('runtime_private_request_invalid');
  return { root: record.root, device: record.device, inode: record.inode };
}

function parseEnvironment(value: unknown): Extract<RuntimeChildRequest, { type: 'launch' }>['environment'] {
  const record = requiredRecord(value, 'runtime_private_request_invalid');
  const keys = Object.keys(record);
  if (
    keys.length < 3
    || keys.length > 5
    || !keys.includes('homeDirectory')
    || !keys.includes('temporaryDirectory')
    || !keys.includes('hostHomeDirectory')
    || keys.some((key) => ![
      'homeDirectory', 'temporaryDirectory', 'hostHomeDirectory', 'credential',
      'redactionSecrets',
    ].includes(key))
    || typeof record.homeDirectory !== 'string'
    || !isAbsolute(record.homeDirectory)
    || hasControlCharacters(record.homeDirectory)
    || typeof record.temporaryDirectory !== 'string'
    || !isAbsolute(record.temporaryDirectory)
    || hasControlCharacters(record.temporaryDirectory)
    || typeof record.hostHomeDirectory !== 'string'
    || !isAbsolute(record.hostHomeDirectory)
    || hasControlCharacters(record.hostHomeDirectory)
  ) throw new Error('runtime_private_request_invalid');
  const credential = record.credential === undefined
    ? undefined
    : parseCredential(record.credential);
  const redactionSecrets = record.redactionSecrets === undefined
    ? undefined
    : parseRedactionSecrets(record.redactionSecrets);
  return {
    homeDirectory: record.homeDirectory,
    temporaryDirectory: record.temporaryDirectory,
    hostHomeDirectory: record.hostHomeDirectory,
    ...(credential ? { credential } : {}),
    ...(redactionSecrets ? { redactionSecrets } : {}),
  };
}

function parseRedactionSecrets(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error('runtime_private_request_invalid');
  }
  let totalBytes = 0;
  const secrets: string[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== 'string'
      || candidate.length < 8
      || /[\u0000\r\n]/u.test(candidate)
    ) throw new Error('runtime_private_request_invalid');
    const bytes = Buffer.byteLength(candidate, 'utf8');
    totalBytes += bytes;
    if (bytes > 16 * 1024 || totalBytes > 64 * 1024) {
      throw new Error('runtime_private_request_invalid');
    }
    if (!secrets.includes(candidate)) secrets.push(candidate);
  }
  return secrets;
}

function parseCredential(value: unknown): RuntimeCredential {
  const record = requiredRecord(value, 'runtime_private_request_invalid');
  assertExactKeys(record, ['provider', 'kind', 'value']);
  const provider = parseProvider(record.provider);
  const secret = typeof record.value === 'string' ? record.value : '';
  if (
    secret.length < 8
    || Buffer.byteLength(secret, 'utf8') > 16 * 1024
    || /[\u0000\r\n]/u.test(secret)
  ) throw new Error('runtime_private_request_invalid');
  if (provider === 'codex' && record.kind === 'openai-api-key') {
    return { provider, kind: record.kind, value: secret };
  }
  if (
    provider === 'claude-code'
    && ['anthropic-api-key', 'anthropic-auth-token', 'claude-code-oauth-token']
      .includes(record.kind as string)
  ) {
    return {
      provider,
      kind: record.kind as Extract<RuntimeCredential, { provider: 'claude-code' }>['kind'],
      value: secret,
    };
  }
  if (
    provider === 'opencode'
    && ['openai-api-key', 'anthropic-api-key'].includes(record.kind as string)
  ) {
    return {
      provider,
      kind: record.kind as Extract<RuntimeCredential, { provider: 'opencode' }>['kind'],
      value: secret,
    };
  }
  throw new Error('runtime_private_request_invalid');
}

function parseProvider(value: unknown): RuntimeProvider {
  if (value === 'codex' || value === 'claude-code' || value === 'opencode') return value;
  throw new Error('runtime_private_request_invalid');
}

function parseSearchDirectories(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.length > 8
    || value.some((directory) => (
      typeof directory !== 'string'
      || !isAbsolute(directory)
      || directory.length > 1_024
      || hasControlCharacters(directory)
    ))
  ) throw new Error('runtime_private_request_invalid');
  return [...new Set(value as string[])];
}

function parseAbsoluteDirectory(value: unknown): string {
  if (
    typeof value !== 'string'
    || !isAbsolute(value)
    || value.length > 4_096
    || hasControlCharacters(value)
  ) throw new Error('runtime_private_request_invalid');
  return value;
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) throw new Error('runtime_private_request_invalid');
}

function requiredOpaqueString(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u.test(value)
  ) throw new Error('runtime_private_message_invalid');
  return value;
}

function requiredPrefixedId(value: unknown, prefix: string): string {
  const id = requiredOpaqueString(value, 128);
  if (!id.startsWith(prefix)) throw new Error('runtime_private_message_invalid');
  return id;
}

function requiredStableCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(value)) {
    throw new Error('runtime_private_message_invalid');
  }
  return value;
}

function requiredSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('runtime_private_request_invalid');
  }
  return value;
}

function requiredTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('runtime_private_message_invalid');
  }
  return value;
}

function isDecimalIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,40}$/u.test(value);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
