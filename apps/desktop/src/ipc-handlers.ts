import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';

import {
  DESKTOP_IPC_CHANNELS,
  PROTOCOL_VERSION,
  desktopSystemInfoSchema,
  executionGetInputSchema,
  executionStopInputSchema,
  missionApprovalPreviewSchema,
  missionApproveInputSchema,
  missionExecutionAcceptedSchema,
  missionPrepareInputSchema,
  reviewExecutionInputSchema,
  reviewPrepareInputSchema,
  applyChallengeInputSchema,
  applyChallengeSchema,
  runtimeCatalogSchema,
  runtimeExecutionEventSchema,
  runtimeExecutionSnapshotSchema,
  workspaceEntriesSchema,
  workspaceListEntriesInputSchema,
  workspaceSelectionSchema,
} from '@roundtable/protocol';

import { isTrustedAppDocumentUrl } from './app-protocol.js';
import {
  DesktopExecutionAuthority,
  DesktopExecutionError,
} from './execution-authority.js';
import { StagingExecutionError } from './staging-execution.js';
import { ReviewCoordinatorError } from './review-coordinator.js';
import {
  DesktopCapabilityError,
  WorkspaceGrantRegistry,
} from './workspace-grants.js';
import type { ApplyChallenge, ReviewBundle, ReviewExecutionInput } from '@roundtable/protocol';

const MAX_WORKSPACE_REQUESTS_PER_SECOND = 8;
const WORKSPACE_REQUEST_TIMEOUT_MS = 10_000;

class DesktopIpcError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DesktopIpcError';
  }
}

class WorkspaceRequestGate {
  readonly #activeOwners = new Set<number>();
  readonly #recentRequests = new Map<number, number[]>();

  runReadOnly<T>(ownerId: number, operation: () => Promise<T>): Promise<T> {
    return this.#run(ownerId, operation, WORKSPACE_REQUEST_TIMEOUT_MS);
  }

  runToSettlement<T>(ownerId: number, operation: () => Promise<T>): Promise<T> {
    return this.#run(ownerId, operation, null);
  }

