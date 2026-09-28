import { randomUUID } from 'node:crypto';
import { opendir, lstat, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  workspaceEntriesSchema,
  workspaceEntrySchema,
  workspaceIdSchema,
  workspaceListEntriesInputSchema,
  workspaceSummarySchema,
  type WorkspaceEntries,
  type WorkspaceEntry,
  type WorkspaceListEntriesInput,
  type WorkspaceSummary,
} from '@roundtable/protocol';

export const MAX_WORKSPACE_ENTRIES = 500;
const MAX_DIRECTORY_SNAPSHOT_ENTRIES = MAX_WORKSPACE_ENTRIES + 1;

export type DesktopCapabilityErrorCode =
  | 'workspace_directory_changed'
  | 'workspace_directory_unavailable'
  | 'workspace_not_authorized'
  | 'workspace_not_directory'
  | 'workspace_path_escape'
  | 'workspace_request_invalid'
  | 'workspace_root_unavailable';

export class DesktopCapabilityError extends Error {
  constructor(readonly code: DesktopCapabilityErrorCode) {
    super(code);
    this.name = 'DesktopCapabilityError';
  }
}

export type DirectoryEntrySnapshot = {
  name: string;
  kind: WorkspaceEntry['kind'];
};

export type DirectorySnapshot = {
  canonicalPath: string;
  device: string;
  inode: string;
  entries: DirectoryEntrySnapshot[];
  truncated: boolean;
};

export type WorkspaceDirectoryReader = (directoryPath: string) => Promise<DirectorySnapshot>;

type WorkspaceGrant = WorkspaceSummary & {
  generation: number;
  ownerId: number;
  root: string;
  rootDevice: string;
  rootInode: string;
};

/** Main-process-only capability. Never serialize this object to the Renderer. */
export type WorkspaceExecutionGrant = {
  workspace: WorkspaceSummary;
  ownerId: number;
  grantRevision: number;
  root: string;
  rootDevice: string;
  rootInode: string;
};

export class WorkspaceGrantRegistry {
  readonly #grants = new Map<string, WorkspaceGrant>();
  readonly #ownerGenerations = new Map<number, number>();

  constructor(
    private readonly directoryReader: WorkspaceDirectoryReader = readDirectorySnapshot,
  ) {}

  ownerGeneration(ownerId: number): number {
    return this.#ownerGenerations.get(ownerId) ?? 0;
  }

  async grant(
    root: string,
    ownerId: number,
    expectedGeneration = this.ownerGeneration(ownerId),
  ): Promise<WorkspaceSummary> {
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) {
      throw new DesktopCapabilityError('workspace_not_authorized');
    }
    if (expectedGeneration !== this.ownerGeneration(ownerId)) {
      throw new DesktopCapabilityError('workspace_not_authorized');
    }

