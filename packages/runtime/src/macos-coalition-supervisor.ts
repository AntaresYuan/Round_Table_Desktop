import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { constants as osConstants } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RuntimeError } from './errors.js';
import { NATIVE_HELPER_MANIFEST } from './native-helper-manifest.js';
import {
  BoundedOutput,
  RedactingEmitter,
  redact,
  validateSupervisedProcessSpec,
  type SupervisedProcess,
  type SupervisedProcessEvent,
  type SupervisedProcessResult,
  type SupervisedProcessSpec,
} from './process-supervisor.js';
import type { RuntimeStopReason, TreeTermination } from './types.js';

const LAUNCHCTL = '/bin/launchctl';
const NULL_DEVICE = '/dev/null';
const CONTROL_ROOT_PREFIX = '/private/tmp/roundtable-guard-';
const HELPER_NAME = 'roundtable-macos-process-helper';
const CONTROL_HEADER_LIMIT = 256;
const CONTROL_LINE_LIMIT = 256;
const START_TIMEOUT_MS = 15_000;
const WATCHDOG_REDUNDANCY = 2;
const CONTROL_WRITE_TIMEOUT_MS = 3_000;
const TREE_RESPONSE_TIMEOUT_MS = 8_000;
const OUTPUT_EOF_TIMEOUT_MS = 3_000;
const LAUNCHD_ABSENCE_STABILITY_MS = 100;
const FIXED_COMMAND_OUTPUT_LIMIT = 64 * 1024;
const FIXED_COMMAND_KILL_WAIT_MS = 2_000;
const MAX_HELPER_BYTES = 4 * 1024 * 1024;
const MAX_UINT64 = (1n << 64n) - 1n;

type CoalitionProcessIdentity = {
  pid: number;
  pidVersion: number;
  uniqueId: string;
  coalitionId: string;
};

type TrustedHelper = {
  path: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  sha256: string;
};

type TrustedHelperSource = {
  path: string;
  resourceRoot: string;
  size: number;
  sha256: string;
};

type FixedCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  processStarted: boolean;
  processClosed: boolean;
  closed: Promise<void>;
};

