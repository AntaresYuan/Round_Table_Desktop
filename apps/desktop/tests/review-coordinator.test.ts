import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DesktopReviewCoordinator } from '../src/review-coordinator.js';
import { StagingExecutionRegistry } from '../src/staging-execution.js';
import { WorkspaceGrantRegistry } from '../src/workspace-grants.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DesktopReviewCoordinator', () => {
  it('keeps readiness and apply inside the main-process coordinator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-review-coordinator-'));
    roots.push(root);
    const source = join(root, 'workspace');
    const stagingParent = join(root, 'staging-parent');
    await mkdir(source);
    await mkdir(stagingParent);
    await writeFile(join(source, 'README.md'), 'before\n', 'utf8');

    const grants = new WorkspaceGrantRegistry();
    const summary = await grants.grant(source, 51);
    const grant = await grants.resolveExecutionGrant(summary.id, 51);
    const staging = new StagingExecutionRegistry(grants);
    const coordinator = new DesktopReviewCoordinator(
      grants,
      staging,
      async (_executionId, ownerId, _nonce, workspaceId) =>
        grants.resolveExecutionGrant(workspaceId, ownerId),
    );

    await coordinator.begin('execution_review_1', 51, 'session-review-01', summary.id, stagingParent);
    const initial = await coordinator.inspect('execution_review_1', 51, 'session-review-01', summary.id);
    await writeFile(join(initial.staging.root, 'README.md'), 'after\n', 'utf8');
    const review = await coordinator.inspect('execution_review_1', 51, 'session-review-01', summary.id);
    const challenge = await coordinator.prepare(review, 51, 'session-review-01');

    await expect(coordinator.authorize(challenge.applyId, 52, 'session-review-01'))
      .rejects.toThrow('apply_authorization_invalid');
    await expect(coordinator.authorize(challenge.applyId, 51, 'session-review-01'))
      .resolves.toEqual({ applied: true });
    await expect(readFile(join(source, 'README.md'), 'utf8')).resolves.toBe('after\n');
    await expect(coordinator.authorize(challenge.applyId, 51, 'session-review-01'))
      .rejects.toThrow('apply_authorization_invalid');
    expect(grant.workspace.id).toBe(summary.id);
  });

  it('cleans pending review state when an owner is revoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-review-revoke-'));
    roots.push(root);
    const source = join(root, 'workspace');
    const stagingParent = join(root, 'staging-parent');
    await mkdir(source);
    await mkdir(stagingParent);
    await writeFile(join(source, 'README.md'), 'before\n', 'utf8');
    const grants = new WorkspaceGrantRegistry();
    const summary = await grants.grant(source, 52);
    const grant = await grants.resolveExecutionGrant(summary.id, 52);
    const coordinator = new DesktopReviewCoordinator(
      grants,
      new StagingExecutionRegistry(grants),
      async (_executionId, ownerId, _nonce, workspaceId) => grants.resolveExecutionGrant(workspaceId, ownerId),
    );
    await coordinator.begin('execution_review_2', 52, 'session-review-02', summary.id, stagingParent);
    const review = await coordinator.inspect('execution_review_2', 52, 'session-review-02', summary.id);
    const challenge = await coordinator.prepare(review, 52, 'session-review-02');
    await coordinator.revokeOwner(52);
    await expect(coordinator.authorize(challenge.applyId, 52, 'session-review-02'))
      .rejects.toThrow('apply_authorization_invalid');
    expect(grant.workspace.id).toBe(summary.id);
  });

  it('rejects a review and removes its staging transaction without touching source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-review-reject-'));
    roots.push(root);
    const source = join(root, 'workspace');
    const stagingParent = join(root, 'staging-parent');
    await mkdir(source);
    await mkdir(stagingParent);
    await writeFile(join(source, 'README.md'), 'before\n', 'utf8');
    const grants = new WorkspaceGrantRegistry();
    const summary = await grants.grant(source, 53);
    const coordinator = new DesktopReviewCoordinator(
      grants,
      new StagingExecutionRegistry(grants),
      async (_executionId, ownerId, _nonce, workspaceId) => grants.resolveExecutionGrant(workspaceId, ownerId),
    );
    await coordinator.begin('execution_review_3', 53, 'session-review-03', summary.id, stagingParent);
    const review = await coordinator.inspect('execution_review_3', 53, 'session-review-03', summary.id);
    const challenge = await coordinator.prepare(review, 53, 'session-review-03');
    await expect(coordinator.reject(challenge.applyId, 53, 'session-review-03'))
      .resolves.toEqual({ rejected: true });
    await expect(readFile(join(source, 'README.md'), 'utf8')).resolves.toBe('before\n');
    await expect(coordinator.authorize(challenge.applyId, 53, 'session-review-03'))
      .rejects.toThrow('apply_authorization_invalid');
  });

  it('surfaces a concurrent source edit as a stable staging conflict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-review-conflict-'));
    roots.push(root);
    const source = join(root, 'workspace');
    const stagingParent = join(root, 'staging-parent');
    await mkdir(source);
    await mkdir(stagingParent);
    await writeFile(join(source, 'README.md'), 'before\n', 'utf8');
    const grants = new WorkspaceGrantRegistry();
    const summary = await grants.grant(source, 54);
    const coordinator = new DesktopReviewCoordinator(
      grants,
      new StagingExecutionRegistry(grants),
      async (_executionId, ownerId, _nonce, workspaceId) => grants.resolveExecutionGrant(workspaceId, ownerId),
    );
    await coordinator.begin('execution_review_4', 54, 'session-review-04', summary.id, stagingParent);
    const initial = await coordinator.inspect('execution_review_4', 54, 'session-review-04', summary.id);
    await writeFile(join(initial.staging.root, 'README.md'), 'approved\n', 'utf8');
    const review = await coordinator.inspect('execution_review_4', 54, 'session-review-04', summary.id);
    const challenge = await coordinator.prepare(review, 54, 'session-review-04');
    await writeFile(join(source, 'README.md'), 'concurrent-edit\n', 'utf8');
    await expect(coordinator.authorize(challenge.applyId, 54, 'session-review-04'))
      .rejects.toThrow('staging_workspace_changed');
    await coordinator.cleanup('execution_review_4', 54);
  });
});
