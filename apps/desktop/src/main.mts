import { app, BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_ORIGIN,
  registerAppProtocol,
  registerAppSchemePrivileges,
} from './app-protocol.js';
import { secureDesktopSession } from './desktop-session.js';
import { DesktopExecutionAuthority } from './execution-authority.js';
import { registerDesktopIpcHandlers } from './ipc-handlers.js';
import { DesktopReviewCoordinator } from './review-coordinator.js';
import { StagingExecutionRegistry } from './staging-execution.js';
import { UtilityAgentRuntime } from './utility-agent-runtime.js';
import { createUtilityDirectoryReader } from './utility-directory-reader.js';
import { secureDesktopWindowLifecycle } from './window-lifecycle.js';
import {
  createWindowOptions,
  DESKTOP_SESSION_PARTITION,
} from './window-options.js';
import { WorkspaceGrantRegistry } from './workspace-grants.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectoryReader = createUtilityDirectoryReader(
  join(currentDirectory, 'directory-reader-child.mjs'),
);
const workspaceGrants = new WorkspaceGrantRegistry(workspaceDirectoryReader);
const windowSessionNonces = new Map<number, string>();
let mainWindow: BrowserWindow | null = null;
let executionAuthority: DesktopExecutionAuthority | null = null;
let reviewCoordinator: DesktopReviewCoordinator | null = null;
let agentRuntime: UtilityAgentRuntime | null = null;

type DesktopQuitCoordinatorOptions = {
  shutdown(): Promise<void>;
  quit(): void;
  onFailure(): void;
  timeoutMs: number;
};

type PreventableQuitEvent = {
  preventDefault(): void;
};

registerAppSchemePrivileges();
app.enableSandbox();

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow(
    createWindowOptions(join(currentDirectory, 'preload.cjs')),
  );

  secureDesktopWindowLifecycle(window, workspaceGrants, {
    onCapabilitiesRevoked: (ownerId) => {
      windowSessionNonces.delete(ownerId);
      void executionAuthority?.revokeOwner(ownerId).catch(() => {
        console.error('[desktop] runtime_owner_revocation_failed');
        void agentRuntime?.shutdown().catch(() => {
          console.error('[desktop] runtime_emergency_shutdown_failed');
        });
      });
      void reviewCoordinator?.revokeOwner(ownerId).catch(() => {
        console.error('[desktop] review_owner_revocation_failed');
      });
    },
    onFailure: (failure) => {
      console.error(`[desktop] ${failure}`);
    },
  });
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  mainWindow = window;
  try {
    await window.loadURL(`${APP_ORIGIN}/index.html`);
  } catch {
    if (mainWindow === window) mainWindow = null;
    if (!window.isDestroyed()) window.destroy();
    throw new Error('desktop_renderer_load_failed');
  }
  return window;
}

