import { createHash, randomUUID } from 'node:crypto';

import type { WorkspaceExecutionGrant, WorkspaceGrantRegistry } from './workspace-grants.js';

export type ReviewChange = {
  relativePath: string;
  change: 'created' | 'modified' | 'deleted';
  before: unknown;
  after: unknown;
};

export type ReviewBundle = {
  version: 1;
  bundleId: string;
  executionId: string;
  workspaceId: string;
  workspace: { root: string; device: string; inode: string };
  staging: { root: string; device: string; inode: string };
  protectedDirectoryNames: readonly string[];
  protectedPaths: readonly string[];
  baselineHash: string;
  resultHash: string;
  changes: readonly ReviewChange[];
  contentHash: string;
};

export type ApplyChallenge = {
  applyId: string;
  bundleId: string;
  executionId: string;
  workspaceId: string;
  baselineHash: string;
  contentHash: string;
  expiresAt: string;
};

type PendingApply = ApplyChallenge & {
  ownerId: number;
  sessionNonce: string;
  grant: WorkspaceExecutionGrant;
  bundle: ReviewBundle;
  consumed: boolean;
};

export class ReviewAuthorityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReviewAuthorityError';
  }
}

export class ReviewAuthority {
  readonly #pending = new Map<string, PendingApply>();
  constructor(
    private readonly grants: WorkspaceGrantRegistry,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async prepare(
    bundle: ReviewBundle,
    ownerId: number,
    sessionNonce: string,
  ): Promise<ApplyChallenge> {
    if (!Number.isSafeInteger(ownerId) || ownerId < 0
      || !/^[A-Za-z0-9._:-]{16,128}$/u.test(sessionNonce)) {
      throw new ReviewAuthorityError('apply_authorization_invalid');
    }
    if (!/^[a-f0-9]{64}$/u.test(bundle.contentHash)
      || bundle.bundleId !== `review_${bundle.contentHash.slice(0, 32)}`) {
      throw new ReviewAuthorityError('review_bundle_invalid');
    }
    const canonical = JSON.stringify({
      version: bundle.version,
      executionId: bundle.executionId,
      source: bundle.workspace,
      staging: bundle.staging,
      protectedDirectoryNames: bundle.protectedDirectoryNames,
      protectedPaths: bundle.protectedPaths,
      baselineHash: bundle.baselineHash,
      resultHash: bundle.resultHash,
      changes: bundle.changes,
    });
    const expectedHash = createHash('sha256').update(canonical).digest('hex');
    if (expectedHash !== bundle.contentHash) {
      throw new ReviewAuthorityError('review_bundle_invalid');
    }
    const grant = await this.grants.resolveExecutionGrant(bundle.workspaceId ?? '', ownerId);
    if (
      bundle.workspace.root !== grant.root
      || bundle.workspace.device !== grant.rootDevice
      || bundle.workspace.inode !== grant.rootInode
    ) {
      throw new ReviewAuthorityError('review_workspace_mismatch');
    }
    const applyId = `apply_${randomUUID()}`;
    const challenge: ApplyChallenge = {
      applyId,
      bundleId: bundle.bundleId,
      executionId: bundle.executionId,
      workspaceId: grant.workspace.id,
      baselineHash: bundle.baselineHash,
      contentHash: bundle.contentHash,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    };
    this.#pending.set(applyId, {
      ...challenge,
      ownerId,
      sessionNonce,
      grant,
      bundle,
      consumed: false,
    });
    return challenge;
  }

  async authorize(
    applyId: string,
    ownerId: number,
    sessionNonce: string,
    apply: (bundle: ReviewBundle, grant: WorkspaceExecutionGrant) => Promise<void>,
  ): Promise<void> {
    const pending = this.#pending.get(applyId);
    if (!pending || pending.consumed || pending.ownerId !== ownerId
      || pending.sessionNonce !== sessionNonce
      || Date.parse(pending.expiresAt) <= this.now()) {
      throw new ReviewAuthorityError('apply_authorization_invalid');
    }
    const current = await this.grants.resolveExecutionGrant(pending.workspaceId, ownerId);
    if (!sameGrant(pending.grant, current)) {
      throw new ReviewAuthorityError('apply_authorization_stale');
    }
    pending.consumed = true;
    await apply(pending.bundle, current);
    this.#pending.delete(applyId);
  }

  reject(applyId: string, ownerId: number, sessionNonce: string): void {
    const pending = this.#pending.get(applyId);
    if (!pending || pending.ownerId !== ownerId || pending.sessionNonce !== sessionNonce) {
      throw new ReviewAuthorityError('apply_authorization_invalid');
    }
    this.#pending.delete(applyId);
  }
}

function sameGrant(left: WorkspaceExecutionGrant, right: WorkspaceExecutionGrant): boolean {
  return left.workspace.id === right.workspace.id
    && left.root === right.root
    && left.rootDevice === right.rootDevice
    && left.rootInode === right.rootInode
    && left.grantRevision === right.grantRevision;
}