    try {
      const canonicalRoot = await realpath(root);
      const rootStat = await stat(canonicalRoot, { bigint: true });
      if (!rootStat.isDirectory()) {
        throw new DesktopCapabilityError('workspace_not_directory');
      }
      if (expectedGeneration !== this.ownerGeneration(ownerId)) {
        throw new DesktopCapabilityError('workspace_not_authorized');
      }

      const summary = workspaceSummarySchema.parse({
        id: `workspace_${randomUUID()}`,
        name: basename(canonicalRoot) || 'Workspace',
      });
      const grantRevision = expectedGeneration + 1;
      this.#deleteOwnerGrants(ownerId);
      this.#ownerGenerations.set(ownerId, grantRevision);
      this.#grants.set(summary.id, {
        ...summary,
        generation: grantRevision,
        ownerId,
        root: canonicalRoot,
        rootDevice: rootStat.dev.toString(),
        rootInode: rootStat.ino.toString(),
      });
      return summary;
    } catch (error) {
      if (error instanceof DesktopCapabilityError) throw error;
      throw new DesktopCapabilityError('workspace_root_unavailable');
    }
  }

  async resolveExecutionGrant(
    rawWorkspaceId: string,
    ownerId: number,
  ): Promise<WorkspaceExecutionGrant> {
    const workspaceId = workspaceIdSchema.safeParse(rawWorkspaceId);
    if (!workspaceId.success) {
      throw new DesktopCapabilityError('workspace_request_invalid');
    }
    const grant = this.#grants.get(workspaceId.data);
    if (
      !grant
      || grant.ownerId !== ownerId
      || grant.generation !== this.ownerGeneration(ownerId)
    ) {
      throw new DesktopCapabilityError('workspace_not_authorized');
    }

    try {
      await this.#assertRootIdentity(grant);
      if (grant.generation !== this.ownerGeneration(ownerId)) {
        throw new DesktopCapabilityError('workspace_not_authorized');
      }
      return {
        workspace: { id: grant.id, name: grant.name },
        ownerId: grant.ownerId,
        grantRevision: grant.generation,
        root: grant.root,
        rootDevice: grant.rootDevice,
        rootInode: grant.rootInode,
      };
    } catch (error) {
      if (error instanceof DesktopCapabilityError) throw error;
      throw new DesktopCapabilityError('workspace_root_unavailable');
    }
  }

  async listEntries(
    rawInput: WorkspaceListEntriesInput,
    ownerId: number,
  ): Promise<WorkspaceEntries> {
    const parsedInput = workspaceListEntriesInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new DesktopCapabilityError('workspace_request_invalid');
    }
    const input = parsedInput.data;
    const grant = this.#grants.get(input.workspaceId);
    if (
      !grant
      || grant.ownerId !== ownerId
      || grant.generation !== this.ownerGeneration(ownerId)
    ) {
      throw new DesktopCapabilityError('workspace_not_authorized');
    }

    try {
      await this.#assertRootIdentity(grant);
      const segments = input.relativePath === '' ? [] : input.relativePath.split('/');
      const requestedPath = resolve(grant.root, ...segments);
      if (!isPathWithinRoot(grant.root, requestedPath)) {
        throw new DesktopCapabilityError('workspace_path_escape');
      }

      const requestedPathInfo = await lstat(requestedPath);
      if (requestedPathInfo.isSymbolicLink()) {
        throw new DesktopCapabilityError('workspace_path_escape');
      }
      const canonicalPath = await realpath(requestedPath);
      if (!isPathWithinRoot(grant.root, canonicalPath)) {
        throw new DesktopCapabilityError('workspace_path_escape');
      }
      const expectedIdentity = await stat(canonicalPath, { bigint: true });
      if (!expectedIdentity.isDirectory()) {
        throw new DesktopCapabilityError('workspace_not_directory');
      }

      const snapshot = validateDirectorySnapshot(await this.directoryReader(canonicalPath));
      if (
        !isSamePath(canonicalPath, snapshot.canonicalPath)
        || !isPathWithinRoot(grant.root, snapshot.canonicalPath)
        || expectedIdentity.dev.toString() !== snapshot.device
        || expectedIdentity.ino.toString() !== snapshot.inode
      ) {
        throw new DesktopCapabilityError('workspace_directory_changed');
      }
      await this.#assertRootIdentity(grant);
      if (grant.generation !== this.ownerGeneration(ownerId)) {
        throw new DesktopCapabilityError('workspace_not_authorized');
      }

      const visibleEntries: WorkspaceEntry[] = [];
      let omittedUnsupportedEntry = false;
      for (const entry of snapshot.entries.slice(0, MAX_WORKSPACE_ENTRIES)) {
        const relativePath = input.relativePath === ''
          ? entry.name
          : `${input.relativePath}/${entry.name}`;
        const parsedEntry = workspaceEntrySchema.safeParse({
          name: entry.name,
          relativePath,
          kind: entry.kind,
        });
        if (parsedEntry.success) visibleEntries.push(parsedEntry.data);
        else omittedUnsupportedEntry = true;
      }
      visibleEntries.sort(compareWorkspaceEntries);

      return workspaceEntriesSchema.parse({
        workspace: { id: grant.id, name: grant.name },
        relativePath: input.relativePath,
        entries: visibleEntries,
        truncated: snapshot.truncated
          || snapshot.entries.length > MAX_WORKSPACE_ENTRIES
          || omittedUnsupportedEntry,
      });
    } catch (error) {
      if (error instanceof DesktopCapabilityError) throw error;
      throw new DesktopCapabilityError('workspace_directory_unavailable');
    }
  }

  revokeOwner(ownerId: number): void {
    this.#deleteOwnerGrants(ownerId);
    this.#ownerGenerations.set(ownerId, this.ownerGeneration(ownerId) + 1);
  }

  #deleteOwnerGrants(ownerId: number): void {
    for (const [workspaceId, grant] of this.#grants) {
      if (grant.ownerId === ownerId) this.#grants.delete(workspaceId);
    }
  }

  async #assertRootIdentity(grant: WorkspaceGrant): Promise<void> {
    const rootIdentity = await stat(grant.root, { bigint: true });
    if (
      !rootIdentity.isDirectory()
      || rootIdentity.dev.toString() !== grant.rootDevice
      || rootIdentity.ino.toString() !== grant.rootInode
    ) {
      throw new DesktopCapabilityError('workspace_directory_changed');
    }
  }
}

