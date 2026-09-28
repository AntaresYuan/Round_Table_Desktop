import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_IPC_CHANNELS,
  type MissionApprovalPreview,
  type MissionExecutionAccepted,
  type RuntimeCatalog,
  type RuntimeExecutionEvent,
  type RuntimeExecutionSnapshot,
  type RuntimeProviderPolicy,
} from '@roundtable/protocol';

import type {
  DesktopRuntimePort,
  OwnedExecutionEvent,
} from '../src/execution-authority.js';

const WINDOW_SESSION_NONCE = 'window-session-00000001';
const OCCURRED_AT = '2026-08-23T00:00:00.000Z';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  removeHandler: vi.fn(),
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
  dialog: { showOpenDialog: electronMocks.showOpenDialog },
  ipcMain: {
    handle: (channel: string, handler: unknown) => {
      electronMocks.handlers.set(channel, handler);
    },
    removeHandler: electronMocks.removeHandler,
  },
  net: { fetch: vi.fn() },
  protocol: {
    handle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
  },
}));

const { assertTrustedSender, registerDesktopIpcHandlers } = await import(
  '../src/ipc-handlers.js'
);
const { DesktopExecutionAuthority, DesktopExecutionError } = await import(
  '../src/execution-authority.js'
);
const { WorkspaceGrantRegistry } = await import('../src/workspace-grants.js');

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.removeHandler.mockClear();
  electronMocks.showOpenDialog.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop IPC handlers', () => {
  it('accepts only the active app window, main frame, and exact app document', () => {
    const fixture = createWindowFixture(17);

    expect(() => assertTrustedSender(fixture.event, fixture.window)).not.toThrow();
    expect(() => assertTrustedSender({
      ...fixture.event,
      senderFrame: { url: 'https://evil.example/' },
    } as unknown as IpcMainInvokeEvent, fixture.window)).toThrow('untrusted_ipc_sender');
    expect(() => assertTrustedSender({
      ...fixture.event,
      sender: {},
    } as unknown as IpcMainInvokeEvent, fixture.window)).toThrow('untrusted_ipc_sender');
    expect(() => assertTrustedSender({
      ...fixture.event,
      senderFrame: { url: 'roundtable://app/index.html' },
    } as unknown as IpcMainInvokeEvent, fixture.window)).toThrow('untrusted_ipc_sender');
    expect(() => assertTrustedSender({
      ...fixture.event,
      senderFrame: { url: 'roundtable://app.evil/index.html' },
    } as unknown as IpcMainInvokeEvent, fixture.window)).toThrow('untrusted_ipc_sender');
    expect(() => assertTrustedSender({
      ...fixture.event,
      senderFrame: { url: 'roundtable://app/index.html?spoof=1' },
    } as unknown as IpcMainInvokeEvent, fixture.window)).toThrow('untrusted_ipc_sender');
  });

  it('registers invoke handlers for every declared command channel and cleans them up exactly once', async () => {
    const fixture = createWindowFixture(19);
    const executionFixture = createExecutionFixture();
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    const cleanup = registerDesktopIpcHandlers({
      getMainWindow: () => fixture.window,
      getWindowSessionNonce: () => WINDOW_SESSION_NONCE,
      grants: new WorkspaceGrantRegistry(),
      executions: executionFixture.authority,
    });
    const invokeChannels = Object.values(DESKTOP_IPC_CHANNELS)
      .filter((channel) => channel !== DESKTOP_IPC_CHANNELS.executionEvent);

    expect(Object.values(DESKTOP_IPC_CHANNELS)).toHaveLength(14);
    expect([...electronMocks.handlers.keys()].sort()).toEqual([...invokeChannels].sort());
    expect(electronMocks.handlers.has(DESKTOP_IPC_CHANNELS.executionEvent)).toBe(false);
    expect(electronMocks.removeHandler.mock.calls.map(([channel]) => channel).sort())
      .toEqual([...invokeChannels].sort());

    const selectHandler = getHandler(DESKTOP_IPC_CHANNELS.workspaceSelect);
    await expect(selectHandler(fixture.event)).resolves.toEqual({ selected: false });

    cleanup();
    for (const channel of invokeChannels) {
      expect(electronMocks.removeHandler.mock.calls.filter(([value]) => value === channel))
        .toHaveLength(2);
    }
    expect(electronMocks.removeHandler).not.toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.executionEvent,
    );
    expect(executionFixture.disposeEvents).toHaveBeenCalledTimes(1);
  });

  it('requires a trusted sender before any invoke capability runs', async () => {
    const fixture = createWindowFixture(21);
    const executionFixture = createExecutionFixture();
    registerDesktopIpcHandlers({
      getMainWindow: () => fixture.window,
      getWindowSessionNonce: () => WINDOW_SESSION_NONCE,
      grants: new WorkspaceGrantRegistry(),
      executions: executionFixture.authority,
    });
    const untrustedEvent = {
      ...fixture.event,
      senderFrame: { url: 'https://evil.example/' },
    } as unknown as IpcMainInvokeEvent;
    const inputs = new Map<string, unknown>([
      [DESKTOP_IPC_CHANNELS.workspaceListEntries, {
        workspaceId: 'workspace_01', relativePath: '',
      }],
      [DESKTOP_IPC_CHANNELS.missionPrepare, {
        workspaceId: 'workspace_01', provider: 'codex', prompt: 'Do the task.',
      }],
      [DESKTOP_IPC_CHANNELS.missionApprove, { approvalId: 'approval_01' }],
      [DESKTOP_IPC_CHANNELS.executionGet, { executionId: 'execution_01' }],
      [DESKTOP_IPC_CHANNELS.executionStop, { executionId: 'execution_01' }],
    ]);

    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      if (channel === DESKTOP_IPC_CHANNELS.executionEvent) continue;
      const handler = getHandler(channel);
      await expect(Promise.resolve().then(() => handler(untrustedEvent, inputs.get(channel))))
        .rejects.toThrow('untrusted_ipc_sender');
    }

    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled();
    expect(executionFixture.getCatalog).not.toHaveBeenCalled();
    expect(executionFixture.prepareMission).not.toHaveBeenCalled();
    expect(executionFixture.approveMission).not.toHaveBeenCalled();
    expect(executionFixture.getExecution).not.toHaveBeenCalled();
    expect(executionFixture.stopExecution).not.toHaveBeenCalled();
    expect(executionFixture.hasActiveExecution).not.toHaveBeenCalled();
  });

  it('completes selection and listing without returning the absolute workspace path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-ipc-'));
    try {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'README.md'), '# IPC\n', 'utf8');
      const fixture = createWindowFixture(23);
      const executionFixture = createExecutionFixture();
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] });

      registerDesktopIpcHandlers({
        getMainWindow: () => fixture.window,
        getWindowSessionNonce: () => WINDOW_SESSION_NONCE,
        grants: new WorkspaceGrantRegistry(),
        executions: executionFixture.authority,
      });
      const selectHandler = getHandler(DESKTOP_IPC_CHANNELS.workspaceSelect);
      const selection = await selectHandler(fixture.event) as {
        selected: true;
        workspace: { id: string; name: string };
      };
      expect(selection.selected).toBe(true);
      expect(selection.workspace.id).toMatch(/^workspace_/u);

      const listHandler = getHandler(DESKTOP_IPC_CHANNELS.workspaceListEntries);
      const listing = await listHandler(fixture.event, {
        workspaceId: selection.workspace.id,
        relativePath: '',
      });

      expect(listing).toMatchObject({
        relativePath: '',
        entries: [
          { name: 'README.md', relativePath: 'README.md', kind: 'file' },
          { name: 'src', relativePath: 'src', kind: 'directory' },
        ],
      });
      expect(JSON.stringify({ selection, listing })).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forwards prepare, approve, get, and stop only with the current owner and session nonce', async () => {
    const fixture = createWindowFixture(29);
    const executionFixture = createExecutionFixture();
    const getWindowSessionNonce = vi.fn(() => WINDOW_SESSION_NONCE);
    registerDesktopIpcHandlers({
      getMainWindow: () => fixture.window,
      getWindowSessionNonce,
      grants: new WorkspaceGrantRegistry(),
      executions: executionFixture.authority,
    });

    const prepareHandler = getHandler(DESKTOP_IPC_CHANNELS.missionPrepare);
    await expect(prepareHandler(fixture.event, {
      workspaceId: 'workspace_01',
      provider: 'codex',
      prompt: 'Implement the approved change.',
    })).resolves.toEqual(approvalPreview());
    expect(executionFixture.prepareMission).toHaveBeenCalledWith({
      workspaceId: 'workspace_01',
      provider: 'codex',
      prompt: 'Implement the approved change.',
    }, 29, WINDOW_SESSION_NONCE);

    const approveHandler = getHandler(DESKTOP_IPC_CHANNELS.missionApprove);
    await expect(approveHandler(fixture.event, { approvalId: 'approval_01' }))
      .resolves.toEqual(executionAccepted());
    expect(executionFixture.approveMission)
      .toHaveBeenCalledWith('approval_01', 29, WINDOW_SESSION_NONCE);

    const getExecutionHandler = getHandler(DESKTOP_IPC_CHANNELS.executionGet);
    expect(getExecutionHandler(fixture.event, { executionId: 'execution_01' }))
      .toEqual(runningSnapshot());
    expect(executionFixture.getExecution)
      .toHaveBeenCalledWith('execution_01', 29, WINDOW_SESSION_NONCE);

    const stopHandler = getHandler(DESKTOP_IPC_CHANNELS.executionStop);
    await expect(stopHandler(fixture.event, { executionId: 'execution_01' }))
      .resolves.toEqual(stoppedSnapshot());
    expect(executionFixture.stopExecution)
      .toHaveBeenCalledWith('execution_01', 29, WINDOW_SESSION_NONCE);
    expect(getWindowSessionNonce).toHaveBeenCalledWith(29);
  });

  it('pushes validated event copies only to the owning current window session', () => {
    const fixture = createWindowFixture(37);
    const executionFixture = createExecutionFixture();
    let currentNonce = WINDOW_SESSION_NONCE;
    const cleanup = registerDesktopIpcHandlers({
      getMainWindow: () => fixture.window,
      getWindowSessionNonce: () => currentNonce,
      grants: new WorkspaceGrantRegistry(),
      executions: executionFixture.authority,
    });
    const rawEvent = outputEvent();

    executionFixture.emit({
      ownerId: 37,
      windowSessionNonce: WINDOW_SESSION_NONCE,
      event: rawEvent,
    });
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.executionEvent,
      rawEvent,
    );
    const delivered = fixture.send.mock.calls[0]?.[1];
    expect(delivered).not.toBe(rawEvent);

    executionFixture.emit({
      ownerId: 38,
      windowSessionNonce: WINDOW_SESSION_NONCE,
      event: rawEvent,
    });
    currentNonce = 'window-session-00000002';
    executionFixture.emit({
      ownerId: 37,
      windowSessionNonce: WINDOW_SESSION_NONCE,
      event: rawEvent,
    });
    expect(fixture.send).toHaveBeenCalledTimes(1);

    cleanup();
    executionFixture.emit({
      ownerId: 37,
      windowSessionNonce: currentNonce,
      event: rawEvent,
    });
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(executionFixture.disposeEvents).toHaveBeenCalledTimes(1);
  });

  it('locks workspace replacement while that window owns an active execution', async () => {
    const fixture = createWindowFixture(41);
    const executionFixture = createExecutionFixture();
    executionFixture.hasActiveExecution.mockReturnValue(true);
    registerDesktopIpcHandlers({
      getMainWindow: () => fixture.window,
      getWindowSessionNonce: () => WINDOW_SESSION_NONCE,
      grants: new WorkspaceGrantRegistry(),
      executions: executionFixture.authority,
    });

    const selectHandler = getHandler(DESKTOP_IPC_CHANNELS.workspaceSelect);
    await expect(selectHandler(fixture.event)).rejects.toThrow('workspace_execution_active');
    expect(executionFixture.hasActiveExecution).toHaveBeenCalledWith(41);
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled();
  });

  it('stabilizes validation and internal failures without leaking error details', async () => {
    const fixture = createWindowFixture(43);
    const executionFixture = createExecutionFixture();
    registerDesktopIpcHandlers({
      getMainWindow: () => fixture.window,
      getWindowSessionNonce: () => WINDOW_SESSION_NONCE,
      grants: new WorkspaceGrantRegistry(),
      executions: executionFixture.authority,
    });

    const prepareHandler = getHandler(DESKTOP_IPC_CHANNELS.missionPrepare);
    await expect(prepareHandler(fixture.event, {
      workspaceId: 'workspace_01',
      provider: 'codex',
      prompt: 'x'.repeat(12_001),
    })).rejects.toThrow('mission_prepare_failed');
    expect(executionFixture.prepareMission).not.toHaveBeenCalled();

    executionFixture.prepareMission.mockRejectedValueOnce(
      new Error('secret internal path: /private/runtime'),
    );
    await expect(prepareHandler(fixture.event, {
      workspaceId: 'workspace_01',
      provider: 'codex',
      prompt: 'valid',
    })).rejects.toThrow('mission_prepare_failed');

    executionFixture.approveMission.mockRejectedValueOnce(
      new DesktopExecutionError('mission_approval_invalid'),
    );
    await expect(getHandler(DESKTOP_IPC_CHANNELS.missionApprove)(
      fixture.event,
      { approvalId: 'approval_01' },
    )).rejects.toThrow('mission_approval_invalid');

    expect(() => getHandler(DESKTOP_IPC_CHANNELS.executionGet)(
      fixture.event,
      { executionId: '../private' },
    )).toThrow('execution_get_failed');

    executionFixture.stopExecution.mockRejectedValueOnce(
      new Error('secret process error'),
    );
    await expect(getHandler(DESKTOP_IPC_CHANNELS.executionStop)(
      fixture.event,
      { executionId: 'execution_01' },
    )).rejects.toThrow('execution_stop_failed');

    executionFixture.getCatalog.mockRejectedValueOnce(
      new Error('secret executable path'),
    );
    await expect(getHandler(DESKTOP_IPC_CHANNELS.runtimeCatalog)(fixture.event))
      .rejects.toThrow('runtime_catalog_failed');

    await expect(getHandler(DESKTOP_IPC_CHANNELS.workspaceListEntries)(
      fixture.event,
      { workspaceId: 'workspace_missing', relativePath: '' },
    )).rejects.toThrow('workspace_not_authorized');
  });

  it('does not time out the native picker and rejects a grant after owner revocation', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'roundtable-ipc-generation-'));
    try {
      const fixture = createWindowFixture(47);
      const executionFixture = createExecutionFixture();
      let resolveDialog!: (result: { canceled: boolean; filePaths: string[] }) => void;
      electronMocks.showOpenDialog.mockReturnValue(new Promise((resolve) => {
        resolveDialog = resolve;
      }));
      const grants = new WorkspaceGrantRegistry();
      registerDesktopIpcHandlers({
        getMainWindow: () => fixture.window,
        getWindowSessionNonce: () => WINDOW_SESSION_NONCE,
        grants,
        executions: executionFixture.authority,
      });
      const selectHandler = getHandler(DESKTOP_IPC_CHANNELS.workspaceSelect);

      const selectionPromise = Promise.resolve(selectHandler(fixture.event));
      const settled = vi.fn();
      void selectionPromise.then(settled, settled);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(settled).not.toHaveBeenCalled();

      grants.revokeOwner(fixture.webContents.id);
      resolveDialog({ canceled: false, filePaths: [root] });
      await expect(selectionPromise).rejects.toThrow('workspace_not_authorized');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps approval IPC pending until a delayed launch returns its execution id', async () => {
    const fixture = createWindowFixture(53);
    const selected = { id: 'workspace_01' as never, name: 'Roundtable' };
    const executionGrant = {
      ownerId: fixture.webContents.id,
      workspace: selected,
      root: '/private/roundtable-test-workspace',
      rootDevice: '1',
      rootInode: '2',
      grantRevision: 1,
    };
    const grants = {
      resolveExecutionGrant: vi.fn(async () => executionGrant),
    } as unknown as InstanceType<typeof WorkspaceGrantRegistry>;
    let resolveLaunch!: () => void;
    const launch = vi.fn(() => new Promise<void>((resolve) => {
      resolveLaunch = resolve;
    }));
    const runtime: DesktopRuntimePort = {
      getCatalog: async () => runtimeCatalog(),
      prepare: async (input) => ({
        preparationToken: `prepared_${input.provider}`,
        catalogEntry: runtimeCatalog().providers.find((entry) => (
          entry.provider === input.provider
        ))!,
      }),
      launch,
      stop: async () => {
        throw new Error('unexpected_stop');
      },
      onEvent: () => () => undefined,
    };
    const authority = new DesktopExecutionAuthority({ grants, runtime });

    try {
      registerDesktopIpcHandlers({
        getMainWindow: () => fixture.window,
        getWindowSessionNonce: () => WINDOW_SESSION_NONCE,
        grants,
        executions: authority,
      });
      const preview = await getHandler(DESKTOP_IPC_CHANNELS.missionPrepare)(fixture.event, {
        workspaceId: selected.id,
        provider: 'codex',
        prompt: 'Run only after approval.',
      }) as MissionApprovalPreview;

      vi.useFakeTimers();
      const approvalPromise = Promise.resolve(
        getHandler(DESKTOP_IPC_CHANNELS.missionApprove)(fixture.event, {
          approvalId: preview.approvalId,
        }),
      ) as Promise<MissionExecutionAccepted>;
      const settled = vi.fn();
      void approvalPromise.then(settled, settled);
      await vi.advanceTimersByTimeAsync(10_001);

      expect(launch).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();

      resolveLaunch();
      const accepted = await approvalPromise;
      expect(accepted).toMatchObject({
        missionId: preview.missionId,
        executionId: expect.stringMatching(/^execution_/u),
        state: 'queued',
      });
      expect(authority.getExecution(
        accepted.executionId,
        fixture.webContents.id,
        WINDOW_SESSION_NONCE,
      )).toMatchObject({
        missionId: preview.missionId,
        executionId: accepted.executionId,
        state: 'queued',
      });
    } finally {
      authority.dispose();
      vi.useRealTimers();
    }
  });
});