type DeferredValue<T> = {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type WatchdogService = {
  label: string;
  target: string;
  plistPath: string;
  controlPath: string;
  secretPath: string;
  bootstrapClosed: boolean;
  socket: Socket | null;
  identity: CoalitionProcessIdentity | null;
  cleanupRequested: boolean;
  preRequestActivity: boolean;
  queuedConfirmation: boolean;
  result: DeferredValue<TreeTermination>;
  resultValue: TreeTermination | null;
};

type ProviderExit = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type SingleConnectionServer = {
  path: string;
  server: Server;
  connection: Promise<Socket>;
  closed: Promise<void>;
};

type MacOsCoalitionSpec = SupervisedProcessSpec & {
  runtimeHomeDirectory: string;
  runtimeTemporaryDirectory: string;
  trustedCodeRoots?: readonly string[] | undefined;
};

export async function startMacOsCoalitionSupervisedProcess(
  spec: MacOsCoalitionSpec,
): Promise<SupervisedProcess> {
  validateSupervisedProcessSpec(spec);
  if (process.platform !== 'darwin') throw new RuntimeError('security_boundary_unavailable');
  const uid = process.getuid?.() ?? -1;
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  await assertTrustedExecutable(LAUNCHCTL, true);
  const privateRuntimeDirectories = await assertPrivateRuntimeDirectories(spec);
  const providerWritableRoots = [
    await canonicalDirectory(spec.cwd),
    privateRuntimeDirectories.home,
    privateRuntimeDirectories.temporary,
  ];
  if (providerWritableRoots.some((root) => pathContains(root, '/private/tmp'))) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  const runtimeCodeRoot = fileURLToPath(new URL('../', import.meta.url));
  const trustedCodeRoots = await Promise.all(
    [...new Set([runtimeCodeRoot, ...(spec.trustedCodeRoots ?? [])])]
      .map(canonicalDirectory),
  );
  const helperSource = await resolveTrustedHelper(providerWritableRoots, trustedCodeRoots);

  const controlRoot = await prepareControlRoot();
  const helperSnapshotPath = join(controlRoot, HELPER_NAME);
  const nonce = randomBytes(32).toString('hex');
  const identity = randomUUID().replaceAll('-', '');
  const label = `com.roundtable.guardian.${identity}`;
  const serviceTarget = `gui/${uid}/${label}`;
  const controlPath = join(controlRoot, 'control.sock');
  const stdoutPath = join(controlRoot, 'stdout.sock');
  const stderrPath = join(controlRoot, 'stderr.sock');
  const nonceSecretPath = join(controlRoot, 'guardian-nonce.secret');
  const plistPath = join(controlRoot, 'guardian.plist');
  const servers: SingleConnectionServer[] = [];
  const sockets = new Set<Socket>();
  let trustedHelper: TrustedHelper | null = null;
  let bootstrapAttempted = false;
  let bootstrapCommandClosed = false;
  let runtimeOwnerIdentity: CoalitionProcessIdentity | null = null;
  let guardianIdentity: CoalitionProcessIdentity | null = null;
  let providerConfigurationStarted = false;
  let providerPid: number | null = null;
  let stopReason: RuntimeStopReason | null = null;
  let terminationConfirmed = false;
  let guardianServiceRemoved = false;
  let coalitionTerminationProven = false;
  let internalTreeConfirmed = false;
  let terminationOperation: Promise<TreeTermination> | null = null;
  let cleanupOperation: Promise<TreeTermination> | null = null;
  let resourceCloseOperation: Promise<void> | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let resourcesClosed = false;
  let protocolSettled = false;
  let startupRetainedFailure = false;
  const watchdogServices = new Map<string, WatchdogService>();
  const activeWatchdogs = new Set<WatchdogService>();

  const started = deferred<{ pid: number; coalitionId: string }>();
  const exited = deferred<ProviderExit>();
  const fatal = deferred<Error>();
  const externalTerminal = deferred<void>();
  const outputEnded = {
    stdout: deferred<void>(),
    stderr: deferred<void>(),
  };
  const treeHistory: TreeTermination[] = [];
  const treeWaiters = new Set<() => void>();
  const outputs = {
    stdout: new BoundedOutput(spec.limits.maxStdoutBytes, spec.limits.maxOutputChunkBytes),
    stderr: new BoundedOutput(spec.limits.maxStderrBytes, spec.limits.maxOutputChunkBytes),
  };
  const emitters = {
    stdout: new RedactingEmitter(
      spec.secrets,
      spec.limits.maxOutputChunkBytes,
      (text) => emitAfterStart({ kind: 'output', stream: 'stdout', text }),
    ),
    stderr: new RedactingEmitter(
      spec.secrets,
      spec.limits.maxOutputChunkBytes,
      (text) => emitAfterStart({ kind: 'output', stream: 'stderr', text }),
    ),
  };
  let controlSocket: Socket | null = null;
  let startedEventEmitted = false;
  const preStartEvents: SupervisedProcessEvent[] = [];

  try {
    trustedHelper = await createTrustedHelperSnapshot(helperSource, helperSnapshotPath);
    await writePrivateNonceSecret(nonceSecretPath, nonce);
    for (const socketPath of [controlPath, stdoutPath, stderrPath]) {
      const entry = await listenForSingleConnection(socketPath, trackAcceptedSocket);
      servers.push(entry);
    }
    const plist = launchdPlist({
      label,
      helperPath: trustedHelper.path,
      controlPath,
      stdoutPath,
      stderrPath,
      nonceSecretPath,
      cwd: spec.cwd,
      command: spec.command,
      args: spec.args,
      exitTimeOutSeconds: Math.max(
        1,
        Math.ceil((spec.limits.terminateGraceMs + spec.limits.killConfirmMs) / 1_000),
      ),
    });
    await writeFile(plistPath, plist, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await assertPrivateFile(plistPath);
    await assertTrustedHelperUnchanged(trustedHelper);
    const bootstrap = await runFixedCommand(
      LAUNCHCTL,
      ['bootstrap', `gui/${uid}`, plistPath],
      5_000,
    );
    bootstrapAttempted = bootstrap.processStarted;
    bootstrapCommandClosed = bootstrap.processClosed;
    void bootstrap.closed.then(() => {
      bootstrapCommandClosed = true;
    });
    if (
      bootstrap.exitCode !== 0
      || bootstrap.stdout.length > 0
      || bootstrap.stderr.length > 0
    ) throw new Error('guardian_bootstrap_failed');
    await rm(plistPath, { force: true });

    const connections = await withTimeout(
      Promise.all(servers.map((entry) => entry.connection)),
      START_TIMEOUT_MS,
      'guardian_connect_timeout',
    );
    const control = connections[0];
    const stdoutSocket = connections[1];
    const stderrSocket = connections[2];
    if (!control || !stdoutSocket || !stderrSocket || connections.length !== 3) {
      throw new Error('guardian_connection_invalid');
    }
    controlSocket = control;

    const [controlHeader, stdoutHeader, stderrHeader] = await withTimeout(
      Promise.all([
        readSocketHeader(control, CONTROL_HEADER_LIMIT),
        readSocketHeader(stdoutSocket, CONTROL_HEADER_LIMIT),
        readSocketHeader(stderrSocket, CONTROL_HEADER_LIMIT),
      ]),
      START_TIMEOUT_MS,
      'guardian_header_timeout',
    );
    await assertPathAbsent(nonceSecretPath);
    const hello = new RegExp(
      `^HELLO ${nonce} ([1-9][0-9]{0,9}) ([0-9]{1,10}) ([1-9][0-9]{0,19}) ([1-9][0-9]{0,19})$`,
      'u',
    ).exec(
      controlHeader.line,
    );
    if (
      !hello
      || stdoutHeader.line !== `RTOUT001 ${nonce} stdout`
      || stderrHeader.line !== `RTOUT001 ${nonce} stderr`
    ) throw new Error('guardian_header_invalid');
    const claimedGuardian: CoalitionProcessIdentity = {
      pid: parsePid(hello[1]!),
      pidVersion: parsePidVersion(hello[2]!),
      uniqueId: parseUint64(hello[3]!),
      coalitionId: parseUint64(hello[4]!),
    };

    attachOutputSocket('stdout', stdoutSocket, stdoutHeader.remainder);
    attachOutputSocket('stderr', stderrSocket, stderrHeader.remainder);
    attachControlSocket(control, controlHeader.remainder);

    const [ownerIdentity, inspectedGuardian] = await raceFatal(Promise.all([
      inspectProcess(requireTrustedHelper(), process.pid),
      inspectProcess(requireTrustedHelper(), claimedGuardian.pid),
    ]));
    if (
      !sameProcessIdentity(inspectedGuardian, claimedGuardian)
      || inspectedGuardian.coalitionId === ownerIdentity.coalitionId
    ) throw new Error('guardian_coalition_not_unique');
    runtimeOwnerIdentity = ownerIdentity;
    guardianIdentity = inspectedGuardian;

    const watchdogs = await raceFatal(armWatchdogs(WATCHDOG_REDUNDANCY));
    if (!watchdogs || watchdogs.length < WATCHDOG_REDUNDANCY) {
      throw new Error('watchdog_start_failed');
    }
    if (watchdogs.some((watchdog) => watchdog.preRequestActivity)) {
      throw new Error('watchdog_start_order_invalid');
    }

    // From this point forward, conservatively assume the guardian may receive
    // enough of the frame to launch the provider even if this owner races a
    // fatal protocol event before the write callback settles.
    providerConfigurationStarted = true;
    await raceFatal(
      withTimeout(
        writeSocket(control, providerConfiguration(spec.env, spec.stdin)),
        START_TIMEOUT_MS,
        'guardian_config_write_timeout',
      ),
    );
    const provider = await raceFatal(
      withTimeout(started.promise, START_TIMEOUT_MS, 'guardian_start_timeout'),
    );
    if (provider.coalitionId !== inspectedGuardian.coalitionId) {
      throw new Error('guardian_provider_coalition_mismatch');
    }
    providerPid = provider.pid;
    armTimers();

    const completion = completeExecution();
    return {
      pid: providerPid,
      completion,
      stop: (reason = 'requested') => requestTermination(reason),
    };
  } catch {
    startupRetainedFailure = true;
    protocolSettled = true;
    clearTimers();
    if (!bootstrapAttempted) {
      await closeResources().catch(() => undefined);
      throw new RuntimeError('security_boundary_unavailable');
    }
    const cleanup = await emergencyCleanup();
    if (cleanup === 'confirmed') {
      throw new RuntimeError('security_boundary_unavailable');
    }
    finishOutputs();
    const completion = Promise.resolve<SupervisedProcessResult>({
      status: 'termination_failed',
      exitCode: null,
      signal: null,
      stdout: redact(outputs.stdout.finish(), spec.secrets),
      stderr: redact(outputs.stderr.finish(), spec.secrets),
      stdoutTruncated: outputs.stdout.truncated,
      stderrTruncated: outputs.stderr.truncated,
      treeTermination: 'failed',
    });
    return {
      pid: providerPid,
      completion,
      stop: (reason = 'requested') => {
        rememberStopReason(reason);
        return emergencyCleanup();
      },
    };
  }

  async function completeExecution(): Promise<SupervisedProcessResult> {
    const normal = (async () => {
      const firstTree = await Promise.race([
        waitForTreeAfter(0),
        externalTerminal.promise.then(() => 'confirmed' as const),
      ]);
      const providerExit = internalTreeConfirmed
        ? await exited.promise
        : exited.settled
          ? await exited.promise
          : { exitCode: null, signal: null };
      clearTimers();
      let treeTermination = firstTree;
      const outputComplete = await waitForOutputEnd();
      if (firstTree === 'confirmed') treeTermination = await emergencyCleanup();
      if (!outputComplete) {
        const cleanup = await emergencyCleanup();
        if (cleanup === 'confirmed') treeTermination = cleanup;
      }
      finishOutputs();
      return buildResult(
        providerExit,
        treeTermination,
        fatal.settled || !outputComplete || !internalTreeConfirmed,
      );
    })();
    const failedProtocol = fatal.promise.then(async () => {
      clearTimers();
      const treeTermination = await emergencyCleanup();
      await waitForOutputEnd();
      finishOutputs();
      return buildResult(
        exited.settled ? await exited.promise : { exitCode: null, signal: null },
        treeTermination,
        true,
      );
    });
    const result = await Promise.race([normal, failedProtocol]);
    protocolSettled = true;
    return result;
  }

  function buildResult(
    providerExit: ProviderExit,
    treeTermination: TreeTermination,
    protocolFailed: boolean,
  ): SupervisedProcessResult {
    const status = protocolFailed || treeTermination === 'failed'
      ? 'termination_failed'
      : stopReason === 'requested' || stopReason === 'shutdown'
        ? 'stopped'
        : stopReason === 'total_timeout'
          ? 'timed_out'
          : stopReason === 'idle_timeout'
            ? 'idle_timed_out'
            : 'exited';
    return {
      status,
      exitCode: providerExit.exitCode,
      signal: providerExit.signal,
      stdout: redact(outputs.stdout.finish(), spec.secrets),
      stderr: redact(outputs.stderr.finish(), spec.secrets),
      stdoutTruncated: outputs.stdout.truncated,
      stderrTruncated: outputs.stderr.truncated,
      treeTermination,
    };
  }

  function attachControlSocket(socket: Socket, remainder: Buffer): void {
    let pending = '';
    let ended = false;
    socket.on('data', (chunk: Buffer) => consume(chunk));
    socket.once('error', () => failProtocol('guardian_control_error'));
    socket.once('end', () => {
      ended = true;
      if (pending.length > 0) {
        failProtocol('guardian_control_incomplete');
      } else if (!terminationConfirmed && !protocolSettled && !internalTreeConfirmed) {
        failProtocol('guardian_control_ended');
      }
    });
    socket.once('close', () => {
      if (
        !ended
        && !terminationConfirmed
        && !protocolSettled
        && (pending.length > 0 || !internalTreeConfirmed)
      ) {
        failProtocol('guardian_control_closed');
      }
    });
    if (remainder.byteLength > 0) consume(remainder);
    socket.resume();

    function consume(chunk: Buffer): void {
      if (chunk.includes(0)) {
        failProtocol('guardian_control_invalid');
        return;
      }
      pending += chunk.toString('utf8');
      if (Buffer.byteLength(pending, 'utf8') > CONTROL_LINE_LIMIT * 4) {
        failProtocol('guardian_control_oversize');
        return;
      }
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > CONTROL_LINE_LIMIT || line.includes('\r')) {
          failProtocol('guardian_control_invalid');
          return;
        }
        handleControlLine(line);
      }
    }
  }

  function handleControlLine(line: string): void {
    if (startupRetainedFailure) return;
    const startMatch = /^START ([1-9][0-9]{0,9}) ([1-9][0-9]{0,19})$/u.exec(line);
    if (startMatch) {
      if (started.settled || exited.settled || treeHistory.length > 0 || !guardianIdentity) {
        failProtocol('guardian_start_order_invalid');
        return;
      }
      const pid = parsePid(startMatch[1]!);
      const coalitionId = parseUint64(startMatch[2]!);
      if (coalitionId !== guardianIdentity.coalitionId) {
        failProtocol('guardian_provider_coalition_mismatch');
        return;
      }
      providerPid = pid;
      started.resolve({ pid, coalitionId });
      safeEmit({ kind: 'started', pid });
      startedEventEmitted = true;
      for (const event of preStartEvents.splice(0)) safeEmit(event);
      return;
    }

    const exitMatch = /^EXIT (-1|0|[1-9][0-9]{0,9}) (0|[1-9][0-9]{0,2})$/u.exec(line);
    if (exitMatch) {
      if (!started.settled || exited.settled || internalTreeConfirmed) {
        failProtocol('guardian_exit_order_invalid');
        return;
      }
      const code = Number(exitMatch[1]);
      const signalNumber = Number(exitMatch[2]);
      const signal = signalName(signalNumber);
      if (
        (code === -1 && signal === null)
        || (code !== -1 && signalNumber !== 0)
        || code > 255
      ) {
        failProtocol('guardian_exit_invalid');
        return;
      }
      exited.resolve({ exitCode: code === -1 ? null : code, signal });
      return;
    }

    const treeMatch = /^TREE (confirmed|failed)$/u.exec(line);
    if (treeMatch) {
      const value: TreeTermination = treeMatch[1] === 'confirmed' ? 'confirmed' : 'failed';
      if (
        !started.settled
        || internalTreeConfirmed
        || (value === 'confirmed' && !exited.settled)
      ) {
        failProtocol('guardian_tree_order_invalid');
        return;
      }
      treeHistory.push(value);
      if (value === 'confirmed') internalTreeConfirmed = true;
      for (const notify of [...treeWaiters]) notify();
      return;
    }

    failProtocol('guardian_control_unknown');
  }

  function attachOutputSocket(
    stream: 'stdout' | 'stderr',
    socket: Socket,
    remainder: Buffer,
  ): void {
    let ended = false;
    socket.on('data', (chunk: Buffer) => consumeOutput(stream, chunk));
    socket.once('end', finish);
    socket.once('error', () => {
      if (!ended) failProtocol(`guardian_${stream}_error`);
    });
    socket.once('close', () => {
      if (!ended) failProtocol(`guardian_${stream}_closed`);
    });
    if (remainder.byteLength > 0) consumeOutput(stream, remainder);
    socket.resume();

    function finish(): void {
      if (ended) return;
      ended = true;
      outputEnded[stream].resolve();
    }
  }

  function consumeOutput(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (startupRetainedFailure) return;
    armIdleTimer();
    const collector = outputs[stream];
    const emitter = emitters[stream];
    const wasTruncated = collector.truncated;
    for (const text of collector.push(chunk)) emitter.push(text);
    if (!wasTruncated && collector.truncated) {
      emitter.finish();
      emitAfterStart({
        kind: 'output_truncated',
        stream,
        observedBytes: collector.observedBytes,
      });
    }
  }

  function requestTermination(reason: RuntimeStopReason): Promise<TreeTermination> {
    rememberStopReason(reason);
    clearTimers();
    if (terminationConfirmed) return emergencyCleanup();
    if (terminationOperation) return terminationOperation;
    const operation = (async () => {
      if (fatal.settled || startupRetainedFailure) return emergencyCleanup();
      if (internalTreeConfirmed) return emergencyCleanup();
      if (!controlSocket?.writable || controlSocket.destroyed) return emergencyCleanup();
      const baseline = treeHistory.length;
      try {
        await withTimeout(
          writeSocket(controlSocket, Buffer.from(baseline === 0 ? 'S' : 'R', 'ascii')),
          CONTROL_WRITE_TIMEOUT_MS,
          'guardian_control_write_timeout',
        );
        const treeTermination = await raceFatal(
          waitForTreeAfter(baseline, TREE_RESPONSE_TIMEOUT_MS),
        );
        return treeTermination === 'confirmed' ? emergencyCleanup() : 'failed';
      } catch {
        return emergencyCleanup();
      }
    })().catch(() => 'failed' as const).finally(() => {
      if (terminationOperation === operation) terminationOperation = null;
    });
    terminationOperation = operation;
    return operation;
  }

  function rememberStopReason(reason: RuntimeStopReason): void {
    if (stopReason) return;
    stopReason = reason;
    safeEmit({ kind: 'stop_requested', reason });
  }

  function waitForTreeAfter(
    index: number,
    timeoutMs?: number,
  ): Promise<TreeTermination> {
    const existing = treeHistory[index];
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined
        ? null
        : setTimeout(() => {
          treeWaiters.delete(notify);
          reject(new Error('guardian_tree_timeout'));
        }, timeoutMs);
      timer?.unref();
      const notify = (): void => {
        const value = treeHistory[index]
          ?? (externalTerminal.settled ? 'confirmed' as const : undefined);
        if (!value) return;
        if (timer) clearTimeout(timer);
        treeWaiters.delete(notify);
        resolve(value);
      };
      treeWaiters.add(notify);
      notify();
    });
  }

  function emergencyCleanup(): Promise<TreeTermination> {
    if (terminationConfirmed) {
      return closeResources().then(
        () => {
          settleExternalTerminal();
          return 'confirmed' as const;
        },
        () => 'failed' as const,
      );
    }
    if (cleanupOperation) return cleanupOperation;
    const operation = performEmergencyCleanup().catch(() => 'failed' as const).finally(() => {
      if (cleanupOperation === operation) cleanupOperation = null;
    });
    cleanupOperation = operation;
    return operation;
  }

  async function performEmergencyCleanup(): Promise<TreeTermination> {
    if (terminationConfirmed) return 'confirmed';
    if (!bootstrapCommandClosed) return 'failed';
    const cleanupTimeoutMs = spec.limits.terminateGraceMs
      + spec.limits.killConfirmMs
      + 5_000;

    if (!guardianIdentity) {
      // Configuration is only attempted after HELLO identity and watchdog
      // attestation. Without either, the fixed guardian cannot have spawned a
      // provider, so stable launchd removal is a complete startup proof.
      if (providerConfigurationStarted || watchdogServices.size > 0) return 'failed';
      if (!await removeGuardianService(cleanupTimeoutMs, true)) return 'failed';
      coalitionTerminationProven = true;
    } else if (!providerConfigurationStarted) {
      // The guardian only accepts a provider frame from this owner after both
      // watchdogs are attested. If no byte of that frame was attempted, the
      // fixed guardian cannot have spawned a provider. Remove the job instead
      // of repeatedly creating watchdogs that can never attest a dead guardian.
      if (!await removeGuardianService(cleanupTimeoutMs, true)) return 'failed';
      coalitionTerminationProven = true;
    } else {
      if (!runtimeOwnerIdentity) return 'failed';
      const helper = requireTrustedHelper();
      await assertTrustedHelperUnchanged(helper);

      if (!coalitionTerminationProven) {
        // Once provider bytes may have been delivered, never open a new
        // watcher listener: the Seatbelt boundary does not authenticate Unix
        // socket peers. Both trusted peers were established before provider
        // configuration, and either one is sufficient after its peer fails.
        const requiredWatchdogs = providerConfigurationStarted || guardianServiceRemoved
          ? 1
          : WATCHDOG_REDUNDANCY;
        const watchdogs = await armWatchdogs(requiredWatchdogs);
        if (!watchdogs || watchdogs.length < requiredWatchdogs) {
          if (!await directCoalitionCleanup(cleanupTimeoutMs)) return 'failed';
          coalitionTerminationProven = true;
        }

        const commandResults = await Promise.all((watchdogs ?? []).map(async (watchdog) => {
          if (watchdog.resultValue === 'confirmed' || watchdog.cleanupRequested) return true;
          if (watchdog.queuedConfirmation) {
            watchdog.cleanupRequested = true;
            confirmWatchdog(watchdog);
            return true;
          }
          const socket = watchdog.socket;
          if (!socket?.writable || socket.destroyed) {
            markWatchdogFailed(watchdog, 'watchdog_control_unavailable');
            return false;
          }
          try {
            await withTimeout(
              writeSocket(socket, Buffer.from('C', 'ascii')),
              CONTROL_WRITE_TIMEOUT_MS,
              'watchdog_control_write_timeout',
            );
            watchdog.cleanupRequested = true;
            if (watchdog.queuedConfirmation) confirmWatchdog(watchdog);
            return true;
          } catch {
            markWatchdogFailed(watchdog, 'watchdog_control_write_failed');
            return false;
          }
        }));
        if (
          !coalitionTerminationProven
          && !commandResults.some(Boolean)
        ) {
          if (!await directCoalitionCleanup(cleanupTimeoutMs)) return 'failed';
          coalitionTerminationProven = true;
        }

        if (!coalitionTerminationProven && !guardianServiceRemoved) {
          // Two READY-attested, distinct watchdog coalitions own the target CID
          // before launchd releases the guardian. Either watchdog can finish
          // the paired-ESRCH proof if its peer fails during this handoff.
          if (!await removeGuardianService(cleanupTimeoutMs, true)) return 'failed';
        }

        const watchdogResult = coalitionTerminationProven
          ? 'confirmed' as const
          : await waitForAnyWatchdogConfirmation(watchdogs ?? [], cleanupTimeoutMs);
        if (watchdogResult !== 'confirmed') {
          if (!await directCoalitionCleanup(cleanupTimeoutMs)) return 'failed';
        }
        coalitionTerminationProven = true;
      }
    }

    if (!await removeGuardianService(cleanupTimeoutMs)) return 'failed';
    if (!await retireWatchdogServices(cleanupTimeoutMs)) return 'failed';
    const firstAbsence = await launchdServiceAbsent(label, uid, serviceTarget);
    await delay(LAUNCHD_ABSENCE_STABILITY_MS);
    const stableAbsence = firstAbsence
      && await launchdServiceAbsent(label, uid, serviceTarget);
    if (!stableAbsence) return 'failed';
    terminationConfirmed = true;
    clearTimers();
    try {
      await closeResources();
      settleExternalTerminal();
      return 'confirmed';
    } catch {
      return 'failed';
    }
  }

  async function directCoalitionCleanup(timeoutMs: number): Promise<boolean> {
    const guardian = guardianIdentity;
    if (!guardian) return false;
    const helper = requireTrustedHelper();
    await assertTrustedHelperUnchanged(helper);

    // Stop every coalition member except the identity-attested guardian before
    // removing its launchd definition. A dead guardian makes isolation fail,
    // but the subsequent full-coalition pass remains authoritative.
    if (!guardianServiceRemoved) {
      const isolated = await runFixedCommand(
        helper.path,
        [
          'isolate',
          guardian.coalitionId,
          String(guardian.pid),
          String(guardian.pidVersion),
          guardian.uniqueId,
          String(spec.limits.terminateGraceMs),
          String(spec.limits.killConfirmMs),
        ],
        timeoutMs,
      );
      if (!isolated.processClosed) return false;
      if (!await removeGuardianService(timeoutMs, true)) return false;
    }

    await assertTrustedHelperUnchanged(helper);
    const terminated = await runFixedCommand(
      helper.path,
      [
        'terminate',
        guardian.coalitionId,
        String(spec.limits.terminateGraceMs),
        String(spec.limits.killConfirmMs),
      ],
      timeoutMs,
    );
    return terminated.processClosed
      && terminated.exitCode === 0
      && terminated.stdout === 'TREE confirmed\n'
      && terminated.stderr.length === 0;
  }

  async function removeGuardianService(
    timeoutMs: number,
    watchdogHandoff = false,
  ): Promise<boolean> {
    if (guardianServiceRemoved) return true;
    if (!coalitionTerminationProven && !watchdogHandoff) return false;
    const bootout = await runFixedCommand(
      LAUNCHCTL,
      ['bootout', serviceTarget],
      timeoutMs,
    );
    guardianServiceRemoved = (
      bootout.exitCode === 0
      && bootout.stdout.length === 0
      && bootout.stderr.length === 0
    ) || isLaunchdBootoutAbsent(bootout);
    return guardianServiceRemoved;
  }

  async function armWatchdogs(required: number): Promise<WatchdogService[] | null> {
    if (!guardianIdentity || !runtimeOwnerIdentity) return null;
    const candidates = [...activeWatchdogs];
    const liveResults = await Promise.all(candidates.map(async (service) => ({
      service,
      live: service.resultValue === null && (
        service.queuedConfirmation || await watchdogIdentityIsLive(service)
      ),
    })));
    const live: WatchdogService[] = [];
    for (const { service, live: isLive } of liveResults) {
      if (service.resultValue === 'confirmed') {
        coalitionTerminationProven = true;
        return [service];
      }
      if (isLive) live.push(service);
      else activeWatchdogs.delete(service);
    }

    while (live.length < required) {
      if (providerConfigurationStarted) return null;
      const replacement = await startWatchdog(guardianIdentity, runtimeOwnerIdentity);
      if (!replacement) return null;
      activeWatchdogs.add(replacement);
      live.push(replacement);
    }
    return live;
  }

  async function startWatchdog(
    expectedGuardian: CoalitionProcessIdentity,
    ownerIdentity: CoalitionProcessIdentity,
  ): Promise<WatchdogService | null> {
    const helper = requireTrustedHelper();
    await assertTrustedHelperUnchanged(helper);
    const watchdogNonce = randomBytes(32).toString('hex');
    const watchdogIdentity = randomUUID().replaceAll('-', '');
    const watchdogLabel = `com.roundtable.watchdog.${watchdogIdentity}`;
    const watchdogTarget = `gui/${uid}/${watchdogLabel}`;
    const watchdogControlPath = join(controlRoot, `watchdog-${watchdogIdentity}.sock`);
    const watchdogPlistPath = join(controlRoot, `watchdog-${watchdogIdentity}.plist`);
    const watchdogSecretPath = join(controlRoot, `watchdog-${watchdogIdentity}.secret`);
    const server = await listenForSingleConnection(
      watchdogControlPath,
      trackAcceptedSocket,
    );
    servers.push(server);
    const service: WatchdogService = {
      label: watchdogLabel,
      target: watchdogTarget,
      plistPath: watchdogPlistPath,
      controlPath: watchdogControlPath,
      secretPath: watchdogSecretPath,
      bootstrapClosed: false,
      socket: null,
      identity: null,
      cleanupRequested: false,
      preRequestActivity: false,
      queuedConfirmation: false,
      result: deferred<TreeTermination>(),
      resultValue: null,
    };
    watchdogServices.set(watchdogLabel, service);
    let commandStarted = false;

    try {
      await writePrivateNonceSecret(watchdogSecretPath, watchdogNonce);
      await writeFile(
        watchdogPlistPath,
        launchdCleanupPlist({
          label: watchdogLabel,
          helperPath: helper.path,
          helperArgs: [
            'watch',
            watchdogControlPath,
            watchdogSecretPath,
            expectedGuardian.coalitionId,
            String(expectedGuardian.pid),
            String(expectedGuardian.pidVersion),
            expectedGuardian.uniqueId,
            String(spec.limits.terminateGraceMs),
            String(spec.limits.killConfirmMs),
          ],
          stdoutPath: NULL_DEVICE,
          stderrPath: NULL_DEVICE,
          exitTimeOutSeconds: Math.max(
            1,
            Math.ceil((spec.limits.terminateGraceMs + spec.limits.killConfirmMs) / 1_000),
          ),
        }),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      await assertPrivateFile(watchdogPlistPath);
      await assertTrustedHelperUnchanged(helper);
      const bootstrap = await runFixedCommand(
        LAUNCHCTL,
        ['bootstrap', `gui/${uid}`, watchdogPlistPath],
        5_000,
      );
      commandStarted = bootstrap.processStarted;
      service.bootstrapClosed = bootstrap.processClosed;
      void bootstrap.closed.then(() => {
        service.bootstrapClosed = true;
      });
      if (
        !bootstrap.processClosed
        || bootstrap.exitCode !== 0
        || bootstrap.stdout.length > 0
        || bootstrap.stderr.length > 0
      ) return null;
      await rm(watchdogPlistPath, { force: true });

      const socket = await withTimeout(
        server.connection,
        START_TIMEOUT_MS,
        'watchdog_connect_timeout',
      );
      service.socket = socket;
      const header = await withTimeout(
        readSocketHeader(socket, CONTROL_HEADER_LIMIT),
        START_TIMEOUT_MS,
        'watchdog_header_timeout',
      );
      await assertPathAbsent(watchdogSecretPath);
      const ready = new RegExp(
        `^RTWATCH001 ${watchdogNonce} READY ([1-9][0-9]{0,9}) ([0-9]{1,10}) ([1-9][0-9]{0,19}) ([1-9][0-9]{0,19})$`,
        'u',
      ).exec(header.line);
      if (!ready) throw new Error('watchdog_header_invalid');
      const claimedWatchdog: CoalitionProcessIdentity = {
        pid: parsePid(ready[1]!),
        pidVersion: parsePidVersion(ready[2]!),
        uniqueId: parseUint64(ready[3]!),
        coalitionId: parseUint64(ready[4]!),
      };
      const inspectedWatchdog = await inspectProcess(helper, claimedWatchdog.pid);
      if (
        !sameProcessIdentity(inspectedWatchdog, claimedWatchdog)
        || inspectedWatchdog.coalitionId === expectedGuardian.coalitionId
        || inspectedWatchdog.coalitionId === ownerIdentity.coalitionId
        || [...watchdogServices.values()].some((existing) => (
          existing !== service
          && existing.identity?.coalitionId === inspectedWatchdog.coalitionId
        ))
      ) throw new Error('watchdog_identity_invalid');
      service.identity = inspectedWatchdog;
      attachWatchdogSocket(service, socket, header.remainder);
      return service;
    } catch {
      service.resultValue = 'failed';
      service.result.resolve('failed');
      service.socket?.destroy();
      return null;
    } finally {
      if (!commandStarted) watchdogServices.delete(watchdogLabel);
    }
  }

  function attachWatchdogSocket(
    service: WatchdogService,
    socket: Socket,
    remainder: Buffer,
  ): void {
    let pending = '';
    let ended = false;
    socket.on('data', (chunk: Buffer) => consume(chunk));
    socket.once('error', () => markWatchdogFailed(service, 'watchdog_control_error'));
    socket.once('end', () => {
      ended = true;
      if (pending.length > 0 || (!service.result.settled && !service.queuedConfirmation)) {
        markWatchdogFailed(service, 'watchdog_control_ended');
      }
    });
    socket.once('close', () => {
      if (!ended && !service.result.settled && !service.queuedConfirmation) {
        markWatchdogFailed(service, 'watchdog_control_closed');
      }
    });
    if (remainder.byteLength > 0) consume(remainder);
    socket.resume();

    function consume(chunk: Buffer): void {
      if (chunk.includes(0)) {
        markWatchdogFailed(service, 'watchdog_control_invalid');
        return;
      }
      pending += chunk.toString('utf8');
      if (Buffer.byteLength(pending, 'utf8') > CONTROL_LINE_LIMIT * 4) {
        markWatchdogFailed(service, 'watchdog_control_oversize');
        return;
      }
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > CONTROL_LINE_LIMIT || line.includes('\r')) {
          markWatchdogFailed(service, 'watchdog_control_invalid');
          return;
        }
        if (line === 'TREE failed') {
          if (!service.cleanupRequested) service.preRequestActivity = true;
          continue;
        }
        if (line === 'TREE confirmed' && !service.result.settled) {
          if (!service.cleanupRequested) {
            service.preRequestActivity = true;
            service.queuedConfirmation = true;
          } else {
            confirmWatchdog(service);
          }
          continue;
        }
        markWatchdogFailed(service, 'watchdog_control_unknown');
        return;
      }
    }
  }

  function confirmWatchdog(service: WatchdogService): void {
    if (service.result.settled) return;
    service.resultValue = 'confirmed';
    service.result.resolve('confirmed');
    coalitionTerminationProven = true;
  }

  function markWatchdogFailed(service: WatchdogService, code: string): void {
    if (!service.result.settled) {
      service.resultValue = 'failed';
      service.result.resolve('failed');
    }
    activeWatchdogs.delete(service);
    if (!coalitionTerminationProven && !terminationConfirmed) failProtocol(code);
  }

  async function waitForAnyWatchdogConfirmation(
    services: readonly WatchdogService[],
    timeoutMs: number,
  ): Promise<TreeTermination> {
    const confirmations = services.map(async (service) => {
      const result = await service.result.promise;
      if (result !== 'confirmed') throw new Error('watchdog_failed');
      return result;
    });
    return withTimeout(
      Promise.any(confirmations),
      timeoutMs,
      'watchdog_tree_timeout',
    ).catch(() => 'failed' as const);
  }

  async function watchdogIdentityIsLive(service: WatchdogService): Promise<boolean> {
    if (
      !service.bootstrapClosed
      || !service.identity
      || !service.socket?.writable
      || service.socket.destroyed
      || service.result.settled
    ) return false;
    try {
      return sameProcessIdentity(
        await inspectProcess(requireTrustedHelper(), service.identity.pid),
        service.identity,
      );
    } catch {
      return false;
    }
  }

  async function retireWatchdogService(
    service: WatchdogService,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!service.bootstrapClosed || !coalitionTerminationProven) return false;
    const bootout = await runFixedCommand(
      LAUNCHCTL,
      ['bootout', service.target],
      timeoutMs,
    );
    const accepted = (
      bootout.exitCode === 0
      && bootout.stdout.length === 0
      && bootout.stderr.length === 0
    ) || isLaunchdBootoutAbsent(bootout);
    if (!accepted) return false;
    const firstAbsence = await launchdServiceAbsent(service.label, uid, service.target);
    await delay(LAUNCHD_ABSENCE_STABILITY_MS);
    const stableAbsence = firstAbsence
      && await launchdServiceAbsent(service.label, uid, service.target);
    if (stableAbsence) {
      service.socket?.destroy();
      activeWatchdogs.delete(service);
      watchdogServices.delete(service.label);
      await Promise.all([
        rm(service.plistPath, { force: true }),
        rm(service.controlPath, { force: true }),
        rm(service.secretPath, { force: true }),
      ]);
    }
    return stableAbsence;
  }

  async function retireWatchdogServices(timeoutMs: number): Promise<boolean> {
    for (const service of [...watchdogServices.values()]) {
      if (!await retireWatchdogService(service, timeoutMs)) return false;
    }
    return watchdogServices.size === 0;
  }

  async function waitForOutputEnd(): Promise<boolean> {
    try {
      await withTimeout(
        Promise.all([outputEnded.stdout.promise, outputEnded.stderr.promise]),
        OUTPUT_EOF_TIMEOUT_MS,
        'guardian_output_eof_timeout',
      );
      return true;
    } catch {
      return false;
    }
  }

  function finishOutputs(): void {
    emitters.stdout.finish();
    emitters.stderr.finish();
  }

  function failProtocol(code: string): void {
    if (terminationConfirmed || fatal.settled) return;
    fatal.resolve(new Error(code));
  }

  function settleExternalTerminal(): void {
    externalTerminal.resolve();
    for (const notify of [...treeWaiters]) notify();
  }

  function safeEmit(event: SupervisedProcessEvent): void {
    if (startupRetainedFailure && event.kind !== 'stop_requested') return;
    try {
      spec.onEvent?.(event);
    } catch {
      // An observer cannot interfere with process ownership.
    }
  }

  function emitAfterStart(event: SupervisedProcessEvent): void {
    if (!startedEventEmitted) {
      preStartEvents.push(event);
      return;
    }
    safeEmit(event);
  }

  function armTimers(): void {
    totalTimer = setTimeout(() => {
      void requestTermination('total_timeout').catch(() => undefined);
    }, spec.limits.totalTimeoutMs);
    totalTimer.unref();
    armIdleTimer();
  }

  function armIdleTimer(): void {
    if (!providerPid || exited.settled) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void requestTermination('idle_timeout').catch(() => undefined);
    }, spec.limits.idleTimeoutMs);
    idleTimer.unref();
  }

  function clearTimers(): void {
    if (totalTimer) clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    totalTimer = null;
    idleTimer = null;
  }

  function closeResources(): Promise<void> {
    if (resourcesClosed) return Promise.resolve();
    if (resourceCloseOperation) return resourceCloseOperation;
    const operation = (async () => {
      for (const socket of sockets) socket.destroy();
      for (const entry of servers) {
        if (entry.server.listening) entry.server.close();
      }
      await Promise.all(servers.map((entry) => entry.closed));
      if (isOwnedControlRoot(controlRoot)) {
        await rm(controlRoot, { recursive: true, force: true });
      }
      resourcesClosed = true;
    })().finally(() => {
      if (resourceCloseOperation === operation) resourceCloseOperation = null;
    });
    resourceCloseOperation = operation;
    return operation;
  }

  function trackAcceptedSocket(socket: Socket): void {
    sockets.add(socket);
    if (resourcesClosed || resourceCloseOperation) socket.destroy();
  }

  function requireTrustedHelper(): TrustedHelper {
    if (!trustedHelper) throw new Error('guardian_helper_unavailable');
    return trustedHelper;
  }

  async function raceFatal<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      fatal.promise.then((error) => Promise.reject(error)),
    ]);
  }
}

