import { randomUUID } from 'node:crypto';

import {
  MACOS_SERVICE_UID_BACKEND,
  MACOS_SERVICE_UID_MAX_CONCURRENCY,
  MACOS_SERVICE_UID_PROTOCOL_VERSION,
  MACOS_SERVICE_UID_SECRET_TRANSPORT,
  parseMacOsServiceUidBrokerRequest,
  parseMacOsServiceUidBrokerResponse,
  parseMacOsServiceUidBrokerTransfer,
  parseMacOsServiceUidPeerEvidence,
  type MacOsServiceUidBroker,
  type MacOsServiceUidBrokerRequest,
  type MacOsServiceUidBrokerResponse,
  type MacOsServiceUidBrokerTransfer,
  type MacOsServiceUidDeployment,
  type MacOsServiceUidPeerEvidence,
  type MacOsServiceUidRemoteSeat,
  type MacOsServiceUidWorkload,
  type MacOsServiceUidWorkspaceGrant,
} from './macos-service-uid-protocol.js';

const IMPLEMENTATION_OWNERSHIP = Object.freeze({
  privilegedBroker: 'external-not-implemented',
  codeSigningVerifier: 'transport-adapter-not-implemented',
} as const);

export type MacOsServiceUidHostFacts = {
  source: 'local-process' | 'test-double';
  platform: NodeJS.Platform;
  uid: number | null;
};

export type MacOsServiceUidExpectedProductionIdentity = {
  brokerUid: number;
  executionUid: number;
  teamIdentifier: string;
  designatedRequirement: string;
};

export type MacOsServiceUidCapabilityUnavailableReason =
  | 'platform_unsupported'
  | 'host_identity_unavailable'
  | 'peer_evidence_invalid'
  | 'deployment_mismatch'
  | 'dedicated_uid_missing'
  | 'production_identity_unconfigured'
  | 'production_peer_untrusted'
  | 'production_identity_mismatch'
  | 'broker_unavailable'
  | 'broker_protocol_invalid'
  | 'broker_identity_mismatch'
  | 'broker_rejected';

type CapabilityBase = {
  backend: typeof MACOS_SERVICE_UID_BACKEND;
  protocolVersion: typeof MACOS_SERVICE_UID_PROTOCOL_VERSION;
  deployment: MacOsServiceUidDeployment;
  maxConcurrency: typeof MACOS_SERVICE_UID_MAX_CONCURRENCY;
  secretTransport: typeof MACOS_SERVICE_UID_SECRET_TRANSPORT;
  implementationOwnership: typeof IMPLEMENTATION_OWNERSHIP;
};

export type MacOsServiceUidCapability =
  | CapabilityBase & {
    available: true;
    realProviderExecution: true;
    executionScope: 'real-provider';
    assurance: 'production-attested-peer';
    serviceInstanceId: string;
    brokerUid: number;
    executionUid: number;
  }
  | CapabilityBase & {
    available: true;
    realProviderExecution: false;
    executionScope: 'fixture-only';
    assurance: 'development-test-double';
    serviceInstanceId: string;
    brokerUid: number;
    executionUid: number;
  }
  | CapabilityBase & {
    available: false;
    realProviderExecution: false;
    executionScope: 'none';
    assurance: 'none';
    reason: MacOsServiceUidCapabilityUnavailableReason;
  };

export type MacOsServiceUidConnection =
  | {
    capability: Extract<MacOsServiceUidCapability, { available: true }>;
    controlPlane: MacOsServiceUidControlPlane;
  }
  | {
    capability: Extract<MacOsServiceUidCapability, { available: false }>;
    controlPlane: null;
  };

export type MacOsServiceUidConnectInput = {
  deployment: MacOsServiceUidDeployment;
  host: MacOsServiceUidHostFacts;
  broker: MacOsServiceUidBroker;
  expectedProductionIdentity?: MacOsServiceUidExpectedProductionIdentity | undefined;
};

export type MacOsServiceUidSeatSnapshot =
  | {
    state: 'idle';
    leaseId: null;
    executionId: null;
    quarantineReason: null;
  }
  | {
    state: 'preparing' | 'prepared' | 'starting' | 'running' | 'stopping' | 'stopped' | 'cleaning';
    leaseId: string;
    executionId: string;
    quarantineReason: null;
  }
  | {
    state: 'quarantined';
    leaseId: string;
    executionId: string;
    quarantineReason: MacOsServiceUidQuarantineReason;
  };

