import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DesktopCapabilityError,
  isPathWithinRoot,
  WorkspaceGrantRegistry,
} from '../src/workspace-grants.js';
import { readDirectorySnapshotAt } from '../src/directory-reader-child.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'roundtable-desktop-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'src'));
  await mkdir(join(directory, 'src', 'components'));
  await writeFile(join(directory, 'src', 'components', 'Button.tsx'), 'export {}\n', 'utf8');
  await writeFile(join(directory, 'README.md'), '# Demo\n', 'utf8');
  return directory;
}

describe('WorkspaceGrantRegistry', () => {
  it('produces a bounded snapshot in the one-shot reader', async () => {
    const root = await temporaryWorkspace();

    const snapshot = await readDirectorySnapshotAt(root);

    expect(snapshot.canonicalPath).toBe(await realpath(root));
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      { name: 'README.md', kind: 'file' },
      { name: 'src', kind: 'directory' },
    ]));
    expect(snapshot.entries.length).toBeLessThanOrEqual(500);
  });

  it('returns opaque workspace metadata and relative entries only', async () => {
    const root = await temporaryWorkspace();
    const registry = new WorkspaceGrantRegistry();
    const workspace = await registry.grant(root, 7);
    const result = await registry.listEntries({ workspaceId: workspace.id, relativePath: '' }, 7);

    expect(workspace).toEqual({
      id: expect.stringMatching(/^workspace_/u),
      name: basename(root),
    });
    expect(result.entries).toEqual([
      { name: 'README.md', relativePath: 'README.md', kind: 'file' },
      { name: 'src', relativePath: 'src', kind: 'directory' },
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('lists valid multilevel relative paths', async () => {
    const root = await temporaryWorkspace();
    const registry = new WorkspaceGrantRegistry();
    const workspace = await registry.grant(root, 7);

    const result = await registry.listEntries({
      workspaceId: workspace.id,
      relativePath: 'src/components',
    }, 7);

    expect(result.relativePath).toBe('src/components');
    expect(result.entries).toEqual([
      { name: 'Button.tsx', relativePath: 'src/components/Button.tsx', kind: 'file' },
    ]);
  });

  it('binds grants to one owner and revokes them on teardown', async () => {
    const root = await temporaryWorkspace();
    const registry = new WorkspaceGrantRegistry();
    const workspace = await registry.grant(root, 7);

    await expect(registry.listEntries({
      workspaceId: workspace.id,
      relativePath: '',
    }, 8)).rejects.toThrow('workspace_not_authorized');

    registry.revokeOwner(7);
    await expect(registry.listEntries({
      workspaceId: workspace.id,
      relativePath: '',
    }, 7)).rejects.toThrow('workspace_not_authorized');
  });

  it('rejects a workspace symlink that points outside the authorized root', async () => {
    const root = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    await symlink(outside, join(root, 'escape'), 'dir');
    const registry = new WorkspaceGrantRegistry();
    const workspace = await registry.grant(root, 7);

    await expect(registry.listEntries({
      workspaceId: workspace.id,
      relativePath: 'escape',
    }, 7)).rejects.toThrow('workspace_path_escape');
  });

  it('returns stable errors without exposing the authorized absolute path', async () => {
    const root = await temporaryWorkspace();
    const registry = new WorkspaceGrantRegistry();
    const workspace = await registry.grant(root, 7);

    const failure = await registry.listEntries({
      workspaceId: workspace.id,
      relativePath: 'missing',
    }, 7).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DesktopCapabilityError);
    expect(String(failure)).toContain('workspace_directory_unavailable');
    expect(String(failure)).not.toContain(root);
  });

  it('rejects a reader snapshot if the opened directory identity changed', async () => {
    const root = await temporaryWorkspace();
    const canonicalRoot = await realpath(root);
    const identity = await stat(canonicalRoot, { bigint: true });
    const registry = new WorkspaceGrantRegistry(async () => ({
      canonicalPath: canonicalRoot,
      device: identity.dev.toString(),
      inode: (identity.ino + 1n).toString(),
      entries: [],
      truncated: false,
    }));
    const workspace = await registry.grant(root, 7);

    await expect(registry.listEntries({
      workspaceId: workspace.id,
      relativePath: '',
    }, 7)).rejects.toThrow('workspace_directory_changed');
  });

  it('caps the returned listing even when the directory has more entries', async () => {
    const root = await temporaryWorkspace();
    const canonicalRoot = await realpath(root);
    const identity = await stat(canonicalRoot, { bigint: true });
    const registry = new WorkspaceGrantRegistry(async () => ({
      canonicalPath: canonicalRoot,
      device: identity.dev.toString(),
      inode: identity.ino.toString(),
      entries: Array.from({ length: 501 }, (_, index) => ({
        name: `file-${String(index).padStart(3, '0')}.txt`,
        kind: 'file' as const,
      })),
      truncated: true,
    }));
    const workspace = await registry.grant(root, 7);

    const result = await registry.listEntries({
      workspaceId: workspace.id,
      relativePath: '',
    }, 7);

    expect(result.entries).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('atomically replaces the previous active grant for an owner', async () => {
    const firstRoot = await temporaryWorkspace();
    const secondRoot = await temporaryWorkspace();
    const registry = new WorkspaceGrantRegistry();
    const first = await registry.grant(firstRoot, 7);
    const second = await registry.grant(secondRoot, 7);

    await expect(registry.listEntries({
      workspaceId: first.id,
      relativePath: '',
    }, 7)).rejects.toThrow('workspace_not_authorized');
    await expect(registry.listEntries({
      workspaceId: second.id,
      relativePath: '',
    }, 7)).resolves.toMatchObject({ workspace: second });
  });

  it('rejects a late grant from an owner generation that was revoked', async () => {
    const root = await temporaryWorkspace();
    const registry = new WorkspaceGrantRegistry();
    const generation = registry.ownerGeneration(7);
    registry.revokeOwner(7);

    await expect(registry.grant(root, 7, generation))
      .rejects.toThrow('workspace_not_authorized');
  });

  it('rejects a root path whose directory identity was replaced after authorization', async () => {
    const root = await temporaryWorkspace();
    const registry = new WorkspaceGrantRegistry();
    const workspace = await registry.grant(root, 7);
    const originalRoot = `${root}-original`;
    await rename(root, originalRoot);
    temporaryDirectories.push(originalRoot);
    await mkdir(root);

    await expect(registry.listEntries({
      workspaceId: workspace.id,
      relativePath: '',
    }, 7)).rejects.toThrow('workspace_directory_changed');
  });
});

describe('isPathWithinRoot', () => {
  it('accepts the root and descendants but rejects siblings', () => {
    const root = resolve('/tmp', 'roundtable-root');

    expect(isPathWithinRoot(root, root)).toBe(true);
    expect(isPathWithinRoot(root, join(root, 'src', 'index.ts'))).toBe(true);
    expect(isPathWithinRoot(root, resolve(root, '..', 'roundtable-root-copy'))).toBe(false);
  });
});
