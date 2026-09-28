import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startSupervisedProcess,
  trackProcessTree,
  type SupervisedProcessEvent,
  type SupervisedProcessSpec,
  windowsTaskkillArguments,
} from '../src/process-supervisor.js';

const fixture = fileURLToPath(new URL('./fixtures/runtime-fixture.mjs', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.ROUNDTABLE_PARENT_CANARY;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-supervisor-'));
  temporaryDirectories.push(root);
  return root;
}

function limits(overrides: Partial<SupervisedProcessSpec['limits']> = {}): SupervisedProcessSpec['limits'] {
  return {
    totalTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    terminateGraceMs: 100,
    killConfirmMs: 2_000,
    maxStdoutBytes: 4 * 1024,
    maxStderrBytes: 2 * 1024,
    maxOutputChunkBytes: 512,
    ...overrides,
  };
}

describe('real process supervision', () => {
  it('uses only the fixed Windows tree-kill argument shape', () => {
    expect(windowsTaskkillArguments(42, false)).toEqual(['/PID', '42', '/T']);
    expect(windowsTaskkillArguments(42, true)).toEqual(['/PID', '42', '/T', '/F']);
    expect(() => windowsTaskkillArguments(-1, true)).toThrow('invalid_process_id');
  });
  it('passes only the explicit env and keeps flood output/events bounded', async () => {
    const root = await temporaryRoot();
    process.env.ROUNDTABLE_PARENT_CANARY = 'must-not-leak';
    const envProcess = startSupervisedProcess({
      command: process.execPath,
      args: [fixture, 'env'],
      cwd: root,
      env: { ROUNDTRIP_SAFE: 'yes' },
      stdin: '',
      secrets: [],
      limits: limits(),
    });
    const envResult = await envProcess.completion;
    const childEnvironment = JSON.parse(envResult.stdout) as Record<string, string>;
    expect(childEnvironment.ROUNDTRIP_SAFE).toBe('yes');
    expect(childEnvironment.ROUNDTABLE_PARENT_CANARY).toBeUndefined();

    const events: SupervisedProcessEvent[] = [];
    const flood = startSupervisedProcess({
      command: process.execPath,
      args: [fixture, 'flood'],
      cwd: root,
      env: {},
      stdin: '',
      secrets: [],
      limits: limits(),
      onEvent: (event) => events.push(event),
    });
    const result = await flood.completion;

    expect(result.status).toBe('exited');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(2 * 1024);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(events.filter((event) => event.kind === 'output_truncated')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'output').every((event) => (
      event.kind !== 'output' || Buffer.byteLength(event.text) <= 512
    ))).toBe(true);
  });

  it('redacts a secret even when it crosses output chunk boundaries', async () => {
    const root = await temporaryRoot();
    const secret = 'split-secret-value';
    const child = startSupervisedProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write('prefix ${secret.slice(0, 7)}'); setTimeout(() => process.stdout.write('${secret.slice(7)} suffix'), 20)`],
      cwd: root,
      env: {},
      stdin: '',
      secrets: [secret],
      limits: limits(),
    });
    const result = await child.completion;

    expect(result.stdout).toBe('prefix [REDACTED] suffix');
    expect(result.stdout).not.toContain(secret);
  });

  it('prefers the longest overlapping secret and does not leak its suffix', async () => {
    const root = await temporaryRoot();
    const shorter = 'token-prefix';
    const longer = 'token-prefix-sensitive-tail';
    const child = startSupervisedProcess({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write('${shorter}'); setTimeout(() => process.stdout.write('${longer.slice(shorter.length)}'), 20)`,
      ],
      cwd: root,
      env: {},
      stdin: '',
      secrets: [shorter, longer],
      limits: limits(),
    });
    const result = await child.completion;

    expect(result.stdout).toBe('[REDACTED]');
    expect(result.stdout).not.toContain('sensitive-tail');
  });

  it('keeps redaction-delayed streaming events within the output chunk cap', async () => {
    const root = await temporaryRoot();
    const secretPrefix = 's'.repeat(2 * 1024);
    const events: SupervisedProcessEvent[] = [];
    const child = startSupervisedProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write('${secretPrefix}')`],
      cwd: root,
      env: {},
      stdin: '',
      secrets: [`${secretPrefix}unseen-tail`],
      limits: limits(),
      onEvent: (event) => events.push(event),
    });
    const result = await child.completion;
    const outputEvents = events.filter((event): event is Extract<
      SupervisedProcessEvent,
      { kind: 'output' }
    > => event.kind === 'output');

    expect(result.stdout).toBe(secretPrefix);
    expect(outputEvents.map((event) => event.text).join('')).toBe(secretPrefix);
    expect(outputEvents.every((event) => Buffer.byteLength(event.text) <= 512)).toBe(true);
  });

  it('escalates TERM to KILL and confirms a grandchild process tree is gone', async () => {
    const root = await temporaryRoot();
    const pidFile = join(root, 'pids.json');
    const events: SupervisedProcessEvent[] = [];
    const child = startSupervisedProcess({
      command: process.execPath,
      args: [fixture, 'tree', pidFile],
      cwd: root,
      env: {},
      stdin: '',
      secrets: [],
      limits: limits({ totalTimeoutMs: 10_000, idleTimeoutMs: 10_000 }),
      onEvent: (event) => events.push(event),
    });
    const pids = await waitForPidFile(pidFile);

    await expect(child.stop()).resolves.toBe('confirmed');
    const result = await child.completion;
    expect(result.status).toBe('stopped');
    expect(result.treeTermination).toBe('confirmed');
    await expect(waitForProcessExit(pids.parent)).resolves.toBe(true);
    await expect(waitForProcessExit(pids.grandchild)).resolves.toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'stop_requested', reason: 'requested' }),
    ]));
  });

  it.skipIf(process.platform === 'win32')(
    'tracks a setsid descendant, closes inherited pipes, and never confirms early',
    async () => {
      const root = await temporaryRoot();
      const pidFile = join(root, 'detached-pids.json');
      const child = startSupervisedProcess({
        command: process.execPath,
        args: [fixture, 'detached-tree', pidFile],
        cwd: root,
        env: {},
        stdin: '',
        secrets: [],
        limits: limits({ totalTimeoutMs: 10_000, idleTimeoutMs: 10_000 }),
      });
      const pids = await waitForPidFile(pidFile);
      try {
        await expect(child.stop()).resolves.toBe('confirmed');
        const result = await Promise.race([
          child.completion,
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error('detached_completion_timeout')),
            3_000,
          )),
        ]);
        expect(result.status).toBe('stopped');
        await expect(waitForProcessExit(pids.parent)).resolves.toBe(true);
        await expect(waitForProcessExit(pids.grandchild)).resolves.toBe(true);
      } finally {
        for (const pid of [pids.parent, pids.grandchild]) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The supervisor should already have reaped the complete tree.
          }
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'exports a persistent crash-cleanup tracker for a detached provider tree',
    async () => {
      const root = await temporaryRoot();
      const pidFile = join(root, 'crash-fallback-pids.json');
      const provider = spawn(process.execPath, [fixture, 'detached-tree', pidFile], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      if (!provider.pid) throw new Error('fixture_spawn_failed');
      const tracker = trackProcessTree(provider.pid);
      await expect(tracker.ready).resolves.toBe(true);
      const pids = await waitForPidFile(pidFile);
      try {
        await expect(tracker.terminate({
          terminateGraceMs: 100,
          killConfirmMs: 2_000,
        })).resolves.toBe('confirmed');
        await expect(waitForProcessExit(pids.parent)).resolves.toBe(true);
        await expect(waitForProcessExit(pids.grandchild)).resolves.toBe(true);
      } finally {
        tracker.dispose();
        for (const pid of [pids.parent, pids.grandchild]) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The crash-cleanup tracker should already have reaped the tree.
          }
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'never confirms an unbound stale PID and permits a failed termination retry',
    async () => {
      const tracker = trackProcessTree(2_147_483_646);
      await expect(tracker.ready).resolves.toBe(false);
      const first = tracker.terminate({ terminateGraceMs: 25, killConfirmMs: 25 });
      await expect(first).resolves.toBe('failed');
      const retry = tracker.terminate({ terminateGraceMs: 25, killConfirmMs: 25 });
      expect(retry).not.toBe(first);
      await expect(retry).resolves.toBe('failed');
      tracker.dispose();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'retains a supervised tracker and retries after an unconfirmed stop',
    async () => {
      const root = await temporaryRoot();
      const child = startSupervisedProcess({
        command: process.execPath,
        args: [fixture, 'idle'],
        cwd: root,
        env: {},
        stdin: '',
        secrets: [],
        limits: limits({ totalTimeoutMs: 10_000, idleTimeoutMs: 10_000 }),
      });
      if (!child.pid) throw new Error('fixture_spawn_failed');
      const originalKill = process.kill.bind(process);
      let rejectFirstGroupSignal = true;
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (rejectFirstGroupSignal && pid === -child.pid && signal === 'SIGTERM') {
          const error = new Error('simulated_group_signal_failure') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        return originalKill(pid, signal);
      });

      try {
        const first = child.stop();
        await expect(first).resolves.toBe('failed');
        const completion = await child.completion;
        expect(completion.status).toBe('termination_failed');
        expect(completion.treeTermination).toBe('failed');

        rejectFirstGroupSignal = false;
        const retry = child.stop();
        expect(retry).not.toBe(first);
        await expect(retry).resolves.toBe('confirmed');
        await expect(waitForProcessExit(child.pid)).resolves.toBe(true);
      } finally {
        kill.mockRestore();
        try {
          originalKill(child.pid, 'SIGKILL');
        } catch {
          // The retry should already have reaped the process.
        }
      }
    },
  );

  it('enforces the idle timeout and confirms cleanup', async () => {
    const root = await temporaryRoot();
    const child = startSupervisedProcess({
      command: process.execPath,
      args: [fixture, 'idle'],
      cwd: root,
      env: {},
      stdin: '',
      secrets: [],
      limits: limits({ totalTimeoutMs: 2_000, idleTimeoutMs: 100 }),
    });
    const result = await child.completion;

    expect(result.status).toBe('idle_timed_out');
    expect(result.treeTermination).toBe('confirmed');
  });

  it('enforces the total timeout even while output keeps the process active', async () => {
    const root = await temporaryRoot();
    const child = startSupervisedProcess({
      command: process.execPath,
      args: [fixture, 'busy'],
      cwd: root,
      env: {},
      stdin: '',
      secrets: [],
      limits: limits({ totalTimeoutMs: 150, idleTimeoutMs: 1_000 }),
    });
    const result = await child.completion;

    expect(result.status).toBe('timed_out');
    expect(result.treeTermination).toBe('confirmed');
  });
});

async function waitForPidFile(path: string): Promise<{ parent: number; grandchild: number }> {
  const deadline = Date.now() + 3_000;
  do {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        parent?: unknown;
        grandchild?: unknown;
      };
      if (typeof parsed.parent === 'number' && typeof parsed.grandchild === 'number') {
        return { parent: parsed.parent, grandchild: parsed.grandchild };
      }
    } catch {
      // The fixture creates the file after its grandchild has spawned.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error('fixture_pid_timeout');
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  do {
    if (!processAlive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return !processAlive(pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