async function resolveTrustedHelper(
  providerWritableRoots: readonly string[],
  trustedCodeRoots: readonly string[],
): Promise<TrustedHelperSource> {
  const manifest = NATIVE_HELPER_MANIFEST[process.arch];
  if (!manifest) throw new RuntimeError('security_boundary_unavailable');
  const candidate = fileURLToPath(
    new URL(`../native/bin/${process.arch}/${HELPER_NAME}`, import.meta.url),
  );
  const [canonical, resourceRoot] = await Promise.all([
    realpath(candidate),
    realpath(fileURLToPath(new URL('../', import.meta.url))),
  ]);
  if (
    canonical !== candidate
    || !pathContains(resourceRoot, canonical)
    || !trustedCodeRoots.includes(resourceRoot)
  ) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  await assertTrustedDirectory(resourceRoot);
  for (const trustRoot of trustedCodeRoots) {
    await assertTrustedDirectory(trustRoot);
    for (const writableRoot of providerWritableRoots) {
      if (pathsOverlap(writableRoot, trustRoot)) {
        throw new RuntimeError('security_boundary_unavailable');
      }
    }
  }
  await assertTrustedExecutable(canonical, false);
  await readTrustedHelper(canonical, false, manifest);
  return {
    path: canonical,
    resourceRoot,
    size: manifest.size,
    sha256: manifest.sha256,
  };
}

