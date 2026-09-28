export declare const opaqueIdBrand: unique symbol;

/** Platform-neutral identity. Runtime validation belongs to the protocol boundary. */
export type OpaqueId<Kind extends string> = string & {
  readonly [opaqueIdBrand]: Kind;
};

export type WorkspaceId = OpaqueId<'WorkspaceId'>;
export type MissionId = OpaqueId<'MissionId'>;
export type TurnId = OpaqueId<'TurnId'>;
export type TaskId = OpaqueId<'TaskId'>;
export type ExecutionId = OpaqueId<'ExecutionId'>;
export type ApprovalId = OpaqueId<'ApprovalId'>;

export type ExecutionMode = 'mock' | 'fallback' | 'real';

export type LocalAgentProvider = 'codex' | 'claude-code' | 'opencode';

export type LocalExecutionState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'stopped'
  | 'timed_out';
