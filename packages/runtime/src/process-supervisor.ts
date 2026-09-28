import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute, join } from 'node:path';

import { RuntimeError } from './errors.js';
import type { RuntimeLimits, RuntimeStopReason, TreeTermination } from './types.js';

export type ProcessTreeTerminationLimits = Pick<
  RuntimeLimits,
  'terminateGraceMs' | 'killConfirmMs'
>;

export type TrackedProcessTree = {
  readonly pid: number;
  readonly ready: Promise<boolean>;
  terminate(limits?: Partial<ProcessTreeTerminationLimits>): Promise<TreeTermination>;
  dispose(): void;
};

const DEFAULT_TREE_TERMINATION_LIMITS: Readonly<ProcessTreeTerminationLimits> = Object.freeze({
  terminateGraceMs: 3_000,
  killConfirmMs: 2_000,
});
const PROCESS_TRACKER_READY_TIMEOUT_MS = 1_000;
const PROCESS_TRACKER_READY_POLL_MS = 25;

export function trackProcessTree(pid: number): TrackedProcessTree {
  validateTrackedPid(pid);
  const tracker = process.platform === 'win32' ? null : new PosixProcessTracker(pid);
  tracker?.start();
  const ready = tracker
    ? tracker.waitUntilBound(
      PROCESS_TRACKER_READY_TIMEOUT_MS,
      PROCESS_TRACKER_READY_POLL_MS,
    )
    : Promise.resolve(Boolean(process.env.SystemRoot ?? process.env.WINDIR));
  let disposed = false;
  let termination: Promise<TreeTermination> | null = null;
  return {
    pid,
    ready,
    terminate: (overrides) => {
      if (disposed && !termination) return Promise.resolve('failed');
      const limits = resolveTreeTerminationLimits(overrides);
      termination ??= terminateProcessTree(pid, limits, tracker).then(
        (result) => {
          if (result === 'confirmed') {
            tracker?.stop();
            disposed = true;
          } else {
            termination = null;
          }
          return result;
        },
        (error: unknown) => {
          termination = null;
          throw error;
        },
      );
      return termination;
    },
    dispose: () => {
      if (termination) return;
      disposed = true;
      tracker?.stop();
    },
  };
}

export async function terminateTrackedProcessTree(
  pid: number,
  limits?: Partial<ProcessTreeTerminationLimits>,
): Promise<TreeTermination> {
  const tracker = trackProcessTree(pid);
  try {
    return await tracker.terminate(limits);
  } finally {
    tracker.dispose();
  }
}

export type SupervisedProcessEvent =
  | { kind: 'started'; pid: number }
  | { kind: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'output_truncated'; stream: 'stdout' | 'stderr'; observedBytes: number }
  | { kind: 'stop_requested'; reason: RuntimeStopReason };

export type SupervisedProcessSpec = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  secrets: readonly string[];
  limits: Pick<
    RuntimeLimits,
    | 'totalTimeoutMs'
    | 'idleTimeoutMs'
    | 'terminateGraceMs'
    | 'killConfirmMs'
    | 'maxStdoutBytes'
    | 'maxStderrBytes'
    | 'maxOutputChunkBytes'
  >;
  onEvent?: (event: SupervisedProcessEvent) => void;
};

export type SupervisedProcessResult = {
  status: 'exited' | 'stopped' | 'timed_out' | 'idle_timed_out' | 'spawn_failed' | 'termination_failed';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  treeTermination: TreeTermination;
};

export type SupervisedProcess = {
  pid: number | null;
  completion: Promise<SupervisedProcessResult>;
  stop(reason?: 'requested' | 'shutdown'): Promise<TreeTermination>;
};