async function createTrustedHelperSnapshot(
  source: TrustedHelperSource,
  destinationPath: string,
): Promise<TrustedHelper> {
  const verifiedSource = await readTrustedHelper(source.path, false, source);
  const destination = await open(
    destinationPath,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW,
    0o500,
  );
  try {
    await destination.writeFile(verifiedSource.bytes);
    await destination.chmod(0o500);
    await destination.sync();
    const info = await destination.stat({ bigint: true });
    const uid = BigInt(process.getuid?.() ?? -1);
    if (
      !info.isFile()
      || info.uid !== uid
      || (info.mode & 0o777n) !== 0o500n
      || info.nlink !== 1n
      || info.size !== BigInt(verifiedSource.bytes.byteLength)
    ) throw new RuntimeError('security_boundary_unavailable');
    return {
      path: destinationPath,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
      sha256: source.sha256,
    };
  } finally {
    await destination.close();
  }
}

async function assertTrustedHelperUnchanged(expected: TrustedHelper): Promise<void> {
  const current = (await readTrustedHelper(expected.path, true)).fingerprint;
  if (
    current.dev !== expected.dev
    || current.ino !== expected.ino
    || current.size !== expected.size
    || current.mtimeNs !== expected.mtimeNs
    || current.ctimeNs !== expected.ctimeNs
    || current.sha256 !== expected.sha256
  ) throw new RuntimeError('security_boundary_unavailable');
}

