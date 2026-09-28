import { ReviewAuthority, type ApplyChallenge, type ReviewBundle } from './review-authority.js';
import { StagingExecutionRegistry, type DesktopReviewBundle } from './staging-execution.js';
import type { WorkspaceExecutionGrant, WorkspaceGrantRegistry } from './workspace-grants.js';

export type ReviewExecutionGate = (
  executionId: string,
  ownerId: number,
  sessionNonce: string,
  workspaceId: string,
) => Promise<WorkspaceExecutionGrant>;

export class ReviewCoordinatorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReviewCoordinatorError';
  }
}

/** Main-process-only orchestration. No renderer value can invoke apply directly. */
export class DesktopReviewCoordinator {
  readonly #reviews = new Map<string, { executionId: string; ownerId: number; nonce: string }>();
  readonly #authority: ReviewAuthority;

  constructor(
    private readonly grants: WorkspaceGrantRegistry,
    private readonly staging: StagingExecutionRegistry,
    private readonly assertExecutionReady: ReviewExecutionGate,
  ) {
    this.#authority = new ReviewAuthority(grants);
  }

  async begin(
    executionId: string,
    ownerId: number,
    sessionNonce: string,
    workspaceId: string,
    stagingParentDirectory: string,
  ): Promise<void> {
    const grant = await this.#ready(executionId, ownerId, sessionNonce, workspaceId);
    if (!this.staging.has(executionId, ownerId)) {
      await this.staging.begin(executionId, ownerId, grant, stagingParentDirectory);
    }
  }

  async inspect(
    executionId: string,
    ownerId: number,
    sessionNonce: string,
    workspaceId: string,
  ): Promise<DesktopReviewBundle> {
    const grant = await this.#ready(executionId, ownerId, sessionNonce, workspaceId);
    return this.staging.inspect(executionId, ownerId, grant);
  }

  async prepare(
    bundle: DesktopReviewBundle,
    ownerId: number,
    sessionNonce: string,
  ): Promise<ApplyChallenge> {
    const grant = await this.#ready(bundle.executionId, ownerId, sessionNonce, bundle.workspaceId);
    const challenge = await this.#authority.prepare(bundle as ReviewBundle, ownerId, sessionNonce);
    if (challenge.workspaceId !== grant.workspace.id) throw new ReviewCoordinatorError('review_workspace_mismatch');
    this.#reviews.set(challenge.applyId, { executionId: bundle.executionId, ownerId, nonce: sessionNonce });
    return challenge;
  }

  async authorize(
    applyId: string,
    ownerId: number,
    sessionNonce: string,
  ): Promise<{ applied: true }> {
    const review = this.#reviews.get(applyId);
    if (!review || review.ownerId !== ownerId || review.nonce !== sessionNonce) {
      throw new ReviewCoordinatorError('apply_authorization_invalid');
    }
    await this.#authority.authorize(applyId, ownerId, sessionNonce, async (bundle, grant) => {
      const stagingBundle = bundle as DesktopReviewBundle;
      if (stagingBundle.executionId !== review.executionId) throw new ReviewCoordinatorError('review_execution_mismatch');
      await this.staging.apply(review.executionId, ownerId, grant, stagingBundle);
    });
    this.#reviews.delete(applyId);
    return { applied: true };
  }

  async reject(applyId: string, ownerId: number, sessionNonce: string): Promise<{ rejected: true }> {
    const review = this.#reviews.get(applyId);
    if (!review || review.ownerId !== ownerId || review.nonce !== sessionNonce) {
      throw new ReviewCoordinatorError('apply_authorization_invalid');
    }
    this.#authority.reject(applyId, ownerId, sessionNonce);
    await this.staging.reject(review.executionId, ownerId);
    this.#reviews.delete(applyId);
    return { rejected: true };
  }

  async cleanup(executionId: string, ownerId: number): Promise<void> {
    await this.staging.cleanup(executionId, ownerId);
    for (const [applyId, review] of this.#reviews) {
      if (review.executionId === executionId && review.ownerId === ownerId) {
        this.#reviews.delete(applyId);
      }
    }
  }

  async revokeOwner(ownerId: number): Promise<void> {
    const executions = [...new Set([...this.#reviews.values()]
      .filter((review) => review.ownerId === ownerId)
      .map((review) => review.executionId))];
    const failures: unknown[] = [];
    await Promise.all(executions.map(async (executionId) => {
      try {
        await this.staging.cleanup(executionId, ownerId);
      } catch (error) {
        failures.push(error);
      }
    }));
    for (const [applyId, review] of this.#reviews) {
      if (review.ownerId === ownerId) this.#reviews.delete(applyId);
    }
    if (failures.length > 0) throw new ReviewCoordinatorError('review_cleanup_failed');
  }

  async #ready(
    executionId: string,
    ownerId: number,
    sessionNonce: string,
    workspaceId: string,
  ): Promise<WorkspaceExecutionGrant> {
    const grant = await this.assertExecutionReady(executionId, ownerId, sessionNonce, workspaceId);
    if (grant.ownerId !== ownerId || grant.workspace.id !== workspaceId) {
      throw new ReviewCoordinatorError('review_execution_not_ready');
    }
    return this.grants.resolveExecutionGrant(workspaceId, ownerId);
  }
}