export type MacOsServiceUidQuarantineReason =
  | 'orphaned_remote_seat'
  | 'broker_failure'
  | 'broker_rejected'
  | 'broker_protocol_invalid'
  | 'broker_identity_mismatch'
  | 'remote_state_mismatch'
  | 'termination_unconfirmed'
  | 'cleanup_unconfirmed';

export type MacOsServiceUidControlErrorCode =
  | 'capability_unavailable'
  | 'request_invalid'
  | 'seat_unavailable'
  | 'operation_in_progress'
  | 'lease_mismatch'
  | 'state_invalid'
  | 'broker_failure'
  | 'broker_rejected'
  | 'broker_protocol_invalid'
  | 'broker_identity_mismatch'
  | 'termination_unconfirmed'
  | 'cleanup_unconfirmed';

export class MacOsServiceUidControlError extends Error {
  readonly code: MacOsServiceUidControlErrorCode;

  constructor(code: MacOsServiceUidControlErrorCode) {
    super(code);
    this.name = 'MacOsServiceUidControlError';
    this.code = code;
  }
}

type LocalSeat =
  | { state: 'idle' }
  | {
    state: 'preparing';
    leaseId: string;
    executionId: string;
  }
  | {
    state: 'prepared';
    leaseId: string;
    executionId: string;
    preparationId: string;
  }
  | {
    state: 'starting';
    leaseId: string;
    executionId: string;
    preparationId: string;
  }
  | {
    state: 'running';
    leaseId: string;
    executionId: string;
    preparationId: string;
    runId: string;
  }
  | {
    state: 'stopping';
    leaseId: string;
    executionId: string;
    preparationId: string;
    runId: string;
  }
  | {
    state: 'stopped';
    leaseId: string;
    executionId: string;
  }
  | {
    state: 'cleaning';
    leaseId: string;
    executionId: string;
    previousState: Exclude<MacOsServiceUidSeatSnapshot['state'], 'idle' | 'cleaning'>;
  }
  | {
    state: 'quarantined';
    leaseId: string;
    executionId: string;
    reason: MacOsServiceUidQuarantineReason;
  };

export function localMacOsServiceUidHostFacts(): MacOsServiceUidHostFacts {
  const uid = process.getuid?.();
  return {
    source: 'local-process',
    platform: process.platform,
    uid: uid === undefined ? null : uid,
  };
}

export function evaluateMacOsServiceUidCapability(input: {
  deployment: MacOsServiceUidDeployment;
  host: MacOsServiceUidHostFacts;
  peerEvidence: unknown;
  expectedProductionIdentity?: MacOsServiceUidExpectedProductionIdentity | undefined;
}): MacOsServiceUidCapability {
  let peer: MacOsServiceUidPeerEvidence;
  try {
    peer = parseMacOsServiceUidPeerEvidence(input.peerEvidence);
  } catch {
    return unavailableCapability(input.deployment, 'peer_evidence_invalid');
  }
  return evaluateParsedMacOsServiceUidCapability(input, peer);
}

