import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  missionPrepareInputSchema,
  runtimeCatalogSchema,
  runtimeExecutionEventSchema,
  type RuntimeCatalogEntry,
  type RuntimeExecutionEvent,
} from '@roundtable/protocol';

import {
  DesktopExecutionAuthority,
  type DesktopRuntimePort,
  type PreparedExecutionWorkspace,
  type RuntimeLaunchRequest,
} from '../src/execution-authority.js';
import { WorkspaceGrantRegistry } from '../src/workspace-grants.js';

const temporaryDirectories: string[] = [];
const windowSessionNonce = 'window-session-00000001';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

class FakeRuntime implements DesktopRuntimePort {
  readonly launches: RuntimeLaunchRequest[] = [];
  readonly preparations: Array<{ provider: string; workspaceRoot: string }> = [];
  readonly #listeners = new Set<(event: RuntimeExecutionEvent) => void>();
  stopEvent: RuntimeExecutionEvent | null = null;
  launchError: Error | null = null;

  async getCatalog() {
    return catalog();
  }

  async prepare(input: {
    provider: 'codex' | 'claude-code' | 'opencode';
    workspaceRoot: string;
    rootDevice: string;
    rootInode: string;
  }) {
    this.preparations.push({ provider: input.provider, workspaceRoot: input.workspaceRoot });
    return {
      preparationToken: `prepared_${input.provider}`,
      catalogEntry: catalog().providers.find((entry) => entry.provider === input.provider)!,
    };
  }

  async launch(input: RuntimeLaunchRequest): Promise<void> {
    if (this.launchError) throw this.launchError;
    this.launches.push(input);
  }

  async stop(executionId: string): Promise<RuntimeExecutionEvent> {
    if (this.stopEvent) return this.stopEvent;
    const launch = this.launches.find((entry) => entry.executionId === executionId);
    if (!launch) throw new Error('missing_execution');
    return runtimeExecutionEventSchema.parse({
      missionId: launch.missionId,
      executionId,
      sequence: 1,
      occurredAt: '2026-08-23T08:31:00.000Z',
      type: 'state',
      state: 'stopped',
      error: null,
      treeTermination: 'confirmed',
    });
  }

