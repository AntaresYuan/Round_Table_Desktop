import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareContainedProviderLaunch } from './containment.js';
import { prepareRuntimeEnvironment } from './environment.js';
import { RuntimeError } from './errors.js';
import { assertExecutableUnchanged } from './executable.js';
import { startMacOsCoalitionSupervisedProcess } from './macos-coalition-supervisor.js';
import {
  startSupervisedProcess,
  type SupervisedProcess,
  type SupervisedProcessEvent,
} from './process-supervisor.js';
import { buildProviderLaunchPlan, providerFixedEnvironment } from './providers.js';
import type {
  RuntimeEvent,
  RuntimeEventUpdate,
  RuntimeExecution,
  RuntimeExecutionInput,
  RuntimeExecutionResult,
  RuntimeLimits,
  RuntimeStopResult,
  RuntimeTerminalStatus,
} from './types.js';
import {
  assertWorkspaceIdentity,
  diffWorkspaceSnapshots,
  isPathWithinWorkspace,
  scanWorkspace,
} from './workspace.js';

export const DEFAULT_RUNTIME_LIMITS: Readonly<RuntimeLimits> = Object.freeze({
  totalTimeoutMs: 30 * 60 * 1_000,
  idleTimeoutMs: 5 * 60 * 1_000,
  terminateGraceMs: 3_000,
  killConfirmMs: 2_000,
  maxStdoutBytes: 2 * 1024 * 1024,
  maxStderrBytes: 512 * 1024,
  maxOutputChunkBytes: 16 * 1024,
  maxScanFiles: 5_000,
  maxScanFileBytes: 2 * 1024 * 1024,
  maxScanTotalBytes: 64 * 1024 * 1024,
  maxScanDepth: 20,
});

type ActiveExecution = {
  process: SupervisedProcess;
  completion: Promise<RuntimeExecutionResult>;
  terminalResult: RuntimeExecutionResult | null;
  stopOperation: Promise<RuntimeStopResult> | null;
};

const RUNTIME_CODE_ROOT = fileURLToPath(new URL('../', import.meta.url));

export type LocalAgentRuntimeOptions = {
  trustedCodeRoots?: readonly string[] | undefined;
};

export class LocalAgentRuntime {
  readonly #knownExecutions = new Set<string>();
  readonly #pendingStarts = new Set<Promise<void>>();
  readonly #activeExecutions = new Map<string, ActiveExecution>();
  readonly #terminalExecutions = new Map<string, RuntimeExecutionResult>();
  readonly #trustedCodeRoots: readonly string[];
  #shuttingDown = false;
  #shutdownOperation: Promise<void> | null = null;

