import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import { RuntimeError } from './errors.js';
import { NATIVE_BOUNDARY_PROBE_MANIFEST } from './native-helper-manifest.js';

const MACOS_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const MACOS_SECURITY_TOOL = '/usr/bin/security';
const MACOS_CURL_TOOL = '/usr/bin/curl';
const MACOS_LAUNCHCTL_TOOL = '/bin/launchctl';
const MACOS_KILL_TOOL = '/bin/kill';
const MACOS_SHELL_TOOL = '/bin/sh';
const MACOS_SLEEP_TOOL = '/bin/sleep';
const MACOS_NULL_DEVICE = '/dev/null';
const MACOS_BOUNDARY_PROBE_NAME = 'roundtable-macos-boundary-probe';
const MACOS_CONTAINMENT_POLICY = 'macos-seatbelt-workspace-write-user-data-keychain-job-escape-signal-ipc-procinfo-deny-v7' as const;
const MACOS_DENIED_READ_ROOTS = Object.freeze([
  '/Users',
  '/Volumes',
  '/Network',
  '/private/var/root',
  '/private/tmp',
  '/private/var/folders',
] as const);
const MACOS_DENIED_MACH_SERVICE_LITERALS = Object.freeze([
  'com.apple.SecurityServer',
  'com.apple.coreservices.appleevents',
  'com.apple.coreservices.launchservicesd',
] as const);
const MACOS_DENIED_MACH_SERVICE_PREFIXES = Object.freeze([
  'com.apple.securityd',
  'com.apple.secd',
  'com.apple.security.',
  'com.apple.keychain',
] as const);
const containmentCapabilities = new Map<string, Promise<RuntimeContainmentCapability>>();

class SameUidIsolationUnsafeError extends Error {}

export type RuntimeContainmentCapability =
  | {
    available: true;
    policy: typeof MACOS_CONTAINMENT_POLICY;
  }
  | {
    available: false;
    policy: null;
    reason: 'platform_unsupported' | 'same_uid_isolation_unsafe' | 'sandbox_exec_invalid';
  };

export type ContainedProviderLaunch = {
  command: string;
  args: string[];
  policy: typeof MACOS_CONTAINMENT_POLICY;
};

export async function probeRuntimeContainmentCapability(input: {
  hostHomeDirectory: string;
}): Promise<RuntimeContainmentCapability> {
  if (process.platform !== 'darwin') {
    return { available: false, policy: null, reason: 'platform_unsupported' };
  }
  let hostHomeDirectory: string;
  try {
    hostHomeDirectory = await canonicalAbsoluteDirectory(input.hostHomeDirectory);
  } catch {
    return { available: false, policy: null, reason: 'sandbox_exec_invalid' };
  }
  let capability = containmentCapabilities.get(hostHomeDirectory);
  if (!capability) {
    capability = probeRuntimeContainmentCapabilityUncached(hostHomeDirectory);
    containmentCapabilities.set(hostHomeDirectory, capability);
  }
  return capability;
}

async function probeRuntimeContainmentCapabilityUncached(
  hostHomeDirectory: string,
): Promise<RuntimeContainmentCapability> {
  try {
    await assertSandboxExecTrusted();
    await attestMacOsSecurityBoundary(hostHomeDirectory);
    return { available: true, policy: MACOS_CONTAINMENT_POLICY };
  } catch (error) {
    if (error instanceof SameUidIsolationUnsafeError) {
      return { available: false, policy: null, reason: 'same_uid_isolation_unsafe' };
    }
    return { available: false, policy: null, reason: 'sandbox_exec_invalid' };
  }
}

export async function prepareContainedProviderLaunch(input: {
  providerExecutable: string;
  providerArgs: readonly string[];
  workspaceRoot: string;
  runtimeHomeDirectory: string;
  runtimeTemporaryDirectory: string;
  hostHomeDirectory: string;
}): Promise<ContainedProviderLaunch> {
  const capability = await probeRuntimeContainmentCapability({
    hostHomeDirectory: input.hostHomeDirectory,
  });
  if (!capability.available) throw new RuntimeError('security_boundary_unavailable');
  return prepareSeatbeltDefenseInDepthLaunch(input);
}

