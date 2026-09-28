import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopBridge } from '@roundtable/protocol';

const electronMocks = {
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
};

beforeAll(async () => {
  const source = transpileModule(
    await readFile(new URL('../src/preload.cts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ModuleKind.CommonJS,
        target: ScriptTarget.ES2022,
      },
      fileName: 'preload.cts',
    },
  ).outputText;
  const moduleRecord = { exports: {} };
  runInNewContext(source, {
    exports: moduleRecord.exports,
    module: moduleRecord,
    Object,
    Promise,
    require: (specifier: string) => {
      if (specifier !== 'electron') throw new Error(`unexpected_preload_dependency:${specifier}`);
      return {
        contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
        ipcRenderer: {
          invoke: electronMocks.invoke,
          on: electronMocks.on,
          removeListener: electronMocks.removeListener,
        },
      };
    },
  });
});

describe('preload bridge', () => {
  beforeEach(() => {
    electronMocks.invoke.mockReset();
    electronMocks.on.mockReset();
    electronMocks.removeListener.mockReset();
  });

  it('exposes exactly the declared capabilities', () => {
    const [globalName, bridge] = electronMocks.exposeInMainWorld.mock.calls[0] as [
      string,
      DesktopBridge,
    ];

    expect(globalName).toBe('roundtableDesktop');
    expect(Object.keys(bridge).sort()).toEqual([
      'approveMission',
      'authorizeApply',
      'getExecution',
      'getRuntimeCatalog',
      'getSystemInfo',
      'listWorkspaceEntries',
      'onExecutionEvent',
      'prepareMission',
      'prepareReview',
      'rejectApply',
      'selectWorkspace',
      'stopExecution',
    ]);
    expect(Object.isFrozen(bridge)).toBe(true);
  });

  it('maps request capabilities to fixed IPC channels', async () => {
    const bridge = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;
    electronMocks.invoke.mockResolvedValue({ selected: false });

    await bridge.getSystemInfo();
    await bridge.selectWorkspace();
    await bridge.listWorkspaceEntries({
      workspaceId: 'workspace_01' as never,
      relativePath: '',
    });
    await bridge.getRuntimeCatalog();
    await bridge.prepareMission({
      workspaceId: 'workspace_01' as never,
      provider: 'codex',
      prompt: 'Implement the approved change.',
    });
    await bridge.approveMission({ approvalId: 'approval_01' as never });
    await bridge.getExecution({ executionId: 'execution_01' as never });
    await bridge.stopExecution({ executionId: 'execution_01' as never });

    expect(electronMocks.invoke.mock.calls).toEqual([
      ['roundtable:system:get-info'],
      ['roundtable:workspace:select'],
      ['roundtable:workspace:list-entries', {
        workspaceId: 'workspace_01',
        relativePath: '',
      }],
      ['roundtable:runtime:catalog'],
      ['roundtable:mission:prepare', {
        workspaceId: 'workspace_01',
        provider: 'codex',
        prompt: 'Implement the approved change.',
      }],
      ['roundtable:mission:approve', { approvalId: 'approval_01' }],
      ['roundtable:execution:get', { executionId: 'execution_01' }],
      ['roundtable:execution:stop', { executionId: 'execution_01' }],
    ]);
  });

  it('rebuilds request DTOs and rejects oversized or ambiguous inputs before Main', async () => {
    const bridge = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;

    await expect(bridge.listWorkspaceEntries({
      workspaceId: `workspace_${'x'.repeat(200)}` as never,
      relativePath: '',
    })).rejects.toThrow('workspace_request_invalid');
    await expect(bridge.listWorkspaceEntries({
      workspaceId: 'workspace_01' as never,
      relativePath: 'src\\escape',
    })).rejects.toThrow('workspace_request_invalid');
    expect(() => bridge.prepareMission({
      workspaceId: 'workspace_01' as never,
      provider: 'codex',
      prompt: 'x'.repeat(12_001),
    })).toThrow('mission_request_invalid');
    expect(() => bridge.prepareMission({
      workspaceId: 'workspace_01' as never,
      provider: 'codex',
      prompt: 'valid',
      ignored: true,
    } as never)).toThrow('mission_request_invalid');
    expect(() => bridge.approveMission({
      approvalId: `approval_${'x'.repeat(200)}` as never,
    })).toThrow('execution_request_invalid');
    expect(() => bridge.getExecution({
      executionId: 'execution_01' as never,
      ignored: true,
    } as never)).toThrow('execution_request_invalid');
    expect(() => bridge.stopExecution({
      executionId: 'approval_01' as never,
    })).toThrow('execution_request_invalid');
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    const listInput = {
      workspaceId: 'workspace_01' as never,
      relativePath: 'src',
      ignored: { large: true },
    };
    const missionInput = {
      workspaceId: 'workspace_01' as never,
      provider: 'claude-code' as const,
      prompt: 'Review src safely.',
    };
    const approvalInput = { approvalId: 'approval_01' as never };
    await bridge.listWorkspaceEntries(listInput as never);
    await bridge.prepareMission(missionInput);
    await bridge.approveMission(approvalInput);

    expect(electronMocks.invoke.mock.calls).toEqual([
      ['roundtable:workspace:list-entries', {
        workspaceId: 'workspace_01',
        relativePath: 'src',
      }],
      ['roundtable:mission:prepare', {
        workspaceId: 'workspace_01',
        provider: 'claude-code',
        prompt: 'Review src safely.',
      }],
      ['roundtable:mission:approve', { approvalId: 'approval_01' }],
    ]);
    expect(electronMocks.invoke.mock.calls[0]?.[1]).not.toBe(listInput);
    expect(electronMocks.invoke.mock.calls[1]?.[1]).not.toBe(missionInput);
    expect(electronMocks.invoke.mock.calls[2]?.[1]).not.toBe(approvalInput);
  });

  it('validates and copies execution events and unsubscribes the exact listener once', () => {
    const bridge = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;
    const listener = vi.fn();
    const unsubscribe = bridge.onExecutionEvent(listener);

    expect(electronMocks.on).toHaveBeenCalledTimes(1);
    const [channel, handler] = electronMocks.on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void,
    ];
    expect(channel).toBe('roundtable:execution:event');

    const rawEvent = {
      missionId: 'mission_01',
      executionId: 'execution_01',
      sequence: 3,
      occurredAt: '2026-08-23T00:00:00.000Z',
      type: 'artifact',
      artifact: {
        relativePath: 'src/result.ts',
        change: 'created',
        size: 42,
        sha256: 'a'.repeat(64),
        scanStatus: 'scanned',
        provenance: 'runtime-workspace-scan',
      },
    };
    handler({}, rawEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    const delivered = listener.mock.calls[0]?.[0];
    expect(delivered).toEqual(rawEvent);
    expect(delivered).not.toBe(rawEvent);
    expect(delivered.artifact).not.toBe(rawEvent.artifact);
    expect(Object.isFrozen(delivered)).toBe(true);
    expect(Object.isFrozen(delivered.artifact)).toBe(true);
    rawEvent.artifact.relativePath = 'changed-after-delivery.ts';
    expect(delivered.artifact.relativePath).toBe('src/result.ts');

    expect(() => handler({}, {
      missionId: 'mission_01',
      executionId: 'execution_01',
      sequence: 4,
      occurredAt: '2026-08-23T00:00:01.000Z',
      type: 'output',
      stream: 'stdout',
      text: 'x'.repeat(8_193),
      truncated: false,
    })).toThrow('execution_event_invalid');
    expect(() => handler({}, {
      ...rawEvent,
      sequence: 5,
      artifact: {
        ...rawEvent.artifact,
        sha256: null,
      },
    })).toThrow('execution_event_invalid');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledTimes(1);
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      'roundtable:execution:event',
      handler,
    );
  });

  it('rejects non-function execution listeners without registering IPC', () => {
    const bridge = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;

    expect(() => bridge.onExecutionEvent(null as never)).toThrow('execution_listener_invalid');
    expect(electronMocks.on).not.toHaveBeenCalled();
  });
});