  constructor(options: LocalAgentRuntimeOptions = {}) {
    const roots = [RUNTIME_CODE_ROOT, ...(options.trustedCodeRoots ?? [])];
    if (
      roots.length > 8
      || roots.some((root) => !isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root))
    ) throw new RuntimeError('security_boundary_unavailable');
    this.#trustedCodeRoots = [...new Set(roots)];
  }

  async start(input: RuntimeExecutionInput): Promise<RuntimeExecution> {
    validateExecutionId(input.executionId);
    if (this.#shuttingDown) throw new RuntimeError('runtime_shutting_down');
    if (this.#knownExecutions.has(input.executionId)) {
      throw new RuntimeError('execution_duplicate');
    }
    this.#knownExecutions.add(input.executionId);
    const emit = createEventEmitter(input.executionId, input.onEvent);
    let settlePendingStart!: () => void;
    const pendingStart = new Promise<void>((resolve) => {
      settlePendingStart = resolve;
    });
    this.#pendingStarts.add(pendingStart);
    try {
      const limits = resolveRuntimeLimits(input.limits);
      await assertWorkspaceIdentity(input.workspace);
      if (input.executable.provider !== input.provider) {
        throw new RuntimeError('executable_invalid');
      }
      await assertExecutableUnchanged(input.executable);
      if (
        !isAbsolute(input.executable.path)
        || isPathWithinWorkspace(input.workspace.root, input.executable.path)
      ) {
        throw new RuntimeError('executable_invalid');
      }

      const preparedEnvironment = await prepareRuntimeEnvironment(
        input.provider,
        input.executable,
        input.environment,
        providerFixedEnvironment(input.provider),
      );
      if (
        isPathWithinWorkspace(input.workspace.root, preparedEnvironment.homeDirectory)
        || isPathWithinWorkspace(input.workspace.root, preparedEnvironment.temporaryDirectory)
      ) {
        throw new RuntimeError('execution_invalid');
      }
      const plan = await buildProviderLaunchPlan(
        input.provider,
        input.workspace.root,
        input.prompt,
        input.model,
        preparedEnvironment.temporaryDirectory,
        preparedEnvironment.hostHomeDirectory,
      );
      const containedLaunch = await prepareContainedProviderLaunch({
        providerExecutable: input.executable.path,
        providerArgs: plan.args,
        workspaceRoot: input.workspace.root,
        runtimeHomeDirectory: preparedEnvironment.homeDirectory,
        runtimeTemporaryDirectory: preparedEnvironment.temporaryDirectory,
        hostHomeDirectory: preparedEnvironment.hostHomeDirectory,
      });

      const before = await scanWorkspace(input.workspace, limits);
      if (before.truncated) throw new RuntimeError('workspace_scan_failed');
      await assertWorkspaceIdentity(input.workspace);
      await assertExecutableUnchanged(input.executable);
      if (this.#shuttingDown) throw new RuntimeError('runtime_shutting_down');
      emit({ kind: 'execution.starting', provider: input.provider });
      if (this.#shuttingDown) throw new RuntimeError('runtime_shutting_down');

      const pendingProcessEvents: SupervisedProcessEvent[] = [];
      let processEventSink: ((event: SupervisedProcessEvent) => void) | null = null;
      const processSpec = {
        command: containedLaunch.command,
        args: containedLaunch.args,
        cwd: input.workspace.root,
        env: preparedEnvironment.env,
        stdin: plan.stdin,
        secrets: preparedEnvironment.secrets,
        limits,
        onEvent: (event) => {
          if (processEventSink) processEventSink(event);
          else pendingProcessEvents.push(event);
        },
      } satisfies Parameters<typeof startSupervisedProcess>[0];
      const supervisedProcess = process.platform === 'darwin'
        ? await startMacOsCoalitionSupervisedProcess({
          ...processSpec,
          runtimeHomeDirectory: preparedEnvironment.homeDirectory,
          runtimeTemporaryDirectory: preparedEnvironment.temporaryDirectory,
          trustedCodeRoots: this.#trustedCodeRoots,
        })
        : startSupervisedProcess(processSpec);

      const completion = this.#completeExecution(
        input, limits,
        before,
        supervisedProcess,
        emit,
      );
      const active: ActiveExecution = {
        process: supervisedProcess,
        completion,
        terminalResult: null,
        stopOperation: null,
      };
      this.#activeExecutions.set(input.executionId, active);
      processEventSink = (event) => {
        if (event.kind === 'started') emit({ kind: 'process.started', pid: event.pid });
        else emitProcessEvent(event, emit);
      };
      for (const event of pendingProcessEvents) processEventSink(event);
      void completion.then(
        (result) => {
          active.terminalResult = result;
          if (result.treeTermination === 'confirmed') {
            this.#deleteActiveExecution(input.executionId, active);
          }
        },
        () => {
          // An unexpected completion failure cannot prove that the process tree
          // is gone. Retain ownership so stop/shutdown can still retry it.
        },
      );

      return {
        executionId: input.executionId,
        completion,
        stop: () => this.stop(input.executionId),
      };
    } catch (error) {
      emit({ kind: 'execution.failed', code: stableErrorCode(error) });
      throw error;
    } finally {
      settlePendingStart();
      this.#pendingStarts.delete(pendingStart);
    }
  }

  async stop(executionId: string): Promise<RuntimeStopResult> {
    validateExecutionId(executionId);
    const active = this.#activeExecutions.get(executionId);
    if (!active) {
      const terminal = this.#terminalExecutions.get(executionId);
      if (terminal) {
        return {
          executionId,
          disposition: terminal.treeTermination === 'confirmed'
            ? 'already_terminal'
            : 'termination_failed',
          treeTermination: terminal.treeTermination,
        };
      }
      throw new RuntimeError('execution_not_active');
    }

    return this.#stopActiveExecution(executionId, active, 'requested');
  }

  shutdown(): Promise<void> {
    if (this.#shutdownOperation) return this.#shutdownOperation;
    this.#shuttingDown = true;
    const operation = this.#performShutdown().catch((error: unknown) => {
      if (this.#shutdownOperation === operation) this.#shutdownOperation = null;
      throw error;
    });
    this.#shutdownOperation = operation;
    return operation;
  }

  async #performShutdown(): Promise<void> {
    if (this.#pendingStarts.size > 0) {
      await Promise.all([...this.#pendingStarts]);
    }
    const active = [...this.#activeExecutions.entries()];
    const outcomes = await Promise.allSettled(active.map(([executionId, execution]) => (
      this.#stopActiveExecution(executionId, execution, 'shutdown')
    )));
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
    if (outcomes.some((outcome) => (
      outcome.status === 'fulfilled' && outcome.value.treeTermination !== 'confirmed'
    ))) {
      throw new Error('runtime_shutdown_unconfirmed');
    }
  }

  #stopActiveExecution(
    executionId: string,
    active: ActiveExecution,
    reason: 'requested' | 'shutdown',
  ): Promise<RuntimeStopResult> {
    if (active.stopOperation) return active.stopOperation;
    const operation = this.#performStopActiveExecution(executionId, active, reason).finally(() => {
      if (active.stopOperation === operation) active.stopOperation = null;
    });
    active.stopOperation = operation;
    return operation;
  }

  async #performStopActiveExecution(
    executionId: string,
    active: ActiveExecution,
    reason: 'requested' | 'shutdown',
  ): Promise<RuntimeStopResult> {
    const stopTreeTermination = await active.process.stop(reason);
    if (stopTreeTermination !== 'confirmed' && !active.terminalResult) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (stopTreeTermination !== 'confirmed' && !active.terminalResult) {
      return {
        executionId,
        disposition: 'termination_failed',
        treeTermination: 'failed',
      };
    }
    let result: RuntimeExecutionResult;
    try {
      result = active.terminalResult ?? await active.completion;
      active.terminalResult = result;
    } catch (error) {
      if (stopTreeTermination === 'confirmed') {
        this.#deleteActiveExecution(executionId, active);
      }
      throw error;
    }

    // Either result is an independent, monotonic proof that ownership is gone.
    // Keep the terminal status unchanged: `termination_failed` can also report
    // protocol or output-integrity failure, not merely an unconfirmed tree.
    const treeTermination: RuntimeExecutionResult['treeTermination'] = stopTreeTermination === 'confirmed'
      || result.treeTermination === 'confirmed'
      ? 'confirmed'
      : 'failed';
    if (treeTermination !== 'confirmed') {
      return {
        executionId,
        disposition: 'termination_failed',
        treeTermination,
      };
    }

    this.#deleteActiveExecution(executionId, active);
    const reconciled: RuntimeExecutionResult = result.treeTermination === 'confirmed'
      ? result
      : {
          ...result,
          treeTermination,
        };
    this.#rememberTerminal(reconciled);
    return {
      executionId,
      disposition: reconciled.status === 'stopped' ? 'stopped' : 'already_terminal',
      treeTermination,
    };
  }

  #deleteActiveExecution(executionId: string, active: ActiveExecution): void {
    if (this.#activeExecutions.get(executionId) === active) {
      this.#activeExecutions.delete(executionId);
    }
  }

  async #completeExecution(
    input: RuntimeExecutionInput,
    limits: RuntimeLimits,
    before: Awaited<ReturnType<typeof scanWorkspace>>,
    process: SupervisedProcess,
    emit: (event: RuntimeEventUpdate) => void,
  ): Promise<RuntimeExecutionResult> {
    const processResult = await process.completion;
    let status: RuntimeTerminalStatus = processResult.status;
    let artifacts: RuntimeExecutionResult['artifacts'] = [];
    let scanTruncated = before.truncated;

    if (processResult.treeTermination !== 'confirmed') {
      status = 'termination_failed';
      scanTruncated = true;
      emit({ kind: 'execution.failed', code: 'process_tree_termination_failed' });
    } else {
      try {
        await assertWorkspaceIdentity(input.workspace);
        const after = await scanWorkspace(input.workspace, limits);
        const detectedArtifacts = diffWorkspaceSnapshots(before, after);
        const scanIncomplete = before.truncated
          || after.truncated
          || detectedArtifacts.some((artifact) => !isCompleteArtifact(artifact));
        if (scanIncomplete) {
          status = 'scan_failed';
          scanTruncated = true;
          emit({ kind: 'execution.failed', code: 'workspace_scan_failed' });
        } else {
          artifacts = detectedArtifacts;
          for (const artifact of artifacts) emit({ kind: 'artifact.changed', artifact });
        }
      } catch (error) {
        status = error instanceof RuntimeError && error.code === 'workspace_changed'
          ? 'workspace_changed'
          : 'scan_failed';
        scanTruncated = true;
        emit({ kind: 'execution.failed', code: stableErrorCode(error) });
      }
    }

    const result: RuntimeExecutionResult = {
      executionId: input.executionId,
      provider: input.provider,
      status,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      stdoutTruncated: processResult.stdoutTruncated,
      stderrTruncated: processResult.stderrTruncated,
      treeTermination: processResult.treeTermination,
      artifacts,
      scanTruncated,
    };
    emit({
      kind: 'process.exited',
      exitCode: result.exitCode,
      signal: result.signal,
      status: result.status,
      treeTermination: result.treeTermination,
    });
    this.#rememberTerminal(result);
    return result;
  }

  #rememberTerminal(result: RuntimeExecutionResult): void {
    this.#terminalExecutions.set(result.executionId, result);
    while (this.#terminalExecutions.size > 256) {
      const first = this.#terminalExecutions.keys().next().value;
      if (typeof first !== 'string') break;
      this.#terminalExecutions.delete(first);
    }
  }
}

