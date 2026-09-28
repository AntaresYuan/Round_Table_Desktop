import { opendir, realpath, stat } from 'node:fs/promises';

import {
  isPortableWorkspaceEntryName,
  type DirectoryEntrySnapshot,
  type DirectorySnapshot,
} from './workspace-grants.js';

const MAX_ENTRIES = 500;

export async function readCurrentDirectorySnapshot(): Promise<DirectorySnapshot> {
  return readDirectorySnapshotAt('.');
}

export async function readDirectorySnapshotAt(
  directoryPath: string,
): Promise<DirectorySnapshot> {
  const canonicalPath = await realpath(directoryPath);
  const identity = await stat(directoryPath, { bigint: true });
  if (!identity.isDirectory()) throw new Error('directory_reader_not_directory');

  const directory = await opendir(directoryPath);
  const entries: DirectoryEntrySnapshot[] = [];
  let truncated = false;
  try {
    for (let index = 0; index <= MAX_ENTRIES; index += 1) {
      const entry = await directory.read();
      if (!entry) break;
      if (entries.length === MAX_ENTRIES) {
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

  const afterIdentity = await stat(directoryPath, { bigint: true });
  if (identity.dev !== afterIdentity.dev || identity.ino !== afterIdentity.ino) {
    throw new Error('directory_reader_changed');
  }

  return {
    canonicalPath,
    device: afterIdentity.dev.toString(),
    inode: afterIdentity.ino.toString(),
    entries,
    truncated,
  };
}

if (process.parentPort) {
  void readCurrentDirectorySnapshot().then(
    (snapshot) => {
      process.parentPort.postMessage({ ok: true, snapshot });
    },
    () => {
      process.parentPort.postMessage({ ok: false, code: 'directory_reader_failed' });
    },
  );
}
