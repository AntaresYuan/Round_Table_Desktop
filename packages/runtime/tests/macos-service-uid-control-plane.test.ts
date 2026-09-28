import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  connectMacOsServiceUidControlPlane,
  evaluateMacOsServiceUidCapability,
  type MacOsServiceUidControlPlane,
} from '../src/macos-service-uid-control-plane.js';
import { MACOS_SERVICE_UID_V1_CORPUS_SHA256 } from '../src/macos-service-uid-protocol.js';
import {
  MACOS_SERVICE_UID_BACKEND,
  MACOS_SERVICE_UID_MACH_SERVICE,
  MACOS_SERVICE_UID_MAX_CONCURRENCY,
  MACOS_SERVICE_UID_PROTOCOL_VERSION,
  MACOS_SERVICE_UID_SECRET_FD_XPC_KEY,
  MACOS_SERVICE_UID_SECRET_TRANSPORT,
  parseMacOsServiceUidBrokerRequest,
  parseMacOsServiceUidBrokerTransfer,
  type MacOsServiceUidBroker,
  type MacOsServiceUidBrokerRequest,
  type MacOsServiceUidBrokerTransfer,
  type MacOsServiceUidPeerEvidence,
  type MacOsServiceUidRemoteSeat,
} from '../src/macos-service-uid-protocol.js';

const DEVELOPMENT_PEER: Extract<MacOsServiceUidPeerEvidence, { deployment: 'development' }> = {
  backend: MACOS_SERVICE_UID_BACKEND,
  protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
  deployment: 'development',
  serviceInstanceId: 'service-development-1',
  brokerUid: 501,
  executionUid: 502,
  maxConcurrency: MACOS_SERVICE_UID_MAX_CONCURRENCY,
  secretTransport: MACOS_SERVICE_UID_SECRET_TRANSPORT,
  authentication: { kind: 'development-test-double' },
  codeIdentity: { status: 'unverified' },
};

const PRODUCTION_PEER: Extract<MacOsServiceUidPeerEvidence, { deployment: 'production' }> = {
  backend: MACOS_SERVICE_UID_BACKEND,
  protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
  deployment: 'production',
  serviceInstanceId: 'service-production-1',
  brokerUid: 0,
  executionUid: 502,
  maxConcurrency: MACOS_SERVICE_UID_MAX_CONCURRENCY,
  secretTransport: MACOS_SERVICE_UID_SECRET_TRANSPORT,
  authentication: { kind: 'xpc-audit-token' },
  codeIdentity: {
    status: 'verified',
    teamIdentifier: 'TEAMIDENTIFIER1',
    designatedRequirement: 'identifier "dev.roundtable.execution-service" and anchor apple generic',
  },
};

type RecordedCall = {
  request: MacOsServiceUidBrokerRequest;
  transfer: MacOsServiceUidBrokerTransfer | undefined;
};

class FakeBroker implements MacOsServiceUidBroker {
  peer: MacOsServiceUidPeerEvidence = DEVELOPMENT_PEER;
  seat: MacOsServiceUidRemoteSeat = {
    state: 'idle',
    leaseId: null,
    executionId: null,
  };
  calls: RecordedCall[] = [];
  prepareGate: Promise<void> | null = null;
  rejectStart = false;
  stopTreeTermination: 'confirmed' | 'failed' = 'confirmed';
  stopSeatUidProcessState: 'empty' | 'nonempty-or-unknown' = 'empty';
  cleanupTreeTermination: 'confirmed' | 'failed' = 'confirmed';
  cleanupSeatUidProcessState: 'empty' | 'nonempty-or-unknown' = 'empty';
  cleanupSecretResidue: 'absent' | 'unknown' = 'absent';
  responseServiceInstanceId: string | null = null;

  async attestPeer(): Promise<unknown> {
    return this.peer;
  }