function emitProcessEvent(
  event: Exclude<SupervisedProcessEvent, { kind: 'started' }>,
  emit: (event: RuntimeEventUpdate) => void,
): void {
  if (event.kind === 'output') {
    emit({ kind: 'process.output', stream: event.stream, text: event.text });
  } else if (event.kind === 'output_truncated') {
    emit({
      kind: 'process.output_truncated',
      stream: event.stream,
      observedBytes: event.observedBytes,
    });
  } else {
    emit({ kind: 'process.stop_requested', reason: event.reason });
  }
}

function createEventEmitter(
  executionId: string,
  observer: RuntimeExecutionInput['onEvent'],
): (update: RuntimeEventUpdate) => void {
  let sequence = 0;
  return (update) => {
    const event = {
      executionId,
      sequence: ++sequence,
      occurredAt: new Date().toISOString(),
      ...update,
    } as RuntimeEvent;
    try {
      observer?.(event);
    } catch {
      // Runtime ownership cannot depend on a UI or persistence observer.
    }
  };
}

function resolveRuntimeLimits(overrides: Partial<RuntimeLimits> | undefined): RuntimeLimits {
  const limits = { ...DEFAULT_RUNTIME_LIMITS, ...overrides };
  assertRange(limits.totalTimeoutMs, 50, 2 * 60 * 60 * 1_000);
  assertRange(limits.idleTimeoutMs, 50, 30 * 60 * 1_000);
  assertRange(limits.terminateGraceMs, 25, 10_000);
  assertRange(limits.killConfirmMs, 25, 10_000);
  assertRange(limits.maxStdoutBytes, 1_024, 16 * 1024 * 1024);
  assertRange(limits.maxStderrBytes, 1_024, 8 * 1024 * 1024);
  assertRange(limits.maxOutputChunkBytes, 256, 64 * 1024);
  assertRange(limits.maxScanFiles, 1, 20_000);
  assertRange(limits.maxScanFileBytes, 1_024, 32 * 1024 * 1024);
  assertRange(limits.maxScanTotalBytes, 1_024, 256 * 1024 * 1024);
  assertRange(limits.maxScanDepth, 1, 64);
  if (
    limits.idleTimeoutMs > limits.totalTimeoutMs
    || limits.maxOutputChunkBytes > Math.min(limits.maxStdoutBytes, limits.maxStderrBytes)
  ) {
    throw new RuntimeError('execution_invalid');
  }
  return limits;
}

function assertRange(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RuntimeError('execution_invalid');
  }
}

function isCompleteArtifact(
  artifact: RuntimeExecutionResult['artifacts'][number],
): boolean {
  if (artifact.change === 'deleted') {
    return artifact.hash === null && artifact.size === 0;
  }
  return typeof artifact.hash === 'string'
    && /^[a-f0-9]{64}$/u.test(artifact.hash)
    && Number.isSafeInteger(artifact.size)
    && artifact.size !== null
    && artifact.size >= 0;
}

function validateExecutionId(executionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}[A-Za-z0-9]$/u.test(executionId)) {
    throw new RuntimeError('execution_invalid');
  }
}

function stableErrorCode(error: unknown): string {
  return error instanceof RuntimeError ? error.code : 'runtime_failed';
}
