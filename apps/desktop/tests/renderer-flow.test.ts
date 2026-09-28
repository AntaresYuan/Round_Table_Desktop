// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  DesktopBridge,
  DesktopSystemInfo,
  MissionApprovalPreview,
  MissionExecutionAccepted,
  RuntimeArtifact,
  RuntimeCatalog,
  RuntimeExecutionEvent,
  RuntimeExecutionSnapshot,
  WorkspaceEntries,
  WorkspaceSelection,
  WorkspaceSummary,
} from '@roundtable/protocol';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountDesktopRenderer, type MountedDesktopRenderer } from '../src/renderer.js';

const workspace = {
  id: 'workspace_opaque_01',
  name: 'demo-workspace',
} as WorkspaceSummary;
const secondWorkspace = {
  id: 'workspace_opaque_02',
  name: 'second-workspace',
} as WorkspaceSummary;

const systemInfo: DesktopSystemInfo = {
  product: 'roundtable',
  applicationVersion: '0.1.0',
  protocolVersion: 1,
  platform: 'darwin',
  architecture: 'arm64',
  electronVersion: '43.4.1',
  capabilities: [
    'system.info',
    'workspace.list',
    'workspace.select',
    'mission.prepare',
    'mission.approve',
    'execution.get',
    'execution.stop',
  ],
};

const policy = {
  adapterVersion: 'codex-v1',
  sandbox: 'workspace-os-sandbox',
  workspaceWrite: true,
  externalFileAccess: 'os-denied',
  projectCustomizations: 'disabled',
  network: 'provider-required',
  secrets: 'provider-scoped',
  timeoutMs: 300_000,
} as const;

const runtimeCatalog: RuntimeCatalog = {
  providers: [
    {
      provider: 'codex',
      label: 'Codex',
      available: true,
      version: '1.2.3',
      installHint: 'Install Codex and sign in.',
      policy,
      warnings: [],
    },
    {
      provider: 'claude-code',
      label: 'Claude Code',
      available: false,
      version: null,
      installHint: 'Install Claude Code and sign in.',
      policy: { ...policy, adapterVersion: 'claude-code-v1', sandbox: 'provider-permissions' },
      warnings: ['Provider permissions are enforced by Claude Code.'],
    },
    {
      provider: 'opencode',
      label: 'OpenCode',
      available: false,
      version: null,
      installHint: 'Install OpenCode and configure a provider.',
      policy: { ...policy, adapterVersion: 'opencode-v1', sandbox: 'provider-permissions' },
      warnings: ['Provider permissions are enforced by OpenCode.'],
    },
  ],
};

let rendererBody = '';

beforeAll(async () => {
  const html = await readFile(join(process.cwd(), 'renderer/index.html'), 'utf8');
  const body = /<body>([\s\S]*?)<\/body>/u.exec(html)?.[1];
  if (!body) throw new Error('renderer_test_body_missing');
  rendererBody = body.replace(/<script[\s\S]*?<\/script>/gu, '');
});

beforeEach(() => {
  document.body.innerHTML = rendererBody;
});

