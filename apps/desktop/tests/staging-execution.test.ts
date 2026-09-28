import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StagingExecutionError, StagingExecutionRegistry } from '../src/staging-execution.js';
import { WorkspaceGrantRegistry } from '../src/workspace-grants.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ source: string; stagingParent: string }> {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-staging-exec-'));
  roots.push(root);
  const source = join(root, 'source');
  const stagingParent = join(root, 'staging-parent');
  await (await import('node:fs/promises')).mkdir(source);
  await (await import('node:fs/promises')).mkdir(stagingParent);
  await writeFile(join(source, 'README.md'), 'before\n', 'utf8');
  return { source, stagingParent };
}

describe('StagingExecutionRegistry', () => {
  it('binds staging, review and apply to the live workspace grant', async () => {
    const { source, stagingParent } = await fixture();
    const grants = new WorkspaceGrantRegistry();
    const summary = await grants.grant(source, 41);
    const grant = await grants.resolveExecutionGrant(summary.id, 41);
    const registry = new StagingExecutionRegistry(grants);

    await registry.begin('exec_staging_1', 41, grant, stagingParent);
    const initial = await registry.inspect('exec_staging_1', 41, grant);
    await writeFile(join(initial.staging.root, 'README.md'), 'after\n', 'utf8');
    const review = await registry.inspect('exec_staging_1', 41, grant);
    expect(review.workspaceId).toBe(summary.id);
    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'README.md', change: 'modified' }),
    ]));

    await registry.apply('exec_staging_1', 41, grant, review);
    await expect(readFile(join(source, 'README.md'), 'utf8')).resolves.toBe('after\n');
    await expect(registry.inspect('exec_staging_1', 41, grant))
      .rejects.toThrow('staging_execution_not_authorized');
  });

  it('rejects a review if staging changes after inspection', async () => {
    const { source, stagingParent } = await fixture();
    const grants = new WorkspaceGrantRegistry();
    const summary = await grants.grant(source, 42);
    const grant = await grants.resolveExecutionGrant(summary.id, 42);
    const registry = new StagingExecutionRegistry(grants);
    await registry.begin('exec_staging_2', 42, grant, stagingParent);
    const review = await registry.inspect('exec_staging_2', 42, grant);
    await writeFile(join(review.staging.root, 'README.md'), 'tampered\n', 'utf8');

    await expect(registry.apply('exec_staging_2', 42, grant, review))
      .rejects.toBeInstanceOf(StagingExecutionError);
    await expect(readFile(join(source, 'README.md'), 'utf8')).resolves.toBe('before\n');
    await registry.cleanup('exec_staging_2', 42);
  });

  it('rekeys a pre-launch transaction without changing its staging identity', async () => {
    const { source, stagingParent } = await fixture();
    const grants = new WorkspaceGrantRegistry();
    const summary = await grants.grant(source, 45);
    const grant = await grants.resolveExecutionGrant(summary.id, 45);
    const registry = new StagingExecutionRegistry(grants);
    await registry.begin('mission_staging_5', 45, grant, stagingParent);
    const before = registry.stagingIdentity('mission_staging_5', 45);
    registry.rekey('mission_staging_5', 'execution_staging_5', 45);
    expect(registry.stagingIdentity('execution_staging_5', 45)).toEqual(before);
    await expect(registry.inspect('mission_staging_5', 45, grant))
      .rejects.toThrow('staging_execution_not_authorized');
    await registry.cleanup('execution_staging_5', 45);
  });

  it('fails closed when the workspace grant is revoked before apply', async () => {
    const { source, stagingParent } = await fixture();
    const grants = new WorkspaceGrantRegistry();
    const summary = await grants.grant(source, 43);
    const grant = await grants.resolveExecutionGrant(summary.id, 43);
    const registry = new StagingExecutionRegistry(grants);
    await registry.begin('exec_staging_3', 43, grant, stagingParent);
    const review = await registry.inspect('exec_staging_3', 43, grant);

    grants.revokeOwner(43);
    await expect(registry.apply('exec_staging_3', 43, grant, review))
      .rejects.toThrow('workspace_not_authorized');
    await expect(readFile(join(source, 'README.md'), 'utf8')).resolves.toBe('before\n');
  });

  it('rejects apply when the real workspace changes after review', async () => {
    const { source, stagingParent } = await fixture();
    const grants = new WorkspaceGrantRegistry();
    const summary = await grants.grant(source, 44);
    const grant = await grants.resolveExecutionGrant(summary.id, 44);
    const registry = new StagingExecutionRegistry(grants);
    await registry.begin('exec_staging_4', 44, grant, stagingParent);
    const initial = await registry.inspect('exec_staging_4', 44, grant);
    await writeFile(join(initial.staging.root, 'README.md'), 'approved\n', 'utf8');
    const review = await registry.inspect('exec_staging_4', 44, grant);
    await writeFile(join(source, 'README.md'), 'concurrent-edit\n', 'utf8');

    await expect(registry.apply('exec_staging_4', 44, grant, review))
      .rejects.toThrow();
    await expect(readFile(join(source, 'README.md'), 'utf8'))
      .resolves.toBe('concurrent-edit\n');
    await registry.cleanup('exec_staging_4', 44);
  });
});
