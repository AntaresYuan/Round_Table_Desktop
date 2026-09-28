import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_LIMITS } from '../src/runtime.js';
import {
  assertWorkspaceIdentity,
  captureWorkspaceIdentity,
  diffWorkspaceSnapshots,
  scanWorkspace,
} from '../src/workspace.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-workspace-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(join(root, 'deleted.txt'), 'delete me\n', 'utf8');
  return root;
}

describe('bounded workspace snapshots', () => {
  it('returns relative hashes and detects created, modified, and deleted files', async () => {
    const root = await temporaryWorkspace();
    const identity = await captureWorkspaceIdentity(root);
    const before = await scanWorkspace(identity, DEFAULT_RUNTIME_LIMITS);
    await writeFile(join(root, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(join(root, 'created.txt'), 'created\n', 'utf8');
    await unlink(join(root, 'deleted.txt'));
    const after = await scanWorkspace(identity, DEFAULT_RUNTIME_LIMITS);

    expect(diffWorkspaceSnapshots(before, after)).toEqual([
      expect.objectContaining({ relativePath: 'created.txt', change: 'created' }),
      expect.objectContaining({
        relativePath: 'deleted.txt',
        change: 'deleted',
        hash: null,
        size: 0,
      }),
      expect.objectContaining({ relativePath: 'src/index.ts', change: 'modified' }),
    ]);
    expect([...after.entries.keys()]).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\//u)]));
    expect(after.entries.get('created.txt')?.hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('does not follow symlinks and marks the bounded result as truncated', async () => {
    const root = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    await symlink(outside, join(root, 'escape'), 'dir');
    const snapshot = await scanWorkspace(await captureWorkspaceIdentity(root), DEFAULT_RUNTIME_LIMITS);

    expect(snapshot.truncated).toBe(true);
    expect([...snapshot.entries.keys()].some((path) => path.startsWith('escape/'))).toBe(false);
  });

  it('rejects a root whose device/inode identity was replaced', async () => {
    const root = await temporaryWorkspace();
    const identity = await captureWorkspaceIdentity(root);
    const original = `${root}-old`;
    await rename(root, original);
    temporaryDirectories.push(original);
    await mkdir(root);

    await expect(assertWorkspaceIdentity(identity)).rejects.toThrow('workspace_changed');
  });

  it('marks a nested scan as truncated when the exact file cap hides later siblings', async () => {
    const root = await temporaryWorkspace();
    const snapshot = await scanWorkspace(await captureWorkspaceIdentity(root), {
      ...DEFAULT_RUNTIME_LIMITS,
      maxScanFiles: 1,
    });

    expect(snapshot.entries.size).toBe(1);
    expect(snapshot.truncated).toBe(true);
  });

  it('marks a scan as truncated when the depth budget hides a nested file', async () => {
    const root = await temporaryWorkspace();
    await mkdir(join(root, 'src', 'nested'));
    await writeFile(join(root, 'src', 'nested', 'hidden.txt'), 'hidden\n', 'utf8');

    const snapshot = await scanWorkspace(await captureWorkspaceIdentity(root), {
      ...DEFAULT_RUNTIME_LIMITS,
      maxScanDepth: 1,
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.entries.has('src/nested/hidden.txt')).toBe(false);
  });

  it('marks an over-budget file as unhashed and the scan as truncated', async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, 'oversized.bin'), Buffer.alloc(2_048, 1));

    const snapshot = await scanWorkspace(await captureWorkspaceIdentity(root), {
      ...DEFAULT_RUNTIME_LIMITS,
      maxScanFileBytes: 1_024,
    });

    expect(snapshot.entries.get('oversized.bin')).toMatchObject({
      hash: null,
      size: 2_048,
    });
    expect(snapshot.truncated).toBe(true);
  });
});