describe('desktop renderer workspace flow', () => {
  it('selects an opaque workspace, navigates by relative path, and returns up', async () => {
    const rootListing = listing('', [
      { name: 'README.md', relativePath: 'README.md', kind: 'file' },
      { name: 'src', relativePath: 'src', kind: 'directory' },
    ]);
    const srcListing = listing('src', [
      { name: 'index.ts', relativePath: 'src/index.ts', kind: 'file' },
    ]);
    const fixture = bridgeFixture({
      selectWorkspace: { selected: true, workspace },
      listWorkspaceEntries: async (input) => input.relativePath === '' ? rootListing : srcListing,
    });
    const controller = mountDesktopRenderer(document, fixture.bridge);

    await controller.ready;
    requiredButton('[data-select-workspace]').click();
    await vi.waitFor(() => {
      expect(fixture.selectWorkspace).toHaveBeenCalledOnce();
      expect(document.querySelector('[data-status]')?.textContent).toBe('Opened / — 2 entries.');
    });

    expect(fixture.listWorkspaceEntries).toHaveBeenNthCalledWith(1, {
      workspaceId: workspace.id,
      relativePath: '',
    });
    expect(document.querySelector('[data-workspace-heading]')?.textContent)
      .toBe('demo-workspace');
    expect(document.body.textContent).not.toContain(workspace.id);
    expect(document.body.textContent).not.toContain('/Users/private/demo-workspace');
    expect(requiredButton('[data-prepare]').disabled).toBe(true);

    const srcButton = requiredButton('[aria-label="Open src directory"]');
    srcButton.click();
    await vi.waitFor(() => {
      expect(fixture.listWorkspaceEntries).toHaveBeenCalledWith({
        workspaceId: workspace.id,
        relativePath: 'src',
      });
      expect(document.querySelector('[data-path-label]')?.textContent).toBe('/src');
    });
    expect(document.activeElement).toBe(document.querySelector('[data-path-label]'));
    expect(document.querySelector('[data-status]')?.textContent).toBe('Opened /src — 1 entry.');
    expect(document.querySelector('[data-workspace-entries]')?.textContent).toContain('index.ts');

    requiredButton('[data-up]').click();
    await vi.waitFor(() => {
      expect(fixture.listWorkspaceEntries).toHaveBeenLastCalledWith({
        workspaceId: workspace.id,
        relativePath: '',
      });
      expect(document.querySelector('[data-path-label]')?.textContent).toBe('/');
    });
    controller.dispose();
  });

  it('keeps workspace navigation sequencing independent and ignores older responses', async () => {
    const slow = deferred<WorkspaceEntries>();
    const fast = deferred<WorkspaceEntries>();
    const fixture = bridgeFixture({
      listWorkspaceEntries: (input) => {
        if (input.relativePath === 'slow') return slow.promise;
        if (input.relativePath === 'fast') return fast.promise;
        return Promise.resolve(listing('current', [
          { name: 'nested', relativePath: 'current/nested', kind: 'directory' },
        ]));
      },
    });
    const controller = mountDesktopRenderer(document, fixture.bridge);
    await controller.openWorkspacePath(workspace, 'current');
    expect(requiredButton('[data-up]').disabled).toBe(false);
    expect(requiredButton('[aria-label="Open nested directory"]').disabled).toBe(false);

    const slowRequest = controller.openWorkspacePath(workspace, 'slow');
    expect(requiredButton('[data-select-workspace]').disabled).toBe(true);
    expect(requiredButton('[data-up]').disabled).toBe(true);
    expect(requiredButton('[aria-label="Open nested directory"]').disabled).toBe(true);
    expect(document.querySelector('[data-workspace-panel]')?.getAttribute('aria-busy')).toBe('true');

    const fastRequest = controller.openWorkspacePath(workspace, 'fast');
    fast.resolve(listing('fast', []));
    await fastRequest;
    slow.resolve(listing('slow', [
      { name: 'stale.txt', relativePath: 'slow/stale.txt', kind: 'file' },
    ]));
    await slowRequest;

    expect(document.querySelector('[data-path-label]')?.textContent).toBe('/fast');
    expect(document.querySelector('[data-status]')?.textContent)
      .toBe('Opened /fast — this directory is empty.');
    expect(document.body.textContent).not.toContain('stale.txt');
    expect(requiredButton('[data-select-workspace]').disabled).toBe(false);
    expect(document.querySelector('[data-workspace-panel]')?.getAttribute('aria-busy')).toBe('false');
    expect(document.activeElement).toBe(document.querySelector('[data-path-label]'));
    controller.dispose();
  });
});

