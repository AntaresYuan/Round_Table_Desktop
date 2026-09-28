import { chmod, copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

// These fixtures retain coverage for the legacy process, redaction, artifact,
// and coalition mechanics.  The production entry point now correctly rejects
// same-UID execution; only this test module substitutes the Seatbelt
// defense-in-depth launcher while the service-UID backend is brought online.
vi.mock('../src/containment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/containment.js')>();
  return {
    ...actual,
    prepareContainedProviderLaunch: actual.prepareSeatbeltDefenseInDepthLaunch,
  };
});

import { resolveProviderExecutable } from '../src/executable.js';
import { LocalAgentRuntime } from '../src/runtime.js';
import type { RuntimeEvent } from '../src/types.js';
import { captureWorkspaceIdentity } from '../src/workspace.js';

const fixture = fileURLToPath(new URL('./fixtures/runtime-fixture.mjs', import.meta.url));
const rapidDaemonSource = fileURLToPath(new URL('./fixtures/rapid-daemon.c', import.meta.url));
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.ROUNDTABLE_INTEGRATION_CANARY;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe.skipIf(process.platform !== 'darwin')(
  'LocalAgentRuntime legacy same-UID fixture integration (test-only)',
  () => {
  it('runs a fixed provider plan, streams events, and returns real file artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-runtime-integration-'));
    temporaryDirectories.push(root);
    const binaryDirectory = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const temporary = join(root, 'temporary');
    await mkdir(binaryDirectory, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    const binary = join(binaryDirectory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    await copyFile(fixture, binary);
    await chmod(binary, 0o755);

    const events: RuntimeEvent[] = [];
    const runtime = new LocalAgentRuntime();
    const execution = await runtime.start({
      executionId: 'execution_fixture_artifact',
      provider: 'codex',
      executable: await resolveProviderExecutable('codex', [binaryDirectory]),
      workspace: await captureWorkspaceIdentity(workspace),
      prompt: 'fixture:create-artifact',
      environment: {
        hostHomeDirectory: homedir(),
        homeDirectory: home,
        temporaryDirectory: temporary,
      },
      limits: {
        totalTimeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        maxScanFiles: 100,
        maxScanFileBytes: 64 * 1024,
        maxScanTotalBytes: 1024 * 1024,
      },
      onEvent: (event) => events.push(event),
    });
    const result = await execution.completion;

    expect(result.status).toBe('exited');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        relativePath: 'provider-generated.txt',
        change: 'created',
        hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'execution.starting',
      'process.started',
      'process.output',
      'artifact.changed',
      'process.exited',
    ]));
    await expect(execution.stop()).resolves.toMatchObject({
      disposition: 'already_terminal',
      treeTermination: 'confirmed',
    });
    await runtime.shutdown();
  });

  it('does not inherit a parent canary and redacts the selected credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-runtime-env-'));
    temporaryDirectories.push(root);
    const binaryDirectory = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const temporary = join(root, 'temporary');
    for (const directory of [binaryDirectory, workspace, home, temporary]) {
      await mkdir(directory, { mode: 0o700 });
    }
    const binary = join(binaryDirectory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    await copyFile(fixture, binary);
    await chmod(binary, 0o755);
    process.env.ROUNDTABLE_INTEGRATION_CANARY = 'parent-secret-canary';
    const credential = 'sk-runtime-integration-secret';
    const runtime = new LocalAgentRuntime();
    const execution = await runtime.start({
      executionId: 'execution_fixture_env',
      provider: 'codex',
      executable: await resolveProviderExecutable('codex', [binaryDirectory]),
      workspace: await captureWorkspaceIdentity(workspace),
      prompt: 'fixture:print-env',
      environment: {
        hostHomeDirectory: homedir(),
        homeDirectory: home,
        temporaryDirectory: temporary,
        credential: {
          provider: 'codex',
          kind: 'openai-api-key',
          value: credential,
        },
      },
      limits: { totalTimeoutMs: 5_000, idleTimeoutMs: 5_000 },
    });
    const result = await execution.completion;

    expect(result.stdout).toContain('OPENAI_API_KEY');
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stdout).not.toContain(credential);
    expect(result.stdout).not.toContain('ROUNDTABLE_INTEGRATION_CANARY');
    expect(result.stdout).not.toContain('parent-secret-canary');
    await runtime.shutdown();
  });

  it('waits for a fixture grandchild tree before confirming stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-runtime-stop-'));
    temporaryDirectories.push(root);
    const binaryDirectory = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const temporary = join(root, 'temporary');
    for (const directory of [binaryDirectory, workspace, home, temporary]) {
      await mkdir(directory, { mode: 0o700 });
    }
    const binary = join(binaryDirectory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    await copyFile(fixture, binary);
    await chmod(binary, 0o755);
    const runtime = new LocalAgentRuntime();
    const execution = await runtime.start({
      executionId: 'execution_fixture_stop',
      provider: 'codex',
      executable: await resolveProviderExecutable('codex', [binaryDirectory]),
      workspace: await captureWorkspaceIdentity(workspace),
      prompt: 'fixture:tree',
      environment: {
        hostHomeDirectory: homedir(),
        homeDirectory: home,
        temporaryDirectory: temporary,
      },
      limits: {
        totalTimeoutMs: 10_000,
        idleTimeoutMs: 10_000,
        terminateGraceMs: 100,
        killConfirmMs: 2_000,
      },
    });
    const pids = await Promise.race([
      waitForPids(join(workspace, '.fixture-pids.json')),
      execution.completion.then((result) => {
        throw new Error(`fixture_tree_exited_early:${JSON.stringify(result)}`);
      }),
    ]);

    await expect(execution.stop()).resolves.toMatchObject({
      disposition: 'stopped',
      treeTermination: 'confirmed',
    });
    const result = await execution.completion;
    expect(result.status).toBe('stopped');
    await expect(waitForExit(pids.parent)).resolves.toBe(true);
    await expect(waitForExit(pids.grandchild)).resolves.toBe(true);
    await runtime.shutdown();
  });

  it('redacts a broker-only secret across streamed output chunk boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-runtime-redaction-'));
    temporaryDirectories.push(root);
    const binaryDirectory = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const temporary = join(root, 'temporary');
    for (const directory of [binaryDirectory, workspace, home, temporary]) {
      await mkdir(directory, { mode: 0o700 });
    }
    const binary = join(binaryDirectory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    await copyFile(fixture, binary);
    await chmod(binary, 0o755);
    const secret = 'broker-only-split-secret';
    const events: RuntimeEvent[] = [];
    const runtime = new LocalAgentRuntime();
    const execution = await runtime.start({
      executionId: 'execution_fixture_redaction',
      provider: 'codex',
      executable: await resolveProviderExecutable('codex', [binaryDirectory]),
      workspace: await captureWorkspaceIdentity(workspace),
      prompt: `fixture:split-redaction:${secret}`,
      environment: {
        hostHomeDirectory: homedir(),
        homeDirectory: home,
        temporaryDirectory: temporary,
        redactionSecrets: [secret],
      },
      limits: { totalTimeoutMs: 5_000, idleTimeoutMs: 5_000 },
      onEvent: (event) => events.push(event),
    });
    const result = await execution.completion;
    const streamed = events
      .filter((event): event is Extract<RuntimeEvent, { kind: 'process.output' }> => (
        event.kind === 'process.output'
      ))
      .map((event) => event.text)
      .join('');

    expect(result.stdout).toBe('prefix [REDACTED] suffix');
    expect(streamed).toBe('prefix [REDACTED] suffix');
    expect(result.stdout).not.toContain(secret);
    expect(streamed).not.toContain(secret);
    await runtime.shutdown();
  });

  it('reaps an immediate setsid double-fork daemon by coalition instead of polling lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roundtable-runtime-rapid-daemon-'));
    temporaryDirectories.push(root);
    const binaryDirectory = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const temporary = join(root, 'temporary');
    for (const directory of [binaryDirectory, workspace, home, temporary]) {
      await mkdir(directory, { mode: 0o700 });
    }
    const binary = join(binaryDirectory, 'codex');
    const daemonLauncher = join(workspace, 'rapid-daemon-launcher');
    await copyFile(fixture, binary);
    await chmod(binary, 0o755);
    await execFileAsync('/usr/bin/xcrun', [
      'clang',
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-mmacosx-version-min=13.0',
      rapidDaemonSource,
      '-o',
      daemonLauncher,
    ], { timeout: 10_000, maxBuffer: 64 * 1024 });
    await chmod(daemonLauncher, 0o755);

    const runtime = new LocalAgentRuntime();
    try {
      const execution = await runtime.start({
        executionId: 'execution_fixture_rapid_daemon',
        provider: 'codex',
        executable: await resolveProviderExecutable('codex', [binaryDirectory]),
        workspace: await captureWorkspaceIdentity(workspace),
        prompt: `fixture:rapid-native-tree:${daemonLauncher}`,
        environment: {
          hostHomeDirectory: homedir(),
          homeDirectory: home,
          temporaryDirectory: temporary,
        },
        limits: {
          totalTimeoutMs: 10_000,
          idleTimeoutMs: 10_000,
          terminateGraceMs: 100,
          killConfirmMs: 3_000,
        },
      });
      const result = await execution.completion;
      const daemonPid = await readRapidDaemonPid(join(workspace, '.fixture-rapid-pids.json'));

      expect(result.status, result.stderr).toBe('exited');
      expect(result.exitCode).toBe(0);
      expect(result.treeTermination).toBe('confirmed');
      expect(result.stdout).toContain('rapid-native-tree-launched');
      expect(result.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relativePath: '.fixture-rapid-pids.json',
          change: 'created',
        }),
      ]));
      await expect(waitForExit(daemonPid)).resolves.toBe(true);
    } finally {
      await runtime.shutdown();
    }
  }, 20_000);
  },
);

async function waitForPids(path: string): Promise<{ parent: number; grandchild: number }> {
  const deadline = Date.now() + 10_000;
  do {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (typeof value.parent === 'number' && typeof value.grandchild === 'number') {
        return { parent: value.parent, grandchild: value.grandchild };
      }
    } catch {
      // The fixture writes the PID file only after the grandchild exists.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error('fixture_pid_timeout');
}

async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  do {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return false;
}

async function readRapidDaemonPid(path: string): Promise<number> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (!Number.isSafeInteger(value.daemon) || (value.daemon as number) <= 0) {
    throw new Error('fixture_rapid_pid_invalid');
  }
  return value.daemon as number;
}