function evaluateParsedMacOsServiceUidCapability(
  input: Omit<Parameters<typeof evaluateMacOsServiceUidCapability>[0], 'peerEvidence'>,
  peer: MacOsServiceUidPeerEvidence,
): MacOsServiceUidCapability {
  if (peer.deployment !== input.deployment) {
    return unavailableCapability(input.deployment, 'deployment_mismatch');
  }
  if (!validHostUid(input.host.uid)) {
    return unavailableCapability(input.deployment, 'host_identity_unavailable');
  }
  if (
    peer.executionUid === input.host.uid
    || peer.executionUid === peer.brokerUid
  ) {
    return unavailableCapability(input.deployment, 'dedicated_uid_missing');
  }

  if (input.deployment === 'development') {
    if (
      peer.deployment !== 'development'
      || peer.authentication.kind !== 'development-test-double'
      || peer.codeIdentity.status !== 'unverified'
    ) return unavailableCapability(input.deployment, 'peer_evidence_invalid');
    return {
      ...capabilityBase(input.deployment),
      available: true,
      realProviderExecution: false,
      executionScope: 'fixture-only',
      assurance: 'development-test-double',
      serviceInstanceId: peer.serviceInstanceId,
      brokerUid: peer.brokerUid,
      executionUid: peer.executionUid,
    };
  }

  if (input.host.platform !== 'darwin') {
    return unavailableCapability(input.deployment, 'platform_unsupported');
  }
  if (input.host.source !== 'local-process') {
    return unavailableCapability(input.deployment, 'production_peer_untrusted');
  }
  const expected = input.expectedProductionIdentity;
  if (!expected || !validProductionIdentity(expected)) {
    return unavailableCapability(input.deployment, 'production_identity_unconfigured');
  }
  if (
    peer.deployment !== 'production'
    || peer.authentication.kind !== 'xpc-audit-token'
    || peer.codeIdentity.status !== 'verified'
  ) return unavailableCapability(input.deployment, 'production_peer_untrusted');
  if (
    peer.brokerUid !== expected.brokerUid
    || peer.executionUid !== expected.executionUid
    || peer.codeIdentity.teamIdentifier !== expected.teamIdentifier
    || peer.codeIdentity.designatedRequirement !== expected.designatedRequirement
  ) return unavailableCapability(input.deployment, 'production_identity_mismatch');
  return {
    ...capabilityBase(input.deployment),
    available: true,
    realProviderExecution: true,
    executionScope: 'real-provider',
    assurance: 'production-attested-peer',
    serviceInstanceId: peer.serviceInstanceId,
    brokerUid: peer.brokerUid,
    executionUid: peer.executionUid,
  };
}

export function connectMacOsServiceUidControlPlane(
  input: MacOsServiceUidConnectInput,
): Promise<MacOsServiceUidConnection> {
  return MacOsServiceUidControlPlane.connect(input);
}

export class MacOsServiceUidControlPlane {
  #seat: LocalSeat;
  #peerTrusted = true;

  private constructor(
    readonly capability: Extract<MacOsServiceUidCapability, { available: true }>,
    private readonly peer: MacOsServiceUidPeerEvidence,
    private readonly broker: MacOsServiceUidBroker,
    initialSeat: LocalSeat,
  ) {
    this.#seat = initialSeat;
  }

  static async connect(
    input: MacOsServiceUidConnectInput,
  ): Promise<MacOsServiceUidConnection> {
    let peer: MacOsServiceUidPeerEvidence;
    try {
      peer = parseMacOsServiceUidPeerEvidence(await input.broker.attestPeer());
    } catch {
      return {
        capability: unavailableCapability(input.deployment, 'peer_evidence_invalid'),
        controlPlane: null,
      };
    }
    const capability = evaluateParsedMacOsServiceUidCapability({
      deployment: input.deployment,
      host: input.host,
      ...(input.expectedProductionIdentity
        ? { expectedProductionIdentity: input.expectedProductionIdentity }
        : {}),
    }, peer);
    if (!capability.available) return { capability, controlPlane: null };

    const request = statusRequest();
    let rawResponse: unknown;
    try {
      rawResponse = await input.broker.request(request);
    } catch {
      return {
        capability: unavailableCapability(input.deployment, 'broker_unavailable'),
        controlPlane: null,
      };
    }
    let response: MacOsServiceUidBrokerResponse;
    try {
      response = parseMacOsServiceUidBrokerResponse(rawResponse, request);
    } catch {
      return {
        capability: unavailableCapability(input.deployment, 'broker_protocol_invalid'),
        controlPlane: null,
      };
    }
    if (!responseMatchesPeer(response, peer)) {
      return {
        capability: unavailableCapability(input.deployment, 'broker_identity_mismatch'),
        controlPlane: null,
      };
    }
    if (!response.ok || response.type !== 'status') {
      return {
        capability: unavailableCapability(input.deployment, 'broker_rejected'),
        controlPlane: null,
      };
    }
    const seat: LocalSeat = response.seat.state === 'idle'
      ? { state: 'idle' }
      : {
        state: 'quarantined',
        leaseId: response.seat.leaseId,
        executionId: response.seat.executionId,
        reason: 'orphaned_remote_seat',
      };
    return {
      capability,
      controlPlane: new MacOsServiceUidControlPlane(
        capability,
        peer,
        input.broker,
        seat,
      ),
    };
  }

