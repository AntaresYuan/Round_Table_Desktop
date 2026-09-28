import {
  createExecutionStagingWorkspace,
  createStagingReviewBundle,
  type ExecutionStagingWorkspace,
  type StagingReviewBundle,
  type StagingWorkspaceManifest,
} from '@roundtable/runtime';

import type { WorkspaceExecutionGrant } from './workspace-grants.js';

type ActiveStagingExecution = {
  ownerId: number;
  grant: WorkspaceExecutionGrant;
  workspace: ExecutionStagingWorkspace;
  manifest: StagingWorkspaceManifest | null;
  review: DesktopReviewBundle | null;
};

export type DesktopReviewBundle = StagingReviewBundle & { workspaceId: string };

export class StagingExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'StagingExecutionError';
  }
}

/** Main-process-only registry. Provider and Renderer never receive this object. */
export class StagingExecutionRegistry {
  readonly #active = new Map<string, ActiveStagingExecution>();

  constructor(private readonly grants: import('./workspace-grants.js').WorkspaceGrantRegistry) {}

  async begin(
    executionId: string,
    ownerId: number,
    grant: WorkspaceExecutionGrant,
    stagingParentDirectory: string,
  ): Promise<void> {
    if (this.#active.has(executionId)) throw new StagingExecutionError('staging_execution_duplicate');
    const current = await this.grants.resolveExecutionGrant(grant.workspace.id, ownerId);
    assertGrant(current, grant);
    const workspace = await createExecutionStagingWorkspace({
      executionId,
      workspace: {
        root: grant.root,
        device: grant.rootDevice,
        inode: grant.rootInode,
      },
      stagingParentDirectory,
    });
    this.#active.set(executionId, { ownerId, grant, workspace, manifest: null, review: null });
  }

  /** Transfers a pre-launch staging transaction to the final execution id
   * without recopying the source or changing its baseline. */
  rekey(fromExecutionId: string, toExecutionId: string, ownerId: number): void {
    if (fromExecutionId === toExecutionId || this.#active.has(toExecutionId)) {
      throw new StagingExecutionError('staging_execution_duplicate');
    }
    const active = this.#active.get(fromExecutionId);
    if (!active || active.ownerId !== ownerId) {
      throw new StagingExecutionError('staging_execution_not_authorized');
    }
    this.#active.delete(fromExecutionId);
    this.#active.set(toExecutionId, active);
  }

  has(executionId: string, ownerId: number): boolean {
    const active = this.#active.get(executionId);
    return active?.ownerId === ownerId;
  }

  stagingIdentity(
    executionId: string,
    ownerId: number,
  ): { root: string; device: string; inode: string } {
    const active = this.#get(executionId, ownerId);
    return {
      root: active.workspace.root,
      device: active.workspace.staging.device,
      inode: active.workspace.staging.inode,
    };
  }

  async inspect(
    executionId: string,
    ownerId: number,
    grant: WorkspaceExecutionGrant,
  ): Promise<DesktopReviewBundle> {
    const active = this.#get(executionId, ownerId);
    assertGrant(active.grant, grant);
    const current = await this.grants.resolveExecutionGrant(grant.workspace.id, ownerId);
    assertGrant(current, grant);
    const manifest = await active.workspace.inspectChanges();
    const review: DesktopReviewBundle = Object.freeze({
      ...createStagingReviewBundle(manifest),
      workspaceId: grant.workspace.id,
    });
    active.manifest = manifest;
    active.review = review;
    return review;
  }

  async apply(
    executionId: string,
    ownerId: number,
    grant: WorkspaceExecutionGrant,
    review: DesktopReviewBundle,
  ): Promise<void> {
    const active = this.#get(executionId, ownerId);
    assertGrant(active.grant, grant);
    const current = await this.grants.resolveExecutionGrant(grant.workspace.id, ownerId);
    assertGrant(current, grant);
    if (!active.manifest || !active.review
      || active.review.bundleId !== review.bundleId
      || active.review.contentHash !== review.contentHash) {
      throw new StagingExecutionError('staging_review_invalid');
    }
    let currentManifest: StagingWorkspaceManifest;
    try {
      currentManifest = await active.workspace.inspectChanges();
    } catch (error) {
      if (error instanceof Error && error.message === 'workspace_changed') {
        throw new StagingExecutionError('staging_workspace_changed');
      }
      throw error;
    }
    const currentReview = createStagingReviewBundle(currentManifest);
    if (currentReview.bundleId !== review.bundleId
      || currentReview.contentHash !== review.contentHash) {
      throw new StagingExecutionError('staging_review_stale');
    }
    try {
      await active.workspace.applyChanges(currentManifest);
    } catch (error) {
      if (error instanceof Error && error.message === 'workspace_recovery_required') {
        throw new StagingExecutionError('staging_recovery_required');
      }
      if (error instanceof Error && error.message === 'workspace_changed') {
        throw new StagingExecutionError('staging_workspace_changed');
      }
      throw error;
    }
    this.#active.delete(executionId);
  }

  async reject(executionId: string, ownerId: number): Promise<void> {
    const active = this.#get(executionId, ownerId);
    await active.workspace.cleanup();
    this.#active.delete(executionId);
  }

  async cleanup(executionId: string, ownerId: number): Promise<void> {
    const active = this.#get(executionId, ownerId);
    await active.workspace.cleanup();
    this.#active.delete(executionId);
  }

  #get(executionId: string, ownerId: number): ActiveStagingExecution {
    const active = this.#active.get(executionId);
    if (!active || active.ownerId !== ownerId) throw new StagingExecutionError('staging_execution_not_authorized');
    return active;
  }
}

function assertGrant(expected: WorkspaceExecutionGrant, actual: WorkspaceExecutionGrant): void {
  if (expected.ownerId !== actual.ownerId
    || expected.workspace.id !== actual.workspace.id
    || expected.grantRevision !== actual.grantRevision
    || expected.root !== actual.root
    || expected.rootDevice !== actual.rootDevice
    || expected.rootInode !== actual.rootInode) {
    throw new StagingExecutionError('staging_grant_stale');
  }
}