async function readTrustedHelper(
  path: string,
  requirePrivateSnapshot: boolean,
  expected?: Pick<TrustedHelperSource, 'size' | 'sha256'>,
): Promise<{ bytes: Buffer; fingerprint: TrustedHelper }> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const uid = BigInt(process.getuid?.() ?? -1);
    if (
      !before.isFile()
      || (requirePrivateSnapshot ? before.uid !== uid : before.uid !== 0n && before.uid !== uid)
      || (before.mode & 0o022n) !== 0n
      || (before.mode & 0o111n) === 0n
      || (requirePrivateSnapshot && (before.mode & 0o777n) !== 0o500n)
      || before.nlink !== 1n
      || before.size <= 0n
      || before.size > BigInt(MAX_HELPER_BYTES)
    ) throw new RuntimeError('security_boundary_unavailable');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.byteLength) !== after.size
    ) throw new RuntimeError('security_boundary_unavailable');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (
      expected
      && (bytes.byteLength !== expected.size || sha256 !== expected.sha256)
    ) throw new RuntimeError('security_boundary_unavailable');
    return {
      bytes,
      fingerprint: {
        path,
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeNs: after.mtimeNs,
        ctimeNs: after.ctimeNs,
        sha256,
      },
    };
  } finally {
    await handle.close();
  }
}