describe('desktop renderer Mission execution flow', () => {
  it('prepares an explicit preview, approves, streams facts, and links artifacts by parent path', async () => {
    const fixture = bridgeFixture({ selectWorkspace: { selected: true, workspace } });
    const controller = mountDesktopRenderer(document, fixture.bridge);
    await authorizeAndPrepare(controller, 'Create src/result.txt with the word ready.');

    expect(fixture.prepareMission).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      provider: 'codex',
      prompt: 'Create src/result.txt with the word ready.',
    });
    expect(requiredElement('[data-mission-form]').hidden).toBe(true);
    expect(requiredElement('[data-approval-panel]').hidden).toBe(false);
    expect(document.querySelector('[data-approval-workspace]')?.textContent).toBe(workspace.name);
    expect(document.querySelector('[data-approval-provider]')?.textContent).toBe('Codex');
    expect(document.querySelector('[data-approval-prompt]')?.textContent)
      .toBe('Create src/result.txt with the word ready.');
    expect(document.querySelector('[data-approval-policy]')?.textContent).toContain('Read and write');
    expect(document.activeElement).toBe(document.querySelector('[data-approval-heading]'));
    expect(document.body.textContent).not.toContain('approval_opaque_01');

    await controller.approveMission();
    expect(fixture.approveMission).toHaveBeenCalledWith({ approvalId: preview().approvalId });
    expect(fixture.getExecution).toHaveBeenCalledWith({ executionId: accepted().executionId });
    expect(document.querySelector('[data-execution-state]')?.textContent).toBe('Running');
    expect(requiredButton('[data-select-workspace]').disabled).toBe(true);

    fixture.emit(outputEvent(2, '<img src=x onerror="globalThis.pwned=true">'));
    fixture.emit(artifactEvent(3, artifact('src/result.txt')));
    fixture.emit(stateEvent(4, 'succeeded'));

    expect(document.querySelector('[data-execution-log]')?.textContent)
      .toContain('<img src=x onerror="globalThis.pwned=true">');
    expect(document.querySelector('[data-execution-log] img')).toBeNull();
    expect(document.querySelector('[data-artifacts]')?.textContent).toContain('src/result.txt');
    expect(document.querySelector('[data-execution-state]')?.textContent).toBe('Succeeded');
    expect(document.querySelector('[data-mission-status]')?.textContent).toBe('Execution completed.');
    expect(requiredButton('[data-select-workspace]').disabled).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('[data-execution-heading]'));

    requiredButton('[aria-label="Show src/result.txt in workspace"]').click();
    await vi.waitFor(() => {
      expect(fixture.listWorkspaceEntries).toHaveBeenLastCalledWith({
        workspaceId: workspace.id,
        relativePath: 'src',
      });
    });
    expect(document.querySelector('[data-path-label]')?.textContent).toBe('/src');
    controller.dispose();
  });

  it('does not claim stopped until a Runtime snapshot confirms process-tree termination', async () => {
    const stopped = deferred<RuntimeExecutionSnapshot>();
    const fixture = bridgeFixture({
      selectWorkspace: { selected: true, workspace },
      stopExecution: () => stopped.promise,
    });
    const controller = mountDesktopRenderer(document, fixture.bridge);
    await authorizeAndPrepare(controller, 'Keep running until stopped.');
    await controller.approveMission();

    const stopPromise = controller.stopExecution();
    expect(document.querySelector('[data-mission-status]')?.textContent)
      .toBe('Stop requested. Waiting for process-tree confirmation…');
    expect(document.querySelector('[data-execution-state]')?.textContent).toBe('Running');
    expect(requiredButton('[data-stop]').disabled).toBe(true);
    expect(document.querySelector('[data-mission-status]')?.textContent).not.toContain('process tree was terminated');

    fixture.emit(stateEvent(2, 'stopping', 'pending'));
    expect(document.querySelector('[data-execution-state]')?.textContent).toBe('Stopping');
    expect(document.querySelector('[data-mission-status]')?.textContent)
      .toBe('Stopping. Waiting for the complete process tree to terminate…');

    stopped.resolve(snapshot({
      sequence: 3,
      state: 'stopped',
      finishedAt: '2026-08-23T09:00:03.000Z',
      treeTermination: 'confirmed',
    }));
    await stopPromise;

    expect(document.querySelector('[data-execution-state]')?.textContent).toBe('Stopped');
    expect(document.querySelector('[data-mission-status]')?.textContent)
      .toBe('Execution stopped and its process tree was terminated.');
    expect(requiredButton('[data-stop]').hidden).toBe(true);
    expect(requiredButton('[data-new-mission]').hidden).toBe(false);
    controller.dispose();
  });

  it('resynchronizes sequence gaps and never lets a late approval response roll state back', async () => {
    const approval = deferred<MissionExecutionAccepted>();
    let snapshotRequest = 0;
    const fixture = bridgeFixture({
      selectWorkspace: { selected: true, workspace },
      approveMission: () => approval.promise,
      getExecution: async () => {
        snapshotRequest += 1;
        return snapshotRequest === 1
          ? snapshot({
              sequence: 2,
              state: 'running',
              logs: [{
                sequence: 2,
                occurredAt: '2026-08-23T09:00:02.000Z',
                stream: 'stdout',
                text: 'recovered from snapshot',
              }],
            })
          : snapshot({ sequence: 1, state: 'queued', startedAt: null });
      },
    });
    const controller = mountDesktopRenderer(document, fixture.bridge);
    await authorizeAndPrepare(controller, 'Exercise the event race.');

    const approvePromise = controller.approveMission();
    // Sequence 1 was not delivered. This event also arrives before approve()
    // returns the execution id, so the mission id is used for correlation.
    fixture.emit(stateEvent(2, 'running'));
    await vi.waitFor(() => {
      expect(fixture.getExecution).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-execution-state]')?.textContent).toBe('Running');
      expect(document.querySelector('[data-execution-log]')?.textContent)
        .toContain('recovered from snapshot');
    });

    approval.resolve(accepted({ state: 'queued' }));
    await approvePromise;
    expect(fixture.getExecution).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-execution-state]')?.textContent).toBe('Running');
    expect(document.querySelector('[data-mission-status]')?.textContent)
      .toBe('Agent process is running.');
    controller.dispose();
  });

  it('invalidates an older mission preview response when workspace selection changes', async () => {
    const pendingPreview = deferred<MissionApprovalPreview>();
    const selections: WorkspaceSelection[] = [
      { selected: true, workspace },
      { selected: true, workspace: secondWorkspace },
    ];
    const fixture = bridgeFixture({
      selectWorkspace: async () => selections.shift() ?? { selected: false },
      listWorkspaceEntries: async (input) => listing(
        input.relativePath,
        [],
        input.workspaceId === secondWorkspace.id ? secondWorkspace : workspace,
      ),
      prepareMission: () => pendingPreview.promise,
    });
    const controller = mountDesktopRenderer(document, fixture.bridge);
    await controller.ready;
    await controller.selectWorkspace();
    setPrompt('Prepare against the first workspace.');

    const preparePromise = controller.prepareMission();
    await controller.selectWorkspace();
    pendingPreview.resolve(preview());
    await preparePromise;

    expect(document.querySelector('[data-workspace-heading]')?.textContent).toBe('second-workspace');
    expect(requiredElement('[data-mission-form]').hidden).toBe(false);
    expect(requiredElement('[data-approval-panel]').hidden).toBe(true);
    expect(document.body.textContent).not.toContain('Prepare against the first workspace.');
    controller.dispose();
  });

  it('bounds live output, deduplicates events, and unsubscribes on dispose', async () => {
    const fixture = bridgeFixture({ selectWorkspace: { selected: true, workspace } });
    const controller = mountDesktopRenderer(document, fixture.bridge);
    await authorizeAndPrepare(controller, 'Produce a long log.');
    await controller.approveMission();

    for (let sequence = 2; sequence <= 221; sequence += 1) {
      fixture.emit(outputEvent(sequence, `line-${sequence}`));
    }
    fixture.emit(outputEvent(221, 'duplicate-must-not-replace'));
    expect(document.querySelectorAll('[data-execution-log] .log-entry')).toHaveLength(200);
    const renderedLines = Array.from(
      document.querySelectorAll<HTMLElement>('[data-execution-log] .log-text'),
    )
      .map((element) => element.textContent);
    expect(renderedLines).not.toContain('line-2');
    expect(document.querySelector('[data-execution-log]')?.textContent).toContain('line-221');
    expect(document.querySelector('[data-execution-log]')?.textContent)
      .not.toContain('duplicate-must-not-replace');

    controller.dispose();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    fixture.emit(stateEvent(222, 'succeeded'));
    expect(document.querySelector('[data-execution-state]')?.textContent).toBe('Running');
  });
});