  async request(
    request: MacOsServiceUidBrokerRequest,
    transfer?: MacOsServiceUidBrokerTransfer,
  ): Promise<unknown> {
    this.calls.push({ request, transfer });
    if (request.type === 'prepare' && this.prepareGate) await this.prepareGate;

    const base = {
      backend: MACOS_SERVICE_UID_BACKEND,
      protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
      requestId: request.requestId,
      serviceInstanceId: this.responseServiceInstanceId ?? this.peer.serviceInstanceId,
      brokerUid: this.peer.brokerUid,
      executionUid: this.peer.executionUid,
      type: request.type,
    };

    if (request.type === 'status') {
      return {
        ...base,
        ok: true,
        maxConcurrency: MACOS_SERVICE_UID_MAX_CONCURRENCY,
        secretTransport: MACOS_SERVICE_UID_SECRET_TRANSPORT,
        seat: this.seat,
      };
    }

    if (request.type === 'prepare') {
      if (this.seat.state !== 'idle') {
        return { ...base, ok: false, error: 'seat_busy', seat: this.seat };
      }
      if (
        transfer?.kind !== 'inherited-fd'
        || transfer.channelId !== request.secretChannel.channelId
        || transfer.descriptors.length !== 1
      ) {
        return { ...base, ok: false, error: 'secret_channel_invalid', seat: this.seat };
      }
      this.seat = {
        state: 'prepared',
        leaseId: request.leaseId,
        executionId: request.executionId,
      };
      return {
        ...base,
        ok: true,
        leaseId: request.leaseId,
        executionId: request.executionId,
        preparationId: 'preparation-1',
        secretChannelState: 'consumed',
        seat: this.seat,
      };
    }

    if (request.type === 'start') {
      if (
        this.seat.state !== 'prepared'
        || this.seat.leaseId !== request.leaseId
        || this.seat.executionId !== request.executionId
      ) return { ...base, ok: false, error: 'lease_invalid', seat: this.seat };
      if (this.rejectStart) {
        this.seat = {
          state: 'quarantined',
          leaseId: request.leaseId,
          executionId: request.executionId,
        };
        return { ...base, ok: false, error: 'internal_failure', seat: this.seat };
      }
      this.seat = {
        state: 'running',
        leaseId: request.leaseId,
        executionId: request.executionId,
      };
      return {
        ...base,
        ok: true,
        leaseId: request.leaseId,
        executionId: request.executionId,
        runId: 'run-1',
        seat: this.seat,
      };
    }

    if (request.type === 'stop') {
      if (
        this.seat.state !== 'running'
        || this.seat.leaseId !== request.leaseId
        || this.seat.executionId !== request.executionId
      ) return { ...base, ok: false, error: 'lease_invalid', seat: this.seat };
      this.seat = {
        state: this.stopTreeTermination === 'confirmed'
          && this.stopSeatUidProcessState === 'empty'
          ? 'stopped'
          : 'quarantined',
        leaseId: request.leaseId,
        executionId: request.executionId,
      };
      return {
        ...base,
        ok: true,
        leaseId: request.leaseId,
        executionId: request.executionId,
        treeTermination: this.stopTreeTermination,
        seatUidProcessState: this.stopSeatUidProcessState,
        seat: this.seat,
      };
    }

    const cleaned = this.cleanupTreeTermination === 'confirmed'
      && this.cleanupSeatUidProcessState === 'empty'
      && this.cleanupSecretResidue === 'absent';
    this.seat = cleaned
      ? { state: 'idle', leaseId: null, executionId: null }
      : {
        state: 'quarantined',
        leaseId: request.leaseId,
        executionId: request.executionId,
      };
    return {
      ...base,
      ok: true,
      leaseId: request.leaseId,
      executionId: request.executionId,
      treeTermination: this.cleanupTreeTermination,
      seatUidProcessState: this.cleanupSeatUidProcessState,
      secretResidue: this.cleanupSecretResidue,
      seat: this.seat,
    };
  }
}

