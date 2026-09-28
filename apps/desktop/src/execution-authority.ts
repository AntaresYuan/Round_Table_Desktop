import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  missionApprovalPreviewSchema,
  missionExecutionAcceptedSchema,
  missionPrepareInputSchema,
  runtimeCatalogEntrySchema,
  runtimeCatalogSchema,
  runtimeExecutionEventSchema,
  runtimeExecutionSnapshotSchema,
  type MissionApprovalPreview,
  type MissionExecutionAccepted,
  type MissionPrepareInput,
  type RuntimeCatalog,
  type RuntimeCatalogEntry,
  type RuntimeExecutionEvent,
  type RuntimeExecutionSnapshot,
} from '@roundtable/protocol';

import {
  DesktopCapabilityError,
  type WorkspaceExecutionGrant,
  type WorkspaceGrantRegistry,
} from './workspace-grants.js';
import {
  ReviewAuthority,
  type ApplyChallenge,
  type ReviewBundle,
} from './review-authority.js';

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000;
const MAX_APPROVALS_PER_OWNER = 8;
const MAX_EXECUTIONS_PER_OWNER = 16;
const MAX_SUMMARY_CHARS = 16_000;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'stopped', 'timed_out']);

export type PreparedRuntimeProvider = {
  preparationToken: string;
  catalogEntry: RuntimeCatalogEntry;
};

export type RuntimeLaunchRequest = {
  preparationToken: string;
  missionId: string;
  executionId: string;
  workspaceId: string;
  workspaceRoot: string;
  rootDevice: string;
  rootInode: string;
  grantRevision: number;
  provider: MissionPrepareInput['provider'];
  prompt: string;
  timeoutMs: number;
};

export type DesktopRuntimePort = {
  getCatalog(): Promise<RuntimeCatalog>;
  prepare(input: {
    provider: MissionPrepareInput['provider'];
    missionId: string;
    promptDigest: string;
    workspaceId: string;
    workspaceRoot: string;
    rootDevice: string;
    rootInode: string;
    grantRevision: number;
  }): Promise<PreparedRuntimeProvider>;
  launch(input: RuntimeLaunchRequest): Promise<void>;
  stop(executionId: string): Promise<RuntimeExecutionEvent>;
  onEvent(listener: (event: RuntimeExecutionEvent) => void): () => void;
};

export class DesktopExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DesktopExecutionError';
  }
}

type ApprovalChallenge = {
  approvalId: string;
  missionId: string;
  ownerId: number;
  windowSessionNonce: string;
  grant: WorkspaceExecutionGrant;
  provider: MissionPrepareInput['provider'];
  prompt: string;
  promptDigest: Buffer;
  prepared: PreparedRuntimeProvider;
  executionWorkspace: PreparedExecutionWorkspace | null;
  expiresAtMs: number;
  consumed: boolean;
};

export type PreparedExecutionWorkspace = {
  root: string;
  rootDevice: string;
  rootInode: string;
  commit(executionId: string): Promise<void> | void;
  cleanup(): Promise<void>;
};

type OwnedExecution = {
  ownerId: number;
  windowSessionNonce: string;
  snapshot: RuntimeExecutionSnapshot;
};

export type OwnedExecutionEvent = {
  ownerId: number;
  windowSessionNonce: string;
  event: RuntimeExecutionEvent;
};

type DesktopExecutionAuthorityOptions = {
  grants: WorkspaceGrantRegistry;
  runtime: DesktopRuntimePort;
  now?: (() => number) | undefined;
  approvalTtlMs?: number | undefined;
  prepareExecutionWorkspace?: ((input: {
    missionId: string;
    ownerId: number;
    grant: WorkspaceExecutionGrant;
  }) => Promise<PreparedExecutionWorkspace>) | undefined;
};

export class DesktopExecutionAuthority {
  readonly #approvals = new Map<string, ApprovalChallenge>();
  readonly #executions = new Map<string, OwnedExecution>();
  readonly #listeners = new Set<(event: OwnedExecutionEvent) => void>();
  readonly #now: () => number;
  readonly #approvalTtlMs: number;
  readonly #disposeRuntimeListener: () => void;
  readonly #reviewAuthority: ReviewAuthority;

