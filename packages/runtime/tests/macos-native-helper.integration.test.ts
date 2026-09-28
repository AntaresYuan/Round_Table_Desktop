import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HELPER_SOURCE = fileURLToPath(new URL(
  '../native/roundtable-macos-process-helper.c',
  import.meta.url,
));
const PROVIDER_FIXTURE = fileURLToPath(new URL(
  './fixtures/native-helper-provider.mjs',
  import.meta.url,
));
const LAUNCHCTL = '/bin/launchctl';
const XCRUN = '/usr/bin/xcrun';
const CONTROL_ROOT_PREFIX = '/private/tmp/roundtable-native-protocol-';
const WATCH_ROOT_PREFIX = '/private/tmp/roundtable-native-watch-';
const BUILD_ROOT_PREFIX = '/private/tmp/roundtable-native-build-';
const RELAY_STDOUT_BYTES = 128 * 1024;
const RELAY_STDERR_BYTES = 96 * 1024;
const COMMAND_OUTPUT_LIMIT = 128 * 1024;
const MAX_UINT64 = (1n << 64n) - 1n;

type ProcessIdentity = {
  pid: number;
  pidVersion: number;
  uniqueId: string;
  coalitionId: string;
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
};

type SingleConnectionServer = {
  path: string;
  server: Server;
  connection: Promise<Socket>;
};

type OutputCollector = {
  chunks: Buffer[];
  observedBytes: number;
  ended: boolean;
  completion: Promise<Buffer>;
};

type GuardianSession = {
  root: string;
  label: string;
  serviceTarget: string;
  nonce: string;
  servers: SingleConnectionServer[];
  sockets: Socket[];
  control: Socket;
  controlReader: SocketReader;
  stdout: OutputCollector;
  stderr: OutputCollector;
  guardian: ProcessIdentity;
  provider: ProcessIdentity;
};

type WatchdogSession = {
  root: string;
  label: string;
  serviceTarget: string;
  server: SingleConnectionServer;
  socket: Socket;
  reader: SocketReader;
  identity: ProcessIdentity;
};

let buildRoot: string | null = null;
let helperPath: string | null = null;

beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  buildRoot = await mkdtemp(BUILD_ROOT_PREFIX);
  await chmod(buildRoot, 0o700);
  helperPath = join(buildRoot, 'roundtable-macos-process-helper');
  const compiled = await runCommand(XCRUN, [
    'clang',
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-mmacosx-version-min=13.0',
    '-DROUNDTABLE_NATIVE_HELPER_TEST_FORCE_FIRST_CLEANUP_FAILURE=1',
    HELPER_SOURCE,
    '-o',
    helperPath,
    '-lproc',
  ], 15_000);
  if (
    compiled.exitCode !== 0
    || compiled.timedOut
    || compiled.overflowed
    || compiled.stderr.length > 0
  ) {
    throw new Error(`native_helper_compile_failed:${compiled.stderr}`);
  }
  await chmod(helperPath, 0o755);
}, 20_000);

afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
  buildRoot = null;
  helperPath = null;
});

