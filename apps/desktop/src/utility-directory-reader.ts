import { utilityProcess, type UtilityProcess } from 'electron';

import {
  DesktopCapabilityError,
  type DirectorySnapshot,
  type WorkspaceDirectoryReader,
} from './workspace-grants.js';

const DIRECTORY_READER_TIMEOUT_MS = 5_000;

export type DisposableWorkspaceDirectoryReader = WorkspaceDirectoryReader & {
  dispose(): void;
};

export function createUtilityDirectoryReader(
  modulePath: string,
): DisposableWorkspaceDirectoryReader {
  const activeChildren = new Map<UtilityProcess, () => void>();
  let disposed = false;

  const read = ((directoryPath: string) => new Promise<DirectorySnapshot>((resolve, reject) => {
    if (disposed) {
      reject(new DesktopCapabilityError('workspace_directory_unavailable'));
      return;
    }

    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(modulePath, [], {
        cwd: directoryPath,
        env: {
          LANG: 'C',
          LC_ALL: 'C',
        },
        serviceName: 'Roundtable Workspace Reader',
        stdio: 'ignore',
      });
    } catch {
      reject(new DesktopCapabilityError('workspace_directory_unavailable'));
      return;
    }

    let exited = false;
    let settled = false;
    let spawned = false;

    const terminate = () => {
      if (exited) return;
      child.kill();
    };
    const finish = (result: { snapshot: DirectorySnapshot } | { error: true }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners('message');
      child.removeAllListeners('error');
      terminate();
      if ('snapshot' in result) resolve(result.snapshot);
      else reject(new DesktopCapabilityError('workspace_directory_unavailable'));
    };

    activeChildren.set(child, () => finish({ error: true }));
    child.once('spawn', () => {
      spawned = true;
      if (settled || disposed) terminate();
    });
    child.once('message', (message: unknown) => {
      if (!message || typeof message !== 'object') {
        finish({ error: true });
        return;
      }
      const result = message as { ok?: unknown; snapshot?: unknown };
      if (result.ok !== true || !result.snapshot || typeof result.snapshot !== 'object') {
        finish({ error: true });
        return;
      }
      finish({ snapshot: result.snapshot as DirectorySnapshot });
    });
    child.once('error', () => finish({ error: true }));
    child.once('exit', () => {
      exited = true;
      activeChildren.delete(child);
      if (!settled) finish({ error: true });
    });

    const timeout = setTimeout(() => finish({ error: true }), DIRECTORY_READER_TIMEOUT_MS);
    timeout.unref();

    // `kill()` can return false until the utility process emits `spawn`. The spawn
    // listener must remain installed after timeout/dispose so a late child is reaped.
    if (disposed && !spawned) finish({ error: true });
  })) as DisposableWorkspaceDirectoryReader;

  read.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const abort of activeChildren.values()) abort();
  };

  return read;
}