  async #run<T>(
    ownerId: number,
    operation: () => Promise<T>,
    timeoutMs: number | null,
  ): Promise<T> {
    this.#enforceRateLimit(ownerId);
    if (this.#activeOwners.has(ownerId)) {
      throw new DesktopIpcError('workspace_request_busy');
    }

    this.#activeOwners.add(ownerId);
    const work = Promise.resolve()
      .then(operation)
      .finally(() => this.#activeOwners.delete(ownerId));
    if (timeoutMs === null) return work;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new DesktopIpcError('workspace_request_timeout'));
      }, timeoutMs);
      timeout.unref();
    });

    try {
      return await Promise.race([work, timed]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  clear(): void {
    this.#activeOwners.clear();
    this.#recentRequests.clear();
  }

  #enforceRateLimit(ownerId: number): void {
    const now = Date.now();
    for (const [knownOwnerId, timestamps] of this.#recentRequests) {
      if (knownOwnerId !== ownerId && timestamps.every((timestamp) => timestamp <= now - 1_000)) {
        this.#recentRequests.delete(knownOwnerId);
      }
    }
    const recent = (this.#recentRequests.get(ownerId) ?? [])
      .filter((timestamp) => timestamp > now - 1_000);
    if (recent.length >= MAX_WORKSPACE_REQUESTS_PER_SECOND) {
      throw new DesktopIpcError('workspace_request_rate_limited');
    }
    recent.push(now);
    this.#recentRequests.set(ownerId, recent);
  }
}

type DesktopHandlerOptions = {
  getMainWindow(): BrowserWindow | null;
  getWindowSessionNonce(ownerId: number): string;
  grants: WorkspaceGrantRegistry;
  executions: DesktopExecutionAuthority;
  review?: {
    begin(input: ReviewExecutionInput, ownerId: number, sessionNonce: string): Promise<{ started: true }>;
    inspect(input: ReviewExecutionInput, ownerId: number, sessionNonce: string): Promise<ReviewBundle>;
    prepare(bundle: ReviewBundle, ownerId: number, sessionNonce: string): Promise<ApplyChallenge>;
    authorize(applyId: string, ownerId: number, sessionNonce: string): Promise<{ applied: true }>;
    reject(applyId: string, ownerId: number, sessionNonce: string): Promise<{ rejected: true }>;
  };
};

export function registerDesktopIpcHandlers(options: DesktopHandlerOptions): () => void {
  const channels = Object.values(DESKTOP_IPC_CHANNELS)
    .filter((channel) => channel !== DESKTOP_IPC_CHANNELS.executionEvent);
  const workspaceRequests = new WorkspaceRequestGate();
  const executionRequests = new WorkspaceRequestGate();
  for (const channel of channels) ipcMain.removeHandler(channel);

  ipcMain.handle(DESKTOP_IPC_CHANNELS.systemGetInfo, (event) => {
    assertTrustedSender(event, options.getMainWindow());
    return desktopSystemInfoSchema.parse({
      product: 'roundtable',
      applicationVersion: app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform,
      architecture: process.arch,
      electronVersion: process.versions.electron,
      capabilities: [
        'execution.get',
        'execution.stop',
        'mission.approve',
        'mission.prepare',
        'runtime.catalog',
        'system.info',
        'workspace.list',
        'workspace.select',
      ],
    });
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.workspaceSelect, async (event) => {
    const window = options.getMainWindow();
    const ownerId = assertTrustedSender(event, window);
    if (!window) throw new Error('desktop_window_unavailable');
    if (options.executions.hasActiveExecution(ownerId)) {
      throw new Error('workspace_execution_active');
    }
    const ownerGeneration = options.grants.ownerGeneration(ownerId);

    return workspaceRequests.runToSettlement(ownerId, async () => {
      try {
        const selection = await dialog.showOpenDialog(window, {
          title: 'Select a Roundtable workspace',
          buttonLabel: 'Open workspace',
          properties: ['openDirectory'],
        });
        if (selection.canceled || !selection.filePaths[0]) {
          return workspaceSelectionSchema.parse({ selected: false });
        }

        assertTrustedSender(event, options.getMainWindow());
        if (options.grants.ownerGeneration(ownerId) !== ownerGeneration) {
          throw new DesktopCapabilityError('workspace_not_authorized');
        }
        const workspace = await options.grants.grant(
          selection.filePaths[0],
          ownerId,
          ownerGeneration,
        );
        return workspaceSelectionSchema.parse({ selected: true, workspace });
      } catch (error) {
        throw stableIpcError(error, 'workspace_selection_failed');
      }
    });
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.workspaceListEntries, async (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    return workspaceRequests.runReadOnly(ownerId, async () => {
      try {
        const input = workspaceListEntriesInputSchema.parse(rawInput);
        return workspaceEntriesSchema.parse(await options.grants.listEntries(input, ownerId));
      } catch (error) {
        throw stableIpcError(error, 'workspace_listing_failed');
      }
    });
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.runtimeCatalog, async (event) => {
    assertTrustedSender(event, options.getMainWindow());
    try {
      return runtimeCatalogSchema.parse(await options.executions.getCatalog());
    } catch (error) {
      throw stableIpcError(error, 'runtime_catalog_failed');
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.missionPrepare, async (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    const windowSessionNonce = options.getWindowSessionNonce(ownerId);
    return executionRequests.runToSettlement(ownerId, async () => {
      try {
        const input = missionPrepareInputSchema.parse(rawInput);
        return missionApprovalPreviewSchema.parse(await options.executions.prepareMission(
          input,
          ownerId,
          windowSessionNonce,
        ));
      } catch (error) {
        throw stableIpcError(error, 'mission_prepare_failed');
      }
    });
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.missionApprove, async (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    const windowSessionNonce = options.getWindowSessionNonce(ownerId);
    return executionRequests.runToSettlement(ownerId, async () => {
      try {
        const input = missionApproveInputSchema.parse(rawInput);
        return missionExecutionAcceptedSchema.parse(await options.executions.approveMission(
          input.approvalId,
          ownerId,
          windowSessionNonce,
        ));
      } catch (error) {
        throw stableIpcError(error, 'mission_approval_failed');
      }
    });
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.executionGet, (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    try {
      const input = executionGetInputSchema.parse(rawInput);
      return runtimeExecutionSnapshotSchema.parse(options.executions.getExecution(
        input.executionId,
        ownerId,
        options.getWindowSessionNonce(ownerId),
      ));
    } catch (error) {
      throw stableIpcError(error, 'execution_get_failed');
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.executionStop, async (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    try {
      const input = executionStopInputSchema.parse(rawInput);
      return runtimeExecutionSnapshotSchema.parse(await options.executions.stopExecution(
        input.executionId,
        ownerId,
        options.getWindowSessionNonce(ownerId),
      ));
    } catch (error) {
      throw stableIpcError(error, 'execution_stop_failed');
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.reviewPrepare, async (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    const sessionNonce = options.getWindowSessionNonce(ownerId);
    if (!options.review) throw new DesktopIpcError('review_apply_unavailable');
    try {
      const input = reviewPrepareInputSchema.parse(rawInput);
      return applyChallengeSchema.parse(await options.review.prepare(
        input.bundle,
        ownerId,
        sessionNonce,
      ));
    } catch (error) {
      throw stableIpcError(error, 'review_prepare_failed');
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.reviewBegin, async (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    const sessionNonce = options.getWindowSessionNonce(ownerId);
    if (!options.review) throw new DesktopIpcError('review_apply_unavailable');
    try {
      const input = reviewExecutionInputSchema.parse(rawInput);
      return await options.review.begin(input, ownerId, sessionNonce);
    } catch (error) {
      throw stableIpcError(error, 'review_begin_failed');
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.reviewInspect, async (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    const sessionNonce = options.getWindowSessionNonce(ownerId);
    if (!options.review) throw new DesktopIpcError('review_apply_unavailable');
    try {
      const input = reviewExecutionInputSchema.parse(rawInput);
      return await options.review.inspect(input, ownerId, sessionNonce);
    } catch (error) {
      throw stableIpcError(error, 'review_inspect_failed');
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.applyAuthorize, async (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    const sessionNonce = options.getWindowSessionNonce(ownerId);
    if (!options.review) throw new DesktopIpcError('review_apply_unavailable');
    try {
      const input = applyChallengeInputSchema.parse(rawInput);
      return await options.review.authorize(input.applyId, ownerId, sessionNonce);
    } catch (error) {
      throw stableIpcError(error, 'apply_authorize_failed');
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.applyReject, async (event, rawInput: unknown) => {
    const ownerId = assertTrustedSender(event, options.getMainWindow());
    const sessionNonce = options.getWindowSessionNonce(ownerId);
    if (!options.review) throw new DesktopIpcError('review_apply_unavailable');
    try {
      const input = applyChallengeInputSchema.parse(rawInput);
      return await options.review.reject(input.applyId, ownerId, sessionNonce);
    } catch (error) {
      throw stableIpcError(error, 'apply_reject_failed');
    }
  });

  const disposeExecutionEvents = options.executions.onEvent((ownedEvent) => {
    const window = options.getMainWindow();
    if (
      !window
      || window.isDestroyed()
      || window.webContents.id !== ownedEvent.ownerId
      || options.getWindowSessionNonce(ownedEvent.ownerId) !== ownedEvent.windowSessionNonce
      || !isTrustedAppDocumentUrl(window.webContents.mainFrame.url)
    ) return;
    window.webContents.send(
      DESKTOP_IPC_CHANNELS.executionEvent,
      runtimeExecutionEventSchema.parse(ownedEvent.event),
    );
  });

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    workspaceRequests.clear();
    executionRequests.clear();
    disposeExecutionEvents();
  };
}

export function assertTrustedSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null,
): number {
  const senderFrame = event.senderFrame;
  if (
    !window
    || event.sender !== window.webContents
    || !senderFrame
    || senderFrame !== event.sender.mainFrame
    || !isTrustedAppDocumentUrl(senderFrame.url)
  ) {
    throw new Error('untrusted_ipc_sender');
  }
  return event.sender.id;
}

function stableIpcError(error: unknown, fallbackCode: string): Error {
  if (
    error instanceof DesktopCapabilityError
    || error instanceof DesktopExecutionError
    || error instanceof DesktopIpcError
    || error instanceof StagingExecutionError
    || error instanceof ReviewCoordinatorError
  ) {
    return new Error(error.code);
  }
  return new Error(fallbackCode);
}