  get seat(): MacOsServiceUidSeatSnapshot {
    if (this.#seat.state === 'idle') {
      return {
        state: 'idle',
        leaseId: null,
        executionId: null,
        quarantineReason: null,
      };
    }
    if (this.#seat.state === 'quarantined') {
      return {
        state: this.#seat.state,
        leaseId: this.#seat.leaseId,
        executionId: this.#seat.executionId,
        quarantineReason: this.#seat.reason,
      };
    }
    return {
      state: this.#seat.state,
      leaseId: this.#seat.leaseId,
      executionId: this.#seat.executionId,
      quarantineReason: null,
    };
  }

  async prepare(input: {
    executionId: string;
    workload: MacOsServiceUidWorkload;
    workspaceGrant: MacOsServiceUidWorkspaceGrant;
    inheritedSecretFd: number;
  }): Promise<{ leaseId: string; preparationId: string }> {
    this.#assertPeerTrusted();
    if (this.#seat.state !== 'idle') throw new MacOsServiceUidControlError('seat_unavailable');

    const leaseId = randomUUID();
    const channelId = randomUUID();
    let request: Extract<MacOsServiceUidBrokerRequest, { type: 'prepare' }>;
    let transfer: MacOsServiceUidBrokerTransfer;
    try {
      request = parseMacOsServiceUidBrokerRequest({
        backend: MACOS_SERVICE_UID_BACKEND,
        protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
        requestId: randomUUID(),
        type: 'prepare',
        leaseId,
        executionId: input.executionId,
        workload: input.workload,
        workspaceGrant: input.workspaceGrant,
        secretChannel: {
          channelId,
          transport: 'inherited-fd',
          fdIndex: 0,
          consumption: 'once',
        },
      }) as Extract<MacOsServiceUidBrokerRequest, { type: 'prepare' }>;
      transfer = parseMacOsServiceUidBrokerTransfer({
        kind: 'inherited-fd',
        channelId,
        descriptors: [input.inheritedSecretFd],
      });
    } catch {
      throw new MacOsServiceUidControlError('request_invalid');
    }
    this.#assertWorkloadAllowed(request.workload);
    this.#seat = { state: 'preparing', leaseId, executionId: request.executionId };
    const response = await this.#exchangeMutation(request, transfer);
    if (!response.ok) this.#rejectBroker(response, leaseId, request.executionId);
    if (
      response.type !== 'prepare'
      || response.leaseId !== leaseId
      || response.executionId !== request.executionId
      || !sameSeat(response.seat, 'prepared', leaseId, request.executionId)
    ) this.#protocolFailure(leaseId, request.executionId);
    this.#seat = {
      state: 'prepared',
      leaseId,
      executionId: request.executionId,
      preparationId: response.preparationId,
    };
    return { leaseId, preparationId: response.preparationId };
  }