export async function readDirectorySnapshot(directoryPath: string): Promise<DirectorySnapshot> {
  const canonicalPath = await realpath(directoryPath);
  const before = await stat(canonicalPath, { bigint: true });
  if (!before.isDirectory()) throw new DesktopCapabilityError('workspace_not_directory');

  const directory = await opendir(canonicalPath);
  const entries: DirectoryEntrySnapshot[] = [];
  let truncated = false;
  try {
    for (let index = 0; index < MAX_DIRECTORY_SNAPSHOT_ENTRIES; index += 1) {
      const entry = await directory.read();
      if (!entry) break;
      if (entries.length === MAX_WORKSPACE_ENTRIES) {
        truncated = true;
        break;
      }
      if (!isPortableWorkspaceEntryName(entry.name)) {
        truncated = true;
        continue;
      }
      entries.push({
        name: entry.name,
        kind: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other',
      });
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  const afterCanonicalPath = await realpath(directoryPath);
  const after = await stat(afterCanonicalPath, { bigint: true });
  if (
    !isSamePath(canonicalPath, afterCanonicalPath)
    || before.dev !== after.dev
    || before.ino !== after.ino
  ) {
    throw new DesktopCapabilityError('workspace_directory_changed');
  }

  return {
    canonicalPath: afterCanonicalPath,
    device: after.dev.toString(),
    inode: after.ino.toString(),
    entries,
    truncated,
  };
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

export function isPortableWorkspaceEntryName(name: string): boolean {
  return name.length > 0
    && name.length <= 255
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes(':')
    && !/[\u0000-\u001f\u007f]/u.test(name);
}

function isSamePath(left: string, right: string): boolean {
  return relative(left, right) === '' && relative(right, left) === '';
}

function compareWorkspaceEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function validateDirectorySnapshot(rawSnapshot: unknown): DirectorySnapshot {
  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    throw new DesktopCapabilityError('workspace_directory_unavailable');
  }
  const snapshot = rawSnapshot as Partial<DirectorySnapshot>;
  if (
    typeof snapshot.canonicalPath !== 'string'
    || snapshot.canonicalPath.length === 0
    || snapshot.canonicalPath.length > 32_768
    || typeof snapshot.device !== 'string'
    || !/^\d{1,40}$/u.test(snapshot.device)
    || typeof snapshot.inode !== 'string'
    || !/^\d{1,40}$/u.test(snapshot.inode)
    || !Array.isArray(snapshot.entries)
    || snapshot.entries.length > MAX_DIRECTORY_SNAPSHOT_ENTRIES
    || typeof snapshot.truncated !== 'boolean'
  ) {
    throw new DesktopCapabilityError('workspace_directory_unavailable');
  }
  for (const entry of snapshot.entries) {
    if (
      !entry
      || typeof entry !== 'object'
      || typeof (entry as DirectoryEntrySnapshot).name !== 'string'
      || !isPortableWorkspaceEntryName((entry as DirectoryEntrySnapshot).name)
      || !['directory', 'file', 'symlink', 'other']
        .includes((entry as DirectoryEntrySnapshot).kind)
    ) {
      throw new DesktopCapabilityError('workspace_directory_unavailable');
    }
  }
  return snapshot as DirectorySnapshot;
}
