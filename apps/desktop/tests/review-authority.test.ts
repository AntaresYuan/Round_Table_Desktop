import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { ReviewAuthority } from '../src/review-authority.js';

const grant = {
  workspace: { id: 'workspace_review_01', name: 'review' },
  ownerId: 7,
  grantRevision: 3,
  root: '/private/tmp/review',
  rootDevice: '1',
  rootInode: '2',
};

const bundleBase = {
  version: 1 as const,
  bundleId: 'review_' + 'a'.repeat(32),
  executionId: 'execution_review_01',
  workspaceId: grant.workspace.id,
  workspace: { root: grant.root, device: grant.rootDevice, inode: grant.rootInode },
  staging: { root: '/private/tmp/staging', device: '1', inode: '3' },
  protectedDirectoryNames: ['.git'],
  protectedPaths: ['.git'],
  baselineHash: 'b'.repeat(64),
  resultHash: 'c'.repeat(64),
  changes: [],
};
const contentHash = createHash('sha256').update(JSON.stringify({
  version: bundleBase.version,
  executionId: bundleBase.executionId,
  source: bundleBase.workspace,
  staging: bundleBase.staging,
  protectedDirectoryNames: bundleBase.protectedDirectoryNames,
  protectedPaths: bundleBase.protectedPaths,
  baselineHash: bundleBase.baselineHash,
  resultHash: bundleBase.resultHash,
  changes: bundleBase.changes,
})).digest('hex');
const bundle = { ...bundleBase, bundleId: `review_${contentHash.slice(0, 32)}`, contentHash };

describe('review authority', () => {
  it('binds one apply to the current grant and consumes it once', async () => {
    const grants = { resolveExecutionGrant: vi.fn().mockResolvedValue(grant) };
    const authority = new ReviewAuthority(grants as never, () => 1_000);
    const challenge = await authority.prepare(bundle, 7, 'session_review_01');
    const apply = vi.fn().mockResolvedValue(undefined);
    await authority.authorize(challenge.applyId, 7, 'session_review_01', apply);
    expect(apply).toHaveBeenCalledWith(bundle, grant);
    await expect(authority.authorize(challenge.applyId, 7, 'session_review_01', apply))
      .rejects.toThrow('apply_authorization_invalid');
  });

  it('rejects a bundle whose declared content hash no longer matches its diff', async () => {
    const grants = { resolveExecutionGrant: vi.fn().mockResolvedValue(grant) };
    const authority = new ReviewAuthority(grants as never, () => 1_000);
    await expect(authority.prepare({ ...bundle, resultHash: 'd'.repeat(64) }, 7, 'session_review_01'))
      .rejects.toThrow('review_bundle_invalid');
  });

  it('rejects a review bound to a different live workspace identity', async () => {
    const grants = { resolveExecutionGrant: vi.fn().mockResolvedValue(grant) };
    const authority = new ReviewAuthority(grants as never, () => 1_000);
    await expect(authority.prepare({
      ...bundle,
      workspace: { ...bundle.workspace, inode: 'different' },
    }, 7, 'session_review_01'))
      .rejects.toThrow('review_workspace_mismatch');
  });

  it('rejects malformed session ownership before resolving a grant', async () => {
    const resolveExecutionGrant = vi.fn().mockResolvedValue(grant);
    const authority = new ReviewAuthority({ resolveExecutionGrant } as never, () => 1_000);
    await expect(authority.prepare(bundle, 7, 'short'))
      .rejects.toThrow('apply_authorization_invalid');
    expect(resolveExecutionGrant).not.toHaveBeenCalled();
  });
});