async function assertTrustedExecutable(path: string, requireRoot: boolean): Promise<void> {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  await access(path, fsConstants.X_OK);
  const canonical = await realpath(path);
  const info = await stat(canonical, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? -1);
  if (
    !info.isFile()
    || (requireRoot ? info.uid !== 0n : info.uid !== 0n && info.uid !== uid)
    || (info.mode & 0o022n) !== 0n
    || (info.mode & 0o111n) === 0n
  ) throw new RuntimeError('security_boundary_unavailable');
}

async function assertTrustedDirectory(path: string): Promise<void> {
  const info = await lstat(path, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? -1);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || (info.uid !== 0n && info.uid !== uid)
    || (info.mode & 0o022n) !== 0n
  ) throw new RuntimeError('security_boundary_unavailable');
}

async function assertPrivateRuntimeDirectories(
  spec: MacOsCoalitionSpec,
): Promise<{ home: string; temporary: string }> {
  const [home, temporary] = await Promise.all([
    canonicalPrivateDirectory(spec.runtimeHomeDirectory),
    canonicalPrivateDirectory(spec.runtimeTemporaryDirectory),
  ]);
  if (home === temporary || dirname(home) !== dirname(temporary)) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  await canonicalPrivateDirectory(dirname(home));
  return { home, temporary };
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  return canonical;
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

async function canonicalPrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  const canonical = await realpath(path);
  const info = await lstat(canonical, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? -1);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077n) !== 0n) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  return canonical;
}