  onEvent(listener: (event: RuntimeExecutionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: RuntimeExecutionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

describe('desktop execution authority', () => {
  it('prepares without spawning and approves the exact bound prompt once', async () => {
    const root = await workspace('approval');
    const grants = new WorkspaceGrantRegistry();
    const selected = await grants.grant(root, 7);
    const runtime = new FakeRuntime();
    const authority = new DesktopExecutionAuthority({ grants, runtime });

    const preview = await authority.prepareMission(missionPrepareInputSchema.parse({
      workspaceId: selected.id,
      provider: 'codex',
      prompt: '  Build the approved change.  ',
    }), 7, windowSessionNonce);

    expect(runtime.preparations).toEqual([{
      provider: 'codex',
      workspaceRoot: await realpath(root),
    }]);
    expect(runtime.launches).toHaveLength(0);
    expect(preview.prompt).toBe('Build the approved change.');
    expect(JSON.stringify(preview)).not.toContain(root);

    const accepted = await authority.approveMission(preview.approvalId, 7, windowSessionNonce);
    expect(runtime.launches).toHaveLength(1);
    expect(runtime.launches[0]).toMatchObject({
      executionId: accepted.executionId,
      workspaceId: selected.id,
      provider: 'codex',
      prompt: 'Build the approved change.',
    });
    await expect(authority.approveMission(preview.approvalId, 7, windowSessionNonce))
      .rejects.toThrow('mission_approval_invalid');
  });

  it('binds pre-launch staging to the approved execution', async () => {
    const root = await workspace('prelaunch-staging');
    const stagingRoot = await workspace('isolated-staging');
    const grants = new WorkspaceGrantRegistry();
    const selected = await grants.grant(root, 8);
    const runtime = new FakeRuntime();
    const commits: string[] = [];
    const cleanups: string[] = [];
    const workspaceFactory = vi.fn(async ({ missionId }: { missionId: string }): Promise<PreparedExecutionWorkspace> => ({
      root: stagingRoot,
      rootDevice: 'staging-device',
      rootInode: 'staging-inode',
      commit: (executionId) => { commits.push(`${missionId}->${executionId}`); },
      cleanup: async () => { cleanups.push(missionId); },
    }));
    const authority = new DesktopExecutionAuthority({
      grants,
      runtime,
      prepareExecutionWorkspace: workspaceFactory,
    });
    const preview = await authority.prepareMission(missionPrepareInputSchema.parse({
      workspaceId: selected.id,
      provider: 'codex',
      prompt: 'Use staging.',
    }), 8, windowSessionNonce);
    const accepted = await authority.approveMission(preview.approvalId, 8, windowSessionNonce);
    expect(workspaceFactory).toHaveBeenCalledOnce();
    expect(commits).toEqual([`${preview.missionId}->${accepted.executionId}`]);
    expect(runtime.preparations[0]!.workspaceRoot).toBe(stagingRoot);
    expect(runtime.launches[0]!.workspaceRoot).toBe(stagingRoot);
    expect(cleanups).toEqual([]);
  });

  it('attempts staging cleanup when launch fails before any runtime event', async () => {
    const root = await workspace('launch-failure');
    const stagingRoot = await workspace('isolated-launch-failure');
    const grants = new WorkspaceGrantRegistry();
    const selected = await grants.grant(root, 9);
    const runtime = new FakeRuntime();
    runtime.launchError = new Error('provider_unavailable');
    let cleaned = 0;
    const authority = new DesktopExecutionAuthority({
      grants,
      runtime,
      prepareExecutionWorkspace: async () => ({
        root: stagingRoot,
        rootDevice: 'staging-device',
        rootInode: 'staging-inode',
        commit: () => undefined,
        cleanup: async () => { cleaned += 1; },
      }),
    });
    const preview = await authority.prepareMission(missionPrepareInputSchema.parse({
      workspaceId: selected.id,
      provider: 'codex',
      prompt: 'Fail closed.',
    }), 9, windowSessionNonce);
    await expect(authority.approveMission(preview.approvalId, 9, windowSessionNonce))
      .rejects.toThrow('runtime_launch_failed');
    expect(cleaned).toBe(1);
  });

  it('invalidates an approval when the owner grants a different workspace', async () => {
    const firstRoot = await workspace('first');
    const secondRoot = await workspace('second');
    const grants = new WorkspaceGrantRegistry();
    const first = await grants.grant(firstRoot, 11);
    const runtime = new FakeRuntime();
    const authority = new DesktopExecutionAuthority({ grants, runtime });
    const preview = await authority.prepareMission(missionPrepareInputSchema.parse({
      workspaceId: first.id,
      provider: 'codex',
      prompt: 'Change only the first workspace.',
    }), 11, windowSessionNonce);

    await grants.grant(secondRoot, 11, grants.ownerGeneration(11));
    await expect(authority.approveMission(preview.approvalId, 11, windowSessionNonce))
      .rejects.toThrow('workspace_not_authorized');
    expect(runtime.launches).toHaveLength(0);
  });

  it('rejects expired, cross-owner, and cross-window approvals', async () => {
    const root = await workspace('identity');
    const grants = new WorkspaceGrantRegistry();
    const selected = await grants.grant(root, 17);
    const runtime = new FakeRuntime();
    let now = 1_800_000_000_000;
    const authority = new DesktopExecutionAuthority({
      grants,
      runtime,
      now: () => now,
      approvalTtlMs: 1_000,
    });
    const preview = await authority.prepareMission(missionPrepareInputSchema.parse({
      workspaceId: selected.id,
      provider: 'claude-code',
      prompt: 'Prepare a safe edit.',
    }), 17, windowSessionNonce);

    await expect(authority.approveMission(preview.approvalId, 18, windowSessionNonce))
      .rejects.toThrow('mission_approval_invalid');
    await expect(authority.approveMission(preview.approvalId, 17, 'another-window-session'))
      .rejects.toThrow('mission_approval_invalid');
    now += 1_001;
    await expect(authority.approveMission(preview.approvalId, 17, windowSessionNonce))
      .rejects.toThrow('mission_approval_invalid');
    expect(runtime.launches).toHaveLength(0);
  });

  it('projects ordered runtime facts and returns stop only after tree confirmation', async () => {
    const root = await workspace('events');
    await writeFile(join(root, 'result.txt'), 'before', 'utf8');
    const grants = new WorkspaceGrantRegistry();
    const selected = await grants.grant(root, 23);
    const runtime = new FakeRuntime();
    const authority = new DesktopExecutionAuthority({ grants, runtime });
    const preview = await authority.prepareMission(missionPrepareInputSchema.parse({
      workspaceId: selected.id,
      provider: 'opencode',
      prompt: 'Edit result.txt.',
    }), 23, windowSessionNonce);
    const accepted = await authority.approveMission(preview.approvalId, 23, windowSessionNonce);
    const events = vi.fn();
    authority.onEvent(events);

    for (const event of [
      runtimeEvent(accepted.missionId, accepted.executionId, 1, {
        type: 'state', state: 'starting', error: null, treeTermination: 'not-required',
      }),
      runtimeEvent(accepted.missionId, accepted.executionId, 2, {
        type: 'state', state: 'running', error: null, treeTermination: 'not-required',
      }),
      runtimeEvent(accepted.missionId, accepted.executionId, 3, {
        type: 'output', stream: 'stdout', text: 'working', truncated: false,
      }),
      runtimeEvent(accepted.missionId, accepted.executionId, 4, {
        type: 'artifact',
        artifact: {
          relativePath: 'result.txt',
          change: 'modified',
          size: 5,
          sha256: 'b'.repeat(64),
          scanStatus: 'scanned',
          provenance: 'runtime-workspace-scan',
        },
      }),
    ]) runtime.emit(event);

    // Duplicate and gap events are not committed or forwarded.
    runtime.emit(runtimeEvent(accepted.missionId, accepted.executionId, 4, {
      type: 'output', stream: 'stdout', text: 'duplicate', truncated: false,
    }));
    runtime.emit(runtimeEvent(accepted.missionId, accepted.executionId, 7, {
      type: 'output', stream: 'stdout', text: 'gap', truncated: false,
    }));

    runtime.stopEvent = runtimeEvent(accepted.missionId, accepted.executionId, 5, {
      type: 'state', state: 'stopped', error: null, treeTermination: 'confirmed',
    });
    const stopped = await authority.stopExecution(
      accepted.executionId,
      23,
      windowSessionNonce,
    );
    expect(stopped).toMatchObject({
      state: 'stopped',
      sequence: 5,
      treeTermination: 'confirmed',
      summary: 'working',
      artifacts: [{ relativePath: 'result.txt', scanStatus: 'scanned' }],
    });
    expect(events).toHaveBeenCalledTimes(5);
  });
});

function catalog() {
  return runtimeCatalogSchema.parse({
    providers: [
      catalogEntry('codex', 'Codex', 'codex-v1', 'workspace-os-sandbox', 'os-denied'),
      catalogEntry('claude-code', 'Claude Code', 'claude-v1', 'workspace-os-sandbox', 'os-denied'),
      catalogEntry('opencode', 'OpenCode', 'opencode-v1', 'provider-permissions', 'provider-denied'),
    ],
  });
}

function catalogEntry(
  provider: RuntimeCatalogEntry['provider'],
  label: string,
  adapterVersion: string,
  sandbox: RuntimeCatalogEntry['policy']['sandbox'],
  externalFileAccess: RuntimeCatalogEntry['policy']['externalFileAccess'],
) {
  return {
    provider,
    label,
    available: true,
    version: 'test 1.0',
    installHint: `Install ${label}.`,
    policy: {
      adapterVersion,
      sandbox,
      workspaceWrite: true,
      externalFileAccess,
      projectCustomizations: 'disabled',
      network: 'provider-required',
      secrets: 'provider-scoped',
      timeoutMs: 1_800_000,
    },
    warnings: [],
  };
}

function runtimeEvent(
  missionId: string,
  executionId: string,
  sequence: number,
  update: Record<string, unknown>,
): RuntimeExecutionEvent {
  return runtimeExecutionEventSchema.parse({
    missionId,
    executionId,
    sequence,
    occurredAt: `2026-08-23T08:30:0${Math.min(sequence, 9)}.000Z`,
    ...update,
  });
}

async function workspace(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `roundtable-${label}-`));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'src'));
  return root;
}