describe.skipIf(process.platform !== 'darwin')('macOS native process helper protocol', () => {
  it('attests HELLO, relays large output, and retries failed cleanup on one control socket', async () => {
    const session = await startGuardianSession('relay');
    try {
      expect(session.guardian).toEqual(await inspectProcess(session.guardian.pid));
      expect(session.provider.coalitionId).toBe(session.guardian.coalitionId);

      const stdoutBytes = Buffer.byteLength('STDIN=0\n') + RELAY_STDOUT_BYTES;
      await Promise.all([
        waitForObservedBytes(session.stdout, stdoutBytes, 5_000),
        waitForObservedBytes(session.stderr, RELAY_STDERR_BYTES, 5_000),
      ]);
      expect(Buffer.concat(session.stdout.chunks)).toEqual(Buffer.concat([
        Buffer.from('STDIN=0\n'),
        Buffer.alloc(RELAY_STDOUT_BYTES, 'O'),
      ]));
      expect(Buffer.concat(session.stderr.chunks)).toEqual(
        Buffer.alloc(RELAY_STDERR_BYTES, 'E'),
      );

      await writeSocket(session.control, Buffer.from('S'));

      // The protocol consumer intentionally does not accept a terminal line
      // until both raw output streams have reached EOF.
      const [stdout, stderr] = await Promise.all([
        withTimeout(session.stdout.completion, 5_000, 'stdout_eof_timeout'),
        withTimeout(session.stderr.completion, 5_000, 'stderr_eof_timeout'),
      ]);
      expect(stdout).toEqual(Buffer.concat([
        Buffer.from('STDIN=0\n'),
        Buffer.alloc(RELAY_STDOUT_BYTES, 'O'),
      ]));
      expect(stderr).toEqual(Buffer.alloc(RELAY_STDERR_BYTES, 'E'));
      expect(await session.controlReader.readLine()).toBe('TREE failed');

      await writeSocket(session.control, Buffer.from('R'));
      expect(await session.controlReader.readLine()).toBe('EXIT -1 9');
      expect(await session.controlReader.readLine()).toBe('TREE confirmed');
    } finally {
      await cleanupSession(session);
    }
  }, 30_000);

  it('cleans provider and detached daemon after all owner sockets disappear', async () => {
    const pidFileName = 'owner-loss-pids.json';
    const session = await startGuardianSession('owner-loss', pidFileName);
    let daemon: ProcessIdentity | null = null;
    try {
      const pids = await readPidFile(join(session.root, pidFileName), 5_000);
      expect(pids.provider).toBe(session.provider.pid);
      daemon = await inspectProcess(pids.daemon);
      expect(daemon.coalitionId).toBe(session.guardian.coalitionId);

      for (const socket of session.sockets) socket.destroy();

      await Promise.all([
        waitForIdentityExit(session.guardian, 10_000),
        waitForIdentityExit(session.provider, 10_000),
        waitForIdentityExit(daemon, 10_000),
      ]);
      expect(await identityExists(session.guardian)).toBe(false);
      expect(await identityExists(session.provider)).toBe(false);
      expect(await identityExists(daemon)).toBe(false);
    } finally {
      await cleanupSession(session, daemon ? [daemon] : []);
    }
  }, 30_000);

  it('isolates an attested guardian coalition without changing the guardian identity', async () => {
    const pidFileName = 'isolate-pids.json';
    const session = await startGuardianSession('owner-loss', pidFileName);
    let daemon: ProcessIdentity | null = null;
    try {
      const pids = await readPidFile(join(session.root, pidFileName), 5_000);
      expect(pids.provider).toBe(session.provider.pid);
      daemon = await inspectProcess(pids.daemon);
      expect(daemon.coalitionId).toBe(session.guardian.coalitionId);

      const mismatchedPidVersion = (
        BigInt(session.guardian.pidVersion) + 1n
      ) % (1n << 32n);
      const rejected = await runCommand(requireHelperPath(), [
        'isolate',
        session.guardian.coalitionId,
        String(session.guardian.pid),
        mismatchedPidVersion.toString(10),
        session.guardian.uniqueId,
        '0',
        '5000',
      ], 8_000);
      expect(rejected).toEqual(expect.objectContaining({
        exitCode: 1,
        stdout: 'TREE failed\n',
        stderr: '',
        timedOut: false,
        overflowed: false,
      }));
      expect(await inspectProcess(session.guardian.pid)).toEqual(session.guardian);
      expect(await inspectProcess(session.provider.pid)).toEqual(session.provider);
      expect(await inspectProcess(daemon.pid)).toEqual(daemon);

      const isolated = await runCommand(requireHelperPath(), [
        'isolate',
        session.guardian.coalitionId,
        String(session.guardian.pid),
        String(session.guardian.pidVersion),
        session.guardian.uniqueId,
        '0',
        '5000',
      ], 8_000);
      expect(isolated).toEqual(expect.objectContaining({
        exitCode: 0,
        stdout: 'TREE isolated\n',
        stderr: '',
        timedOut: false,
        overflowed: false,
      }));

      await Promise.all([
        waitForIdentityExit(session.provider, 5_000),
        waitForIdentityExit(daemon, 5_000),
      ]);
      expect(await inspectProcess(session.guardian.pid)).toEqual(session.guardian);
      expect(await identityExists(session.provider)).toBe(false);
      expect(await identityExists(daemon)).toBe(false);

      await Promise.all([
        withTimeout(session.stdout.completion, 5_000, 'stdout_eof_timeout'),
        withTimeout(session.stderr.completion, 5_000, 'stderr_eof_timeout'),
      ]);
      expect(await session.controlReader.readLine()).toBe('TREE failed');
      await writeSocket(session.control, Buffer.from('R'));
      expect(await session.controlReader.readLine()).toBe('EXIT -1 9');
      expect(await session.controlReader.readLine()).toBe('TREE confirmed');
      await waitForIdentityExit(session.guardian, 5_000);
    } finally {
      await cleanupSession(session, daemon ? [daemon] : []);
    }
  }, 30_000);

  it('rejects symlinked, over-permissive, and wrong-length nonce secret files', async () => {
    const session = await startGuardianSession('relay');
    const root = await mkdtemp(WATCH_ROOT_PREFIX);
    await chmod(root, 0o700);
    try {
      const symlinkTarget = await writeNonceSecret(root, 'nonce-target.secret', cryptoNonce());
      const symlinkPath = join(root, 'nonce-link.secret');
      await symlink(symlinkTarget, symlinkPath);
      const wrongModePath = join(root, 'nonce-mode.secret');
      await writeFile(wrongModePath, cryptoNonce(), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const wrongLengthPath = join(root, 'nonce-length.secret');
      await writeFile(wrongLengthPath, 'a'.repeat(63), {
        encoding: 'utf8',
        mode: 0o400,
        flag: 'wx',
      });
      const missingSocket = join(root, 'missing-owner.sock');
      const watchTail = [
        session.guardian.coalitionId,
        String(session.guardian.pid),
        String(session.guardian.pidVersion),
        session.guardian.uniqueId,
        '100',
        '1000',
      ];

      for (const noncePath of [symlinkPath, wrongModePath]) {
        const rejected = await runCommand(requireHelperPath(), [
          'watch',
          missingSocket,
          noncePath,
          ...watchTail,
        ], 5_000);
        expect(rejected).toEqual({
          exitCode: 1,
          stdout: '',
          stderr: '',
          timedOut: false,
          overflowed: false,
        });
      }
      const rejectedRun = await runCommand(requireHelperPath(), [
        'run',
        missingSocket,
        join(root, 'missing-stdout.sock'),
        join(root, 'missing-stderr.sock'),
        wrongLengthPath,
        root,
        '/usr/bin/true',
      ], 5_000);
      expect(rejectedRun).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: '',
        timedOut: false,
        overflowed: false,
      });
      expect(await inspectProcess(session.guardian.pid)).toEqual(session.guardian);
      expect(await inspectProcess(session.provider.pid)).toEqual(session.provider);
    } finally {
      try {
        await cleanupSession(session);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it('attests an independent watchdog and confirms cleanup after owner command and bootout', async () => {
    const pidFileName = 'watch-command-pids.json';
    const session = await startGuardianSession('owner-loss', pidFileName);
    let watchdog: WatchdogSession | null = null;
    let daemon: ProcessIdentity | null = null;
    try {
      const pids = await readPidFile(join(session.root, pidFileName), 5_000);
      daemon = await inspectProcess(pids.daemon);
      watchdog = await startWatchdogSession(session);

      expect(watchdog.identity).toEqual(await inspectProcess(watchdog.identity.pid));
      expect(watchdog.identity.coalitionId).not.toBe(session.guardian.coalitionId);
      await writeSocket(watchdog.socket, Buffer.from('C'));
      await bootoutGuardianService(session);
      await readUntilTreeConfirmed(watchdog.reader, 10_000);

      await Promise.all([
        waitForIdentityExit(session.guardian, 5_000),
        waitForIdentityExit(session.provider, 5_000),
        waitForIdentityExit(daemon, 5_000),
        waitForIdentityExit(watchdog.identity, 5_000),
      ]);
      expect(await identityExists(session.guardian)).toBe(false);
      expect(await identityExists(session.provider)).toBe(false);
      expect(await identityExists(daemon)).toBe(false);
    } finally {
      try {
        await cleanupSession(session, daemon ? [daemon] : []);
      } finally {
        if (watchdog) await cleanupWatchdogSession(watchdog);
      }
    }
  }, 30_000);

  it('keeps retrying after owner EOF and self-cleans a provider plus detached daemon', async () => {
    const pidFileName = 'watch-owner-loss-pids.json';
    const session = await startGuardianSession('owner-loss', pidFileName);
    let watchdog: WatchdogSession | null = null;
    let daemon: ProcessIdentity | null = null;
    try {
      const pids = await readPidFile(join(session.root, pidFileName), 5_000);
      daemon = await inspectProcess(pids.daemon);
      watchdog = await startWatchdogSession(session);

      watchdog.socket.destroy();
      await Promise.all([
        waitForIdentityExit(session.guardian, 8_000),
        waitForIdentityExit(session.provider, 8_000),
        waitForIdentityExit(daemon, 8_000),
      ]);
      expect(await identityExists(session.guardian)).toBe(false);
      expect(await identityExists(session.provider)).toBe(false);
      expect(await identityExists(daemon)).toBe(false);

      await bootoutGuardianService(session);
      await waitForIdentityExit(watchdog.identity, 8_000);
    } finally {
      try {
        await cleanupSession(session, daemon ? [daemon] : []);
      } finally {
        if (watchdog) await cleanupWatchdogSession(watchdog);
      }
    }
  }, 30_000);
});

class SocketReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #buffer = Buffer.alloc(0);

  constructor(socket: Socket) {
    this.#iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async readLine(maximumBytes = 256): Promise<string> {
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline >= 0) {
        if (newline > maximumBytes) throw new Error('protocol_line_oversize');
        const line = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.subarray(newline + 1);
        if (line.includes(0x00) || line.includes(0x0d)) {
          throw new Error('protocol_line_invalid');
        }
        return line.toString('utf8');
      }
      if (this.#buffer.byteLength > maximumBytes) {
        throw new Error('protocol_line_oversize');
      }
      const chunk = await this.#readIteratorChunk();
      if (!chunk) throw new Error('protocol_line_eof');
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
    }
  }

  async readChunk(): Promise<Buffer | null> {
    if (this.#buffer.byteLength > 0) {
      const buffered = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      return buffered;
    }
    return this.#readIteratorChunk();
  }

  async #readIteratorChunk(): Promise<Buffer | null> {
    const next = await this.#iterator.next();
    if (next.done) return null;
    if (!Buffer.isBuffer(next.value)) throw new Error('protocol_chunk_invalid');
    return next.value;
  }
}