async function prepareControlRoot(): Promise<string> {
  const root = await mkdtemp(CONTROL_ROOT_PREFIX);
  try {
    await chmod(root, 0o700);
    const canonical = await canonicalPrivateDirectory(root);
    if (canonical !== root || !isOwnedControlRoot(canonical)) {
      throw new RuntimeError('security_boundary_unavailable');
    }
    return canonical;
  } catch (error) {
    if (isOwnedControlRoot(root)) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function isOwnedControlRoot(path: string): boolean {
  return /^\/private\/tmp\/roundtable-guard-[A-Za-z0-9]+$/u.test(path);
}

async function listenForSingleConnection(
  path: string,
  onConnection: (socket: Socket) => void,
): Promise<SingleConnectionServer> {
  const accepted = deferred<Socket>();
  const closed = deferred<void>();
  const acceptedSocket: { current: Socket | null } = { current: null };
  void accepted.promise.catch(() => undefined);
  const server = createServer({ allowHalfOpen: false, pauseOnConnect: true }, (socket) => {
    if (accepted.settled) {
      socket.destroy();
      return;
    }
    acceptedSocket.current = socket;
    onConnection(socket);
    accepted.resolve(socket);
    server.close();
  });
  server.once('close', () => closed.resolve());
  const listening = deferred<void>();
  server.once('error', (error) => {
    listening.reject(error);
    accepted.reject(error);
  });
  server.listen(path, () => listening.resolve());
  try {
    await listening.promise;
    await chmod(path, 0o600);
    const info = await lstat(path, { bigint: true });
    if (!info.isSocket() || (info.mode & 0o077n) !== 0n) {
      throw new RuntimeError('security_boundary_unavailable');
    }
    return { path, server, connection: accepted.promise, closed: closed.promise };
  } catch (error) {
    const connected = acceptedSocket.current;
    connected?.destroy();
    if (connected && !closed.settled) {
      await closed.promise;
    } else {
      await closeServer(server);
    }
    throw error;
  }
}

async function readSocketHeader(
  socket: Socket,
  maximumBytes: number,
): Promise<{ line: string; remainder: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > maximumBytes) {
        finish(new Error('guardian_header_oversize'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const header = buffer.subarray(0, newline);
      if (header.includes(0x00) || header.includes(0x0d)) {
        finish(new Error('guardian_header_invalid'));
        return;
      }
      const remainder = Buffer.from(buffer.subarray(newline + 1));
      socket.pause();
      cleanup();
      resolve({ line: header.toString('utf8'), remainder });
    };
    const onError = (): void => finish(new Error('guardian_header_error'));
    const onEnd = (): void => finish(new Error('guardian_header_ended'));
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const finish = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    socket.resume();
  });
}

function providerConfiguration(env: NodeJS.ProcessEnv, stdin: string): Buffer {
  const entries: Buffer[] = [];
  for (const [name, value] of Object.entries(env).sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes('\u0000')) {
      throw new Error('guardian_environment_invalid');
    }
    entries.push(Buffer.from(`${name}=${value}\u0000`, 'utf8'));
  }
  const environment = Buffer.concat(entries);
  const input = Buffer.from(stdin, 'utf8');
  const header = Buffer.alloc(16);
  header.write('RTCFG001', 0, 'ascii');
  header.writeUInt32BE(environment.byteLength, 8);
  header.writeUInt32BE(input.byteLength, 12);
  return Buffer.concat([header, environment, input]);
}

async function inspectProcess(
  helper: TrustedHelper,
  pid: number,
): Promise<CoalitionProcessIdentity> {
  await assertTrustedHelperUnchanged(helper);
  const inspected = await runFixedCommand(helper.path, ['inspect', String(pid)], 3_000);
  if (inspected.exitCode !== 0 || inspected.stderr.length > 0) {
    throw new Error('guardian_inspect_failed');
  }
  const match = /^INSPECT ([1-9][0-9]{0,9}) ([0-9]{1,10}) ([1-9][0-9]{0,19}) ([1-9][0-9]{0,19})\n$/u
    .exec(inspected.stdout);
  if (!match) throw new Error('guardian_inspect_invalid');
  const result = {
    pid: parsePid(match[1]!),
    pidVersion: parsePidVersion(match[2]!),
    uniqueId: parseUint64(match[3]!),
    coalitionId: parseUint64(match[4]!),
  };
  return result;
}