describe('macos-service-uid-v1 protocol', () => {
  it('keeps the machine-readable lifecycle corpus aligned with the TypeScript model', async () => {
    const corpus = JSON.parse(await readFile(fileURLToPath(new URL(
      '../contracts/macos-service-uid-v1/contract.json',
      import.meta.url,
    )), 'utf8')) as Record<string, unknown>;
    const corpusBytes = await readFile(fileURLToPath(new URL(
      '../contracts/macos-service-uid-v1/contract.json',
      import.meta.url,
    )));
    expect(createHash('sha256').update(corpusBytes).digest('hex'))
      .toBe(MACOS_SERVICE_UID_V1_CORPUS_SHA256);
    const nativeMirror = JSON.parse(await readFile(fileURLToPath(new URL(
      '../native/service-uid/protocol-corpus.json',
      import.meta.url,
    )), 'utf8')) as Record<string, unknown>;
    expect(nativeMirror).toEqual(corpus);
    expect(corpus.contract).toBe(MACOS_SERVICE_UID_BACKEND);
    expect(corpus.version).toBe(MACOS_SERVICE_UID_PROTOCOL_VERSION);
    expect(corpus.maxConcurrency).toBe(MACOS_SERVICE_UID_MAX_CONCURRENCY);
    expect(corpus.secretTransport).toBe(MACOS_SERVICE_UID_SECRET_TRANSPORT);
    expect(corpus.requests).toEqual(['prepare', 'start', 'stop', 'status', 'cleanup']);
    expect(corpus.requestKeySets).toMatchObject({
      status: ['backend', 'protocolVersion', 'requestId', 'type'],
      start: ['backend', 'protocolVersion', 'requestId', 'type', 'leaseId', 'executionId', 'preparationId'],
    });
    expect(corpus.transportRules).toMatchObject({
      fdKey: 'secretChannelFd',
      fdType: 'XPC_TYPE_FD',
      fdAllowedRequest: 'prepare',
      fdCount: 1,
    });
    expect(corpus.responseKeySets).toMatchObject({
      'status.success': expect.arrayContaining(['serviceInstanceId', 'seat']),
      'prepare.success': expect.arrayContaining(['preparationId', 'secretChannelState']),
      'start.success': expect.arrayContaining(['runId', 'seat']),
      'stop.success': expect.arrayContaining(['treeTermination', 'seatUidProcessState']),
      'cleanup.success': expect.arrayContaining(['secretResidue', 'seat']),
      failure: expect.arrayContaining(['error', 'seat']),
    });
    expect(corpus.seatKeySet).toEqual(['state', 'leaseId', 'executionId']);
    expect(corpus.errors).toEqual(expect.arrayContaining(['unauthorized', 'invalid_request']));
  });
  it('accepts only the narrow operation schema and keeps the secret descriptor out of payloads', () => {
    expect(MACOS_SERVICE_UID_MACH_SERVICE).toBe('com.roundtable.runtime.service-uid-v1');
    expect(MACOS_SERVICE_UID_MACH_SERVICE).not.toBe(
      'com.roundtable.runtime.service-uid-bootstrap-probe-v0',
    );
    expect(MACOS_SERVICE_UID_SECRET_FD_XPC_KEY).toBe('secretChannelFd');
    const validPrepare = {
      backend: MACOS_SERVICE_UID_BACKEND,
      protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
      requestId: 'request-1',
      type: 'prepare',
      leaseId: 'lease-1',
      executionId: 'execution-1',
      workload: { kind: 'fixture', fixture: 'lifecycle-v1' },
      workspaceGrant: { grantId: 'workspace-grant-1', revision: 1 },
      secretChannel: {
        channelId: 'secret-channel-1',
        transport: 'inherited-fd',
        fdIndex: 0,
        consumption: 'once',
      },
    };
    const request = parseMacOsServiceUidBrokerRequest(validPrepare);
    const transfer = parseMacOsServiceUidBrokerTransfer({
      kind: 'inherited-fd',
      channelId: 'secret-channel-1',
      descriptors: [23],
    });

    expect(request.type).toBe('prepare');
    expect(JSON.stringify(request)).not.toContain('23');
    expect(transfer).toEqual({
      kind: 'inherited-fd',
      channelId: 'secret-channel-1',
      descriptors: [23],
    });
    for (const forbidden of [
      { command: '/bin/sh' },
      { arguments: ['-c', 'id'] },
      { environment: { TOKEN: 'secret' } },
      { workspacePath: '/private/tmp/workspace' },
      { secret: 'plaintext' },
    ]) {
      expect(() => parseMacOsServiceUidBrokerRequest({
        ...validPrepare,
        ...forbidden,
      })).toThrow('macos_service_uid_protocol_invalid');
    }
    expect(() => parseMacOsServiceUidBrokerRequest({
      ...validPrepare,
      type: 'exec',
    })).toThrow('macos_service_uid_protocol_invalid');
    expect(() => parseMacOsServiceUidBrokerRequest({
      ...validPrepare,
      secretChannel: { ...validPrepare.secretChannel, secret: 'plaintext' },
    })).toThrow('macos_service_uid_protocol_invalid');
    expect(() => parseMacOsServiceUidBrokerTransfer({
      kind: 'inherited-fd',
      channelId: 'secret-channel-1',
      descriptors: [2],
    })).toThrow('macos_service_uid_protocol_invalid');

    expect(() => parseMacOsServiceUidBrokerRequest({
      probe_contract: 'bootstrap-probe-v0',
      probe_version: 0,
      request_id: 'request-1',
      operation: 'status',
    })).toThrow('macos_service_uid_protocol_invalid');
  });
});