/**
 * Builds the Seatbelt layer used inside a separately identified service UID.
 * This is deliberately not exported from the package entry point: Seatbelt
 * cannot by itself isolate an untrusted provider from processes sharing its
 * effective UID.
 */
export async function prepareSeatbeltDefenseInDepthLaunch(input: {
  providerExecutable: string;
  providerArgs: readonly string[];
  workspaceRoot: string;
  runtimeHomeDirectory: string;
  runtimeTemporaryDirectory: string;
  hostHomeDirectory: string;
}): Promise<ContainedProviderLaunch> {
  if (process.platform !== 'darwin') throw new RuntimeError('security_boundary_unavailable');
  await assertSandboxExecTrusted();
  const hostHomeDirectory = await canonicalAbsoluteDirectory(input.hostHomeDirectory);
  const workspaceRoot = await canonicalAbsoluteDirectory(input.workspaceRoot);
  const runtimeHomeDirectory = await canonicalAbsoluteDirectory(input.runtimeHomeDirectory);
  const runtimeTemporaryDirectory = await canonicalAbsoluteDirectory(
    input.runtimeTemporaryDirectory,
  );
  const providerExecutable = await canonicalAbsoluteFile(input.providerExecutable);
  const deniedRoots = [...MACOS_DENIED_READ_ROOTS, hostHomeDirectory];
  if (deniedRoots.some((deniedRoot) => pathContains(workspaceRoot, deniedRoot))) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  const profileDirectory = await mkdtemp(join(runtimeTemporaryDirectory, 'seatbelt-'));
  const profilePath = join(profileDirectory, 'provider.sb');
  const profile = macOsContainmentProfile({
    deniedRoots,
    allowedSubpaths: [
      workspaceRoot,
      runtimeHomeDirectory,
      runtimeTemporaryDirectory,
    ],
    allowedLiterals: [providerExecutable],
    allowedWriteLiterals: [MACOS_NULL_DEVICE],
  });
  await writeFile(profilePath, profile, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  const profileInfo = await stat(profilePath, { bigint: true });
  if (!profileInfo.isFile() || (profileInfo.mode & 0o077n) !== 0n) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  return {
    command: MACOS_SANDBOX_EXEC,
    args: ['-f', profilePath, providerExecutable, ...input.providerArgs],
    policy: MACOS_CONTAINMENT_POLICY,
  };
}

function macOsContainmentProfile(input: {
  deniedRoots: readonly string[];
  allowedSubpaths: readonly string[];
  allowedLiterals: readonly string[];
  allowedWriteLiterals: readonly string[];
}): string {
  const deniedRoots = [...new Set(input.deniedRoots)];
  const allowedSubpaths = [...new Set(input.allowedSubpaths)];
  const allowedLiterals = [...new Set(input.allowedLiterals)];
  const allowedWriteLiterals = [...new Set(input.allowedWriteLiterals)];
  const allowedAncestorMetadata = [...new Set(
    [...allowedSubpaths, ...allowedLiterals, ...allowedWriteLiterals].flatMap(pathAncestors),
  )];
  return [
    '(version 1)',
    '(allow default)',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny network-outbound (remote unix-socket))',
    '(deny process-info* (target others))',
    '(deny sysctl-read (sysctl-name "kern.procargs2"))',
    '(deny job-creation)',
    '(deny lsopen)',
    '(deny appleevent-send)',
    '(deny mach-lookup',
    ...MACOS_DENIED_MACH_SERVICE_LITERALS.map((name) => (
      `  (global-name ${sandboxLiteral(name)})`
    )),
    ...MACOS_DENIED_MACH_SERVICE_PREFIXES.map((prefix) => (
      `  (global-name-prefix ${sandboxLiteral(prefix)})`
    )),
    ')',
    ...deniedRoots.map((path) => (
      `(deny file-read* (subpath ${sandboxLiteral(path)}))`
    )),
    '(deny file-write*)',
    ...allowedSubpaths.map((path) => (
      `(allow file-read* (subpath ${sandboxLiteral(path)}))`
    )),
    ...allowedSubpaths.map((path) => (
      `(allow file-write* (subpath ${sandboxLiteral(path)}))`
    )),
    ...allowedWriteLiterals.map((path) => (
      `(allow file-write* (literal ${sandboxLiteral(path)}))`
    )),
    ...allowedLiterals.map((path) => (
      `(allow file-read* (literal ${sandboxLiteral(path)}))`
    )),
    ...allowedAncestorMetadata.map((path) => (
      `(allow file-read-metadata (literal ${sandboxLiteral(path)}))`
    )),
    '',
  ].join('\n');
}