async function startGuardianSession(
  mode: 'relay' | 'owner-loss',
  pidFileName?: string,
): Promise<GuardianSession> {
  const helper = requireHelperPath();
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('uid_unavailable');
  const root = await mkdtemp(CONTROL_ROOT_PREFIX);
  await chmod(root, 0o700);
  const nonce = cryptoNonce();
  const nonceSecretPath = await writeNonceSecret(root, 'guardian-nonce.secret', nonce);
  const label = `com.roundtable.native-protocol.${process.pid}.${cryptoNonce(8)}`;
  const serviceTarget = `gui/${uid}/${label}`;
  const servers: SingleConnectionServer[] = [];
  const sockets: Socket[] = [];
  let guardian: ProcessIdentity | null = null;
  let provider: ProcessIdentity | null = null;
  let stdout: OutputCollector | null = null;
  let stderr: OutputCollector | null = null;
  try {
    const paths = ['control.sock', 'stdout.sock', 'stderr.sock'].map((name) => (
      join(root, name)
    ));
    for (const path of paths) servers.push(await listenForConnection(path));
    const providerArgs = [PROVIDER_FIXTURE, mode];
    if (pidFileName) providerArgs.push(join(root, pidFileName));
    const submitted = await runCommand(LAUNCHCTL, [
      'submit',
      '-l',
      label,
      '-o',
      '/dev/null',
      '-e',
      '/dev/null',
      '--',
      helper,
      'run',
      paths[0]!,
      paths[1]!,
      paths[2]!,
      nonceSecretPath,
      root,
      process.execPath,
      ...providerArgs,
    ], 5_000);
    if (submitted.exitCode !== 0 || submitted.timedOut || submitted.overflowed) {
      throw new Error(`launchctl_submit_failed:${submitted.stderr}`);
    }

    const accepted = await withTimeout(
      Promise.all(servers.map((server) => server.connection)),
      10_000,
      'guardian_connect_timeout',
    );
    sockets.push(...accepted);
    const control = accepted[0]!;
    const stdoutSocket = accepted[1]!;
    const stderrSocket = accepted[2]!;
    const controlReader = new SocketReader(control);
    const stdoutReader = new SocketReader(stdoutSocket);
    const stderrReader = new SocketReader(stderrSocket);
    const [hello, stdoutHeader, stderrHeader] = await Promise.all([
      controlReader.readLine(),
      stdoutReader.readLine(),
      stderrReader.readLine(),
    ]);
    guardian = parseHello(hello, nonce);
    expect(guardian).toEqual(await inspectProcess(guardian.pid));
    expect(await processCommandLine(guardian.pid)).not.toContain(nonce);
    await expectPathAbsent(nonceSecretPath);
    expect(stdoutHeader).toBe(`RTOUT001 ${nonce} stdout`);
    expect(stderrHeader).toBe(`RTOUT001 ${nonce} stderr`);
    stdout = collectOutput(stdoutReader);
    stderr = collectOutput(stderrReader);
    void stdout.completion.catch(() => undefined);
    void stderr.completion.catch(() => undefined);

    await writeSocket(control, providerConfiguration());
    const start = parseStart(await controlReader.readLine());
    expect(start.coalitionId).toBe(guardian.coalitionId);
    provider = await inspectProcess(start.pid);
    expect(provider.coalitionId).toBe(guardian.coalitionId);
    return {
      root,
      label,
      serviceTarget,
      nonce,
      servers,
      sockets,
      control,
      controlReader,
      stdout,
      stderr,
      guardian,
      provider,
    };
  } catch (error) {
    await cleanupPartialSession({
      root,
      label,
      serviceTarget,
      servers,
      sockets,
      identities: [guardian, provider].filter(
        (identity): identity is ProcessIdentity => identity !== null,
      ),
      ...(guardian ? { coalitionId: guardian.coalitionId } : {}),
      outputCompletions: [stdout, stderr]
        .filter((collector): collector is OutputCollector => collector !== null)
        .map((collector) => collector.completion),
    });
    throw error;
  }
}