describe('macos-service-uid-v1 capability', () => {
  it('labels portable development as fixture-only and production as identity-gated', () => {
    const development = evaluateMacOsServiceUidCapability({
      deployment: 'development',
      host: { source: 'test-double', platform: 'linux', uid: 501 },
      peerEvidence: DEVELOPMENT_PEER,
    });
    expect(development).toMatchObject({
      available: true,
      realProviderExecution: false,
      executionScope: 'fixture-only',
      assurance: 'development-test-double',
      maxConcurrency: 1,
      implementationOwnership: {
        privilegedBroker: 'external-not-implemented',
        codeSigningVerifier: 'transport-adapter-not-implemented',
      },
    });

    expect(evaluateMacOsServiceUidCapability({
      deployment: 'production',
      host: { source: 'local-process', platform: 'linux', uid: 501 },
      peerEvidence: PRODUCTION_PEER,
      expectedProductionIdentity: productionIdentity(),
    })).toMatchObject({ available: false, reason: 'platform_unsupported' });
    expect(evaluateMacOsServiceUidCapability({
      deployment: 'production',
      host: { source: 'test-double', platform: 'darwin', uid: 501 },
      peerEvidence: PRODUCTION_PEER,
      expectedProductionIdentity: productionIdentity(),
    })).toMatchObject({ available: false, reason: 'production_peer_untrusted' });
    expect(evaluateMacOsServiceUidCapability({
      deployment: 'production',
      host: { source: 'local-process', platform: 'darwin', uid: 501 },
      peerEvidence: PRODUCTION_PEER,
      expectedProductionIdentity: productionIdentity(),
    })).toMatchObject({
      available: true,
      realProviderExecution: true,
      executionScope: 'real-provider',
      assurance: 'production-attested-peer',
    });
  });

  it('fails closed for an invalid, same-UID, or mismatched peer', () => {
    expect(evaluateMacOsServiceUidCapability({
      deployment: 'development',
      host: { source: 'test-double', platform: 'linux', uid: 502 },
      peerEvidence: DEVELOPMENT_PEER,
    })).toMatchObject({ available: false, reason: 'dedicated_uid_missing' });
    expect(evaluateMacOsServiceUidCapability({
      deployment: 'development',
      host: { source: 'test-double', platform: 'linux', uid: 501 },
      peerEvidence: { ...DEVELOPMENT_PEER, arbitrary: true },
    })).toMatchObject({ available: false, reason: 'peer_evidence_invalid' });
    expect(evaluateMacOsServiceUidCapability({
      deployment: 'production',
      host: { source: 'local-process', platform: 'darwin', uid: 501 },
      peerEvidence: PRODUCTION_PEER,
      expectedProductionIdentity: {
        ...productionIdentity(),
        designatedRequirement: 'identifier "wrong.service"',
      },
    })).toMatchObject({ available: false, reason: 'production_identity_mismatch' });
  });

  it('rejects accessor-backed peer evidence instead of evaluating two identities', async () => {
    let statusRequests = 0;
    const dynamicPeer = {
      ...PRODUCTION_PEER,
      get brokerUid() {
        return statusRequests === 0 ? 0 : 777;
      },
      get executionUid() {
        return statusRequests === 0 ? 502 : 501;
      },
    };
    const broker: MacOsServiceUidBroker = {
      async attestPeer() {
        return dynamicPeer;
      },
      async request() {
        statusRequests += 1;
        return {};
      },
    };

    const connection = await connectMacOsServiceUidControlPlane({
      deployment: 'production',
      host: { source: 'local-process', platform: 'darwin', uid: 501 },
      broker,
      expectedProductionIdentity: productionIdentity(),
    });
    expect(connection).toMatchObject({
      capability: { available: false, reason: 'peer_evidence_invalid' },
      controlPlane: null,
    });
    expect(statusRequests).toBe(0);
  });
});