function pathAncestors(path: string): string[] {
  const ancestors: string[] = [];
  let current = dirname(path);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
}

function pathContains(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

async function assertSandboxExecTrusted(): Promise<void> {
  await access(MACOS_SANDBOX_EXEC, constants.X_OK);
  const canonical = await realpath(MACOS_SANDBOX_EXEC);
  const info = await stat(canonical, { bigint: true });
  if (
    canonical !== MACOS_SANDBOX_EXEC
    || !info.isFile()
    || info.uid !== 0n
    || (info.mode & 0o022n) !== 0n
    || (info.mode & 0o111n) === 0n
  ) {
    throw new RuntimeError('security_boundary_unavailable');
  }
}

async function attestMacOsSecurityBoundary(hostHomeDirectory: string): Promise<void> {
  const boundaryProbeSource = await resolveTrustedBoundaryProbe();
  const probeRoot = await mkdtemp(join(hostHomeDirectory, '.roundtable-containment-probe-'));
  try {
    const workspace = join(probeRoot, 'workspace');
    const allowedCanary = join(workspace, 'allowed.txt');
    const deniedCanary = join(probeRoot, 'denied.txt');
    await mkdir(workspace, { mode: 0o700 });
    await Promise.all([
      writeFile(allowedCanary, 'workspace-readable', { mode: 0o600, flag: 'wx' }),
      writeFile(deniedCanary, 'host-home-private', { mode: 0o600, flag: 'wx' }),
    ]);
    const boundaryProbe = join(workspace, MACOS_BOUNDARY_PROBE_NAME);
    await copyFile(boundaryProbeSource, boundaryProbe, constants.COPYFILE_EXCL);
    await chmod(boundaryProbe, 0o755);
    const profile = macOsContainmentProfile({
      deniedRoots: [...MACOS_DENIED_READ_ROOTS, hostHomeDirectory],
      allowedSubpaths: [workspace],
      allowedLiterals: [],
      allowedWriteLiterals: [MACOS_NULL_DEVICE],
    });
    await attestRawProcArgsDenial(profile, hostHomeDirectory, boundaryProbe);
    const deniedWriteCanary = join(probeRoot, 'denied-write.txt');
    const allowedWriteCanary = join(workspace, 'allowed-write.txt');
    const [allowedExit, deniedExit, allowedWriteExit, deniedWriteExit] = await Promise.all([
      runFixedSandboxReadProbe(profile, allowedCanary),
      runFixedSandboxReadProbe(profile, deniedCanary),
      runFixedSandboxWriteProbe(profile, allowedWriteCanary),
      runFixedSandboxWriteProbe(profile, deniedWriteCanary),
    ]);
    if (
      allowedExit !== 0
      || deniedExit === 0
      || deniedExit === null
      || allowedWriteExit !== 0
      || deniedWriteExit === 0
      || deniedWriteExit === null
    ) {
      throw new RuntimeError('security_boundary_unavailable');
    }
    await attestUnixSocketBoundary(profile, hostHomeDirectory);
    await attestSignalBoundary(profile, hostHomeDirectory);
    await attestLaunchdJobCreationDenial(profile, hostHomeDirectory);
    await attestKeychainMachDenial(profile, workspace, hostHomeDirectory);
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function attestRawProcArgsDenial(
  profile: string,
  hostHomeDirectory: string,
  boundaryProbe: string,
): Promise<void> {
  const marker = `roundtable-procargs-${randomUUID()}`;
  const canary = spawn(
    process.execPath,
    ['-e', 'setInterval(() => undefined, 1_000)', marker],
    {
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
      },
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    },
  );
  canary.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => canary.once('close', () => resolve()));
  try {
    const canaryPid = await waitForChildSpawn(canary, 1_000);
    const baselineExit = await runFixedCommand(
      boundaryProbe,
      ['procargs', String(canaryPid), marker],
      hostHomeDirectory,
      3_000,
    );
    const deniedExit = await runFixedCommand(
      MACOS_SANDBOX_EXEC,
      ['-p', profile, boundaryProbe, 'procargs', String(canaryPid), marker],
      hostHomeDirectory,
      3_000,
    );
    if (baselineExit === 0 && deniedExit === 0) {
      throw new SameUidIsolationUnsafeError();
    }
    if (baselineExit !== 0 || deniedExit !== 7) {
      throw new RuntimeError('security_boundary_unavailable');
    }
    assertProcessAlive(canaryPid);
  } finally {
    await terminateCanary(canary, closed);
  }
}

async function resolveTrustedBoundaryProbe(): Promise<string> {
  const manifest = NATIVE_BOUNDARY_PROBE_MANIFEST[process.arch];
  if (!manifest) throw new RuntimeError('security_boundary_unavailable');
  const candidates = [
    fileURLToPath(new URL(`../native/bin/${process.arch}/${MACOS_BOUNDARY_PROBE_NAME}`, import.meta.url)),
    fileURLToPath(new URL(`./native/${MACOS_BOUNDARY_PROBE_NAME}`, import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      if (canonical !== candidate) continue;
      const info = await stat(canonical);
      if (
        !info.isFile()
        || (info.mode & 0o111) === 0
        || info.size !== manifest.size
      ) continue;
      const digest = createHash('sha256').update(await readFile(canonical)).digest('hex');
      if (digest === manifest.sha256) return canonical;
    } catch {
      // Distribution and source layouts use different fixed candidates.
    }
  }
  throw new RuntimeError('security_boundary_unavailable');
}

async function attestUnixSocketBoundary(
  profile: string,
  hostHomeDirectory: string,
): Promise<void> {
  const socketPath = `/private/tmp/roundtable-containment-${randomUUID()}.sock`;
  let acceptedConnections = 0;
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    acceptedConnections += 1;
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    const curlArgs = [
      '-q',
      '--fail',
      '--silent',
      '--unix-socket',
      socketPath,
      'http://localhost/',
    ];
    const baselineExit = await runFixedCommand(
      MACOS_CURL_TOOL,
      curlArgs,
      hostHomeDirectory,
      3_000,
    );
    const baselineConnections = acceptedConnections;
    const deniedExit = await runFixedCommand(
      MACOS_SANDBOX_EXEC,
      ['-p', profile, MACOS_CURL_TOOL, ...curlArgs],
      hostHomeDirectory,
      3_000,
    );
    if (
      baselineExit !== 0
      || baselineConnections !== 1
      || deniedExit === 0
      || deniedExit === null
      || acceptedConnections !== baselineConnections
    ) {
      throw new RuntimeError('security_boundary_unavailable');
    }
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
}

async function attestSignalBoundary(
  profile: string,
  hostHomeDirectory: string,
): Promise<void> {
  const canary = spawn(MACOS_SLEEP_TOOL, ['30'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
  canary.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => canary.once('close', () => resolve()));
  try {
    const canaryPid = await waitForChildSpawn(canary, 1_000);
    assertProcessAlive(canaryPid);
    const sameSandboxExit = await runFixedCommand(
      MACOS_SANDBOX_EXEC,
      [
        '-p',
        profile,
        MACOS_SHELL_TOOL,
        '-c',
        [
          `${MACOS_SLEEP_TOOL} 2 & child=$!`,
          'kill -TERM "$child"',
          'signal_status=$?',
          'wait "$child"',
          'wait_status=$?',
          '[ "$signal_status" -eq 0 ] && [ "$wait_status" -eq 143 ]',
        ].join('; '),
      ],
      hostHomeDirectory,
      5_000,
    );
    const deniedExternalExit = await runFixedCommand(
      MACOS_SANDBOX_EXEC,
      ['-p', profile, MACOS_KILL_TOOL, '-0', String(canaryPid)],
      hostHomeDirectory,
      3_000,
    );
    if (
      sameSandboxExit !== 0
      || deniedExternalExit === 0
      || deniedExternalExit === null
    ) {
      throw new RuntimeError('security_boundary_unavailable');
    }
    assertProcessAlive(canaryPid);
  } finally {
    await terminateCanary(canary, closed);
  }
}

async function attestLaunchdJobCreationDenial(
  profile: string,
  hostHomeDirectory: string,
): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new RuntimeError('security_boundary_unavailable');
  const identity = randomUUID();
  const baselineLabel = `com.roundtable.containment.baseline.${identity}`;
  const deniedLabel = `com.roundtable.containment.denied.${identity}`;
  const baselineTarget = `gui/${uid}/${baselineLabel}`;
  const deniedTarget = `gui/${uid}/${deniedLabel}`;
  try {
    const baselineSubmitExit = await runFixedCommand(
      MACOS_LAUNCHCTL_TOOL,
      ['submit', '-l', baselineLabel, '--', MACOS_SLEEP_TOOL, '30'],
      hostHomeDirectory,
      3_000,
    );
    const baselinePrintExit = baselineSubmitExit === 0
      ? await runFixedCommand(
        MACOS_LAUNCHCTL_TOOL,
        ['print', baselineTarget],
        hostHomeDirectory,
        3_000,
      )
      : null;
    const deniedSubmitExit = await runFixedCommand(
      MACOS_SANDBOX_EXEC,
      [
        '-p',
        profile,
        MACOS_LAUNCHCTL_TOOL,
        'submit',
        '-l',
        deniedLabel,
        '--',
        MACOS_SLEEP_TOOL,
        '30',
      ],
      hostHomeDirectory,
      3_000,
    );
    const deniedPrintExit = await runFixedCommand(
      MACOS_LAUNCHCTL_TOOL,
      ['print', deniedTarget],
      hostHomeDirectory,
      3_000,
    );
    if (
      baselineSubmitExit !== 0
      || baselinePrintExit !== 0
      || deniedSubmitExit === 0
      || deniedSubmitExit === null
      || deniedPrintExit === 0
      || deniedPrintExit === null
    ) {
      throw new RuntimeError('security_boundary_unavailable');
    }
  } finally {
    await Promise.all([
      baselineTarget,
      deniedTarget,
    ].map((target) => (
      runFixedCommand(
        MACOS_LAUNCHCTL_TOOL,
        ['bootout', target],
        hostHomeDirectory,
        3_000,
      ).catch(() => undefined)
    )));
  }
}

async function runFixedSandboxReadProbe(
  profile: string,
  target: string,
): Promise<number | null> {
  return runFixedCommand(
    MACOS_SANDBOX_EXEC,
    ['-p', profile, '/bin/cat', target],
    undefined,
    1_000,
  );
}

async function runFixedSandboxWriteProbe(
  profile: string,
  target: string,
): Promise<number | null> {
  return runFixedCommand(
    MACOS_SANDBOX_EXEC,
    ['-p', profile, '/usr/bin/touch', target],
    undefined,
    1_000,
  );
}

async function attestKeychainMachDenial(
  profile: string,
  workspace: string,
  hostHomeDirectory: string,
): Promise<void> {
  const identity = randomUUID();
  const keychainPath = join(workspace, 'canary.keychain-db');
  const password = `roundtable-probe-password-${identity}`;
  const account = `roundtable-probe-${identity}`;
  const service = `roundtable-seatbelt-${identity}`;
  const canary = `roundtable-keychain-canary-${identity}`;
  let created = false;
  try {
    const createExit = await runFixedCommand(
      MACOS_SECURITY_TOOL,
      ['create-keychain', '-p', password, keychainPath],
      hostHomeDirectory,
      3_000,
    );
    created = createExit === 0;
    const addExit = created
      ? await runFixedCommand(
        MACOS_SECURITY_TOOL,
        [
          'add-generic-password',
          '-a',
          account,
          '-s',
          service,
          '-w',
          canary,
          keychainPath,
        ],
        hostHomeDirectory,
        3_000,
      )
      : null;
    const baselineExit = addExit === 0
      ? await runFixedCommand(
        MACOS_SECURITY_TOOL,
        ['find-generic-password', '-a', account, '-s', service, '-w', keychainPath],
        hostHomeDirectory,
        3_000,
      )
      : null;
    const deniedExit = baselineExit === 0
      ? await runFixedCommand(
        MACOS_SANDBOX_EXEC,
        [
          '-p',
          profile,
          MACOS_SECURITY_TOOL,
          'find-generic-password',
          '-a',
          account,
          '-s',
          service,
          '-w',
          keychainPath,
        ],
        hostHomeDirectory,
        3_000,
      )
      : null;
    const ordinaryCliExit = await runFixedCommand(
      MACOS_SANDBOX_EXEC,
      ['-p', profile, MACOS_CURL_TOOL, '--version'],
      hostHomeDirectory,
      3_000,
    );
    if (
      createExit !== 0
      || addExit !== 0
      || baselineExit !== 0
      || deniedExit === 0
      || deniedExit === null
      || ordinaryCliExit !== 0
    ) {
      throw new RuntimeError('security_boundary_unavailable');
    }
  } finally {
    if (created) {
      await runFixedCommand(
        MACOS_SECURITY_TOOL,
        ['delete-keychain', keychainPath],
        hostHomeDirectory,
        3_000,
      ).catch(() => undefined);
    }
  }
}

async function waitForChildSpawn(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('containment_canary_spawn_timeout')), timeoutMs);
    timer.unref();
    child.once('spawn', () => {
      const pid = child.pid;
      if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0 || pid === process.pid) {
        finish(new Error('containment_canary_pid_invalid'));
        return;
      }
      finish(undefined, pid);
    });
    child.once('error', () => finish(new Error('containment_canary_spawn_failed')));
    child.once('exit', () => finish(new Error('containment_canary_exited_early')));

    function finish(error: Error | undefined, pid?: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error || pid === undefined) reject(error ?? new Error('containment_canary_pid_invalid'));
      else resolve(pid);
    }
  });
}