async function startWatchdogSession(target: GuardianSession): Promise<WatchdogSession> {
  const helper = requireHelperPath();
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('uid_unavailable');
  const root = await mkdtemp(WATCH_ROOT_PREFIX);
  await chmod(root, 0o700);
  const nonce = cryptoNonce();
  const nonceSecretPath = await writeNonceSecret(root, 'watch-nonce.secret', nonce);
  const label = `com.roundtable.native-watch.${process.pid}.${cryptoNonce(8)}`;
  const serviceTarget = `gui/${uid}/${label}`;
  const server = await listenForConnection(join(root, 'owner.sock'));
  let socket: Socket | null = null;
  let identity: ProcessIdentity | null = null;
  try {
    const submitted = await runCommand(LAUNCHCTL, [
      'submit',
      '-l',
      label,
      '-o',
      '/dev/null',
      '-e',
      '/dev/null',
      '--',
      helper,
      'watch',
      server.path,
      nonceSecretPath,
      target.guardian.coalitionId,
      String(target.guardian.pid),
      String(target.guardian.pidVersion),
      target.guardian.uniqueId,
      '100',
      '1000',
    ], 5_000);
    if (submitted.exitCode !== 0 || submitted.timedOut || submitted.overflowed) {
      throw new Error(`watchdog_submit_failed:${submitted.stderr}`);
    }
    socket = await withTimeout(server.connection, 10_000, 'watchdog_connect_timeout');
    const reader = new SocketReader(socket);
    identity = parseWatchReady(await reader.readLine(), nonce);
    expect(identity).toEqual(await inspectProcess(identity.pid));
    expect(await processCommandLine(identity.pid)).not.toContain(nonce);
    await expectPathAbsent(nonceSecretPath);
    if (identity.coalitionId === target.guardian.coalitionId) {
      throw new Error('watchdog_coalition_not_independent');
    }
    return { root, label, serviceTarget, server, socket, reader, identity };
  } catch (error) {
    socket?.destroy();
    await closeServer(server.server);
    await runCommand(LAUNCHCTL, ['bootout', serviceTarget], 8_000);
    await runCommand(LAUNCHCTL, ['remove', label], 3_000);
    if (identity && await identityExists(identity)) {
      await killIdentityIfUnchanged(identity);
    }
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function collectOutput(reader: SocketReader): OutputCollector {
  const collector: OutputCollector = {
    chunks: [],
    observedBytes: 0,
    ended: false,
    completion: Promise.resolve(Buffer.alloc(0)),
  };
  collector.completion = (async () => {
    for (;;) {
      const chunk = await reader.readChunk();
      if (!chunk) {
        collector.ended = true;
        return Buffer.concat(collector.chunks);
      }
      collector.chunks.push(chunk);
      collector.observedBytes += chunk.byteLength;
    }
  })();
  return collector;
}

async function cleanupSession(
  session: GuardianSession,
  additionalIdentities: readonly ProcessIdentity[] = [],
): Promise<void> {
  await cleanupPartialSession({
    root: session.root,
    label: session.label,
    serviceTarget: session.serviceTarget,
    servers: session.servers,
    sockets: session.sockets,
    identities: [session.guardian, session.provider, ...additionalIdentities],
    coalitionId: session.guardian.coalitionId,
    outputCompletions: [session.stdout.completion, session.stderr.completion],
  });
}

async function cleanupWatchdogSession(session: WatchdogSession): Promise<void> {
  session.socket.destroy();
  await closeServer(session.server.server);
  await runCommand(LAUNCHCTL, ['bootout', session.serviceTarget], 8_000);
  await runCommand(LAUNCHCTL, ['remove', session.label], 3_000);
  await waitForIdentityExit(session.identity, 5_000).catch(() => undefined);
  if (await identityExists(session.identity)) {
    await killIdentityIfUnchanged(session.identity);
  }
  const coalition = await runCommand(
    requireHelperPath(),
    ['terminate', session.identity.coalitionId, '0', '3000'],
    5_000,
  );
  if (
    coalition.exitCode !== 0
    || coalition.timedOut
    || coalition.overflowed
    || coalition.stdout !== 'TREE confirmed\n'
    || coalition.stderr.length > 0
  ) {
    throw new Error(`residual_watchdog_coalition:${session.identity.coalitionId}`);
  }
  await rm(session.root, { recursive: true, force: true });
  const printed = await runCommand(LAUNCHCTL, ['print', session.serviceTarget], 3_000);
  if (printed.timedOut || printed.overflowed || printed.exitCode === 0) {
    throw new Error(`residual_watchdog_job:${session.label}`);
  }
  if (await identityExists(session.identity)) {
    throw new Error(`residual_watchdog_identity:${session.identity.pid}`);
  }
  try {
    await lstat(session.root);
    throw new Error(`residual_watchdog_root:${session.root}`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function cleanupPartialSession(input: {
  root: string;
  label: string;
  serviceTarget: string;
  servers: readonly SingleConnectionServer[];
  sockets: readonly Socket[];
  identities: readonly ProcessIdentity[];
  coalitionId?: string;
  outputCompletions?: readonly Promise<Buffer>[];
}): Promise<void> {
  const helper = requireHelperPath();
  for (const socket of input.sockets) socket.destroy();
  await Promise.all(input.servers.map((entry) => closeServer(entry.server)));
  if (input.outputCompletions) {
    await Promise.allSettled(input.outputCompletions);
  }

  await runCommand(LAUNCHCTL, ['bootout', input.serviceTarget], 8_000);
  await runCommand(LAUNCHCTL, ['remove', input.label], 3_000);
  if (input.coalitionId) {
    await runCommand(
      helper,
      ['terminate', input.coalitionId, '0', '5000'],
      8_000,
    );
  }
  for (const identity of input.identities) {
    await waitForIdentityExit(identity, 5_000).catch(() => undefined);
  }
  for (const identity of input.identities) {
    if (await identityExists(identity)) await killIdentityIfUnchanged(identity);
  }
  await rm(input.root, { recursive: true, force: true });

  const printed = await runCommand(
    LAUNCHCTL,
    ['print', input.serviceTarget],
    3_000,
  );
  if (printed.timedOut || printed.overflowed || printed.exitCode === 0) {
    throw new Error(`residual_launchd_job:${input.label}`);
  }
  for (const identity of input.identities) {
    if (await identityExists(identity)) {
      throw new Error(`residual_process_identity:${identity.pid}`);
    }
  }
  if (input.coalitionId) {
    const terminated = await runCommand(
      helper,
      ['terminate', input.coalitionId, '0', '1000'],
      3_000,
    );
    if (
      terminated.exitCode !== 0
      || terminated.timedOut
      || terminated.overflowed
      || terminated.stdout !== 'TREE confirmed\n'
      || terminated.stderr.length > 0
    ) {
      throw new Error(`residual_coalition:${input.coalitionId}`);
    }
  }
  try {
    await lstat(input.root);
    throw new Error(`residual_control_root:${input.root}`);
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) return;
    throw error;
  }
}

async function listenForConnection(path: string): Promise<SingleConnectionServer> {
  let resolveConnection!: (socket: Socket) => void;
  let rejectConnection!: (error: Error) => void;
  const connection = new Promise<Socket>((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });
  const server = createServer({ allowHalfOpen: false }, (socket) => {
    resolveConnection(socket);
    server.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      rejectConnection(error);
      reject(error);
    });
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return { path, server, connection };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function providerConfiguration(): Buffer {
  const environment = Buffer.from('PATH=/usr/bin:/bin\0LANG=C\0LC_ALL=C\0');
  const header = Buffer.alloc(16);
  header.write('RTCFG001', 0, 'ascii');
  header.writeUInt32BE(environment.byteLength, 8);
  header.writeUInt32BE(0, 12);
  return Buffer.concat([header, environment]);
}

function parseHello(line: string, nonce: string): ProcessIdentity {
  const match = new RegExp(
    `^HELLO ${nonce} ([1-9][0-9]{0,9}) ([0-9]{1,10}) ([1-9][0-9]{0,19}) ([1-9][0-9]{0,19})$`,
    'u',
  ).exec(line);
  if (!match) throw new Error('invalid_hello');
  return {
    pid: parsePid(match[1]!),
    pidVersion: parsePidVersion(match[2]!),
    uniqueId: parseUint64(match[3]!),
    coalitionId: parseUint64(match[4]!),
  };
}

function parseWatchReady(line: string, nonce: string): ProcessIdentity {
  const match = new RegExp(
    `^RTWATCH001 ${nonce} READY ([1-9][0-9]{0,9}) ([0-9]{1,10}) `
      + '([1-9][0-9]{0,19}) ([1-9][0-9]{0,19})$',
    'u',
  ).exec(line);
  if (!match) throw new Error('invalid_watch_ready');
  return {
    pid: parsePid(match[1]!),
    pidVersion: parsePidVersion(match[2]!),
    uniqueId: parseUint64(match[3]!),
    coalitionId: parseUint64(match[4]!),
  };
}

function parseStart(line: string): { pid: number; coalitionId: string } {
  const match = /^START ([1-9][0-9]{0,9}) ([1-9][0-9]{0,19})$/u.exec(line);
  if (!match) throw new Error('invalid_start');
  return {
    pid: parsePid(match[1]!),
    coalitionId: parseUint64(match[2]!),
  };
}

async function inspectProcess(pid: number): Promise<ProcessIdentity> {
  const result = await runCommand(
    requireHelperPath(),
    ['inspect', String(pid)],
    3_000,
  );
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.overflowed
    || result.stderr.length > 0
  ) throw new Error(`inspect_failed:${pid}`);
  const match = /^INSPECT ([1-9][0-9]{0,9}) ([0-9]{1,10}) ([1-9][0-9]{0,19}) ([1-9][0-9]{0,19})\n$/u
    .exec(result.stdout);
  if (!match) throw new Error(`inspect_invalid:${pid}`);
  return {
    pid: parsePid(match[1]!),
    pidVersion: parsePidVersion(match[2]!),
    uniqueId: parseUint64(match[3]!),
    coalitionId: parseUint64(match[4]!),
  };
}

async function identityExists(identity: ProcessIdentity): Promise<boolean> {
  try {
    return sameIdentity(await inspectProcess(identity.pid), identity);
  } catch {
    return false;
  }
}

async function waitForIdentityExit(
  identity: ProcessIdentity,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await identityExists(identity))) return;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`process_exit_timeout:${identity.pid}`);
}

async function killIdentityIfUnchanged(identity: ProcessIdentity): Promise<void> {
  if (!(await identityExists(identity))) return;
  try {
    process.kill(identity.pid, 'SIGKILL');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
    throw error;
  }
  await waitForIdentityExit(identity, 2_000);
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid
    && left.pidVersion === right.pidVersion
    && left.uniqueId === right.uniqueId
    && left.coalitionId === right.coalitionId;
}

async function readPidFile(
  path: string,
  timeoutMs: number,
): Promise<{ provider: number; daemon: number }> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (
        typeof value.provider === 'number'
        && typeof value.daemon === 'number'
      ) {
        return {
          provider: parsePid(String(value.provider)),
          daemon: parsePid(String(value.daemon)),
        };
      }
    } catch {
      // The provider publishes the file only after the daemon exists.
    }
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error('pid_file_timeout');
}

