import { createServer } from 'node:net';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createExecutionStagingWorkspace,
  createStagingReviewBundle,
  type ExecutionStagingWorkspace,
  type StagingWorkspaceApplyFaultPoint,
  type StagingWorkspaceManifest,
} from '../src/staging-workspace.js';
import { captureWorkspaceIdentity } from '../src/workspace.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('execution staging workspace', () => {
  it('creates a stable immutable review bundle bound to baseline and result hashes', async () => {
    const fixture = await createFixture();
    const staging = await createStaging(fixture);
    await writeFile(join(staging.root, 'review.txt'), 'review\n', 'utf8');
    const manifest = await staging.inspectChanges();
    const first = createStagingReviewBundle(manifest);
    const second = createStagingReviewBundle(manifest);
    expect(first).toEqual(second);
    expect(first.bundleId).toMatch(/^review_[a-f0-9]{32}$/u);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.baselineHash).toBe(manifest.baselineHash);
    expect(first.resultHash).toBe(manifest.resultHash);
    await staging.cleanup();
  });

  it('copies independently, audits changes, and mutates the source only after explicit apply', async () => {
    const fixture = await createFixture();
    const staging = await createStaging(fixture);
    const stagingRoot = staging.root;
    const sourceFileBefore = await lstat(join(fixture.workspace, 'src', 'index.ts'), {
      bigint: true,
    });
    const stagedFileBefore = await lstat(join(staging.root, 'src', 'index.ts'), {
      bigint: true,
    });

    expect(staging.root).not.toContain(`${fixture.workspace}/`);
    expect(stagedFileBefore.ino).not.toBe(sourceFileBefore.ino);
    await expect(lstat(join(staging.root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(join(staging.root, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(join(staging.root, 'created.txt'), 'created\n', 'utf8');
    await unlink(join(staging.root, 'deleted.txt'));
    await mkdir(join(staging.root, 'empty-created'));

    const manifest = await staging.inspectChanges();
    expect(manifest).toMatchObject({
      version: 1,
      executionId: 'execution_staging_test',
      source: await captureWorkspaceIdentity(fixture.workspace),
      protectedDirectoryNames: ['.git'],
      protectedPaths: ['.git'],
    });
    expect(manifest.baselineHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.resultHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.resultHash).not.toBe(manifest.baselineHash);
    expect(manifest.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'created.txt', change: 'created', before: null }),
      expect.objectContaining({ relativePath: 'deleted.txt', change: 'deleted', after: null }),
      expect.objectContaining({
        relativePath: 'empty-created',
        change: 'created',
        after: expect.objectContaining({ kind: 'directory' }),
      }),
      expect.objectContaining({
        relativePath: 'src/index.ts',
        change: 'modified',
        before: expect.objectContaining({ kind: 'file', size: 24 }),
        after: expect.objectContaining({ kind: 'file', size: 24 }),
      }),
    ]));

    expect(await readFile(join(fixture.workspace, 'src', 'index.ts'), 'utf8'))
      .toBe('export const value = 1;\n');
    await expect(lstat(join(fixture.workspace, 'created.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await staging.applyChanges(manifest);

    expect(await readFile(join(fixture.workspace, 'src', 'index.ts'), 'utf8'))
      .toBe('export const value = 2;\n');
    expect((await lstat(join(fixture.workspace, 'src', 'index.ts'), { bigint: true })).ino)
      .not.toBe(sourceFileBefore.ino);
    expect(await readFile(join(fixture.workspace, 'created.txt'), 'utf8')).toBe('created\n');
    await expect(lstat(join(fixture.workspace, 'deleted.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await lstat(join(fixture.workspace, 'empty-created'))).isDirectory()).toBe(true);
    expect(await readFile(join(fixture.workspace, '.git', 'config'), 'utf8'))
      .toBe('[core]\nrepositoryformatversion = 0\n');
    expect((await readdir(fixture.workspace)).some((name) => (
      name.startsWith('.roundtable-apply-')
    ))).toBe(false);
    await expect(staging.applyChanges(manifest)).rejects.toThrow('workspace_changed');

    await Promise.all([staging.cleanup(), staging.cleanup()]);
    await staging.cleanup();
    await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects source symlinks and removes the partial staging root', async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, 'outside.txt');
    await writeFile(outside, 'outside\n', 'utf8');
    await symlink(outside, join(fixture.workspace, 'escape'));
    const before = await readdir(fixture.stagingParent);

    await expect(createStaging(fixture)).rejects.toThrow('workspace_invalid');

    expect(await readdir(fixture.stagingParent)).toEqual(before);
    expect(await readFile(outside, 'utf8')).toBe('outside\n');
  });

  it('refuses to create staging state inside the source workspace', async () => {
    const fixture = await createFixture();
    const nestedParent = join(fixture.workspace, 'src');
    const before = await readdir(nestedParent);

    await expect(createExecutionStagingWorkspace({
      executionId: 'execution_nested_staging',
      workspace: await captureWorkspaceIdentity(fixture.workspace),
      stagingParentDirectory: nestedParent,
    })).rejects.toThrow('workspace_invalid');

    expect(await readdir(nestedParent)).toEqual(before);
  });

  it('rejects a staging parent that is not private to the host owner', async () => {
    const fixture = await createFixture();
    await chmod(fixture.stagingParent, 0o755);
    await expect(createStaging(fixture)).rejects.toThrow('workspace_invalid');
  });

  it('rejects hard links that could expose content outside the source tree', async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, 'outside.txt');
    await writeFile(outside, 'outside\n', 'utf8');
    await link(outside, join(fixture.workspace, 'hard-link'));

    await expect(createStaging(fixture)).rejects.toThrow('workspace_invalid');
    expect(await readFile(outside, 'utf8')).toBe('outside\n');
  });

  it.skipIf(process.platform === 'win32')('rejects Unix sockets as special files', async () => {
    const fixture = await createFixture();
    const socketPath = join(fixture.workspace, 'special.sock');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(createStaging(fixture)).rejects.toThrow('workspace_invalid');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects unsafe staging changes and cleanup remains idempotent', async () => {
    const fixture = await createFixture();
    const staging = await createStaging(fixture);
    const stagingRoot = staging.root;
    const outside = join(fixture.root, 'outside.txt');
    await writeFile(outside, 'outside\n', 'utf8');
    await symlink(outside, join(staging.root, 'escape'));

    await expect(staging.inspectChanges()).rejects.toThrow('workspace_scan_failed');
    await chmod(staging.root, 0o755);
    await Promise.all([staging.cleanup(), staging.cleanup()]);
    await staging.cleanup();

    expect(await readFile(outside, 'utf8')).toBe('outside\n');
    await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a tampered manifest without consuming the reviewed manifest', async () => {
    const fixture = await createFixture();
    const staging = await createStaging(fixture);
    try {
      await writeFile(join(staging.root, 'created.txt'), 'created\n', 'utf8');
      const manifest = await staging.inspectChanges();
      const first = manifest.changes[0];
      if (!first) throw new Error('expected_manifest_change');
      const tampered: StagingWorkspaceManifest = {
        ...manifest,
        changes: [{ ...first, relativePath: '../outside.txt' }, ...manifest.changes.slice(1)],
      };

      await expect(staging.applyChanges(tampered)).rejects.toThrow('workspace_changed');
      await expect(lstat(join(fixture.workspace, 'created.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await staging.applyChanges(manifest);
      expect(await readFile(join(fixture.workspace, 'created.txt'), 'utf8')).toBe('created\n');
    } finally {
      await staging.cleanup();
    }
  });

  it('applies file and directory type transitions in dependency order', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, 'file-to-directory'), 'old file\n', 'utf8');
    await mkdir(join(fixture.workspace, 'directory-to-file'));
    await writeFile(
      join(fixture.workspace, 'directory-to-file', 'child.txt'),
      'old child\n',
      'utf8',
    );
    const staging = await createStaging(fixture);
    try {
      await unlink(join(staging.root, 'file-to-directory'));
      await mkdir(join(staging.root, 'file-to-directory'));
      await writeFile(join(staging.root, 'file-to-directory', 'child.txt'), 'new child\n', 'utf8');
      await rm(join(staging.root, 'directory-to-file'), { recursive: true });
      await writeFile(join(staging.root, 'directory-to-file'), 'new file\n', 'utf8');

      const manifest = await staging.inspectChanges();
      await staging.applyChanges(manifest);

      expect(await readFile(
        join(fixture.workspace, 'file-to-directory', 'child.txt'),
        'utf8',
      )).toBe('new child\n');
      expect(await readFile(join(fixture.workspace, 'directory-to-file'), 'utf8'))
        .toBe('new file\n');
    } finally {
      await staging.cleanup();
    }
  });

  it('revalidates source paths and refuses a symlink swap before apply', async () => {
    const fixture = await createFixture();
    const staging = await createStaging(fixture);
    const outsideDirectory = join(fixture.root, 'outside-directory');
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, 'index.ts'), 'outside\n', 'utf8');
    try {
      await writeFile(join(staging.root, 'src', 'index.ts'), 'staged\n', 'utf8');
      const manifest = await staging.inspectChanges();
      await rename(join(fixture.workspace, 'src'), join(fixture.workspace, 'src-original'));
      await symlink(outsideDirectory, join(fixture.workspace, 'src'), 'dir');

      await expect(staging.applyChanges(manifest)).rejects.toThrow('workspace_changed');
      expect(await readFile(join(outsideDirectory, 'index.ts'), 'utf8')).toBe('outside\n');
    } finally {
      await staging.cleanup();
    }
  });

  it('refuses to delete an ancestor containing protected nested Git metadata', async () => {
    const fixture = await createFixture();
    const nestedGit = join(fixture.workspace, 'package', '.git');
    await mkdir(nestedGit, { recursive: true });
    await writeFile(join(nestedGit, 'config'), 'nested git metadata\n', 'utf8');
    await writeFile(join(fixture.workspace, 'package', 'keep.txt'), 'keep\n', 'utf8');
    const staging = await createStaging(fixture);
    try {
      await rm(join(staging.root, 'package'), { recursive: true });
      const manifest = await staging.inspectChanges();

      await expect(staging.applyChanges(manifest)).rejects.toThrow('workspace_changed');
      expect(await readFile(join(nestedGit, 'config'), 'utf8')).toBe('nested git metadata\n');
      expect(await readFile(join(fixture.workspace, 'package', 'keep.txt'), 'utf8')).toBe('keep\n');
    } finally {
      await staging.cleanup();
    }
  });

  it('treats case aliases of protected Git metadata as the same protected path', async () => {
    const fixture = await createFixture();
    await rename(join(fixture.workspace, '.git'), join(fixture.workspace, '.GIT'));
    const staging = await createStaging(fixture);
    try {
      await expect(lstat(join(staging.root, '.GIT'))).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(join(staging.root, '.GIT'));
      await writeFile(join(staging.root, '.GIT', 'config'), 'attacker controlled\n', 'utf8');

      await expect(staging.inspectChanges()).rejects.toThrow('workspace_scan_failed');
      expect(await readFile(join(fixture.workspace, '.GIT', 'config'), 'utf8'))
        .toBe('[core]\nrepositoryformatversion = 0\n');
    } finally {
      await staging.cleanup();
    }
  });

  it('rolls back earlier delete and modify operations when a later apply step fails', async () => {
    const fixture = await createFixture();
    const staging = await createStaging(fixture, async (point) => {
      if (point.kind === 'install_file' && point.relativePath === 'src/index.ts') {
        throw new Error('injected_after_install');
      }
    });
    try {
      await unlink(join(staging.root, 'deleted.txt'));
      await writeFile(join(staging.root, 'src', 'index.ts'), 'staged replacement\n', 'utf8');
      const manifest = await staging.inspectChanges();

      await expect(staging.applyChanges(manifest)).rejects.toThrow('workspace_changed');

      expect(await readFile(join(fixture.workspace, 'deleted.txt'), 'utf8')).toBe('delete me\n');
      expect(await readFile(join(fixture.workspace, 'src', 'index.ts'), 'utf8'))
        .toBe('export const value = 1;\n');
      expect(staging.recoveryFacts()).toBeNull();
      expect((await readdir(fixture.workspace)).some((name) => (
        name.toLocaleLowerCase('en').startsWith('.roundtable-apply-')
      ))).toBe(false);
    } finally {
      await staging.cleanup();
    }
  });

  it('preserves concurrent user content and recovery facts when rollback cannot confirm ownership', async () => {
    const fixture = await createFixture();
    let injected = false;
    const staging = await createStaging(fixture, async (point) => {
      if (
        !injected
        && point.kind === 'install_file'
        && point.relativePath === 'src/index.ts'
      ) {
        injected = true;
        await writeFile(
          join(fixture.workspace, 'src', 'index.ts'),
          'concurrent user content\n',
          'utf8',
        );
        throw new Error('injected_rollback_conflict');
      }
    });
    await writeFile(join(staging.root, 'src', 'index.ts'), 'staged replacement\n', 'utf8');
    const manifest = await staging.inspectChanges();

    await expect(staging.applyChanges(manifest))
      .rejects.toThrow('workspace_recovery_required');

    expect(await readFile(join(fixture.workspace, 'src', 'index.ts'), 'utf8'))
      .toBe('concurrent user content\n');
    expect(await readFile(join(fixture.workspace, '.git', 'config'), 'utf8'))
      .toBe('[core]\nrepositoryformatversion = 0\n');
    const recovery = staging.recoveryFacts();
    expect(recovery).toMatchObject({
      version: 1,
      executionId: 'execution_staging_test',
      state: 'quarantined',
      sourceState: 'unknown',
    });
    if (!recovery) throw new Error('expected_recovery_facts');
    expect(JSON.parse(await readFile(recovery.journalPath, 'utf8'))).toMatchObject({
      version: 1,
      transactionId: recovery.transactionId,
      baselineHash: manifest.baselineHash,
      resultHash: manifest.resultHash,
    });
    expect(JSON.parse(await readFile(recovery.statePath, 'utf8'))).toMatchObject({
      state: 'quarantined',
      sourceState: 'unknown',
      conflictCount: expect.any(Number),
    });
    await expect(staging.cleanup()).rejects.toThrow('workspace_recovery_required');
    expect((await lstat(recovery.recoveryRoot)).isDirectory()).toBe(true);
  });

  it('quarantines the transaction when a recovery subdirectory is replaced', async () => {
    const fixture = await createFixture();
    const holder: { staging?: ExecutionStagingWorkspace } = {};
    let replacementPath: string | null = null;
    const staging = await createStaging(fixture, async (point) => {
      if (point.kind !== 'backup_entry' || replacementPath !== null) return;
      const recovery = holder.staging?.recoveryFacts();
      if (!recovery) throw new Error('expected_recovery_facts');
      const prepared = join(recovery.recoveryRoot, 'prepared');
      replacementPath = join(recovery.recoveryRoot, 'prepared-original');
      await rename(prepared, replacementPath);
      await mkdir(prepared, { mode: 0o700 });
      throw new Error('injected_recovery_subdirectory_swap');
    });
    holder.staging = staging;
    await writeFile(join(staging.root, 'src', 'index.ts'), 'staged replacement\n', 'utf8');
    const manifest = await staging.inspectChanges();

    await expect(staging.applyChanges(manifest))
      .rejects.toThrow('workspace_recovery_required');

    await expect(readFile(join(fixture.workspace, 'src', 'index.ts'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const recovery = staging.recoveryFacts();
    expect(recovery).toMatchObject({
      state: 'quarantined',
      sourceState: 'unknown',
    });
    if (!recovery || !replacementPath) throw new Error('expected_quarantined_recovery');
    expect(await readFile(
      join(recovery.recoveryRoot, 'backups', '00000000'),
      'utf8',
    )).toBe('export const value = 1;\n');
    expect((await lstat(replacementPath)).isDirectory()).toBe(true);
    expect((await lstat(join(recovery.recoveryRoot, 'prepared'))).isDirectory()).toBe(true);
    await expect(staging.cleanup()).rejects.toThrow('workspace_recovery_required');
  });

  it('reserves apply synchronously and refuses cleanup while an apply is active', async () => {
    const fixture = await createFixture();
    const staging = await createStaging(fixture);
    try {
      await writeFile(join(staging.root, 'created.txt'), 'created\n', 'utf8');
      const manifest = await staging.inspectChanges();

      const outcomes = await Promise.allSettled([
        staging.applyChanges(manifest),
        staging.applyChanges(manifest),
        staging.cleanup(),
      ]);

      expect(outcomes[0]).toMatchObject({ status: 'fulfilled' });
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'workspace_changed' }),
      });
      expect(outcomes[2]).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'workspace_changed' }),
      });
      expect(await readFile(join(fixture.workspace, 'created.txt'), 'utf8')).toBe('created\n');
    } finally {
      await staging.cleanup();
    }
  });
});

async function createFixture(): Promise<{
  root: string;
  workspace: string;
  stagingParent: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-staging-test-'));
  temporaryDirectories.push(root);
  const workspace = join(root, 'workspace');
  const stagingParent = join(root, 'staging');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(workspace, '.git'));
  await mkdir(join(workspace, 'empty'));
  await mkdir(stagingParent);
  await writeFile(join(workspace, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(join(workspace, 'deleted.txt'), 'delete me\n', 'utf8');
  await writeFile(
    join(workspace, '.git', 'config'),
    '[core]\nrepositoryformatversion = 0\n',
    'utf8',
  );
  return { root, workspace, stagingParent };
}

async function createStaging(input: {
  workspace: string;
  stagingParent: string;
}, applyFaultInjectorForTesting?: (
  point: StagingWorkspaceApplyFaultPoint,
) => void | Promise<void>): Promise<ExecutionStagingWorkspace> {
  return createExecutionStagingWorkspace({
    executionId: 'execution_staging_test',
    workspace: await captureWorkspaceIdentity(input.workspace),
    stagingParentDirectory: input.stagingParent,
    ...(applyFaultInjectorForTesting ? { applyFaultInjectorForTesting } : {}),
  });
}