async function bootstrapDesktop(): Promise<void> {
  await app.whenReady();
  agentRuntime = new UtilityAgentRuntime({
    modulePath: join(currentDirectory, 'local-agent-runtime-child.mjs'),
    stateRoot: join(app.getPath('userData'), 'runtime-v1'),
    sourceHome: homedir(),
    searchDirectories: [join(homedir(), '.local', 'bin')],
  });
  const staging = new StagingExecutionRegistry(workspaceGrants);
  executionAuthority = new DesktopExecutionAuthority({
    grants: workspaceGrants,
    runtime: agentRuntime,
    prepareExecutionWorkspace: async ({ missionId, ownerId, grant }) => {
      const stagingParentDirectory = join(app.getPath('userData'), 'staging-v1');
      await staging.begin(missionId, ownerId, grant, stagingParentDirectory);
      try {
        const identity = staging.stagingIdentity(missionId, ownerId);
        let activeExecutionId = missionId;
        return {
          root: identity.root,
          rootDevice: identity.device,
          rootInode: identity.inode,
          commit: (executionId: string) => {
            staging.rekey(activeExecutionId, executionId, ownerId);
            activeExecutionId = executionId;
          },
          cleanup: () => staging.cleanup(activeExecutionId, ownerId),
        };
      } catch (error) {
        await staging.cleanup(missionId, ownerId).catch(() => undefined);
        throw error;
      }
    },
  });
  reviewCoordinator = new DesktopReviewCoordinator(
    workspaceGrants,
    staging,
    async (executionId, ownerId, sessionNonce, workspaceId) => {
      const execution = executionAuthority?.getExecution(executionId, ownerId, sessionNonce);
      if (!execution || execution.workspace.id !== workspaceId
        || !['succeeded', 'failed', 'stopped', 'timed_out'].includes(execution.state)
        || execution.treeTermination !== 'confirmed') {
        throw new Error('review_execution_not_ready');
      }
      return workspaceGrants.resolveExecutionGrant(workspaceId, ownerId);
    },
  );
  const desktopSession = session.fromPartition(DESKTOP_SESSION_PARTITION);
  await registerAppProtocol(desktopSession.protocol);
  secureDesktopSession(desktopSession);
  const disposeIpc = registerDesktopIpcHandlers({
    getMainWindow: () => mainWindow,
    getWindowSessionNonce: (ownerId) => windowSessionNonce(ownerId),
    grants: workspaceGrants,
    executions: executionAuthority,
    review: {
      begin: async (input, ownerId, sessionNonce) => {
        await reviewCoordinator?.begin(
          input.executionId,
          ownerId,
          sessionNonce,
          input.workspaceId,
          join(app.getPath('userData'), 'staging-v1'),
        );
        return { started: true };
      },
      inspect: async (input, ownerId, sessionNonce) => reviewCoordinator!.inspect(
        input.executionId,
        ownerId,
        sessionNonce,
        input.workspaceId,
      ) as Promise<import('@roundtable/protocol').ReviewBundle>,
      prepare: (bundle, ownerId, sessionNonce) => reviewCoordinator!.prepare(
        bundle as never,
        ownerId,
        sessionNonce,
      ) as Promise<import('@roundtable/protocol').ApplyChallenge>,
      authorize: async (applyId, ownerId, sessionNonce) => {
        await reviewCoordinator!.authorize(applyId, ownerId, sessionNonce);
        return { applied: true };
      },
      reject: (applyId, ownerId, sessionNonce) => reviewCoordinator!.reject(
        applyId,
        ownerId,
        sessionNonce,
      ),
    },
  });
  app.on('before-quit', createDesktopQuitCoordinator({
    shutdown: shutdownDesktop,
    quit: () => app.quit(),
    onFailure: () => console.error('[desktop] desktop_shutdown_failed'),
    timeoutMs: 30_000,
  }));
  app.once('will-quit', () => {
    disposeIpc();
    executionAuthority?.dispose();
    reviewCoordinator = null;
    workspaceDirectoryReader.dispose();
  });

  await createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow().catch(() => {
        console.error('[desktop] desktop_renderer_load_failed');
      });
    }
  });
}

function windowSessionNonce(ownerId: number): string {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || mainWindow.webContents.id !== ownerId
  ) throw new Error('execution_not_authorized');
  let nonce = windowSessionNonces.get(ownerId);
  if (!nonce) {
    nonce = `window_${randomUUID()}`;
    windowSessionNonces.set(ownerId, nonce);
  }
  return nonce;
}

async function shutdownDesktop(): Promise<void> {
  const owners = [...windowSessionNonces.keys()];
  windowSessionNonces.clear();
  const ownerCleanup = await Promise.allSettled(owners.map(async (ownerId) => {
    workspaceGrants.revokeOwner(ownerId);
    await reviewCoordinator?.revokeOwner(ownerId);
    await executionAuthority?.revokeOwner(ownerId);
  }));
  if (ownerCleanup.some((result) => result.status === 'rejected')) {
    throw new Error('desktop_shutdown_cleanup_failed');
  }
  await agentRuntime?.shutdown();
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('desktop_shutdown_timeout')), timeoutMs);
    timeout.unref();
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timeout));
}

export function createDesktopQuitCoordinator(
  options: DesktopQuitCoordinatorOptions,
): (event: PreventableQuitEvent) => void {
  let state: 'idle' | 'cleaning' | 'ready-to-quit' = 'idle';
  return (event) => {
    if (state === 'ready-to-quit') return;
    event.preventDefault();
    if (state === 'cleaning') return;
    state = 'cleaning';
    let shutdown: Promise<void>;
    try {
      shutdown = options.shutdown();
    } catch (error) {
      shutdown = Promise.reject(error);
    }
    void withDeadline(
      shutdown,
      options.timeoutMs,
    ).then(
      () => {
        state = 'ready-to-quit';
        options.quit();
      },
      () => {
        state = 'idle';
        options.onFailure();
      },
    );
  };
}

void bootstrapDesktop().catch(() => {
  console.error('[desktop] desktop_bootstrap_failed');
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
