import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MACOS_HOST_RUNTIME_V1_CORPUS,
  MACOS_HOST_RUNTIME_V1_CORPUS_SHA256,
} from '../src/generated/macos-host-runtime-v1-contract.js';
import {
  hostRuntimeSessionOpenRequestSchema,
  hostRuntimeSessionOpenResponseSchema,
  hostRuntimeSessionOpenFailureSchema,
} from '../src/index.js';

describe('macOS host runtime v1 canonical contract', () => {
  it('binds the generated TypeScript mirror to the canonical bytes', async () => {
    const path = fileURLToPath(new URL(
      '../contracts/macos-host-runtime-v1/contract.json',
      import.meta.url,
    ));
    const bytes = await readFile(path);
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe(MACOS_HOST_RUNTIME_V1_CORPUS_SHA256);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(MACOS_HOST_RUNTIME_V1_CORPUS);
  });

  it('does not expose secrets or generic privileged operations', () => {
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.secretVisibility).toBe('host-runtime-only');
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.operations).not.toContain('shell.execute');
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.operations).not.toContain('filesystem.write');
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.operations).not.toContain('broker.request');
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.forbiddenPayloadKeys).toContain('credential');
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.forbiddenPayloadKeys).toContain('rootCommand');
  });

  it('freezes an exact-version transport handshake before operation dispatch', () => {
    expect(hostRuntimeSessionOpenRequestSchema.parse({
      protocolVersion: 1,
      clientNonce: 'client_0123456789abcdef0123456789abcdef',
    })).toBeTruthy();
    expect(hostRuntimeSessionOpenResponseSchema.parse({
      protocolVersion: 1,
      sessionNonce: 'session_0123456789abcdef0123456789abcdef',
    })).toBeTruthy();
    expect(hostRuntimeSessionOpenFailureSchema.parse({
      error: 'unsupported_protocol_version',
    })).toBeTruthy();
    expect(hostRuntimeSessionOpenFailureSchema.parse({
      error: 'invalid_handshake',
    })).toBeTruthy();
    expect(hostRuntimeSessionOpenFailureSchema.safeParse({ error: 'unknown' }).success).toBe(false);
    expect(hostRuntimeSessionOpenFailureSchema.safeParse({
      error: 'unsupported_protocol_version', extra: true,
    }).success).toBe(false);
    expect(hostRuntimeSessionOpenRequestSchema.safeParse({
      protocolVersion: 2,
      clientNonce: 'client_0123456789abcdef0123456789abcdef',
    }).success).toBe(false);
    expect(hostRuntimeSessionOpenRequestSchema.safeParse({
      protocolVersion: 1,
      clientNonce: 'client_predictable',
    }).success).toBe(false);
    expect(hostRuntimeSessionOpenResponseSchema.safeParse({
      protocolVersion: 2,
      sessionNonce: 'session_0123456789abcdef0123456789abcdef',
    }).success).toBe(false);
    expect(hostRuntimeSessionOpenResponseSchema.safeParse({
      protocolVersion: 1,
      sessionNonce: 'session_predictable',
    }).success).toBe(false);
    expect(hostRuntimeSessionOpenRequestSchema.safeParse({
      protocolVersion: 1,
      clientNonce: 'client_0123456789abcdef0123456789abcdef',
      extra: true,
    }).success).toBe(false);
    expect(hostRuntimeSessionOpenResponseSchema.safeParse({
      protocolVersion: 1,
      sessionNonce: 'session_0123456789abcdef0123456789abcdef',
      extra: true,
    }).success).toBe(false);
    expect(Object.keys({
      protocolVersion: 1,
      clientNonce: 'client_0123456789abcdef0123456789abcdef',
    }).sort()).toEqual([...MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.requestKeys].sort());
    expect(Object.keys({
      protocolVersion: 1,
      sessionNonce: 'session_0123456789abcdef0123456789abcdef',
    }).sort()).toEqual([...MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.responseKeys].sort());
    expect(Object.keys({ error: 'unsupported_protocol_version' }).sort())
      .toEqual([...MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.failureResponseKeys].sort());
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.versionPolicy)
      .toBe('exact-match-before-dispatch');
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.maxRequestBytes).toBeLessThanOrEqual(256);
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.maxResponseBytes).toBeLessThanOrEqual(128);
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.transportHandshake.failureDisposition)
      .toBe('reply-then-invalidate-connection');
  });
});