function assertProcessAlive(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch {
    throw new RuntimeError('security_boundary_unavailable');
  }
}

async function terminateCanary(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  if (await settlesWithin(closed, 2_000)) return;
  if (child.pid !== undefined) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // A concurrent exit is confirmed by the close wait below.
    }
  }
  if (!await settlesWithin(closed, 2_000)) {
    throw new RuntimeError('security_boundary_unavailable');
  }
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function runFixedCommand(
  command: string,
  args: readonly string[],
  homeDirectory: string | undefined,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(
      command,
      [...args],
      {
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
          ...(homeDirectory ? { HOME: homeDirectory } : {}),
        },
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref();
    child.once('error', () => finish(null));
    child.once('close', (exitCode) => finish(exitCode));

    function finish(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exitCode);
    }
  });
}

async function canonicalAbsoluteDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || hasControlCharacters(path)) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  const canonical = await realpath(path);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new RuntimeError('security_boundary_unavailable');
  return canonical;
}

async function canonicalAbsoluteFile(path: string): Promise<string> {
  if (!isAbsolute(path) || hasControlCharacters(path)) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  const canonical = await realpath(path);
  const info = await stat(canonical, { bigint: true });
  if (!info.isFile()) throw new RuntimeError('security_boundary_unavailable');
  return canonical;
}

function sandboxLiteral(value: string): string {
  return JSON.stringify(value);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