export function startSupervisedProcess(spec: SupervisedProcessSpec): SupervisedProcess {
  validateSupervisedProcessSpec(spec);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
    });
  } catch {
    return failedSpawnResult();
  }

  const pid = child.pid ?? null;
  const stdout = new BoundedOutput(spec.limits.maxStdoutBytes, spec.limits.maxOutputChunkBytes);
  const stderr = new BoundedOutput(spec.limits.maxStderrBytes, spec.limits.maxOutputChunkBytes);
  const emitters = {
    stdout: new RedactingEmitter(
      spec.secrets,
      spec.limits.maxOutputChunkBytes,
      (text) => safeEmit({ kind: 'output', stream: 'stdout', text }),
    ),
    stderr: new RedactingEmitter(
      spec.secrets,
      spec.limits.maxOutputChunkBytes,
      (text) => safeEmit({ kind: 'output', stream: 'stderr', text }),
    ),
  };
  let stopReason: RuntimeStopReason | null = null;
  let closed = false;
  let spawnFailed = false;
  let resolveExit: ((value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
  let terminationPromise: Promise<TreeTermination> | null = null;
  let terminationConfirmed = false;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const processTracker = pid !== null && process.platform !== 'win32'
    ? new PosixProcessTracker(pid)
    : null;
  processTracker?.start();

  const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });

  child.once('error', () => {
    spawnFailed = pid === null;
    settleExit({ exitCode: null, signal: null });
  });
  child.once('exit', (exitCode, signal) => {
    settleExit({ exitCode, signal });
  });
  child.stdin.on('error', () => undefined);
  child.stdout.on('data', (chunk: Buffer) => consumeOutput('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => consumeOutput('stderr', chunk));

  if (pid !== null) safeEmit({ kind: 'started', pid });
  if (spec.stdin.length > 0) child.stdin.write(spec.stdin, 'utf8');
  child.stdin.end();
  totalTimer = setTimeout(() => {
    void requestTermination('total_timeout');
  }, spec.limits.totalTimeoutMs);
  totalTimer.unref();
  armIdleTimer();

  const completion = (async (): Promise<SupervisedProcessResult> => {
    const result = await exitPromise;
    clearTimers();
    const treeTermination = await requestResidualTermination();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    emitters.stdout.finish();
    emitters.stderr.finish();
    const status = spawnFailed
      ? 'spawn_failed'
      : treeTermination === 'failed'
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
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: redact(stdout.finish(), spec.secrets),
      stderr: redact(stderr.finish(), spec.secrets),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      treeTermination,
    };
  })();

  return {
    pid,
    completion,
    stop: async (reason = 'requested') => {
      if (terminationConfirmed) return 'confirmed';
      return requestTermination(reason);
    },
  };

  function consumeOutput(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    armIdleTimer();
    const collector = stream === 'stdout' ? stdout : stderr;
    const emitter = stream === 'stdout' ? emitters.stdout : emitters.stderr;
    const wasTruncated = collector.truncated;
    for (const text of collector.push(chunk)) emitter.push(text);
    if (!wasTruncated && collector.truncated) {
      emitter.finish();
      safeEmit({
        kind: 'output_truncated',
        stream,
        observedBytes: collector.observedBytes,
      });
    }
  }

  function settleExit(result: { exitCode: number | null; signal: NodeJS.Signals | null }): void {
    if (closed) return;
    closed = true;
    resolveExit?.(result);
  }

  function safeEmit(event: SupervisedProcessEvent): void {
    try {
      spec.onEvent?.(event);
    } catch {
      // An observer is not allowed to interfere with process ownership.
    }
  }

  function clearTimers(): void {
    if (totalTimer) clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    totalTimer = null;
    idleTimer = null;
  }

  function armIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void requestTermination('idle_timeout');
    }, spec.limits.idleTimeoutMs);
    idleTimer.unref();
  }

  function requestTermination(reason: RuntimeStopReason): Promise<TreeTermination> {
    if (!stopReason) {
      stopReason = reason;
      safeEmit({ kind: 'stop_requested', reason });
    }
    clearTimers();
    return startTermination(() => terminateProcessTree(pid, spec.limits, processTracker));
  }

  function requestResidualTermination(): Promise<TreeTermination> {
    if (terminationConfirmed) return Promise.resolve('confirmed');
    return startTermination(() => terminateResidualTree(pid, spec.limits, processTracker));
  }

  function startTermination(
    terminate: () => Promise<TreeTermination>,
  ): Promise<TreeTermination> {
    if (terminationConfirmed) return Promise.resolve('confirmed');
    if (terminationPromise) return terminationPromise;
    const operation = terminate().then(
      (treeTermination) => {
        if (treeTermination === 'confirmed') {
          terminationConfirmed = true;
          processTracker?.stop();
        } else {
          settleExit({ exitCode: null, signal: null });
        }
        return treeTermination;
      },
      (error: unknown) => {
        settleExit({ exitCode: null, signal: null });
        throw error;
      },
    ).finally(() => {
      if (terminationPromise === operation) terminationPromise = null;
    });
    terminationPromise = operation;
    return operation;
  }
}

