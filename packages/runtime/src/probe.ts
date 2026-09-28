import { prepareContainedProviderLaunch } from './containment.js';
import { prepareRuntimeEnvironment } from './environment.js';
import { RuntimeError } from './errors.js';
import { assertExecutableUnchanged, resolveProviderExecutable } from './executable.js';
import { startSupervisedProcess } from './process-supervisor.js';
import { providerDisclosures, providerFixedEnvironment, type ProviderDisclosure } from './providers.js';
import type {
  ExecutableFingerprint,
  RuntimeEnvironmentPolicy,
  RuntimeProvider,
} from './types.js';

export type ProviderUnavailableReason =
  | 'executable_changed'
  | 'executable_not_found'
  | 'probe_failed'
  | 'probe_timeout'
  | 'security_capability_missing'
  | 'version_unavailable';

export type ProviderCapability =
  | {
    provider: RuntimeProvider;
    available: true;
    version: string;
    executable: ExecutableFingerprint;
    disclosures: readonly ProviderDisclosure[];
  }
  | {
    provider: RuntimeProvider;
    available: false;
    version: string | null;
    reason: ProviderUnavailableReason;
    disclosures: readonly ProviderDisclosure[];
  };

export type ProviderCapabilityProbeInput = {
  provider: RuntimeProvider;
  executable: ExecutableFingerprint;
  environment: Pick<
    RuntimeEnvironmentPolicy,
    'hostHomeDirectory' | 'homeDirectory' | 'temporaryDirectory'
  >;
  timeoutMs?: number;
};

export type ProviderCapabilityDiscoveryInput = {
  provider: RuntimeProvider;
  additionalSearchDirectories?: readonly string[];
  environment: Pick<
    RuntimeEnvironmentPolicy,
    'hostHomeDirectory' | 'homeDirectory' | 'temporaryDirectory'
  >;
  timeoutMs?: number;
};

const REQUIRED_HELP_TEXT: Readonly<Record<RuntimeProvider, readonly string[]>> = Object.freeze({
  codex: Object.freeze([
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--sandbox',
    '--ephemeral',
    '--json',
  ]),
  'claude-code': Object.freeze([
    '--safe-mode',
    '--permission-mode',
    '--settings',
    '--setting-sources',
    '--strict-mcp-config',
    '--mcp-config',
    '--input-format',
    '--output-format',
  ]),
  opencode: Object.freeze([
    '--pure',
    '--auto',
    '--format',
    '--dir',
    '--agent',
  ]),
});
const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_PROBE_TIMEOUT_MS = 15_000;

export async function probeProviderCapability(
  input: ProviderCapabilityProbeInput,
): Promise<ProviderCapability> {
  const disclosures = providerDisclosures(input.provider);
  if (input.executable.provider !== input.provider) {
    return unavailable(input.provider, 'executable_changed', null, disclosures);
  }
  try {
    await assertExecutableUnchanged(input.executable);
  } catch {
    return unavailable(input.provider, 'executable_changed', null, disclosures);
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_PROVIDER_PROBE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 250
    || timeoutMs > MAX_PROVIDER_PROBE_TIMEOUT_MS
  ) {
    return unavailable(input.provider, 'probe_failed', null, disclosures);
  }

  let prepared: Awaited<ReturnType<typeof prepareRuntimeEnvironment>>;
  try {
    prepared = await prepareRuntimeEnvironment(
      input.provider,
      input.executable,
      input.environment,
      providerFixedEnvironment(input.provider),
    );
  } catch {
    return unavailable(input.provider, 'probe_failed', null, disclosures);
  }

  const [versionResult, ...helpResults] = await Promise.all([
    runFixedProbe(
      input.executable.path,
      ['--version'],
      prepared,
      timeoutMs,
    ),
    ...helpArguments(input.provider).map((args) => runFixedProbe(
      input.executable.path,
      args,
      prepared,
      timeoutMs,
    )),
  ]);
  if (versionResult.reason) {
    return unavailable(input.provider, versionResult.reason, null, disclosures);
  }
  const version = normalizedVersion(versionResult.output);
  if (!version) return unavailable(input.provider, 'version_unavailable', null, disclosures);

  const helpOutputs: string[] = [];
  for (const result of helpResults) {
    if (result.reason) {
      return unavailable(input.provider, result.reason, version, disclosures);
    }
    helpOutputs.push(result.output);
  }
  const help = helpOutputs.join('\n');
  if (REQUIRED_HELP_TEXT[input.provider].some((capability) => !help.includes(capability))) {
    return unavailable(input.provider, 'security_capability_missing', version, disclosures);
  }

  try {
    await assertExecutableUnchanged(input.executable);
  } catch {
    return unavailable(input.provider, 'executable_changed', version, disclosures);
  }
  return {
    provider: input.provider,
    available: true,
    version,
    executable: input.executable,
    disclosures,
  };
}