async function authorizeAndPrepare(
  controller: MountedDesktopRenderer,
  prompt: string,
): Promise<void> {
  await controller.ready;
  await controller.selectWorkspace();
  setPrompt(prompt);
  expect(requiredButton('[data-prepare]').disabled).toBe(false);
  await controller.prepareMission();
}

function setPrompt(value: string): void {
  const input = requiredElement<HTMLTextAreaElement>('[data-prompt]');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

type BridgeOverrides = {
  selectWorkspace?: WorkspaceSelection | DesktopBridge['selectWorkspace'];
  listWorkspaceEntries?: DesktopBridge['listWorkspaceEntries'];
  getRuntimeCatalog?: DesktopBridge['getRuntimeCatalog'];
  prepareMission?: DesktopBridge['prepareMission'];
  approveMission?: DesktopBridge['approveMission'];
  getExecution?: DesktopBridge['getExecution'];
  stopExecution?: DesktopBridge['stopExecution'];
};

function bridgeFixture(overrides: BridgeOverrides = {}) {
  const listeners = new Set<(event: RuntimeExecutionEvent) => void>();
  const unsubscribe = vi.fn();
  const getSystemInfo = vi.fn(async () => systemInfo);
  const selectionOverride = overrides.selectWorkspace;
  const selectWorkspaceImplementation: DesktopBridge['selectWorkspace'] =
    typeof selectionOverride === 'function'
      ? selectionOverride
      : async () => selectionOverride ?? { selected: false as const };
  const selectWorkspace = vi.fn(selectWorkspaceImplementation);
  const listWorkspaceEntries = vi.fn(overrides.listWorkspaceEntries ?? (async (input) => (
    listing(input.relativePath, [])
  )));
  const getRuntimeCatalog = vi.fn(overrides.getRuntimeCatalog ?? (async () => runtimeCatalog));
  const prepareMission = vi.fn(overrides.prepareMission ?? (async () => preview()));
  const approveMission = vi.fn(overrides.approveMission ?? (async () => accepted()));
  const getExecution = vi.fn(overrides.getExecution ?? (async () => snapshot()));
  const stopExecution = vi.fn(overrides.stopExecution ?? (async () => snapshot({
    sequence: 2,
    state: 'stopped',
    finishedAt: '2026-08-23T09:00:02.000Z',
    treeTermination: 'confirmed',
  })));
  const onExecutionEvent = vi.fn((listener: (event: RuntimeExecutionEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  });
  const bridge: DesktopBridge = {
    getSystemInfo,
    selectWorkspace,
    listWorkspaceEntries,
    getRuntimeCatalog,
    prepareMission,
    approveMission,
    getExecution,
    stopExecution,
    onExecutionEvent,
  };
  return {
    bridge,
    getSystemInfo,
    selectWorkspace,
    listWorkspaceEntries,
    getRuntimeCatalog,
    prepareMission,
    approveMission,
    getExecution,
    stopExecution,
    onExecutionEvent,
    unsubscribe,
    emit(event: RuntimeExecutionEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function preview(overrides: Partial<MissionApprovalPreview> = {}): MissionApprovalPreview {
  return {
    approvalId: 'approval_opaque_01' as MissionApprovalPreview['approvalId'],
    missionId: 'mission_opaque_01' as MissionApprovalPreview['missionId'],
    workspace,
    provider: 'codex',
    prompt: 'Create src/result.txt with the word ready.',
    policy,
    warnings: ['This agent can modify files inside the authorized workspace.'],
    expiresAt: '2026-08-23T09:10:00.000Z',
    ...overrides,
  };
}

function accepted(overrides: Partial<MissionExecutionAccepted> = {}): MissionExecutionAccepted {
  return {
    missionId: 'mission_opaque_01' as MissionExecutionAccepted['missionId'],
    executionId: 'execution_opaque_01' as MissionExecutionAccepted['executionId'],
    state: 'starting',
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<RuntimeExecutionSnapshot> = {},
): RuntimeExecutionSnapshot {
  return {
    missionId: 'mission_opaque_01' as RuntimeExecutionSnapshot['missionId'],
    executionId: 'execution_opaque_01' as RuntimeExecutionSnapshot['executionId'],
    workspace,
    provider: 'codex',
    state: 'running',
    sequence: 1,
    startedAt: '2026-08-23T09:00:01.000Z',
    finishedAt: null,
    error: null,
    summary: '',
    treeTermination: 'not-required',
    logs: [],
    artifacts: [],
    ...overrides,
  };
}

function stateEvent(
  sequence: number,
  state: RuntimeExecutionSnapshot['state'],
  termination: RuntimeExecutionSnapshot['treeTermination'] = 'not-required',
): RuntimeExecutionEvent {
  return {
    missionId: 'mission_opaque_01' as RuntimeExecutionEvent['missionId'],
    executionId: 'execution_opaque_01' as RuntimeExecutionEvent['executionId'],
    sequence,
    occurredAt: `2026-08-23T09:00:${String(sequence).padStart(2, '0')}.000Z`,
    type: 'state',
    state,
    error: null,
    treeTermination: termination,
  };
}

function outputEvent(sequence: number, text: string): RuntimeExecutionEvent {
  return {
    missionId: 'mission_opaque_01' as RuntimeExecutionEvent['missionId'],
    executionId: 'execution_opaque_01' as RuntimeExecutionEvent['executionId'],
    sequence,
    occurredAt: '2026-08-23T09:00:02.000Z',
    type: 'output',
    stream: 'stdout',
    text,
    truncated: false,
  };
}

function artifactEvent(sequence: number, value: RuntimeArtifact): RuntimeExecutionEvent {
  return {
    missionId: 'mission_opaque_01' as RuntimeExecutionEvent['missionId'],
    executionId: 'execution_opaque_01' as RuntimeExecutionEvent['executionId'],
    sequence,
    occurredAt: '2026-08-23T09:00:03.000Z',
    type: 'artifact',
    artifact: value,
  };
}

function artifact(relativePath: string): RuntimeArtifact {
  return {
    relativePath,
    change: 'created',
    size: 6,
    sha256: 'a'.repeat(64),
    scanStatus: 'scanned',
    provenance: 'runtime-workspace-scan',
  };
}

function listing(
  relativePath: string,
  entries: WorkspaceEntries['entries'],
  listingWorkspace = workspace,
): WorkspaceEntries {
  return {
    workspace: listingWorkspace,
    relativePath,
    entries,
    truncated: false,
  };
}

function requiredButton(selector: string): HTMLButtonElement {
  return requiredElement<HTMLButtonElement>(selector);
}

function requiredElement<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing_test_element:${selector}`);
  return element;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