  async start(input: { leaseId: string }): Promise<{ executionId: string; runId: string }> {
    this.#assertPeerTrusted();
    const seat = this.#seat;
    if (seat.state !== 'prepared') this.#throwForSeat(input.leaseId);
    if (seat.leaseId !== input.leaseId) throw new MacOsServiceUidControlError('lease_mismatch');
    const request = parseMacOsServiceUidBrokerRequest({
      backend: MACOS_SERVICE_UID_BACKEND,
      protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: 'start',
      leaseId: seat.leaseId,
      executionId: seat.executionId,
      preparationId: seat.preparationId,
    });
    this.#seat = { ...seat, state: 'starting' };
    const response = await this.#exchangeMutation(request);
    if (!response.ok) this.#rejectBroker(response, seat.leaseId, seat.executionId);
    if (
      response.type !== 'start'
      || response.leaseId !== seat.leaseId
      || response.executionId !== seat.executionId
      || !sameSeat(response.seat, 'running', seat.leaseId, seat.executionId)
    ) this.#protocolFailure(seat.leaseId, seat.executionId);
    this.#seat = {
      state: 'running',
      leaseId: seat.leaseId,
      executionId: seat.executionId,
      preparationId: seat.preparationId,
      runId: response.runId,
    };
    return { executionId: seat.executionId, runId: response.runId };
  }

  async stop(input: {
    leaseId: string;
    reason?: 'requested' | 'shutdown' | 'timeout';
  }): Promise<void> {
    this.#assertPeerTrusted();
    const seat = this.#seat;
    if (seat.state !== 'running') this.#throwForSeat(input.leaseId);
    if (seat.leaseId !== input.leaseId) throw new MacOsServiceUidControlError('lease_mismatch');
    const request = parseMacOsServiceUidBrokerRequest({
      backend: MACOS_SERVICE_UID_BACKEND,
      protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: 'stop',
      leaseId: seat.leaseId,
      executionId: seat.executionId,
      reason: input.reason ?? 'requested',
    });
    this.#seat = { ...seat, state: 'stopping' };
    const response = await this.#exchangeMutation(request);
    if (!response.ok) this.#rejectBroker(response, seat.leaseId, seat.executionId);
    if (
      response.type !== 'stop'
      || response.leaseId !== seat.leaseId
      || response.executionId !== seat.executionId
    ) this.#protocolFailure(seat.leaseId, seat.executionId);
    if (
      response.treeTermination !== 'confirmed'
      || response.seatUidProcessState !== 'empty'
      || !sameSeat(response.seat, 'stopped', seat.leaseId, seat.executionId)
    ) {
      this.#quarantine(seat.leaseId, seat.executionId, 'termination_unconfirmed');
      throw new MacOsServiceUidControlError('termination_unconfirmed');
    }
    this.#seat = {
      state: 'stopped',
      leaseId: seat.leaseId,
      executionId: seat.executionId,
    };
  }

  async status(): Promise<MacOsServiceUidSeatSnapshot> {
    this.#assertPeerTrusted();
    const seat = this.#seat;
    if (isTransientSeat(seat)) throw new MacOsServiceUidControlError('operation_in_progress');
    const request = statusRequest();
    let response: MacOsServiceUidBrokerResponse;
    try {
      response = await this.#exchange(request);
    } catch (error) {
      this.#quarantineExisting(quarantineReasonForExchangeError(error));
      throw stableControlError(error, 'broker_failure');
    }
    if (!response.ok || response.type !== 'status') {
      this.#quarantineExisting('broker_rejected');
      throw new MacOsServiceUidControlError('broker_rejected');
    }
    this.#reconcileStatus(response.seat);
    return this.seat;
  }

  async cleanup(input: { leaseId: string }): Promise<void> {
    this.#assertPeerTrusted();
    const seat = this.#seat;
    if (seat.state === 'idle') throw new MacOsServiceUidControlError('state_invalid');
    if (isTransientSeat(seat)) throw new MacOsServiceUidControlError('operation_in_progress');
    if (seat.leaseId !== input.leaseId) throw new MacOsServiceUidControlError('lease_mismatch');
    const request = parseMacOsServiceUidBrokerRequest({
      backend: MACOS_SERVICE_UID_BACKEND,
      protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: 'cleanup',
      leaseId: seat.leaseId,
      executionId: seat.executionId,
      disposition: 'terminate-and-scrub',
    });
    this.#seat = {
      state: 'cleaning',
      leaseId: seat.leaseId,
      executionId: seat.executionId,
      previousState: seat.state,
    };
    const response = await this.#exchangeMutation(request);
    if (!response.ok) this.#rejectBroker(response, seat.leaseId, seat.executionId);
    if (
      response.type !== 'cleanup'
      || response.leaseId !== seat.leaseId
      || response.executionId !== seat.executionId
    ) this.#protocolFailure(seat.leaseId, seat.executionId);
    if (
      response.treeTermination !== 'confirmed'
      || response.seatUidProcessState !== 'empty'
      || response.secretResidue !== 'absent'
      || response.seat.state !== 'idle'
    ) {
      this.#quarantine(seat.leaseId, seat.executionId, 'cleanup_unconfirmed');
      throw new MacOsServiceUidControlError('cleanup_unconfirmed');
    }
    this.#seat = { state: 'idle' };
  }

  async #exchangeMutation(
    request: MacOsServiceUidBrokerRequest,
    transfer?: MacOsServiceUidBrokerTransfer,
  ): Promise<MacOsServiceUidBrokerResponse> {
    try {
      return await this.#exchange(request, transfer);
    } catch (error) {
      const seat = this.#seat;
      if (seat.state !== 'idle') {
        this.#quarantine(
          seat.leaseId,
          seat.executionId,
          quarantineReasonForExchangeError(error),
        );
      }
      throw stableControlError(error, 'broker_failure');
    }
  }

  async #exchange(
    request: MacOsServiceUidBrokerRequest,
    transfer?: MacOsServiceUidBrokerTransfer,
  ): Promise<MacOsServiceUidBrokerResponse> {
    let raw: unknown;
    try {
      raw = await this.broker.request(request, transfer);
    } catch {
      throw new MacOsServiceUidControlError('broker_failure');
    }
    let response: MacOsServiceUidBrokerResponse;
    try {
      response = parseMacOsServiceUidBrokerResponse(raw, request);
    } catch {
      throw new MacOsServiceUidControlError('broker_protocol_invalid');
    }
    if (!responseMatchesPeer(response, this.peer)) {
      this.#peerTrusted = false;
      throw new MacOsServiceUidControlError('broker_identity_mismatch');
    }
    return response;
  }

  #reconcileStatus(remote: MacOsServiceUidRemoteSeat): void {
    const local = this.#seat;
    if (local.state === 'idle') {
      if (remote.state !== 'idle') {
        this.#quarantine(
          remote.leaseId,
          remote.executionId,
          'orphaned_remote_seat',
        );
      }
      return;
    }
    if (remote.state === 'idle') {
      this.#quarantine(local.leaseId, local.executionId, 'remote_state_mismatch');
      throw new MacOsServiceUidControlError('broker_protocol_invalid');
    }
    if (remote.leaseId !== local.leaseId || remote.executionId !== local.executionId) {
      this.#quarantine(local.leaseId, local.executionId, 'remote_state_mismatch');
      throw new MacOsServiceUidControlError('broker_protocol_invalid');
    }
    if (remote.state === 'quarantined') {
      this.#quarantine(local.leaseId, local.executionId, 'broker_rejected');
      return;
    }
    if (local.state === 'running' && remote.state === 'stopped') {
      this.#seat = {
        state: 'stopped',
        leaseId: local.leaseId,
        executionId: local.executionId,
      };
      return;
    }
    if (local.state === 'quarantined') return;
    if (remote.state !== local.state) {
      this.#quarantine(local.leaseId, local.executionId, 'remote_state_mismatch');
      throw new MacOsServiceUidControlError('broker_protocol_invalid');
    }
  }

  #rejectBroker(
    response: Extract<MacOsServiceUidBrokerResponse, { ok: false }>,
    leaseId: string,
    executionId: string,
  ): never {
    const remote = response.seat;
    if (
      remote.state !== 'idle'
      && remote.leaseId === leaseId
      && remote.executionId === executionId
    ) {
      this.#quarantine(remote.leaseId, remote.executionId, 'broker_rejected');
    } else {
      this.#quarantine(leaseId, executionId, 'broker_rejected');
    }
    throw new MacOsServiceUidControlError('broker_rejected');
  }

  #protocolFailure(leaseId: string, executionId: string): never {
    this.#quarantine(leaseId, executionId, 'broker_protocol_invalid');
    throw new MacOsServiceUidControlError('broker_protocol_invalid');
  }

  #quarantine(
    leaseId: string,
    executionId: string,
    reason: MacOsServiceUidQuarantineReason,
  ): void {
    this.#seat = { state: 'quarantined', leaseId, executionId, reason };
  }

  #quarantineExisting(reason: MacOsServiceUidQuarantineReason): void {
    const seat = this.#seat;
    if (seat.state !== 'idle') this.#quarantine(seat.leaseId, seat.executionId, reason);
  }

  #assertPeerTrusted(): void {
    if (!this.#peerTrusted) {
      throw new MacOsServiceUidControlError('broker_identity_mismatch');
    }
  }

  #assertWorkloadAllowed(workload: MacOsServiceUidWorkload): void {
    if (
      (this.capability.executionScope === 'fixture-only' && workload.kind !== 'fixture')
      || (this.capability.executionScope === 'real-provider' && workload.kind !== 'provider')
    ) throw new MacOsServiceUidControlError('capability_unavailable');
  }

  #throwForSeat(leaseId: string): never {
    const seat = this.#seat;
    if (seat.state !== 'idle' && seat.leaseId !== leaseId) {
      throw new MacOsServiceUidControlError('lease_mismatch');
    }
    if (isTransientSeat(seat)) {
      throw new MacOsServiceUidControlError('operation_in_progress');
    }
    throw new MacOsServiceUidControlError('state_invalid');
  }
}