export class BoundedOutput {
  readonly #decoder = new StringDecoder('utf8');
  readonly #chunks: string[] = [];
  #retainedBytes = 0;
  #finished = false;
  observedBytes = 0;
  truncated = false;

  constructor(
    private readonly maxBytes: number,
    private readonly maxChunkBytes: number,
  ) {}

  push(chunk: Buffer): string[] {
    if (this.#finished) return [];
    this.observedBytes += chunk.byteLength;
    const remaining = Math.max(0, this.maxBytes - this.#retainedBytes);
    const retained = chunk.subarray(0, remaining);
    if (retained.byteLength < chunk.byteLength) this.truncated = true;
    this.#retainedBytes += retained.byteLength;
    const output: string[] = [];
    for (let offset = 0; offset < retained.byteLength; offset += this.maxChunkBytes) {
      const text = this.#decoder.write(retained.subarray(offset, offset + this.maxChunkBytes));
      if (text.length > 0) {
        this.#chunks.push(text);
        output.push(text);
      }
    }
    return output;
  }

  finish(): string {
    if (!this.#finished) {
      this.#finished = true;
      const tail = this.#decoder.end();
      if (tail.length > 0) this.#chunks.push(tail);
    }
    return this.#chunks.join('');
  }
}

export class RedactingEmitter {
  #pending = '';
  #finished = false;

  constructor(
    private readonly secrets: readonly string[],
    private readonly maxChunkBytes: number,
    private readonly emit: (text: string) => void,
  ) {}

  push(text: string): void {
    if (this.#finished || text.length === 0) return;
    if (this.secrets.length === 0) {
      this.#emitBounded(text);
      return;
    }
    this.#pending += text;
    this.#flushSafePrefix();
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#pending.length > 0) this.#emitBounded(redact(this.#pending, this.secrets));
    this.#pending = '';
  }

  #flushSafePrefix(): void {
    for (;;) {
      const match = earliestSecretMatch(this.#pending, this.secrets);
      if (match) {
        const prefix = this.#pending.slice(0, match.index);
        if (prefix.length > 0) this.#emitBounded(prefix);
        if (secretMatchMayExtend(this.#pending, match, this.secrets)) {
          this.#pending = this.#pending.slice(match.index);
          return;
        }
        this.#emitBounded('[REDACTED]');
        this.#pending = this.#pending.slice(match.index + match.secret.length);
        continue;
      }
      const retained = longestSecretPrefixSuffix(this.#pending, this.secrets);
      const safeLength = this.#pending.length - retained;
      if (safeLength > 0) this.#emitBounded(this.#pending.slice(0, safeLength));
      this.#pending = this.#pending.slice(safeLength);
      return;
    }
  }

  #emitBounded(text: string): void {
    let chunk = '';
    let chunkBytes = 0;
    for (const character of text) {
      const characterBytes = Buffer.byteLength(character, 'utf8');
      if (chunkBytes + characterBytes > this.maxChunkBytes && chunk.length > 0) {
        this.emit(chunk);
        chunk = '';
        chunkBytes = 0;
      }
      chunk += character;
      chunkBytes += characterBytes;
    }
    if (chunk.length > 0) this.emit(chunk);
  }
}

export function redact(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length >= 8) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

type PosixProcessRecord = {
  pid: number;
  parentPid: number;
  processGroupId: number;
  identity: string;
};

class PosixProcessSampler {
  #latest: Map<number, PosixProcessRecord> | null = null;
  #sampledAt = 0;
  #pending: Promise<Map<number, PosixProcessRecord> | null> | null = null;

  sample(force = false): Promise<Map<number, PosixProcessRecord> | null> {
    if (!force && this.#latest && Date.now() - this.#sampledAt <= 75) {
      return Promise.resolve(this.#latest);
    }
    this.#pending ??= readPosixProcessTable().then((records) => {
      if (records) {
        this.#latest = records;
        this.#sampledAt = Date.now();
      }
      return records;
    }).finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }
}

const POSIX_PROCESS_SAMPLER = new PosixProcessSampler();

class PosixProcessTracker {
  readonly #tracked = new Map<number, string>();
  #latest = new Map<number, PosixProcessRecord>();
  #rootIdentity: string | null = null;
  #capturePromise: Promise<boolean> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(private readonly rootPid: number) {}

  start(): void {
    void this.capture(true);
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  capture(force = false): Promise<boolean> {
    this.#capturePromise ??= this.#captureOnce(force).finally(() => {
      this.#capturePromise = null;
    });
    return this.#capturePromise;
  }

  hasLiveProcesses(): boolean {
    return this.#tracked.size > 0;
  }

  async waitUntilBound(timeoutMs: number, pollMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (!(await this.capture(true))) return false;
      if (this.isBoundToRootIdentity() && this.hasLiveProcesses()) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    } while (Date.now() <= deadline);
    return false;
  }

  isBoundToRootIdentity(): boolean {
    return this.#rootIdentity !== null;
  }

  async signalProcessGroup(signal: NodeJS.Signals): Promise<boolean> {
    if (!(await this.capture(true)) || this.#rootIdentity === null) return false;
    const root = this.#latest.get(this.rootPid);
    if (root && root.identity !== this.#rootIdentity) {
      // The original process group is gone and its numeric leader PID was reused.
      return true;
    }
    const members = [...this.#latest.values()].filter((record) => (
      record.processGroupId === this.rootPid
    ));
    if (members.length === 0) return true;
    if (members.some((record) => this.#tracked.get(record.pid) !== record.identity)) {
      return false;
    }
    return sendPosixGroupSignal(this.rootPid, signal);
  }

  async signal(signal: NodeJS.Signals): Promise<boolean> {
    if (!(await this.capture(true))) return false;
    let succeeded = true;
    const pids = [...this.#tracked.keys()].sort((left, right) => right - left);
    for (const pid of pids) {
      const expectedIdentity = this.#tracked.get(pid);
      const current = this.#latest.get(pid);
      if (!expectedIdentity || current?.identity !== expectedIdentity) continue;
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (!isNoSuchProcess(error)) succeeded = false;
      }
    }
    return succeeded;
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (!(await this.capture())) return false;
      if (!this.hasLiveProcesses()) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return (await this.capture()) && !this.hasLiveProcesses();
  }

  async #captureOnce(force: boolean): Promise<boolean> {
    const records = await POSIX_PROCESS_SAMPLER.sample(force);
    if (!records) return false;
    this.#latest = records;

    for (const [pid, identity] of this.#tracked) {
      if (records.get(pid)?.identity !== identity) this.#tracked.delete(pid);
    }

    const root = records.get(this.rootPid);
    if (root && this.#rootIdentity === null) this.#rootIdentity = root.identity;
    const rootMatches = root !== undefined && root.identity === this.#rootIdentity;
    if (rootMatches) this.#tracked.set(root.pid, root.identity);
    if (rootMatches || (root === undefined && this.#rootIdentity !== null)) {
      for (const record of records.values()) {
        if (record.processGroupId !== this.rootPid) continue;
        this.#tracked.set(record.pid, record.identity);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records.values()) {
        if (!this.#tracked.has(record.pid) && this.#tracked.has(record.parentPid)) {
          this.#tracked.set(record.pid, record.identity);
          changed = true;
        }
      }
    }
    return true;
  }

  #schedule(): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.capture().finally(() => this.#schedule());
    }, 100);
    this.#timer.unref();
  }
}