async function bootoutGuardianService(session: GuardianSession): Promise<void> {
  const result = await runCommand(LAUNCHCTL, ['bootout', session.serviceTarget], 8_000);
  const accepted = result.exitCode === 0
    || (
      result.exitCode === 3
      && result.stdout.length === 0
      && result.stderr === 'Boot-out failed: 3: No such process\n'
    );
  if (!accepted || result.timedOut || result.overflowed) {
    throw new Error(`guardian_bootout_failed:${result.stderr}`);
  }
}

async function readUntilTreeConfirmed(reader: SocketReader, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const line = await withTimeout(
      reader.readLine(),
      remaining,
      'watchdog_tree_timeout',
    );
    if (line === 'TREE confirmed') return;
    if (line !== 'TREE failed') throw new Error(`watchdog_tree_invalid:${line}`);
  } while (Date.now() < deadline);
  throw new Error('watchdog_tree_timeout');
}

async function waitForObservedBytes(
  collector: OutputCollector,
  expectedBytes: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (collector.observedBytes >= expectedBytes) return;
    if (collector.ended) throw new Error('output_ended_early');
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error('output_observation_timeout');
}

function parsePid(value: string): number {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
    throw new Error('invalid_pid');
  }
  return pid;
}

function parsePidVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0 || version > 0xffff_ffff) {
    throw new Error('invalid_pidversion');
  }
  return version;
}