describe('macos-service-uid-v1 control plane', () => {
  it('runs prepare/start/stop/cleanup with one seat and out-of-band descriptor transfer', async () => {
    const broker = new FakeBroker();
    const control = await connectDevelopment(broker);

    const prepared = await prepareFixture(control, 'execution-1', 31);
    expect(control.seat).toMatchObject({ state: 'prepared', leaseId: prepared.leaseId });
    expect(broker.calls.at(-1)?.request).not.toHaveProperty('command');
    expect(broker.calls.at(-1)?.request).not.toHaveProperty('environment');
    expect(broker.calls.at(-1)?.request).not.toHaveProperty('workspacePath');
    expect(broker.calls.at(-1)?.transfer?.descriptors).toEqual([31]);

    await expect(control.start({ leaseId: prepared.leaseId })).resolves.toEqual({
      executionId: 'execution-1',
      runId: 'run-1',
    });
    expect(broker.calls.at(-1)?.transfer).toBeUndefined();
    await expect(control.stop({ leaseId: prepared.leaseId })).resolves.toBeUndefined();
    expect(control.seat.state).toBe('stopped');
    await expect(control.cleanup({ leaseId: prepared.leaseId })).resolves.toBeUndefined();
    expect(control.seat).toEqual({
      state: 'idle',
      leaseId: null,
      executionId: null,
      quarantineReason: null,
    });
    expect(broker.calls.map(({ request }) => request.type)).toEqual([
      'status',
      'prepare',
      'start',
      'stop',
      'cleanup',
    ]);
  });

  it('reserves the only seat before awaiting the broker', async () => {
    const broker = new FakeBroker();
    const control = await connectDevelopment(broker);
    const gate = deferred<void>();
    broker.prepareGate = gate.promise;

    const first = prepareFixture(control, 'execution-1', 31);
    expect(control.seat.state).toBe('preparing');
    await expect(prepareFixture(control, 'execution-2', 32)).rejects.toMatchObject({
      code: 'seat_unavailable',
    });
    expect(broker.calls.filter(({ request }) => request.type === 'prepare')).toHaveLength(1);
    gate.resolve();
    await expect(first).resolves.toMatchObject({ preparationId: 'preparation-1' });
  });

  it('relies on the broker seat lease to serialize competing control-plane connections', async () => {
    const broker = new FakeBroker();
    const [firstControl, secondControl] = await Promise.all([
      connectDevelopment(broker),
      connectDevelopment(broker),
    ]);
    const gate = deferred<void>();
    broker.prepareGate = gate.promise;

    const first = prepareFixture(firstControl, 'execution-1', 31);
    const second = prepareFixture(secondControl, 'execution-2', 32);
    expect(broker.calls.filter(({ request }) => request.type === 'prepare')).toHaveLength(2);
    gate.resolve();

    await expect(first).resolves.toMatchObject({ preparationId: 'preparation-1' });
    await expect(second).rejects.toMatchObject({ code: 'broker_rejected' });
    expect(firstControl.seat.state).toBe('prepared');
    expect(secondControl.seat).toMatchObject({
      state: 'quarantined',
      quarantineReason: 'broker_rejected',
    });
    expect(broker.seat).toMatchObject({
      state: 'prepared',
      executionId: 'execution-1',
    });
  });

  it('admits only fixtures in development', async () => {
    const broker = new FakeBroker();
    const control = await connectDevelopment(broker);

    await expect(control.prepare({
      executionId: 'execution-1',
      workload: { kind: 'provider', provider: 'codex' },
      workspaceGrant: { grantId: 'workspace-grant-1', revision: 1 },
      inheritedSecretFd: 31,
    })).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(broker.calls.map(({ request }) => request.type)).toEqual(['status']);
  });

  it('rejects an invalid descriptor before reserving or contacting the broker', async () => {
    const broker = new FakeBroker();
    const control = await connectDevelopment(broker);

    await expect(prepareFixture(control, 'execution-1', 2)).rejects.toMatchObject({
      code: 'request_invalid',
    });
    expect(control.seat.state).toBe('idle');
    expect(broker.calls.map(({ request }) => request.type)).toEqual(['status']);
  });

  it('quarantines an orphaned broker seat until cleanup proves tree death and secret erasure', async () => {
    const broker = new FakeBroker();
    broker.seat = {
      state: 'prepared',
      leaseId: 'orphaned-lease-1',
      executionId: 'orphaned-execution-1',
    };
    const control = await connectDevelopment(broker);

    expect(control.seat).toEqual({
      state: 'quarantined',
      leaseId: 'orphaned-lease-1',
      executionId: 'orphaned-execution-1',
      quarantineReason: 'orphaned_remote_seat',
    });
    await expect(prepareFixture(control, 'execution-2', 32)).rejects.toMatchObject({
      code: 'seat_unavailable',
    });
    await expect(control.cleanup({ leaseId: 'orphaned-lease-1' })).resolves.toBeUndefined();
    expect(control.seat.state).toBe('idle');
  });

  it('quarantines rejected starts and permits only explicit cleanup before reuse', async () => {
    const broker = new FakeBroker();
    const control = await connectDevelopment(broker);
    const prepared = await prepareFixture(control, 'execution-1', 31);
    broker.rejectStart = true;

    await expect(control.start({ leaseId: prepared.leaseId })).rejects.toMatchObject({
      code: 'broker_rejected',
    });
    expect(control.seat).toMatchObject({
      state: 'quarantined',
      quarantineReason: 'broker_rejected',
    });
    await expect(prepareFixture(control, 'execution-2', 32)).rejects.toMatchObject({
      code: 'seat_unavailable',
    });
    await control.cleanup({ leaseId: prepared.leaseId });
    broker.rejectStart = false;
    await expect(prepareFixture(control, 'execution-2', 32)).resolves.toMatchObject({
      preparationId: 'preparation-1',
    });
  });

  it('does not release a seat on failed termination or incomplete cleanup proof', async () => {
    const broker = new FakeBroker();
    const control = await connectDevelopment(broker);
    const prepared = await prepareFixture(control, 'execution-1', 31);
    await control.start({ leaseId: prepared.leaseId });
    broker.stopTreeTermination = 'failed';

    await expect(control.stop({ leaseId: prepared.leaseId })).rejects.toMatchObject({
      code: 'termination_unconfirmed',
    });
    expect(control.seat.state).toBe('quarantined');
    broker.cleanupSecretResidue = 'unknown';
    await expect(control.cleanup({ leaseId: prepared.leaseId })).rejects.toMatchObject({
      code: 'cleanup_unconfirmed',
    });
    expect(control.seat).toMatchObject({
      state: 'quarantined',
      quarantineReason: 'cleanup_unconfirmed',
    });
    await expect(prepareFixture(control, 'execution-2', 32)).rejects.toMatchObject({
      code: 'seat_unavailable',
    });
    broker.cleanupTreeTermination = 'confirmed';
    broker.cleanupSecretResidue = 'absent';
    broker.cleanupSeatUidProcessState = 'nonempty-or-unknown';
    await expect(control.cleanup({ leaseId: prepared.leaseId })).rejects.toMatchObject({
      code: 'cleanup_unconfirmed',
    });
    expect(control.seat.state).toBe('quarantined');
    broker.cleanupSeatUidProcessState = 'empty';
    await control.cleanup({ leaseId: prepared.leaseId });
    expect(control.seat.state).toBe('idle');
  });

  it('fails closed on broker identity drift and requires a newly attested connection to clean up', async () => {
    const broker = new FakeBroker();
    const control = await connectDevelopment(broker);
    const prepared = await prepareFixture(control, 'execution-1', 31);
    broker.responseServiceInstanceId = 'service-development-2';

    await expect(control.start({ leaseId: prepared.leaseId })).rejects.toMatchObject({
      code: 'broker_identity_mismatch',
    });
    expect(control.seat).toMatchObject({
      state: 'quarantined',
      quarantineReason: 'broker_identity_mismatch',
    });
    await expect(control.cleanup({ leaseId: prepared.leaseId })).rejects.toMatchObject({
      code: 'broker_identity_mismatch',
    });

    broker.peer = {
      ...DEVELOPMENT_PEER,
      serviceInstanceId: 'service-development-2',
    };
    const reconnected = await connectDevelopment(broker);
    expect(reconnected.seat).toMatchObject({
      state: 'quarantined',
      quarantineReason: 'orphaned_remote_seat',
    });
    await reconnected.cleanup({ leaseId: prepared.leaseId });
    expect(reconnected.seat.state).toBe('idle');
  });
});

async function connectDevelopment(
  broker: FakeBroker,
): Promise<MacOsServiceUidControlPlane> {
  const connection = await connectMacOsServiceUidControlPlane({
    deployment: 'development',
    host: { source: 'test-double', platform: 'linux', uid: 501 },
    broker,
  });
  if (!connection.capability.available || !connection.controlPlane) {
    throw new Error(`connection failed: ${connection.capability.reason}`);
  }
  return connection.controlPlane;
}

function prepareFixture(
  control: MacOsServiceUidControlPlane,
  executionId: string,
  inheritedSecretFd: number,
): Promise<{ leaseId: string; preparationId: string }> {
  return control.prepare({
    executionId,
    workload: { kind: 'fixture', fixture: 'lifecycle-v1' },
    workspaceGrant: { grantId: `workspace-grant-${executionId}`, revision: 1 },
    inheritedSecretFd,
  });
}

function productionIdentity() {
  return {
    brokerUid: PRODUCTION_PEER.brokerUid,
    executionUid: PRODUCTION_PEER.executionUid,
    teamIdentifier: PRODUCTION_PEER.codeIdentity.teamIdentifier,
    designatedRequirement: PRODUCTION_PEER.codeIdentity.designatedRequirement,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