type WindowFixture = {
  window: BrowserWindow;
  event: IpcMainInvokeEvent;
  webContents: { id: number; mainFrame: { url: string }; send: ReturnType<typeof vi.fn> };
  send: ReturnType<typeof vi.fn>;
};

function createWindowFixture(ownerId: number): WindowFixture {
  const mainFrame = { url: 'roundtable://app/index.html' };
  const send = vi.fn();
  const webContents = { id: ownerId, mainFrame, send };
  const window = {
    webContents,
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  return { window, event, webContents, send };
}

type Handler = (event: IpcMainInvokeEvent, input?: unknown) => unknown | Promise<unknown>;

function getHandler(channel: string): Handler {
  const handler = electronMocks.handlers.get(channel);
  if (typeof handler !== 'function') throw new Error(`missing_test_handler:${channel}`);
  return handler as Handler;
}

function providerPolicy(adapterVersion = 'provider-v1'): RuntimeProviderPolicy {
  return {
    adapterVersion,
    sandbox: 'workspace-os-sandbox',
    workspaceWrite: true,
    externalFileAccess: 'os-denied',
    projectCustomizations: 'disabled',
    network: 'provider-required',
    secrets: 'provider-scoped',
    timeoutMs: 300_000,
  };
}

function runtimeCatalog(): RuntimeCatalog {
  return {
    providers: [
      {
        provider: 'codex',
        label: 'Codex',
        available: true,
        version: '1.0.0',
        installHint: 'Install Codex CLI.',
        policy: providerPolicy('codex-v1'),
        warnings: [],
      },
      {
        provider: 'claude-code',
        label: 'Claude Code',
        available: true,
        version: '1.0.0',
        installHint: 'Install Claude Code.',
        policy: providerPolicy('claude-v1'),
        warnings: [],
      },
      {
        provider: 'opencode',
        label: 'OpenCode',
        available: false,
        version: null,
        installHint: 'Install OpenCode.',
        policy: {
          ...providerPolicy('opencode-v1'),
          sandbox: 'provider-permissions',
          externalFileAccess: 'provider-denied',
        },
        warnings: ['Shell remains disabled.'],
      },
    ],
  };
}

function approvalPreview(): MissionApprovalPreview {
  return {
    approvalId: 'approval_01' as never,
    missionId: 'mission_01' as never,
    workspace: { id: 'workspace_01' as never, name: 'Roundtable' },
    provider: 'codex',
    prompt: 'Implement the approved change.',
    policy: providerPolicy('codex-v1'),
    warnings: [],
    expiresAt: '2026-08-23T00:05:00.000Z',
  };
}

function executionAccepted(): MissionExecutionAccepted {
  return {
    missionId: 'mission_01' as never,
    executionId: 'execution_01' as never,
    state: 'queued',
  };
}

function runningSnapshot(): RuntimeExecutionSnapshot {
  return {
    missionId: 'mission_01' as never,
    executionId: 'execution_01' as never,
    workspace: { id: 'workspace_01' as never, name: 'Roundtable' },
    provider: 'codex',
    state: 'running',
    sequence: 1,
    startedAt: OCCURRED_AT,
    finishedAt: null,
    error: null,
    summary: '',
    treeTermination: 'not-required',
    logs: [],
    artifacts: [],
  };
}

function stoppedSnapshot(): RuntimeExecutionSnapshot {
  return {
    ...runningSnapshot(),
    state: 'stopped',
    sequence: 2,
    finishedAt: '2026-08-23T00:00:01.000Z',
    treeTermination: 'confirmed',
  };
}

function outputEvent(): RuntimeExecutionEvent {
  return {
    missionId: 'mission_01' as never,
    executionId: 'execution_01' as never,
    sequence: 1,
    occurredAt: OCCURRED_AT,
    type: 'output',
    stream: 'stdout',
    text: 'done',
    truncated: false,
  };
}

function createExecutionFixture() {
  const listeners = new Set<(event: OwnedExecutionEvent) => void>();
  let registeredListener: ((event: OwnedExecutionEvent) => void) | undefined;
  const disposeEvents = vi.fn(() => {
    if (registeredListener) listeners.delete(registeredListener);
  });
  const getCatalog = vi.fn(async () => runtimeCatalog());
  const prepareMission = vi.fn(async () => approvalPreview());
  const approveMission = vi.fn(async () => executionAccepted());
  const getExecution = vi.fn(() => runningSnapshot());
  const stopExecution = vi.fn(async () => stoppedSnapshot());
  const hasActiveExecution = vi.fn(() => false);
  const onEvent = vi.fn((listener: (event: OwnedExecutionEvent) => void) => {
    registeredListener = listener;
    listeners.add(listener);
    return disposeEvents;
  });
  const authority = {
    getCatalog,
    prepareMission,
    approveMission,
    getExecution,
    stopExecution,
    hasActiveExecution,
    onEvent,
  } as unknown as InstanceType<typeof DesktopExecutionAuthority>;

  return {
    authority,
    getCatalog,
    prepareMission,
    approveMission,
    getExecution,
    stopExecution,
    hasActiveExecution,
    disposeEvents,
    emit(event: OwnedExecutionEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}