function parseUint64(value: string): string {
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_UINT64) throw new Error('invalid_uint64');
  return parsed.toString(10);
}

function requireHelperPath(): string {
  if (!helperPath) throw new Error('test_helper_unavailable');
  return helperPath;
}

async function writeNonceSecret(root: string, name: string, nonce: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, nonce, { encoding: 'utf8', mode: 0o400, flag: 'wx' });
  await chmod(path, 0o400);
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o777) !== 0o400 || info.nlink !== 1) {
    throw new Error('nonce_secret_invalid');
  }
  return path;
}

async function expectPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`nonce_secret_not_unlinked:${path}`);
}

async function processCommandLine(pid: number): Promise<string> {
  const result = await runCommand('/bin/ps', [
    '-ww',
    '-p',
    String(pid),
    '-o',
    'command=',
  ], 3_000);
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.overflowed
    || result.stderr.length > 0
  ) throw new Error(`process_argv_unavailable:${pid}`);
  return result.stdout;
}

function cryptoNonce(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

async function writeSocket(socket: Socket, payload: Buffer): Promise<void> {
  await withTimeout(new Promise<void>((resolve, reject) => {
    socket.write(payload, (error) => {
      if (error) reject(error);
      else resolve();
    });
  }), 3_000, 'socket_write_timeout');
}

function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let observed = 0;
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => consume(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => consume(stderr, chunk));
    child.once('error', () => finish(null));
    child.once('close', (exitCode) => finish(exitCode));

    function consume(target: Buffer[], chunk: Buffer): void {
      observed += chunk.byteLength;
      if (observed > COMMAND_OUTPUT_LIMIT) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    }

    function finish(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        overflowed,
      });
    }
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