function statusRequest(): Extract<MacOsServiceUidBrokerRequest, { type: 'status' }> {
  return parseMacOsServiceUidBrokerRequest({
    backend: MACOS_SERVICE_UID_BACKEND,
    protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
    requestId: randomUUID(),
    type: 'status',
  }) as Extract<MacOsServiceUidBrokerRequest, { type: 'status' }>;
}

function responseMatchesPeer(
  response: MacOsServiceUidBrokerResponse,
  peer: MacOsServiceUidPeerEvidence,
): boolean {
  return response.serviceInstanceId === peer.serviceInstanceId
    && response.brokerUid === peer.brokerUid
    && response.executionUid === peer.executionUid;
}

function sameSeat(
  seat: MacOsServiceUidRemoteSeat,
  state: Exclude<MacOsServiceUidRemoteSeat['state'], 'idle'>,
  leaseId: string,
  executionId: string,
): boolean {
  return seat.state === state
    && seat.leaseId === leaseId
    && seat.executionId === executionId;
}

function isTransientSeat(seat: LocalSeat): seat is Extract<
  LocalSeat,
  { state: 'preparing' | 'starting' | 'stopping' | 'cleaning' }
> {
  return seat.state === 'preparing'
    || seat.state === 'starting'
    || seat.state === 'stopping'
    || seat.state === 'cleaning';
}

