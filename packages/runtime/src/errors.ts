export type RuntimeErrorCode =
  | 'execution_duplicate'
  | 'execution_invalid'
  | 'execution_not_active'
  | 'executable_changed'
  | 'executable_invalid'
  | 'executable_not_found'
  | 'model_invalid'
  | 'provider_credential_invalid'
  | 'runtime_shutting_down'
  | 'security_boundary_unavailable'
  | 'workspace_changed'
  | 'workspace_invalid'
  | 'workspace_recovery_required'
  | 'workspace_scan_failed';

export class RuntimeError extends Error {
  constructor(readonly code: RuntimeErrorCode) {
    super(code);
    this.name = 'RuntimeError';
  }
}