export async function discoverProviderCapability(
  input: ProviderCapabilityDiscoveryInput,
): Promise<ProviderCapability> {
  const disclosures = providerDisclosures(input.provider);
  try {
    const executable = await resolveProviderExecutable(
      input.provider,
      input.additionalSearchDirectories,
    );
    return probeProviderCapability({
      provider: input.provider,
      executable,
      environment: input.environment,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  } catch (error) {
    const reason: ProviderUnavailableReason = error instanceof RuntimeError
      && error.code === 'executable_not_found'
      ? 'executable_not_found'
      : 'probe_failed';
    return unavailable(input.provider, reason, null, disclosures);
  }
}

function helpArguments(provider: RuntimeProvider): readonly (readonly string[])[] {
  if (provider === 'codex') return [['exec', '--help']];
  if (provider === 'claude-code') return [['--help']];
  return [['--help'], ['run', '--help']];
}

async function runFixedProbe(
  providerExecutable: string,
  providerArgs: readonly string[],
  prepared: Awaited<ReturnType<typeof prepareRuntimeEnvironment>>,
  timeoutMs: number,
): Promise<{ output: string; reason: ProviderUnavailableReason | null }> {
  let command = providerExecutable;
  let args = [...providerArgs];
  if (process.platform === 'darwin') {
    try {
      const contained = await prepareContainedProviderLaunch({
        providerExecutable,
        providerArgs,
        workspaceRoot: prepared.homeDirectory,
        runtimeHomeDirectory: prepared.homeDirectory,
        runtimeTemporaryDirectory: prepared.temporaryDirectory,
        hostHomeDirectory: prepared.hostHomeDirectory,
      });
      command = contained.command;
      args = contained.args;
    } catch {
      return { output: '', reason: 'probe_failed' };
    }
  }
  const supervised = startSupervisedProcess({
    command,
    args,
    cwd: prepared.homeDirectory,
    env: prepared.env,
    stdin: '',
    secrets: [],
    limits: {
      totalTimeoutMs: timeoutMs,
      idleTimeoutMs: timeoutMs,
      terminateGraceMs: 250,
      killConfirmMs: 1_000,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      maxOutputChunkBytes: 4 * 1024,
    },
  });
  const result = await supervised.completion;
  if (result.status === 'timed_out' || result.status === 'idle_timed_out') {
    return { output: '', reason: 'probe_timeout' };
  }
  if (
    result.status !== 'exited'
    || result.exitCode !== 0
    || result.stdoutTruncated
    || result.stderrTruncated
  ) {
    return { output: '', reason: 'probe_failed' };
  }
  return {
    output: `${result.stdout}\n${result.stderr}`,
    reason: null,
  };
}

function normalizedVersion(value: string): string | null {
  const line = value
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line || line.length > 160 || /[\u0000-\u001f\u007f]/u.test(line)) return null;
  return line;
}

function unavailable(
  provider: RuntimeProvider,
  reason: ProviderUnavailableReason,
  version: string | null,
  disclosures: readonly ProviderDisclosure[],
): ProviderCapability {
  return { provider, available: false, version, reason, disclosures };
}