function sameProcessIdentity(
  left: CoalitionProcessIdentity,
  right: CoalitionProcessIdentity,
): boolean {
  return left.pid === right.pid
    && left.pidVersion === right.pidVersion
    && left.uniqueId === right.uniqueId
    && left.coalitionId === right.coalitionId;
}

function parsePid(value: string): number {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
    throw new Error('guardian_pid_invalid');
  }
  return pid;
}

function parsePidVersion(value: string): number {
  const pidVersion = Number(value);
  if (!Number.isSafeInteger(pidVersion) || pidVersion < 0 || pidVersion > 4_294_967_295) {
    throw new Error('guardian_pidversion_invalid');
  }
  return pidVersion;
}

function parseUint64(value: string): string {
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_UINT64) throw new Error('guardian_uint64_invalid');
  return parsed.toString(10);
}

function signalName(signalNumber: number): NodeJS.Signals | null {
  if (signalNumber === 0) return null;
  const match = Object.entries(osConstants.signals).find(([, value]) => value === signalNumber);
  return match?.[0] as NodeJS.Signals | undefined ?? null;
}

async function writeSocket(socket: Socket, payload: Buffer): Promise<void> {
  if (!socket.writable || socket.destroyed) throw new Error('guardian_socket_unwritable');
  await new Promise<void>((resolve, reject) => {
    socket.write(payload, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function launchdServiceAbsent(
  label: string,
  uid: number,
  serviceTarget: string,
): Promise<boolean> {
  const result = await runFixedCommand(LAUNCHCTL, ['print', serviceTarget], 3_000);
  return result.exitCode === 113
    && result.stdout.length === 0
    && result.stderr === [
      'Bad request.',
      `Could not find service "${label}" in domain for user gui: ${uid}`,
      '',
    ].join('\n');
}

function isLaunchdBootoutAbsent(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): boolean {
  return result.exitCode === 3
    && result.stdout.length === 0
    && result.stderr === 'Boot-out failed: 3: No such process\n';
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function launchdPlist(input: {
  label: string;
  helperPath: string;
  controlPath: string;
  stdoutPath: string;
  stderrPath: string;
  nonceSecretPath: string;
  cwd: string;
  command: string;
  args: readonly string[];
  exitTimeOutSeconds: number;
}): string {
  const programArguments = [
    input.helperPath,
    'run',
    input.controlPath,
    input.stdoutPath,
    input.stderrPath,
    input.nonceSecretPath,
    input.cwd,
    input.command,
    ...input.args,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '<key>Label</key>',
    `<string>${xmlEscape(input.label)}</string>`,
    '<key>Program</key>',
    `<string>${xmlEscape(input.helperPath)}</string>`,
    '<key>ProgramArguments</key>',
    '<array>',
    ...programArguments.map((argument) => `<string>${xmlEscape(argument)}</string>`),
    '</array>',
    '<key>RunAtLoad</key>',
    '<true/>',
    '<key>KeepAlive</key>',
    '<false/>',
    '<key>AbandonProcessGroup</key>',
    '<false/>',
    '<key>ProcessType</key>',
    '<string>Background</string>',
    '<key>Umask</key>',
    '<integer>63</integer>',
    '<key>ExitTimeOut</key>',
    `<integer>${input.exitTimeOutSeconds}</integer>`,
    '<key>StandardOutPath</key>',
    `<string>${NULL_DEVICE}</string>`,
    '<key>StandardErrorPath</key>',
    `<string>${NULL_DEVICE}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function launchdCleanupPlist(input: {
  label: string;
  helperPath: string;
  helperArgs: readonly string[];
  stdoutPath: string;
  stderrPath: string;
  exitTimeOutSeconds: number;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '<key>Label</key>',
    `<string>${xmlEscape(input.label)}</string>`,
    '<key>Program</key>',
    `<string>${xmlEscape(input.helperPath)}</string>`,
    '<key>ProgramArguments</key>',
    '<array>',
    ...[input.helperPath, ...input.helperArgs]
      .map((argument) => `<string>${xmlEscape(argument)}</string>`),
    '</array>',
    '<key>RunAtLoad</key>',
    '<true/>',
    '<key>KeepAlive</key>',
    '<false/>',
    '<key>AbandonProcessGroup</key>',
    '<false/>',
    '<key>ProcessType</key>',
    '<string>Background</string>',
    '<key>Umask</key>',
    '<integer>63</integer>',
    '<key>ExitTimeOut</key>',
    `<integer>${input.exitTimeOutSeconds}</integer>`,
    '<key>StandardOutPath</key>',
    `<string>${xmlEscape(input.stdoutPath)}</string>`,
    '<key>StandardErrorPath</key>',
    `<string>${xmlEscape(input.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function xmlEscape(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error('guardian_plist_invalid');
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function assertPrivateFile(path: string): Promise<void> {
  const info = await lstat(path, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? -1);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077n) !== 0n) {
    throw new RuntimeError('security_boundary_unavailable');
  }
}

async function writePrivateNonceSecret(path: string, nonce: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(nonce)) {
    throw new RuntimeError('security_boundary_unavailable');
  }
  const handle = await open(
    path,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(Buffer.from(nonce, 'ascii'));
    await handle.chmod(0o400);
    await handle.sync();
    const info = await handle.stat({ bigint: true });
    const uid = BigInt(process.getuid?.() ?? -1);
    if (
      !info.isFile()
      || info.uid !== uid
      || (info.mode & 0o777n) !== 0o400n
      || info.nlink !== 1n
      || info.size !== 64n
    ) throw new RuntimeError('security_boundary_unavailable');
  } finally {
    await handle.close();
  }
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new RuntimeError('security_boundary_unavailable');
}

async function runFixedCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<FixedCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let forcedFailure = false;
    let processClosed = false;
    let observed = 0;
    let killWaitTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolvePromise) => {
      resolveClosed = resolvePromise;
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(command, [...args], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let processStarted = child.pid !== undefined;
    child.once('spawn', () => {
      processStarted = true;
    });
    const timer = setTimeout(() => {
      abortChild();
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => consume(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => consume(stderr, chunk));
    child.once('error', () => {
      if (child.pid) abortChild();
      else {
        forcedFailure = true;
        markClosed();
        finish(null);
      }
    });
    child.once('close', (exitCode) => {
      markClosed();
      finish(forcedFailure ? null : exitCode);
    });

    function consume(target: Buffer[], chunk: Buffer): void {
      observed += chunk.byteLength;
      if (observed > FIXED_COMMAND_OUTPUT_LIMIT) {
        abortChild();
        return;
      }
      if (forcedFailure) return;
      target.push(chunk);
    }

    function abortChild(): void {
      if (settled || forcedFailure) return;
      forcedFailure = true;
      const killRequested = child.kill('SIGKILL');
      if (!killRequested && child.pid === undefined) markClosed();
      killWaitTimer = setTimeout(() => finish(null), FIXED_COMMAND_KILL_WAIT_MS);
      killWaitTimer.unref();
    }

    function markClosed(): void {
      if (processClosed) return;
      processClosed = true;
      resolveClosed();
    }

    function finish(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killWaitTimer) clearTimeout(killWaitTimer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        processStarted,
        processClosed,
        closed,
      });
    }
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function deferred<T>(): {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const result = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    settled: false,
    resolve(value: T): void {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject(error: unknown): void {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(error);
    },
  };
  return result;
}