  constructor(private readonly options: DesktopExecutionAuthorityOptions) {
    this.#now = options.now ?? Date.now;
    this.#approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.#reviewAuthority = new ReviewAuthority(options.grants, this.#now);
    this.#disposeRuntimeListener = options.runtime.onEvent((event) => {
      this.#applyRuntimeEvent(event);
    });
  }

  async getCatalog(): Promise<RuntimeCatalog> {
    return runtimeCatalogSchema.parse(await this.options.runtime.getCatalog());
  }

  async prepareMission(
    rawInput: MissionPrepareInput,
    ownerId: number,
    windowSessionNonce: string,
  ): Promise<MissionApprovalPreview> {
    this.#assertOwner(ownerId, windowSessionNonce);
    await this.#pruneApprovals();
    const input = missionPrepareInputSchema.parse(rawInput);
    if (this.#countOwnerApprovals(ownerId) >= MAX_APPROVALS_PER_OWNER) {
      throw new DesktopExecutionError('mission_approval_limit');
    }
    if (this.hasActiveExecution(ownerId)) {
      throw new DesktopExecutionError('execution_already_active');
    }

    const beforeGrant = await this.options.grants.resolveExecutionGrant(
      input.workspaceId,
      ownerId,
    );
    const missionId = `mission_${randomUUID()}`;
    const promptDigest = digestPrompt(input.prompt);
    const executionWorkspace = this.options.prepareExecutionWorkspace
      ? await this.options.prepareExecutionWorkspace({ missionId, ownerId, grant: beforeGrant })
      : null;
    let prepared: PreparedRuntimeProvider;
    try {
      prepared = await this.options.runtime.prepare({
        provider: input.provider,
        missionId,
        promptDigest: promptDigest.toString('hex'),
        workspaceId: beforeGrant.workspace.id,
        workspaceRoot: executionWorkspace?.root ?? beforeGrant.root,
        rootDevice: executionWorkspace?.rootDevice ?? beforeGrant.rootDevice,
        rootInode: executionWorkspace?.rootInode ?? beforeGrant.rootInode,
        grantRevision: beforeGrant.grantRevision,
      });
    } catch (error) {
      await cleanupPreparedWorkspace(executionWorkspace);
      throw error;
    }
    let catalogEntry: RuntimeCatalogEntry;
    let grant: WorkspaceExecutionGrant;
    try {
      catalogEntry = runtimeCatalogEntrySchema.parse(prepared.catalogEntry);
      if (catalogEntry.provider !== input.provider || !catalogEntry.available) {
        throw new DesktopExecutionError('runtime_provider_unavailable');
      }
      grant = await this.options.grants.resolveExecutionGrant(input.workspaceId, ownerId);
      if (!sameGrant(beforeGrant, grant)) {
        throw new DesktopCapabilityError('workspace_not_authorized');
      }
    } catch (error) {
      await cleanupPreparedWorkspace(executionWorkspace);
      throw error;
    }

    const approvalId = `approval_${randomUUID()}`;
    const expiresAtMs = this.#now() + this.#approvalTtlMs;
    this.#approvals.set(approvalId, {
      approvalId,
      missionId,
      ownerId,
      windowSessionNonce,
      grant,
      provider: input.provider,
      prompt: input.prompt,
      promptDigest,
      prepared,
      executionWorkspace,
      expiresAtMs,
      consumed: false,
    });

    return missionApprovalPreviewSchema.parse({
      approvalId,
      missionId,
      workspace: grant.workspace,
      provider: input.provider,
      prompt: input.prompt,
      policy: catalogEntry.policy,
      warnings: catalogEntry.warnings,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  async approveMission(
    approvalId: string,
    ownerId: number,
    windowSessionNonce: string,
  ): Promise<MissionExecutionAccepted> {
    this.#assertOwner(ownerId, windowSessionNonce);
    await this.#pruneApprovals();
    const challenge = this.#approvals.get(approvalId);
    if (
      !challenge
      || challenge.ownerId !== ownerId
      || challenge.windowSessionNonce !== windowSessionNonce
      || challenge.consumed
      || challenge.expiresAtMs <= this.#now()
    ) {
      throw new DesktopExecutionError('mission_approval_invalid');
    }
    this.#makeExecutionCapacity(ownerId);
    if (this.hasActiveExecution(ownerId)) {
      throw new DesktopExecutionError('execution_already_active');
    }

    const currentGrant = await this.options.grants.resolveExecutionGrant(
      challenge.grant.workspace.id,
      ownerId,
    );
    if (
      !sameGrant(challenge.grant, currentGrant)
      || !sameDigest(challenge.promptDigest, digestPrompt(challenge.prompt))
    ) {
      throw new DesktopExecutionError('mission_approval_stale');
    }

    const executionId = `execution_${randomUUID()}`;
    try {
      await challenge.executionWorkspace?.commit(executionId);
    } catch {
      throw new DesktopExecutionError('staging_prepare_failed');
    }
    challenge.consumed = true;
    const snapshot = runtimeExecutionSnapshotSchema.parse({
      missionId: challenge.missionId,
      executionId,
      workspace: currentGrant.workspace,
      provider: challenge.provider,
      state: 'queued',
      sequence: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
      summary: '',
      treeTermination: 'not-required',
      logs: [],
      artifacts: [],
    });
    this.#executions.set(executionId, {
      ownerId,
      windowSessionNonce,
      snapshot,
    });

    try {
      await this.options.runtime.launch({
        preparationToken: challenge.prepared.preparationToken,
        missionId: challenge.missionId,
        executionId,
        workspaceId: currentGrant.workspace.id,
        workspaceRoot: challenge.executionWorkspace?.root ?? currentGrant.root,
        rootDevice: challenge.executionWorkspace?.rootDevice ?? currentGrant.rootDevice,
        rootInode: challenge.executionWorkspace?.rootInode ?? currentGrant.rootInode,
        grantRevision: currentGrant.grantRevision,
        provider: challenge.provider,
        prompt: challenge.prompt,
        timeoutMs: challenge.prepared.catalogEntry.policy.timeoutMs,
      });
    } catch (error) {
      const current = this.#executions.get(executionId)?.snapshot;
      if (current && current.sequence === 0) {
        this.#applyRuntimeEvent(runtimeExecutionEventSchema.parse({
          missionId: challenge.missionId,
          executionId,
          sequence: 1,
          occurredAt: new Date(this.#now()).toISOString(),
          type: 'state',
          state: 'failed',
          error: stableRuntimeFailure(error),
          treeTermination: 'not-required',
        }));
      }
      if (current && current.sequence === 0) {
        await cleanupPreparedWorkspace(challenge.executionWorkspace);
      }
      throw new DesktopExecutionError('runtime_launch_failed');
    }

    return missionExecutionAcceptedSchema.parse({
      missionId: challenge.missionId,
      executionId,
      state: this.#executions.get(executionId)?.snapshot.state ?? 'failed',
    });
  }

  getExecution(
    executionId: string,
    ownerId: number,
    windowSessionNonce: string,
  ): RuntimeExecutionSnapshot {
    this.#assertOwner(ownerId, windowSessionNonce);
    const execution = this.#executions.get(executionId);
    if (
      !execution
      || execution.ownerId !== ownerId
      || execution.windowSessionNonce !== windowSessionNonce
    ) {
      throw new DesktopExecutionError('execution_not_authorized');
    }
    return runtimeExecutionSnapshotSchema.parse(execution.snapshot);
  }

  async stopExecution(
    executionId: string,
    ownerId: number,
    windowSessionNonce: string,
  ): Promise<RuntimeExecutionSnapshot> {
    const current = this.getExecution(executionId, ownerId, windowSessionNonce);
    if (TERMINAL_STATES.has(current.state) && current.treeTermination !== 'failed') return current;
    const terminalEvent = runtimeExecutionEventSchema.parse(
      await this.options.runtime.stop(executionId),
    );
    this.#applyRuntimeEvent(terminalEvent);
    const stopped = this.getExecution(executionId, ownerId, windowSessionNonce);
    if (!TERMINAL_STATES.has(stopped.state) || stopped.treeTermination === 'failed') {
      throw new DesktopExecutionError('execution_stop_unconfirmed');
    }
    return stopped;
  }

  async prepareApplyReview(
    bundle: ReviewBundle,
    ownerId: number,
    windowSessionNonce: string,
  ): Promise<ApplyChallenge> {
    this.#assertOwner(ownerId, windowSessionNonce);
    const execution = this.getExecution(bundle.executionId, ownerId, windowSessionNonce);
    if (!TERMINAL_STATES.has(execution.state) || execution.treeTermination !== 'confirmed') {
      throw new DesktopExecutionError('execution_not_ready_for_apply');
    }
    if (bundle.workspaceId !== execution.workspace.id) {
      throw new DesktopExecutionError('review_workspace_mismatch');
    }
    return this.#reviewAuthority.prepare(bundle, ownerId, windowSessionNonce);
  }

  async authorizeApplyReview(
    applyId: string,
    ownerId: number,
    windowSessionNonce: string,
    apply: (bundle: ReviewBundle, grant: WorkspaceExecutionGrant) => Promise<void>,
  ): Promise<void> {
    this.#assertOwner(ownerId, windowSessionNonce);
    await this.#reviewAuthority.authorize(applyId, ownerId, windowSessionNonce, apply);
  }

  hasActiveExecution(ownerId: number): boolean {
    for (const execution of this.#executions.values()) {
      if (execution.ownerId === ownerId && executionBlocksAdmission(execution.snapshot)) {
        return true;
      }
    }
    return false;
  }

  onEvent(listener: (event: OwnedExecutionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async revokeOwner(ownerId: number): Promise<void> {
    const approvalCleanups: Promise<void>[] = [];
    for (const [approvalId, challenge] of this.#approvals) {
      if (challenge.ownerId === ownerId) {
        this.#approvals.delete(approvalId);
        if (!challenge.consumed && challenge.executionWorkspace) {
          approvalCleanups.push(challenge.executionWorkspace.cleanup());
        }
      }
    }
    const cleanupResults = await Promise.allSettled(approvalCleanups);
    const cleanupFailed = cleanupResults.some((result) => result.status === 'rejected');
    const stops: Promise<unknown>[] = [];
    for (const execution of this.#executions.values()) {
      if (execution.ownerId !== ownerId || !executionBlocksAdmission(execution.snapshot)) continue;
      stops.push(this.options.runtime.stop(execution.snapshot.executionId).then((event) => {
        this.#applyRuntimeEvent(event);
        const reconciled = this.#executions.get(execution.snapshot.executionId)?.snapshot;
        if (!reconciled || executionBlocksAdmission(reconciled)) {
          throw new DesktopExecutionError('execution_stop_unconfirmed');
        }
      }));
    }
    await Promise.all(stops);
    if (cleanupFailed) throw new DesktopExecutionError('staging_cleanup_failed');
  }

  dispose(): void {
    this.#disposeRuntimeListener();
    this.#listeners.clear();
    this.#approvals.clear();
  }

  #applyRuntimeEvent(rawEvent: RuntimeExecutionEvent): void {
    const parsed = runtimeExecutionEventSchema.safeParse(rawEvent);
    if (!parsed.success) return;
    const event = parsed.data;
    const owned = this.#executions.get(event.executionId);
    if (!owned || owned.snapshot.missionId !== event.missionId) return;
    if (event.sequence <= owned.snapshot.sequence) return;
    if (event.sequence !== owned.snapshot.sequence + 1) return;
    const reconcilingUnconfirmedTree = TERMINAL_STATES.has(owned.snapshot.state)
      && owned.snapshot.treeTermination === 'failed';
    if (TERMINAL_STATES.has(owned.snapshot.state) && !reconcilingUnconfirmedTree) return;
    if (
      reconcilingUnconfirmedTree
      && (
        event.type !== 'state'
        || !TERMINAL_STATES.has(event.state)
        || event.treeTermination !== 'confirmed'
      )
    ) return;

    const next = structuredClone(owned.snapshot);
    next.sequence = event.sequence;
    if (event.type === 'state') {
      next.state = event.state;
      next.error = event.error;
      next.treeTermination = event.treeTermination;
      if (event.state === 'running' && next.startedAt === null) next.startedAt = event.occurredAt;
      if (TERMINAL_STATES.has(event.state)) next.finishedAt = event.occurredAt;
    } else if (event.type === 'output') {
      next.logs.push({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        stream: event.stream,
        text: event.text,
      });
      if (next.logs.length > 256) next.logs.splice(0, next.logs.length - 256);
      if (event.stream === 'stdout') {
        next.summary = `${next.summary}${next.summary ? '\n' : ''}${event.text}`
          .slice(-MAX_SUMMARY_CHARS);
      }
    } else {
      const index = next.artifacts.findIndex((artifact) => (
        artifact.relativePath === event.artifact.relativePath
      ));
      if (index === -1) {
        next.artifacts.push(event.artifact);
        if (next.artifacts.length > 200) {
          next.artifacts.splice(0, next.artifacts.length - 200);
        }
      }
      else next.artifacts[index] = event.artifact;
    }
    owned.snapshot = runtimeExecutionSnapshotSchema.parse(next);
    for (const listener of this.#listeners) {
      try {
        listener({
          ownerId: owned.ownerId,
          windowSessionNonce: owned.windowSessionNonce,
          event,
        });
      } catch {
        // Runtime ownership cannot depend on an individual UI event sink.
      }
    }
  }

  async #pruneApprovals(): Promise<void> {
    const now = this.#now();
    const cleanups: Promise<void>[] = [];
    for (const [approvalId, challenge] of this.#approvals) {
      if (challenge.consumed || challenge.expiresAtMs <= now) {
        this.#approvals.delete(approvalId);
        if (!challenge.consumed && challenge.executionWorkspace) {
          cleanups.push(challenge.executionWorkspace.cleanup());
        }
      }
    }
    const results = await Promise.allSettled(cleanups);
    if (results.some((result) => result.status === 'rejected')) {
      throw new DesktopExecutionError('staging_cleanup_failed');
    }
  }

  #countOwnerApprovals(ownerId: number): number {
    let count = 0;
    for (const challenge of this.#approvals.values()) {
      if (challenge.ownerId === ownerId && !challenge.consumed) count += 1;
    }
    return count;
  }

  #countOwnerExecutions(ownerId: number): number {
    let count = 0;
    for (const execution of this.#executions.values()) {
      if (execution.ownerId === ownerId) count += 1;
    }
    return count;
  }

  #makeExecutionCapacity(ownerId: number): void {
    while (this.#countOwnerExecutions(ownerId) >= MAX_EXECUTIONS_PER_OWNER) {
      const oldestTerminal = [...this.#executions.entries()].find(([, execution]) => (
        execution.ownerId === ownerId
        && TERMINAL_STATES.has(execution.snapshot.state)
        && execution.snapshot.treeTermination !== 'failed'
      ));
      if (!oldestTerminal) throw new DesktopExecutionError('execution_limit');
      this.#executions.delete(oldestTerminal[0]);
    }
  }

  #assertOwner(ownerId: number, windowSessionNonce: string): void {
    if (
      !Number.isSafeInteger(ownerId)
      || ownerId < 0
      || typeof windowSessionNonce !== 'string'
      || windowSessionNonce.length < 16
      || windowSessionNonce.length > 128
    ) {
      throw new DesktopExecutionError('execution_not_authorized');
    }
  }
}

function sameGrant(left: WorkspaceExecutionGrant, right: WorkspaceExecutionGrant): boolean {
  return left.ownerId === right.ownerId
    && left.workspace.id === right.workspace.id
    && left.grantRevision === right.grantRevision
    && left.root === right.root
    && left.rootDevice === right.rootDevice
    && left.rootInode === right.rootInode;
}

function digestPrompt(prompt: string): Buffer {
  return createHash('sha256').update(prompt, 'utf8').digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function stableRuntimeFailure(error: unknown): string {
  if (error instanceof DesktopExecutionError) return error.code;
  return 'runtime_launch_failed';
}

async function cleanupPreparedWorkspace(
  workspace: PreparedExecutionWorkspace | null,
): Promise<void> {
  if (!workspace) return;
  try {
    await workspace.cleanup();
  } catch {
    throw new DesktopExecutionError('staging_cleanup_failed');
  }
}

function executionBlocksAdmission(snapshot: RuntimeExecutionSnapshot): boolean {
  return !TERMINAL_STATES.has(snapshot.state) || snapshot.treeTermination === 'failed';
}