function stableControlError(
  error: unknown,
  fallback: MacOsServiceUidControlErrorCode,
): MacOsServiceUidControlError {
  return error instanceof MacOsServiceUidControlError
    ? error
    : new MacOsServiceUidControlError(fallback);
}

function quarantineReasonForExchangeError(
  error: unknown,
): MacOsServiceUidQuarantineReason {
  if (error instanceof MacOsServiceUidControlError) {
    if (error.code === 'broker_identity_mismatch') return 'broker_identity_mismatch';
    if (error.code === 'broker_protocol_invalid') return 'broker_protocol_invalid';
  }
  return 'broker_failure';
}

function capabilityBase(deployment: MacOsServiceUidDeployment): CapabilityBase {
  return {
    backend: MACOS_SERVICE_UID_BACKEND,
    protocolVersion: MACOS_SERVICE_UID_PROTOCOL_VERSION,
    deployment,
    maxConcurrency: MACOS_SERVICE_UID_MAX_CONCURRENCY,
    secretTransport: MACOS_SERVICE_UID_SECRET_TRANSPORT,
    implementationOwnership: IMPLEMENTATION_OWNERSHIP,
  };
}

function unavailableCapability(
  deployment: MacOsServiceUidDeployment,
  reason: MacOsServiceUidCapabilityUnavailableReason,
): Extract<MacOsServiceUidCapability, { available: false }> {
  return {
    ...capabilityBase(deployment),
    available: false,
    realProviderExecution: false,
    executionScope: 'none',
    assurance: 'none',
    reason,
  };
}

function validHostUid(value: number | null): value is number {
  return value !== null
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 2_147_483_647;
}

function validProductionIdentity(
  value: MacOsServiceUidExpectedProductionIdentity,
): boolean {
  return Number.isSafeInteger(value.brokerUid)
    && value.brokerUid >= 0
    && value.brokerUid <= 2_147_483_647
    && Number.isSafeInteger(value.executionUid)
    && value.executionUid > 0
    && value.executionUid <= 2_147_483_647
    && value.brokerUid !== value.executionUid
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}[A-Za-z0-9]$/u.test(value.teamIdentifier)
    && value.designatedRequirement.length > 0
    && Buffer.byteLength(value.designatedRequirement, 'utf8') <= 1_024
    && !/[\u0000-\u001f\u007f]/u.test(value.designatedRequirement);
}
