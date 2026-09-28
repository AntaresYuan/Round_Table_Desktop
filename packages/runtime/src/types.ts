export const RUNTIME_PROVIDERS = Object.freeze([
  'codex',
  'claude-code',
  'opencode',
] as const);

export type RuntimeProvider = (typeof RUNTIME_PROVIDERS)[number];

export type WorkspaceIdentity = {
  root: string;
  device: string;
  inode: string;
};

export type ExecutableFingerprint = {
  provider: RuntimeProvider;
  path: string;
  device: string;
  inode: string;
  size: string;
  modifiedNanoseconds: string;
  sha256: string;
};

export type RuntimeCredential =
  | {
    provider: 'codex';
    kind: 'openai-api-key';
    value: string;
  }
  | {
    provider: 'claude-code';
    kind: 'anthropic-api-key' | 'anthropic-auth-token' | 'claude-code-oauth-token';
    value: string;
  }
  | {
    provider: 'opencode';
    kind: 'openai-api-key' | 'anthropic-api-key';
    value: string;
  };

export type RuntimeEnvironmentPolicy = {
  hostHomeDirectory: string;
  homeDirectory: string;
  temporaryDirectory: string;
  credential?: RuntimeCredential;
  redactionSecrets?: readonly string[];
};

export type RuntimeLimits = {
  totalTimeoutMs: number;
  idleTimeoutMs: number;
  terminateGraceMs: number;
  killConfirmMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxOutputChunkBytes: number;
  maxScanFiles: number;
  maxScanFileBytes: number;
  maxScanTotalBytes: number;
  maxScanDepth: number;
};

export type RuntimeArtifact = {
  relativePath: string;
  change: 'created' | 'modified' | 'deleted';
  hash: string | null;
  size: number | null;
};

export type RuntimeEventUpdate =
  | { kind: 'execution.starting'; provider: RuntimeProvider }
  | { kind: 'process.started'; pid: number }
  | { kind: 'process.output'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'process.output_truncated'; stream: 'stdout' | 'stderr'; observedBytes: number }
  | { kind: 'process.stop_requested'; reason: RuntimeStopReason }
  | { kind: 'artifact.changed'; artifact: RuntimeArtifact }
  | {
    kind: 'process.exited';
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    status: RuntimeTerminalStatus;
    treeTermination: TreeTermination;
  }
  | { kind: 'execution.failed'; code: string };

export type RuntimeEvent = {
  executionId: string;
  sequence: number;
  occurredAt: string;
} & RuntimeEventUpdate;

export type RuntimeStopReason = 'requested' | 'total_timeout' | 'idle_timeout' | 'shutdown';

export type RuntimeTerminalStatus =
  | 'exited'
  | 'stopped'
  | 'timed_out'
  | 'idle_timed_out'
  | 'spawn_failed'
  | 'scan_failed'
  | 'workspace_changed'
  | 'termination_failed';

export type TreeTermination = 'confirmed' | 'failed';

export type RuntimeExecutionInput = {
  executionId: string;
  provider: RuntimeProvider;
  executable: ExecutableFingerprint;
  workspace: WorkspaceIdentity;
  prompt: string;
  environment: RuntimeEnvironmentPolicy;
  model?: string;
  limits?: Partial<RuntimeLimits>;
  onEvent?: (event: RuntimeEvent) => void;
};

export type RuntimeExecutionResult = {
  executionId: string;
  provider: RuntimeProvider;
  status: RuntimeTerminalStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  treeTermination: TreeTermination;
  artifacts: RuntimeArtifact[];
  scanTruncated: boolean;
};

export type RuntimeStopResult = {
  executionId: string;
  disposition: 'stopped' | 'already_terminal' | 'termination_failed';
  treeTermination: TreeTermination;
};

export type RuntimeExecution = {
  executionId: string;
  completion: Promise<RuntimeExecutionResult>;
  stop(): Promise<RuntimeStopResult>;
};
