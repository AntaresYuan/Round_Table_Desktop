import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { startMacOsCoalitionSupervisedProcess } from '../src/macos-coalition-supervisor.js';
import type { SupervisedProcess, SupervisedProcessEvent } from '../src/process-supervisor.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const runtimePackageRoot = fileURLToPath(new URL('../', import.meta.url));
const monorepoRoot = fileURLToPath(new URL('../../../', import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe.skipIf(process.platform !== 'darwin')('macOS coalition supervisor watchdogs', () => {
  it('allows a healthy provider to run longer than the TREE response watchdog', async () => {
    const fixture = await createFixtureRoot('roundtable-coalition-long-run-');
    let supervised: SupervisedProcess | null = null;
    const startedAt = Date.now();
    try {
      supervised = await startMacOsCoalitionSupervisedProcess({
        ...fixture.spec,
        command: '/bin/sleep',
        args: ['9'],
        limits: supervisorLimits(20_000),
      });
      const result = await supervised.completion;

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(8_500);
      expect(result).toMatchObject({
        status: 'exited',
        exitCode: 0,
        treeTermination: 'confirmed',
      });
    } finally {
      await supervised?.stop('shutdown').catch(() => undefined);
    }
  }, 30_000);

  it('falls back to bounded external cleanup when the guardian cannot answer stop', async () => {
    const fixture = await createFixtureRoot('roundtable-coalition-watchdog-');
    let supervised: SupervisedProcess | null = null;
    let guardianPid: number | null = null;
    try {
      supervised = await startMacOsCoalitionSupervisedProcess({
        ...fixture.spec,
        command: '/bin/sleep',
        args: ['30'],
        limits: supervisorLimits(25_000),
      });
      expect(supervised.pid).not.toBeNull();
      guardianPid = await parentPid(supervised.pid!);
      expect(guardianPid).not.toBe(process.pid);
      process.kill(guardianPid, 'SIGSTOP');

      const stopStartedAt = Date.now();
      await expect(supervised.stop('requested')).resolves.toBe('confirmed');
      expect(Date.now() - stopStartedAt).toBeGreaterThanOrEqual(7_500);
      await expect(supervised.completion).resolves.toMatchObject({
        status: 'termination_failed',
        treeTermination: 'confirmed',
      });
    } finally {
      if (guardianPid !== null) {
        try {
          process.kill(guardianPid, 'SIGCONT');
        } catch {
          // The expected cleanup path has already reaped the guardian.
        }
      }
      await supervised?.stop('shutdown').catch(() => undefined);
    }
  }, 35_000);

  it('uses redundant independent watchdogs if the guardian crashes before TREE proof', async () => {
    const fixture = await createFixtureRoot('roundtable-coalition-guardian-crash-');
    let supervised: SupervisedProcess | null = null;
    let guardianPid: number | null = null;
    let providerPid: number | null = null;
    try {
      supervised = await startMacOsCoalitionSupervisedProcess({
        ...fixture.spec,
        command: '/bin/sleep',
        args: ['30'],
        limits: supervisorLimits(25_000),
      });
      providerPid = supervised.pid;
      expect(providerPid).not.toBeNull();
      guardianPid = await parentPid(providerPid!);
      process.kill(guardianPid, 'SIGKILL');

      await expect(supervised.stop('requested')).resolves.toBe('confirmed');
      await expect(supervised.completion).resolves.toMatchObject({
        status: 'termination_failed',
        treeTermination: 'confirmed',
      });
      expect(() => process.kill(providerPid!, 0)).toThrow();
    } finally {
      if (guardianPid !== null) {
        try {
          process.kill(guardianPid, 'SIGKILL');
        } catch {
          // The expected watchdog has already reaped the guardian.
        }
      }
      await supervised?.stop('shutdown').catch(() => undefined);
    }
  }, 40_000);

  it('survives one watchdog crash and still proves full-coalition cleanup', async () => {
    const fixture = await createFixtureRoot('roundtable-coalition-watchdog-crash-');
    const beforeLabels = await watchdogServiceLabels();
    let supervised: SupervisedProcess | null = null;
    let providerPid: number | null = null;
    let monitorActive = false;
    let monitor: Promise<void> | null = null;
    const observedLabels = new Set<string>();
    try {
      supervised = await startMacOsCoalitionSupervisedProcess({
        ...fixture.spec,
        command: '/bin/sleep',
        args: ['30'],
        limits: supervisorLimits(25_000),
      });
      providerPid = supervised.pid;
      expect(providerPid).not.toBeNull();
      const ownedLabels = (await watchdogServiceLabels())
        .filter((label) => !beforeLabels.includes(label));
      expect(ownedLabels).toHaveLength(2);
      for (const label of ownedLabels) observedLabels.add(label);
      monitorActive = true;
      monitor = (async () => {
        while (monitorActive) {
          const labels = await watchdogServiceLabels().catch(() => []);
          for (const label of labels) {
            if (!beforeLabels.includes(label)) observedLabels.add(label);
          }
          await delay(25);
        }
      })();

      process.kill(await launchdServicePid(ownedLabels[0]!), 'SIGKILL');

      await expect(supervised.completion).resolves.toMatchObject({
        status: 'termination_failed',
        treeTermination: 'confirmed',
      });
      monitorActive = false;
      await monitor;
      expect([...observedLabels].sort()).toEqual(ownedLabels.sort());
      expect(() => process.kill(providerPid!, 0)).toThrow();
      const remaining = (await watchdogServiceLabels())
        .filter((label) => !beforeLabels.includes(label));
      expect(remaining).toEqual([]);
    } finally {
      monitorActive = false;
      await monitor?.catch(() => undefined);
      await supervised?.stop('shutdown').catch(() => undefined);
    }
  }, 40_000);

  it('uses the trusted direct fallback if both watchdogs crash together', async () => {
    const fixture = await createFixtureRoot('roundtable-coalition-watchdogs-crash-');
    const beforeLabels = await watchdogServiceLabels();
    let supervised: SupervisedProcess | null = null;
    let providerPid: number | null = null;
    try {
      supervised = await startMacOsCoalitionSupervisedProcess({
        ...fixture.spec,
        command: '/bin/sleep',
        args: ['30'],
        limits: supervisorLimits(25_000),
      });
      providerPid = supervised.pid;
      expect(providerPid).not.toBeNull();
      const ownedLabels = (await watchdogServiceLabels())
        .filter((label) => !beforeLabels.includes(label));
      expect(ownedLabels).toHaveLength(2);
      const watchdogPids = await Promise.all(ownedLabels.map(launchdServicePid));
      for (const pid of watchdogPids) process.kill(pid, 'SIGSTOP');
      for (const pid of watchdogPids) process.kill(pid, 'SIGKILL');

      await expect(supervised.completion).resolves.toMatchObject({
        status: 'termination_failed',
        treeTermination: 'confirmed',
      });
      expect(() => process.kill(providerPid!, 0)).toThrow();
      const remaining = (await watchdogServiceLabels())
        .filter((label) => !beforeLabels.includes(label));
      expect(remaining).toEqual([]);
    } finally {
      await supervised?.stop('shutdown').catch(() => undefined);
    }
  }, 40_000);

  it('emits START before immediate output arriving on separate sockets', async () => {
    const fixture = await createFixtureRoot('roundtable-coalition-event-order-');
    const events: SupervisedProcessEvent[] = [];
    let supervised: SupervisedProcess | null = null;
    try {
      supervised = await startMacOsCoalitionSupervisedProcess({
        ...fixture.spec,
        command: '/bin/sh',
        args: ['-c', "printf 'fast-stdout'; printf 'fast-stderr' >&2"],
        limits: supervisorLimits(15_000),
        onEvent: (event) => events.push(event),
      });
      await expect(supervised.completion).resolves.toMatchObject({
        status: 'exited',
        exitCode: 0,
        treeTermination: 'confirmed',
      });
      expect(events[0]).toMatchObject({ kind: 'started' });
      expect(events.filter((event) => event.kind === 'output')).toHaveLength(2);
      expect(events.findIndex((event) => event.kind === 'output')).toBeGreaterThan(0);
    } finally {
      await supervised?.stop('shutdown').catch(() => undefined);
    }
  }, 20_000);

  it.each([
    {
      label: 'ancestor of the Runtime package trust root',
      cwd: monorepoRoot,
      trustedCodeRoots: [] as string[],
    },
    {
      label: 'child of the Runtime package trust root',
      cwd: join(runtimePackageRoot, 'src'),
      trustedCodeRoots: [] as string[],
    },
    {
      label: 'transitive protocol dependency under the desktop monorepo trust root',
      cwd: join(monorepoRoot, 'packages', 'protocol'),
      trustedCodeRoots: [monorepoRoot],
    },
  ])('rejects a provider-writable $label before creating control state', async ({
    cwd,
    trustedCodeRoots,
  }) => {
    const fixture = await createFixtureRoot('roundtable-coalition-helper-trust-');
    const before = (await readdir('/private/tmp'))
      .filter((entry) => entry.startsWith('roundtable-guard-'))
      .sort();

    await expect(startMacOsCoalitionSupervisedProcess({
      ...fixture.spec,
      cwd,
      trustedCodeRoots,
      command: '/usr/bin/true',
      args: [],
      limits: supervisorLimits(5_000),
    })).rejects.toMatchObject({ code: 'security_boundary_unavailable' });

    const after = (await readdir('/private/tmp'))
      .filter((entry) => entry.startsWith('roundtable-guard-'))
      .sort();
    expect(after).toEqual(before);
  });

  it('rejects a writable ancestor of the private control root', async () => {
    const fixture = await createFixtureRoot('roundtable-coalition-control-root-');
    const before = (await readdir('/private/tmp'))
      .filter((entry) => entry.startsWith('roundtable-guard-'))
      .sort();

    await expect(startMacOsCoalitionSupervisedProcess({
      ...fixture.spec,
      cwd: '/private',
      command: '/usr/bin/true',
      args: [],
      limits: supervisorLimits(5_000),
    })).rejects.toMatchObject({ code: 'security_boundary_unavailable' });

    const after = (await readdir('/private/tmp'))
      .filter((entry) => entry.startsWith('roundtable-guard-'))
      .sort();
    expect(after).toEqual(before);
  });
});

async function createFixtureRoot(prefix: string): Promise<{
  spec: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
    secrets: string[];
    runtimeHomeDirectory: string;
    runtimeTemporaryDirectory: string;
  };
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const home = join(root, 'home');
  const temporary = join(root, 'temporary');
  await mkdir(home, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  return {
    spec: {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdin: '',
      secrets: [],
      runtimeHomeDirectory: home,
      runtimeTemporaryDirectory: temporary,
    },
  };
}

function supervisorLimits(timeoutMs: number): {
  totalTimeoutMs: number;
  idleTimeoutMs: number;
  terminateGraceMs: number;
  killConfirmMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxOutputChunkBytes: number;
} {
  return {
    totalTimeoutMs: timeoutMs,
    idleTimeoutMs: timeoutMs,
    terminateGraceMs: 100,
    killConfirmMs: 3_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    maxOutputChunkBytes: 4 * 1024,
  };
}

async function parentPid(pid: number): Promise<number> {
  const result = await execFileAsync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 16 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  const value = Number(result.stdout.trim());
  if (!Number.isSafeInteger(value) || value <= 1) throw new Error('guardian_parent_invalid');
  return value;
}

async function watchdogServiceLabels(): Promise<string[]> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('uid_unavailable');
  const result = await execFileAsync('/bin/launchctl', ['print', `gui/${uid}`], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  return [...new Set(
    [...result.stdout.matchAll(/com\.roundtable\.watchdog\.[a-f0-9]{32}/gu)]
      .map((match) => match[0]),
  )].sort();
}

async function launchdServicePid(label: string): Promise<number> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('uid_unavailable');
  const result = await execFileAsync(
    '/bin/launchctl',
    ['print', `gui/${uid}/${label}`],
    {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    },
  );
  const match = /^\s*pid = ([1-9][0-9]{0,9})$/mu.exec(result.stdout);
  const pid = Number(match?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('watchdog_pid_invalid');
  return pid;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