async function readPosixProcessTable(): Promise<Map<number, PosixProcessRecord> | null> {
  return new Promise((resolve) => {
    let settled = false;
    let observedBytes = 0;
    const chunks: Buffer[] = [];
    let processList: ReturnType<typeof spawn>;
    try {
      processList = spawn(
        '/bin/ps',
        ['-axo', 'pid=,ppid=,pgid=,lstart='],
        {
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          shell: false,
        },
      );
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      processList.kill('SIGKILL');
      finish(null);
    }, 1_000);
    timer.unref();
    processList.stdout?.on('data', (chunk: Buffer) => {
      observedBytes += chunk.byteLength;
      if (observedBytes > 1024 * 1024) {
        processList.kill('SIGKILL');
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    processList.once('error', () => finish(null));
    processList.once('close', (exitCode) => {
      finish(exitCode === 0 ? parsePosixProcessTable(Buffer.concat(chunks).toString('utf8')) : null);
    });

    function finish(value: Map<number, PosixProcessRecord> | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
  });
}

function parsePosixProcessTable(value: string): Map<number, PosixProcessRecord> {
  const records = new Map<number, PosixProcessRecord>();
  for (const line of value.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const processGroupId = Number(match[3]);
    const identity = match[4];
    if (
      Number.isSafeInteger(pid)
      && pid > 0
      && Number.isSafeInteger(parentPid)
      && parentPid >= 0
      && Number.isSafeInteger(processGroupId)
      && processGroupId > 0
      && identity
    ) {
      records.set(pid, { pid, parentPid, processGroupId, identity });
    }
  }
  return records;
}

async function terminateResidualTree(
  pid: number | null,
  limits: Pick<RuntimeLimits, 'terminateGraceMs' | 'killConfirmMs'>,
  tracker: PosixProcessTracker | null,
): Promise<TreeTermination> {
  if (pid === null) return 'confirmed';
  if (tracker) {
    const captured = await tracker.capture(true);
    if (!captured || !tracker.isBoundToRootIdentity()) return 'failed';
    if (!tracker.hasLiveProcesses()) return 'confirmed';
  } else if (!(await processTreeAlive(pid))) {
    return 'confirmed';
  }
  return terminateProcessTree(pid, limits, tracker);
}

async function terminateProcessTree(
  pid: number | null,
  limits: Pick<RuntimeLimits, 'terminateGraceMs' | 'killConfirmMs'>,
  tracker: PosixProcessTracker | null,
): Promise<TreeTermination> {
  if (pid === null) return 'confirmed';
  if (process.platform === 'win32') {
    await runTaskkill(pid, false);
    if (await waitForTreeExit(pid, limits.terminateGraceMs)) return 'confirmed';
    await runTaskkill(pid, true);
    return (await waitForTreeExit(pid, limits.killConfirmMs)) ? 'confirmed' : 'failed';
  }

  const captured = tracker ? await tracker.capture(true) : true;
  if (tracker && (!captured || !tracker.isBoundToRootIdentity())) return 'failed';
  if (tracker?.hasLiveProcesses() === false) return 'confirmed';
  const groupTerminated = tracker
    ? await tracker.signalProcessGroup('SIGTERM')
    : sendPosixGroupSignal(pid, 'SIGTERM');
  const descendantsTerminated = tracker ? await tracker.signal('SIGTERM') : true;
  if (!captured || !groupTerminated || !descendantsTerminated) return 'failed';
  if (tracker
    ? await tracker.waitForExit(limits.terminateGraceMs)
    : await waitForTreeExit(pid, limits.terminateGraceMs)) return 'confirmed';
  const groupKilled = tracker
    ? await tracker.signalProcessGroup('SIGKILL')
    : sendPosixGroupSignal(pid, 'SIGKILL');
  const descendantsKilled = tracker ? await tracker.signal('SIGKILL') : true;
  if (!groupKilled || !descendantsKilled) return 'failed';
  return (tracker
    ? await tracker.waitForExit(limits.killConfirmMs)
    : await waitForTreeExit(pid, limits.killConfirmMs)) ? 'confirmed' : 'failed';
}

function sendPosixGroupSignal(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return isNoSuchProcess(error);
  }
}

async function processTreeAlive(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !isNoSuchProcess(error);
    }
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

async function waitForTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await processTreeAlive(pid))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return !(await processTreeAlive(pid));
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) return;
  const command = join(systemRoot, 'System32', 'taskkill.exe');
  const args = windowsTaskkillArguments(pid, force);
  await new Promise<void>((resolve) => {
    const taskkill = spawn(command, args, {
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: join(systemRoot, 'System32'),
      },
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    const timer = setTimeout(() => {
      taskkill.kill('SIGKILL');
      resolve();
    }, 2_000);
    timer.unref();
    taskkill.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
    taskkill.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function windowsTaskkillArguments(pid: number, force: boolean): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid_process_id');
  return ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
}

function failedSpawnResult(): SupervisedProcess {
  const completion = Promise.resolve<SupervisedProcessResult>({
    status: 'spawn_failed',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    treeTermination: 'confirmed',
  });
  return {
    pid: null,
    completion,
    stop: async () => 'confirmed',
  };
}

export function validateSupervisedProcessSpec(spec: SupervisedProcessSpec): void {
  const numbers = Object.values(spec.limits);
  const environmentBytes = Object.entries(spec.env).reduce((total, [name, value]) => (
    total + Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value ?? '', 'utf8')
  ), 0);
  const secretBytes = spec.secrets.reduce((total, secret) => (
    total + Buffer.byteLength(secret, 'utf8')
  ), 0);
  if (
    spec.command.length === 0
    || !isAbsolute(spec.command)
    || !isAbsolute(spec.cwd)
    || spec.args.length > 128
    || spec.args.some((argument) => Buffer.byteLength(argument, 'utf8') > 128 * 1024)
    || Buffer.byteLength(spec.stdin, 'utf8') > 128 * 1024
    || Object.keys(spec.env).length > 64
    || environmentBytes > 256 * 1024
    || spec.secrets.length > 32
    || secretBytes > 64 * 1024
    || spec.secrets.some((secret) => (
      typeof secret !== 'string'
      || secret.length < 8
      || /[\u0000\r\n]/u.test(secret)
    ))
    || numbers.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || spec.limits.maxOutputChunkBytes > Math.min(
      spec.limits.maxStdoutBytes,
      spec.limits.maxStderrBytes,
    )
  ) {
    throw new Error('invalid_process_spec');
  }
}

function resolveTreeTerminationLimits(
  overrides: Partial<ProcessTreeTerminationLimits> | undefined,
): ProcessTreeTerminationLimits {
  const limits = { ...DEFAULT_TREE_TERMINATION_LIMITS, ...overrides };
  if (
    !Number.isSafeInteger(limits.terminateGraceMs)
    || limits.terminateGraceMs < 25
    || limits.terminateGraceMs > 10_000
    || !Number.isSafeInteger(limits.killConfirmMs)
    || limits.killConfirmMs < 25
    || limits.killConfirmMs > 10_000
  ) {
    throw new RuntimeError('execution_invalid');
  }
  return limits;
}

function validateTrackedPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new RuntimeError('execution_invalid');
  }
}

function earliestSecretMatch(
  value: string,
  secrets: readonly string[],
): { index: number; secret: string } | null {
  let found: { index: number; secret: string } | null = null;
  for (const secret of secrets) {
    const index = value.indexOf(secret);
    if (
      index >= 0
      && (
        !found
        || index < found.index
        || (index === found.index && secret.length > found.secret.length)
      )
    ) found = { index, secret };
  }
  return found;
}

function longestSecretPrefixSuffix(value: string, secrets: readonly string[]): number {
  let longest = 0;
  for (const secret of secrets) {
    const maximum = Math.min(value.length, secret.length - 1);
    for (let length = maximum; length > longest; length -= 1) {
      if (value.endsWith(secret.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

function secretMatchMayExtend(
  value: string,
  match: { index: number; secret: string },
  secrets: readonly string[],
): boolean {
  const candidate = value.slice(match.index);
  return secrets.some((secret) => (
    secret.length > match.secret.length
    && secret.startsWith(match.secret)
    && secret.startsWith(candidate)
  ));
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
