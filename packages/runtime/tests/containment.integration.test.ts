import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  prepareSeatbeltDefenseInDepthLaunch,
  probeRuntimeContainmentCapability,
} from '../src/containment.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('outer provider workspace containment', () => {
  it('reports a stable fail-closed capability on unsupported platforms', async () => {
    const capability = await probeRuntimeContainmentCapability({
      hostHomeDirectory: homedir(),
    });
    if (process.platform === 'darwin') {
      expect(capability).toEqual({
        available: false,
        policy: null,
        reason: 'same_uid_isolation_unsafe',
      });
    } else {
      expect(capability).toEqual({
        available: false,
        policy: null,
        reason: 'platform_unsupported',
      });
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'rejects a workspace that would reopen an entire denied host boundary',
    async () => {
      const hostHomeDirectory = homedir();
      const root = await mkdtemp(join(hostHomeDirectory, '.roundtable-boundary-test-'));
      temporaryDirectories.push(root);
      const runtimeHome = join(root, 'runtime-home');
      const runtimeTemporary = join(root, 'runtime-tmp');
      await Promise.all([runtimeHome, runtimeTemporary].map((directory) => (
        mkdir(directory, { mode: 0o700 })
      )));

      for (const workspaceRoot of ['/private', '/private/tmp', hostHomeDirectory]) {
        await expect(prepareSeatbeltDefenseInDepthLaunch({
          providerExecutable: process.execPath,
          providerArgs: [],
          workspaceRoot,
          runtimeHomeDirectory: runtimeHome,
          runtimeTemporaryDirectory: runtimeTemporary,
          hostHomeDirectory,
        })).rejects.toMatchObject({ code: 'security_boundary_unavailable' });
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'denies host-home and temp/cache reads and external writes while allowing workspace access',
    async () => {
      const hostHomeDirectory = homedir();
      const originalProcessHome = process.env.HOME;
      const root = await mkdtemp(join(hostHomeDirectory, '.roundtable-containment-test-'));
      const privateTemporaryRoot = await mkdtemp('/private/tmp/roundtable-containment-test-');
      const privateCacheRoot = await mkdtemp(join(tmpdir(), 'roundtable-containment-test-'));
      temporaryDirectories.push(root, privateTemporaryRoot, privateCacheRoot);
      const workspace = join(root, 'workspace');
      const runtimeHome = join(root, 'runtime-home');
      const runtimeTemporary = join(root, 'runtime-tmp');
      await Promise.all([workspace, runtimeHome, runtimeTemporary].map((directory) => (
        mkdir(directory, { mode: 0o700 })
      )));
      const deniedCanary = join(root, 'outside-secret.txt');
      const deniedTemporaryCanary = join(privateTemporaryRoot, 'outside-secret.txt');
      const deniedCacheCanary = join(privateCacheRoot, 'outside-secret.txt');
      const allowedCanary = join(workspace, 'inside.txt');
      const deniedWriteCanary = join(root, 'outside-write.txt');
      const deniedTemporaryWriteCanary = join(privateTemporaryRoot, 'outside-write.txt');
      const deniedCacheWriteCanary = join(privateCacheRoot, 'outside-write.txt');
      const allowedWriteCanary = join(workspace, 'inside-write.txt');
      await writeFile(deniedCanary, 'must-not-be-readable', 'utf8');
      await writeFile(deniedTemporaryCanary, 'private-tmp-must-not-be-readable', 'utf8');
      await writeFile(deniedCacheCanary, 'private-cache-must-not-be-readable', 'utf8');
      await writeFile(allowedCanary, 'workspace-readable', 'utf8');
      const script = [
        'const fs = require("node:fs");',
        'const read = (path) => { try { fs.readFileSync(path, "utf8"); return "read"; } catch { return "denied"; } };',
        'const write = (path) => { try { fs.writeFileSync(path, "created", { flag: "wx" }); return "wrote"; } catch { return "denied"; } };',
        'const denied = read(process.argv[1]);',
        'const deniedTemporary = read(process.argv[2]);',
        'const deniedCache = read(process.argv[3]);',
        'const allowed = fs.readFileSync(process.argv[4], "utf8");',
        'const deniedWrite = write(process.argv[5]);',
        'const deniedTemporaryWrite = write(process.argv[6]);',
        'const deniedCacheWrite = write(process.argv[7]);',
        'const allowedWrite = write(process.argv[8]);',
        'process.stdout.write(JSON.stringify({ denied, deniedTemporary, deniedCache, allowed, deniedWrite, deniedTemporaryWrite, deniedCacheWrite, allowedWrite }));',
      ].join(' ');
      process.env.HOME = runtimeHome;
      try {
        const launch = await prepareSeatbeltDefenseInDepthLaunch({
          providerExecutable: process.execPath,
          providerArgs: [
            '-e',
            script,
            deniedCanary,
            deniedTemporaryCanary,
            deniedCacheCanary,
            allowedCanary,
            deniedWriteCanary,
            deniedTemporaryWriteCanary,
            deniedCacheWriteCanary,
            allowedWriteCanary,
          ],
          workspaceRoot: workspace,
          runtimeHomeDirectory: runtimeHome,
          runtimeTemporaryDirectory: runtimeTemporary,
          hostHomeDirectory,
        });
        const profile = await readFile(launch.args[1]!, 'utf8');
        for (const deniedRoot of [
          '/Users',
          '/Volumes',
          '/Network',
          '/private/var/root',
          '/private/tmp',
          '/private/var/folders',
        ]) {
          expect(profile).toContain(`(deny file-read* (subpath ${JSON.stringify(deniedRoot)}))`);
        }
        expect(profile).toContain(
          '(global-name "com.apple.SecurityServer")',
        );
        expect(profile).toContain(
          '(global-name "com.apple.coreservices.appleevents")',
        );
        expect(profile).toContain(
          '(global-name "com.apple.coreservices.launchservicesd")',
        );
        expect(profile).toContain(
          '(global-name-prefix "com.apple.securityd")',
        );
        expect(profile).toContain('(deny job-creation)');
        expect(profile).toContain('(deny signal)');
        expect(profile).toContain('(allow signal (target same-sandbox))');
        expect(profile).toContain('(deny network-outbound (remote unix-socket))');
        expect(profile).toContain('(deny process-info* (target others))');
        expect(profile).toContain('(deny sysctl-read (sysctl-name "kern.procargs2"))');
        expect(profile).toContain('(deny lsopen)');
        expect(profile).toContain('(deny appleevent-send)');
        expect(profile).toContain(
          `(allow file-read* (literal ${JSON.stringify(process.execPath)}))`,
        );
        expect(profile).toContain('(deny file-write*)');
        expect(profile).toContain(
          `(allow file-write* (subpath ${JSON.stringify(workspace)}))`,
        );
        expect(profile).toContain('(allow file-write* (literal "/dev/null"))');

        const result = await run(launch.command, launch.args, workspace);

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          denied: 'denied',
          deniedTemporary: 'denied',
          deniedCache: 'denied',
          allowed: 'workspace-readable',
          deniedWrite: 'denied',
          deniedTemporaryWrite: 'denied',
          deniedCacheWrite: 'denied',
          allowedWrite: 'wrote',
        });
      } finally {
        if (originalProcessHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalProcessHome;
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'allows inherited same-sandbox signals and denies signals to a host canary',
    async () => {
      const hostHomeDirectory = homedir();
      const root = await mkdtemp(join(hostHomeDirectory, '.roundtable-signal-test-'));
      temporaryDirectories.push(root);
      const workspace = join(root, 'workspace');
      const runtimeHome = join(root, 'runtime-home');
      const runtimeTemporary = join(root, 'runtime-tmp');
      await Promise.all([workspace, runtimeHome, runtimeTemporary].map((directory) => (
        mkdir(directory, { mode: 0o700 })
      )));
      const canary = spawn('/bin/sleep', ['30'], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        stdio: 'ignore',
        shell: false,
      });
      canary.on('error', () => undefined);
      const canaryClosed = new Promise<void>((resolve) => canary.once('close', () => resolve()));
      try {
        const canaryPid = await waitForSpawn(canary);
        const script = [
          'const { spawn } = require("node:child_process");',
          '(async () => {',
          'const externalPid = Number(process.argv[1]);',
          'const child = spawn("/bin/sleep", ["2"], { stdio: "ignore" });',
          'const childClosed = new Promise((resolve, reject) => { child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject); });',
          'await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });',
          'let sameSandboxSignal = "not-sent";',
          'try { sameSandboxSignal = child.kill("SIGTERM") ? "sent" : "not-sent"; } catch { sameSandboxSignal = "error"; }',
          'const childResult = await childClosed;',
          'let externalSignal = "allowed";',
          'try { process.kill(externalPid, 0); } catch (error) { externalSignal = error && error.code === "EPERM" ? "denied" : "error"; }',
          'process.stdout.write(JSON.stringify({ sameSandboxSignal, childResult, externalSignal }));',
          '})().catch((error) => { process.stderr.write(String(error)); process.exitCode = 70; });',
        ].join(' ');
        const launch = await prepareSeatbeltDefenseInDepthLaunch({
          providerExecutable: process.execPath,
          providerArgs: ['-e', script, String(canaryPid)],
          workspaceRoot: workspace,
          runtimeHomeDirectory: runtimeHome,
          runtimeTemporaryDirectory: runtimeTemporary,
          hostHomeDirectory,
        });

        const result = await run(launch.command, launch.args, workspace);

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          sameSandboxSignal: 'sent',
          childResult: { code: null, signal: 'SIGTERM' },
          externalSignal: 'denied',
        });
        expect(() => process.kill(canaryPid, 0)).not.toThrow();
      } finally {
        await terminateChild(canary, canaryClosed);
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'documents that Seatbelt alone cannot deny raw KERN_PROCARGS2 for the same UID',
    async () => {
      const hostHomeDirectory = homedir();
      const root = await mkdtemp(join(hostHomeDirectory, '.roundtable-procargs-test-'));
      temporaryDirectories.push(root);
      const workspace = join(root, 'workspace');
      const runtimeHome = join(root, 'runtime-home');
      const runtimeTemporary = join(root, 'runtime-tmp');
      await Promise.all([workspace, runtimeHome, runtimeTemporary].map((directory) => (
        mkdir(directory, { mode: 0o700 })
      )));
      const probeExecutable = join(workspace, 'procargs-probe');
      const probeSource = fileURLToPath(
        new URL('./fixtures/procargs-probe.c', import.meta.url),
      );
      const compileResult = await run(
        '/usr/bin/xcrun',
        [
          'clang',
          '-std=c11',
          '-Wall',
          '-Wextra',
          '-Werror',
          probeSource,
          '-o',
          probeExecutable,
        ],
        workspace,
      );
      expect(compileResult).toMatchObject({ exitCode: 0, stderr: '' });

      const marker = `roundtable-cross-execution-${process.pid}-${Date.now()}`;
      const canary = spawn(
        process.execPath,
        ['-e', 'setInterval(() => undefined, 1_000)', marker],
        {
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
          stdio: 'ignore',
          shell: false,
        },
      );
      canary.on('error', () => undefined);
      const canaryClosed = new Promise<void>((resolve) => canary.once('close', () => resolve()));
      try {
        const canaryPid = await waitForSpawn(canary);
        const baseline = await run(
          probeExecutable,
          [String(canaryPid), marker],
          workspace,
        );
        expect(baseline).toEqual({
          exitCode: 0,
          stdout: 'allowed\n',
          stderr: '',
        });

        const launch = await prepareSeatbeltDefenseInDepthLaunch({
          providerExecutable: probeExecutable,
          providerArgs: [String(canaryPid), marker],
          workspaceRoot: workspace,
          runtimeHomeDirectory: runtimeHome,
          runtimeTemporaryDirectory: runtimeTemporary,
          hostHomeDirectory,
        });
        const contained = await run(launch.command, launch.args, workspace);

        expect(contained).toEqual({
          exitCode: 0,
          stdout: 'allowed\n',
          stderr: '',
        });
        expect(() => process.kill(canaryPid, 0)).not.toThrow();
      } finally {
        await terminateChild(canary, canaryClosed);
      }
    },
  );
});

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: cwd,
        TMPDIR: cwd,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function waitForSpawn(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('canary_spawn_timeout')), 2_000);
    timer.unref();
    child.once('spawn', () => {
      clearTimeout(timer);
      const pid = child.pid;
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
        reject(new Error('canary_pid_invalid'));
      } else {
        resolve(pid);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function terminateChild(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.race([
    closed,
    new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('canary_cleanup_timeout')), 2_000);
      timer.unref();
    }),
  ]);
}
