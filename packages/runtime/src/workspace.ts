import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { RuntimeError } from './errors.js';
import type { RuntimeArtifact, RuntimeLimits, WorkspaceIdentity } from './types.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.next', '.roundtable', 'node_modules']);

type SnapshotEntry = {
  hash: string | null;
  size: number;
  device: string;
  inode: string;
  modifiedNanoseconds: string;
};

export type WorkspaceSnapshot = {
  entries: Map<string, SnapshotEntry>;
  truncated: boolean;
};

export async function captureWorkspaceIdentity(root: string): Promise<WorkspaceIdentity> {
  if (!isAbsolute(root) || hasControlCharacters(root)) {
    throw new RuntimeError('workspace_invalid');
  }
  try {
    const canonicalRoot = await realpath(root);
    const info = await stat(canonicalRoot, { bigint: true });
    if (!info.isDirectory()) throw new RuntimeError('workspace_invalid');
    return {
      root: canonicalRoot,
      device: info.dev.toString(),
      inode: info.ino.toString(),
    };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('workspace_invalid');
  }
}

export async function assertWorkspaceIdentity(expected: WorkspaceIdentity): Promise<void> {
  try {
    const current = await captureWorkspaceIdentity(expected.root);
    if (
      current.root !== expected.root
      || current.device !== expected.device
      || current.inode !== expected.inode
    ) {
      throw new RuntimeError('workspace_changed');
    }
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'workspace_changed') throw error;
    throw new RuntimeError('workspace_changed');
  }
}

export async function scanWorkspace(
  workspace: WorkspaceIdentity,
  limits: Pick<
    RuntimeLimits,
    'maxScanFiles' | 'maxScanFileBytes' | 'maxScanTotalBytes' | 'maxScanDepth'
  >,
): Promise<WorkspaceSnapshot> {
  await assertWorkspaceIdentity(workspace);
  const entries = new Map<string, SnapshotEntry>();
  let truncated = false;
  let visitedEntries = 0;
  let hashedBytes = 0;
  const maxVisitedEntries = limits.maxScanFiles * 4 + 100;

  try {
    await walk(workspace.root, [], 0);
    await assertWorkspaceIdentity(workspace);
    return { entries, truncated };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('workspace_scan_failed');
  }

  async function walk(directory: string, segments: string[], depth: number): Promise<void> {
    if (depth > limits.maxScanDepth) {
      truncated = true;
      return;
    }
    const directoryIdentity = await lstat(directory, { bigint: true });
    const canonicalDirectory = await realpath(directory);
    if (
      !directoryIdentity.isDirectory()
      || canonicalDirectory !== directory
      || !isPathWithinWorkspace(workspace.root, canonicalDirectory)
    ) {
      throw new RuntimeError('workspace_scan_failed');
    }
    const handle = await opendir(canonicalDirectory);
    const children = [];
    try {
      const remainingEntryBudget = Math.max(0, maxVisitedEntries - visitedEntries);
      for (let index = 0; index <= remainingEntryBudget; index += 1) {
        const child = await handle.read();
        if (!child) break;
        if (index === remainingEntryBudget) {
          truncated = true;
          break;
        }
        children.push(child);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));

    for (const child of children) {
      if (entries.size >= limits.maxScanFiles) {
        truncated = true;
        return;
      }
      visitedEntries += 1;
      if (visitedEntries > maxVisitedEntries) {
        truncated = true;
        return;
      }
      if (!isPortablePathComponent(child.name)) {
        truncated = true;
        continue;
      }
      const childSegments = [...segments, child.name];
      const childPath = join(directory, child.name);
      await assertDirectoryUnchanged(directory, directoryIdentity);
      if (child.isSymbolicLink()) {
        truncated = true;
        continue;
      }
      if (child.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(child.name)) continue;
        await walk(childPath, childSegments, depth + 1);
        continue;
      }
      if (!child.isFile()) continue;

      const relativePath = childSegments.join('/');
      const snapshot = await snapshotFile(childPath, limits.maxScanFileBytes, () => (
        Math.max(0, limits.maxScanTotalBytes - hashedBytes)
      ));
      entries.set(relativePath, snapshot.entry);
      hashedBytes += snapshot.hashedBytes;
      if (snapshot.entry.hash === null) truncated = true;
    }
    await assertDirectoryUnchanged(directory, directoryIdentity);
  }
}

export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): RuntimeArtifact[] {
  const paths = [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort();
  const artifacts: RuntimeArtifact[] = [];
  for (const relativePath of paths) {
    const previous = before.entries.get(relativePath);
    const current = after.entries.get(relativePath);
    if (!previous && current) {
      artifacts.push({
        relativePath,
        change: 'created',
        hash: current.hash,
        size: current.size,
      });
    } else if (previous && !current) {
      artifacts.push({
        relativePath,
        change: 'deleted',
        hash: null,
        size: 0,
      });
    } else if (previous && current && !sameSnapshotEntry(previous, current)) {
      artifacts.push({
        relativePath,
        change: 'modified',
        hash: current.hash,
        size: current.size,
      });
    }
  }
  return artifacts;
}

export function isPathWithinWorkspace(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

async function snapshotFile(
  path: string,
  maxFileBytes: number,
  remainingTotalBytes: () => number,
): Promise<{ entry: SnapshotEntry; hashedBytes: number }> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new RuntimeError('workspace_scan_failed');
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RuntimeError('workspace_scan_failed');
    }
    let hash: string | null = null;
    let hashedBytes = 0;
    if (
      Number.isSafeInteger(size)
      && size <= maxFileBytes
      && size <= remainingTotalBytes()
    ) {
      const content = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs
      ) {
        throw new RuntimeError('workspace_scan_failed');
      }
      hash = createHash('sha256').update(content).digest('hex');
      hashedBytes = content.byteLength;
    }
    return {
      entry: {
        hash,
        size,
        device: before.dev.toString(),
        inode: before.ino.toString(),
        modifiedNanoseconds: before.mtimeNs.toString(),
      },
      hashedBytes,
    };
  } finally {
    await handle.close();
  }
}

function sameSnapshotEntry(left: SnapshotEntry, right: SnapshotEntry): boolean {
  if (left.hash !== null && right.hash !== null) return left.hash === right.hash;
  return left.size === right.size
    && left.device === right.device
    && left.inode === right.inode
    && left.modifiedNanoseconds === right.modifiedNanoseconds;
}

async function assertDirectoryUnchanged(
  directory: string,
  expected: BigIntStats,
): Promise<void> {
  const current = await lstat(directory, { bigint: true });
  const canonical = await realpath(directory);
  if (
    !current.isDirectory()
    || canonical !== directory
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || current.mtimeNs !== expected.mtimeNs
  ) {
    throw new RuntimeError('workspace_scan_failed');
  }
}

function isPortablePathComponent(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes(':')
    && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
