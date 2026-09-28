import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { RuntimeError } from './errors.js';
import type { WorkspaceIdentity } from './types.js';
import { assertWorkspaceIdentity, captureWorkspaceIdentity } from './workspace.js';

const STAGING_DIRECTORY_PREFIX = 'roundtable-execution-';
const APPLY_TEMPORARY_PREFIX = '.roundtable-apply-';
const APPLY_RECOVERY_SUFFIX = '.recovery';
const APPLY_RECOVERY_PLAN = 'journal.json';
const APPLY_RECOVERY_STATE = 'state.json';
const APPLY_RECOVERY_BACKUPS = 'backups';
const APPLY_RECOVERY_PREPARED = 'prepared';
const APPLY_RECOVERY_DISPLACED = 'displaced';
const MAX_APPLY_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_APPLY_STATE_BYTES = 64 * 1024;
const REQUIRED_PROTECTED_DIRECTORY = '.git';

export const DEFAULT_STAGING_WORKSPACE_LIMITS: Readonly<StagingWorkspaceLimits> = Object.freeze({
  maxEntries: 5_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDepth: 20,
});

export type StagingWorkspaceLimits = {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
};

export type StagingWorkspaceEntry =
  | {
    kind: 'directory';
    mode: number;
  }
  | {
    kind: 'file';
    mode: number;
    size: number;
    sha256: string;
  };

export type StagingWorkspaceChange = {
  relativePath: string;
  change: 'created' | 'modified' | 'deleted';
  before: StagingWorkspaceEntry | null;
  after: StagingWorkspaceEntry | null;
};

export type StagingWorkspaceManifest = {
  version: 1;
  executionId: string;
  source: WorkspaceIdentity;
  staging: WorkspaceIdentity;
  protectedDirectoryNames: readonly string[];
  protectedPaths: readonly string[];
  baselineHash: string;
  resultHash: string;
  changes: readonly StagingWorkspaceChange[];
};

export type StagingReviewBundle = {
  version: 1;
  bundleId: string;
  executionId: string;
  workspace: WorkspaceIdentity;
  staging: WorkspaceIdentity;
  protectedDirectoryNames: readonly string[];
  protectedPaths: readonly string[];
  baselineHash: string;
  resultHash: string;
  changes: readonly StagingWorkspaceChange[];
  contentHash: string;
};

/**
 * Creates the immutable, content-addressed review object shown to the host
 * approval layer. It contains metadata and audited changes only; file bytes
 * remain in the staging root until an authorized apply consumes the bundle.
 */
export function createStagingReviewBundle(
  manifest: StagingWorkspaceManifest,
): StagingReviewBundle {
  const canonical = JSON.stringify({
    version: manifest.version,
    executionId: manifest.executionId,
    source: manifest.source,
    staging: manifest.staging,
    protectedDirectoryNames: manifest.protectedDirectoryNames,
    protectedPaths: manifest.protectedPaths,
    baselineHash: manifest.baselineHash,
    resultHash: manifest.resultHash,
    changes: manifest.changes,
  });
  const contentHash = createHash('sha256').update(canonical).digest('hex');
  return Object.freeze({
    version: 1,
    bundleId: `review_${contentHash.slice(0, 32)}`,
    executionId: manifest.executionId,
    workspace: { ...manifest.source },
    staging: { ...manifest.staging },
    protectedDirectoryNames: [...manifest.protectedDirectoryNames],
    protectedPaths: [...manifest.protectedPaths],
    baselineHash: manifest.baselineHash,
    resultHash: manifest.resultHash,
    changes: manifest.changes.map((change) => ({
      ...change,
      before: change.before ? { ...change.before } : null,
      after: change.after ? { ...change.after } : null,
    })),
    contentHash,
  });
}

export type CreateExecutionStagingWorkspaceInput = {
  executionId: string;
  workspace: WorkspaceIdentity;
  stagingParentDirectory: string;
  protectedDirectoryNames?: readonly string[];
  limits?: Partial<StagingWorkspaceLimits>;
  /** Deterministic fault/race injection for tests. Production callers must omit it. */
  applyFaultInjectorForTesting?: (
    point: StagingWorkspaceApplyFaultPoint,
  ) => void | Promise<void>;
};

export type StagingWorkspaceApplyFaultPoint = {
  mutationIndex: number;
  kind: 'backup_entry' | 'create_directory' | 'install_file' | 'set_directory_mode';
  relativePath: string;
};

export type StagingWorkspaceRecoveryFacts = {
  version: 1;
  transactionId: string;
  executionId: string;
  recoveryRoot: string;
  journalPath: string;
  statePath: string;
  state:
    | 'prepared'
    | 'applying'
    | 'rolling_back'
    | 'rolled_back'
    | 'quarantined'
    | 'committed';
  sourceState: 'baseline' | 'result' | 'unknown';
  operationCount: number;
  completedOperationCount: number;
};

export type ExecutionStagingWorkspace = {
  readonly root: string;
  readonly source: WorkspaceIdentity;
  readonly staging: WorkspaceIdentity;
  inspectChanges(): Promise<StagingWorkspaceManifest>;
  applyChanges(manifest: StagingWorkspaceManifest): Promise<void>;
  recoveryFacts(): StagingWorkspaceRecoveryFacts | null;
  cleanup(): Promise<void>;
};

type EntryIdentity = {
  device: string;
  inode: string;
  modifiedNanoseconds: string;
  changedNanoseconds: string;
};

type ScannedEntry = {
  audit: StagingWorkspaceEntry;
  identity: EntryIdentity;
};

type ScannedFileEntry = ScannedEntry & {
  audit: Extract<StagingWorkspaceEntry, { kind: 'file' }>;
};

type DirectoryIdentity = EntryIdentity & {
  mode: number;
};

type TreeSnapshot = {
  root: DirectoryIdentity;
  entries: Map<string, ScannedEntry>;
  protectedPaths: Map<string, 'directory' | 'file'>;
};

type ScanMode = 'source' | 'staging';

type ApplyOperation = {
  index: number;
  kind: StagingWorkspaceApplyFaultPoint['kind'];
  relativePath: string;
  before: ScannedEntry | null;
  after: ScannedEntry | null;
  backupName: string | null;
  preparedName: string | null;
  directoryModeBefore: number | null;
};

type ApplyRecoveryJournal = {
  version: 1;
  transactionId: string;
  executionId: string;
  source: WorkspaceIdentity;
  staging: WorkspaceIdentity;
  protectedDirectoryNames: readonly string[];
  protectedPaths: readonly string[];
  baselineHash: string;
  resultHash: string;
  operationCount: number;
  operations: readonly ApplyOperation[];
};

type ApplyRecoveryState = {
  version: 1;
  transactionId: string;
  state: StagingWorkspaceRecoveryFacts['state'];
  sourceState: StagingWorkspaceRecoveryFacts['sourceState'];
  activeOperationIndex: number | null;
  completedOperationCount: number;
  rollbackCompletedCount: number;
  conflictCount: number;
  firstConflictPath: string | null;
};

type ApplyRecoveryBundle = {
  transactionId: string;
  directoryName: string;
  sourceRoot: string;
  root: string;
  identity: WorkspaceIdentity;
  journalPath: string;
  statePath: string;
  backupsRoot: string;
  backupsIdentity: WorkspaceIdentity;
  preparedRoot: string;
  preparedIdentity: WorkspaceIdentity;
  displacedRoot: string;
  displacedIdentity: WorkspaceIdentity;
  operationCount: number;
  preparedEntries: Map<number, ScannedEntry>;
};

type AttemptedApplyOperation = {
  operation: ApplyOperation;
  mutated: boolean;
  ownedResult: ScannedEntry | null;
};

export async function createExecutionStagingWorkspace(
  input: CreateExecutionStagingWorkspaceInput,
): Promise<ExecutionStagingWorkspace> {
  validateExecutionId(input.executionId);
  const limits = resolveLimits(input.limits);
  const protectedDirectoryNames = resolveProtectedDirectoryNames(
    input.protectedDirectoryNames,
  );
  await assertWorkspaceIdentity(input.workspace);
  const stagingParent = await canonicalDirectory(
    input.stagingParentDirectory,
    'workspace_invalid',
  );
  await assertPrivateStagingParent(stagingParent);
  if (isPathWithin(input.workspace.root, stagingParent)) {
    throw new RuntimeError('workspace_invalid');
  }

  let stagingRoot: string | null = null;
  try {
    stagingRoot = await mkdtemp(join(stagingParent, STAGING_DIRECTORY_PREFIX));
    await chmod(stagingRoot, 0o700);
    const canonicalStagingRoot = await realpath(stagingRoot);
    if (
      canonicalStagingRoot !== stagingRoot
      || pathsOverlap(input.workspace.root, canonicalStagingRoot)
    ) {
      throw new RuntimeError('workspace_invalid');
    }

    const baseline = await scanTree(
      input.workspace.root,
      limits,
      protectedDirectoryNames,
      'source',
      'workspace_invalid',
    );
    await copySnapshot(input.workspace.root, canonicalStagingRoot, baseline);
    const sourceAfterCopy = await scanTree(
      input.workspace.root,
      limits,
      protectedDirectoryNames,
      'source',
      'workspace_invalid',
    );
    if (!sameGuardedTree(baseline, sourceAfterCopy)) {
      throw new RuntimeError('workspace_changed');
    }
    await assertWorkspaceIdentity(input.workspace);

    const stagingIdentity = await captureWorkspaceIdentity(canonicalStagingRoot);
    await assertPrivateStagingIdentity(stagingIdentity);
    const stagedBaseline = await scanTree(
      canonicalStagingRoot,
      limits,
      protectedDirectoryNames,
      'staging',
      'workspace_scan_failed',
    );
    if (!sameAuditedTree(baseline, stagedBaseline)) {
      throw new RuntimeError('workspace_scan_failed');
    }

    return new ExecutionStagingWorkspaceImpl({
      executionId: input.executionId,
      source: { ...input.workspace },
      staging: stagingIdentity,
      protectedDirectoryNames,
      limits,
      baseline,
      applyFaultInjectorForTesting: input.applyFaultInjectorForTesting,
    });
  } catch (error) {
    if (stagingRoot !== null) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('workspace_invalid');
  }
}

class ExecutionStagingWorkspaceImpl implements ExecutionStagingWorkspace {
  readonly root: string;
  readonly source: WorkspaceIdentity;
  readonly staging: WorkspaceIdentity;
  readonly #executionId: string;
  readonly #staging: WorkspaceIdentity;
  readonly #protectedDirectoryNames: readonly string[];
  readonly #limits: StagingWorkspaceLimits;
  readonly #baseline: TreeSnapshot;
  readonly #applyFaultInjectorForTesting:
    | CreateExecutionStagingWorkspaceInput['applyFaultInjectorForTesting'];
  #applyStarted = false;
  #applyOperation: Promise<void> | null = null;
  #recoveryFacts: StagingWorkspaceRecoveryFacts | null = null;
  #cleaned = false;
  #cleanupOperation: Promise<void> | null = null;

  constructor(input: {
    executionId: string;
    source: WorkspaceIdentity;
    staging: WorkspaceIdentity;
    protectedDirectoryNames: readonly string[];
    limits: StagingWorkspaceLimits;
    baseline: TreeSnapshot;
    applyFaultInjectorForTesting:
      | CreateExecutionStagingWorkspaceInput['applyFaultInjectorForTesting'];
  }) {
    this.#executionId = input.executionId;
    this.source = input.source;
    this.#staging = input.staging;
    this.staging = { ...input.staging };
    this.root = input.staging.root;
    this.#protectedDirectoryNames = input.protectedDirectoryNames;
    this.#limits = input.limits;
    this.#baseline = input.baseline;
    this.#applyFaultInjectorForTesting = input.applyFaultInjectorForTesting;
  }

  async inspectChanges(): Promise<StagingWorkspaceManifest> {
    const prepared = await this.#prepareManifest();
    return prepared.manifest;
  }

  applyChanges(manifest: StagingWorkspaceManifest): Promise<void> {
    if (this.#recoveryFacts) {
      return Promise.reject(new RuntimeError('workspace_recovery_required'));
    }
    if (
      this.#applyStarted
      || this.#applyOperation
      || this.#cleaned
      || this.#cleanupOperation
    ) {
      return Promise.reject(new RuntimeError('workspace_changed'));
    }
    const operation = this.#performApply(manifest).finally(() => {
      if (this.#applyOperation === operation) this.#applyOperation = null;
    });
    this.#applyOperation = operation;
    return operation;
  }

  async #performApply(manifest: StagingWorkspaceManifest): Promise<void> {
    const prepared = await this.#prepareManifest(true);
    if (!isDeepStrictEqual(manifest, prepared.manifest)) {
      throw new RuntimeError('workspace_changed');
    }
    assertProtectedAncestorsUnchanged(
      prepared.manifest.changes,
      prepared.manifest.protectedPaths,
    );
    this.#applyStarted = true;
    try {
      await applyManifest({
        source: this.source,
        staging: this.#staging,
        baseline: this.#baseline,
        staged: prepared.staged,
        manifest: prepared.manifest,
        protectedDirectoryNames: this.#protectedDirectoryNames,
        limits: this.#limits,
        applyFaultInjectorForTesting: this.#applyFaultInjectorForTesting,
        updateRecoveryFacts: (facts) => {
          this.#recoveryFacts = facts;
        },
      });
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('workspace_changed');
    }
  }

  recoveryFacts(): StagingWorkspaceRecoveryFacts | null {
    return this.#recoveryFacts ? { ...this.#recoveryFacts } : null;
  }

  cleanup(): Promise<void> {
    if (this.#recoveryFacts) {
      return Promise.reject(new RuntimeError('workspace_recovery_required'));
    }
    if (this.#cleaned) return Promise.resolve();
    if (this.#applyOperation) return Promise.reject(new RuntimeError('workspace_changed'));
    if (this.#cleanupOperation) return this.#cleanupOperation;
    const operation = this.#performCleanup().finally(() => {
      if (this.#cleanupOperation === operation) this.#cleanupOperation = null;
    });
    this.#cleanupOperation = operation;
    return operation;
  }

  async #prepareManifest(forApply = false): Promise<{
    manifest: StagingWorkspaceManifest;
    staged: TreeSnapshot;
  }> {
    if (this.#recoveryFacts) {
      throw new RuntimeError('workspace_recovery_required');
    }
    if (
      ((!forApply && this.#applyStarted) || (!forApply && this.#applyOperation))
      || this.#cleaned
      || this.#cleanupOperation
    ) {
      throw new RuntimeError('workspace_changed');
    }
    await assertWorkspaceIdentity(this.source);
    const currentSource = await scanTree(
      this.source.root,
      this.#limits,
      this.#protectedDirectoryNames,
      'source',
      'workspace_changed',
    );
    if (!sameGuardedTree(this.#baseline, currentSource)) {
      throw new RuntimeError('workspace_changed');
    }
    await assertPrivateStagingIdentity(this.#staging);
    const staged = await scanTree(
      this.root,
      this.#limits,
      this.#protectedDirectoryNames,
      'staging',
      'workspace_scan_failed',
    );
    const changes = diffTrees(this.#baseline, staged);
    const protectedPaths = [...this.#baseline.protectedPaths.keys()].sort(comparePaths);
    return {
      staged,
      manifest: {
        version: 1,
        executionId: this.#executionId,
        source: { ...this.source },
        staging: { ...this.#staging },
        protectedDirectoryNames: [...this.#protectedDirectoryNames],
        protectedPaths,
        baselineHash: auditedTreeHash(this.#baseline),
        resultHash: auditedTreeHash(staged),
        changes,
      },
    };
  }

  async #performCleanup(): Promise<void> {
    try {
      await assertPrivateStagingIdentity(this.#staging, false);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        this.#cleaned = true;
        return;
      }
      throw error;
    }
    await rm(this.root, { recursive: true, force: true });
    this.#cleaned = true;
  }
}

async function applyManifest(input: {
  source: WorkspaceIdentity;
  staging: WorkspaceIdentity;
  baseline: TreeSnapshot;
  staged: TreeSnapshot;
  manifest: StagingWorkspaceManifest;
  protectedDirectoryNames: readonly string[];
  limits: StagingWorkspaceLimits;
  applyFaultInjectorForTesting:
    | CreateExecutionStagingWorkspaceInput['applyFaultInjectorForTesting'];
  updateRecoveryFacts(facts: StagingWorkspaceRecoveryFacts | null): void;
}): Promise<void> {
  const preflight = await preflightApply(input);
  let bundle: ApplyRecoveryBundle | null = null;
  let state: ApplyRecoveryState | null = null;
  const attempted: AttemptedApplyOperation[] = [];
  let committed = false;

  try {
    bundle = await createApplyRecoveryBundle({
      source: input.source,
      journal: preflight.journal,
      stagedContents: preflight.stagedContents,
    });
    state = initialApplyRecoveryState(preflight.journal.transactionId);
    await writeRecoveryState(bundle, state, true);
    input.updateRecoveryFacts(recoveryFacts(input, bundle, state));

    // The recovery bundle is the only source-root change permitted between the
    // complete preflight and the first journalled workspace mutation.
    const sourceAfterRecoverySetup = await scanTree(
      input.source.root,
      input.limits,
      input.protectedDirectoryNames,
      'source',
      'workspace_changed',
      bundle.directoryName,
    );
    if (!sameGuardedEntries(input.baseline, sourceAfterRecoverySetup)) {
      throw new RuntimeError('workspace_changed');
    }

    for (const operation of preflight.operations) {
      state = {
        ...state,
        state: 'applying',
        activeOperationIndex: operation.index,
      };
      await writeRecoveryState(bundle, state);
      input.updateRecoveryFacts(recoveryFacts(input, bundle, state));

      const attempt: AttemptedApplyOperation = {
        operation,
        mutated: false,
        ownedResult: null,
      };
      attempted.push(attempt);
      await executeApplyOperation(input, bundle, attempt);

      state = {
        ...state,
        activeOperationIndex: null,
        completedOperationCount: state.completedOperationCount + 1,
      };
      await writeRecoveryState(bundle, state);
      input.updateRecoveryFacts(recoveryFacts(input, bundle, state));
      await input.applyFaultInjectorForTesting?.({
        mutationIndex: operation.index,
        kind: operation.kind,
        relativePath: operation.relativePath,
      });
    }

    const applied = await scanTree(
      input.source.root,
      input.limits,
      input.protectedDirectoryNames,
      'source',
      'workspace_changed',
      bundle.directoryName,
    );
    if (
      !sameAuditedTree(applied, input.staged)
      || !isDeepStrictEqual(applied.protectedPaths, input.baseline.protectedPaths)
    ) throw new RuntimeError('workspace_changed');

    state = {
      ...state,
      state: 'committed',
      sourceState: 'result',
      activeOperationIndex: null,
    };
    await writeRecoveryState(bundle, state);
    committed = true;
    input.updateRecoveryFacts(recoveryFacts(input, bundle, state));
    try {
      await cleanupApplyRecoveryBundle(bundle, preflight.operations, attempted, 'committed');
    } catch {
      state = {
        ...state,
        state: 'quarantined',
        sourceState: 'result',
      };
      await writeRecoveryState(bundle, state).catch(() => undefined);
      input.updateRecoveryFacts(recoveryFacts(input, bundle, state));
      throw new RuntimeError('workspace_recovery_required');
    }
    input.updateRecoveryFacts(null);
  } catch (error) {
    if (!bundle || !state) throw normalizeApplyError(error);
    if (committed) {
      if (error instanceof RuntimeError && error.code === 'workspace_recovery_required') {
        throw error;
      }
      throw new RuntimeError('workspace_recovery_required');
    }

    state = {
      ...state,
      state: 'rolling_back',
      sourceState: 'unknown',
      activeOperationIndex: null,
    };
    await writeRecoveryState(bundle, state).catch(() => undefined);
    input.updateRecoveryFacts(recoveryFacts(input, bundle, state));

    const rollback = await rollbackApplyOperations(input, bundle, attempted, state);
    state = rollback.state;
    let sourceRestored = false;
    try {
      const restored = await scanTree(
        input.source.root,
        input.limits,
        input.protectedDirectoryNames,
        'source',
        'workspace_changed',
        bundle.directoryName,
      );
      sourceRestored = rollback.conflictCount === 0
        && sameAuditedTree(restored, input.baseline)
        && isDeepStrictEqual(restored.protectedPaths, input.baseline.protectedPaths);
    } catch {
      sourceRestored = false;
    }

    if (sourceRestored) {
      state = {
        ...state,
        state: 'rolled_back',
        sourceState: 'baseline',
        activeOperationIndex: null,
      };
      await writeRecoveryState(bundle, state).catch(() => undefined);
      input.updateRecoveryFacts(recoveryFacts(input, bundle, state));
      let recoveryCleanupSucceeded = false;
      try {
        await cleanupApplyRecoveryBundle(bundle, preflight.operations, attempted, 'rolled_back');
        recoveryCleanupSucceeded = true;
      } catch {
        recoveryCleanupSucceeded = false;
      }
      if (recoveryCleanupSucceeded) {
        input.updateRecoveryFacts(null);
        throw normalizeApplyError(error);
      }
    }

    state = {
      ...state,
      state: 'quarantined',
      sourceState: sourceRestored ? 'baseline' : 'unknown',
      activeOperationIndex: null,
    };
    await writeRecoveryState(bundle, state).catch(() => undefined);
    input.updateRecoveryFacts(recoveryFacts(input, bundle, state));
    throw new RuntimeError('workspace_recovery_required');
  }
}

async function preflightApply(input: {
  source: WorkspaceIdentity;
  staging: WorkspaceIdentity;
  baseline: TreeSnapshot;
  staged: TreeSnapshot;
  manifest: StagingWorkspaceManifest;
  protectedDirectoryNames: readonly string[];
  limits: StagingWorkspaceLimits;
}): Promise<{
  operations: ApplyOperation[];
  journal: ApplyRecoveryJournal;
  stagedContents: Map<number, Buffer>;
}> {
  await assertWorkspaceIdentity(input.source);
  await assertPrivateStagingIdentity(input.staging);
  const transactionId = randomUUID();
  const operations = buildApplyOperations(input.baseline, input.staged, input.manifest);
  const stagedContents = new Map<number, Buffer>();

  for (const operation of operations) {
    workspacePath(
      input.source.root,
      operation.relativePath,
      input.protectedDirectoryNames,
    );
    if (operation.kind !== 'install_file' || !operation.after) continue;
    const content = await readVerifiedFile(
      workspacePath(
        input.staging.root,
        operation.relativePath,
        input.protectedDirectoryNames,
      ),
      operation.after,
      'workspace_scan_failed',
    );
    stagedContents.set(operation.index, content);
  }

  const stagingAfterReads = await scanTree(
    input.staging.root,
    input.limits,
    input.protectedDirectoryNames,
    'staging',
    'workspace_scan_failed',
  );
  if (!sameGuardedTree(input.staged, stagingAfterReads)) {
    throw new RuntimeError('workspace_scan_failed');
  }
  const sourceAtMutationBoundary = await scanTree(
    input.source.root,
    input.limits,
    input.protectedDirectoryNames,
    'source',
    'workspace_changed',
  );
  if (!sameGuardedTree(input.baseline, sourceAtMutationBoundary)) {
    throw new RuntimeError('workspace_changed');
  }

  const journal: ApplyRecoveryJournal = {
    version: 1,
    transactionId,
    executionId: input.manifest.executionId,
    source: { ...input.source },
    staging: { ...input.staging },
    protectedDirectoryNames: [...input.protectedDirectoryNames],
    protectedPaths: [...input.manifest.protectedPaths],
    baselineHash: input.manifest.baselineHash,
    resultHash: input.manifest.resultHash,
    operationCount: operations.length,
    operations,
  };
  assertSerializedBound(journal, MAX_APPLY_JOURNAL_BYTES);
  return { operations, journal, stagedContents };
}

function buildApplyOperations(
  baseline: TreeSnapshot,
  staged: TreeSnapshot,
  manifest: StagingWorkspaceManifest,
): ApplyOperation[] {
  const operations: ApplyOperation[] = [];
  const add = (operation: Omit<ApplyOperation, 'index'>): void => {
    operations.push({ ...operation, index: operations.length });
  };

  const entriesToBackup = manifest.changes
    .filter((change) => (
      change.before !== null
      && !(change.before.kind === 'directory' && change.after?.kind === 'directory')
    ))
    .sort((left, right) => comparePathsDeepestFirst(left.relativePath, right.relativePath));
  for (const change of entriesToBackup) {
    const before = baseline.entries.get(change.relativePath);
    if (!before) throw new RuntimeError('workspace_changed');
    add({
      kind: 'backup_entry',
      relativePath: change.relativePath,
      before,
      after: staged.entries.get(change.relativePath) ?? null,
      backupName: operationEntryName(operations.length),
      preparedName: null,
      directoryModeBefore: null,
    });
  }

  const directoriesToCreate = manifest.changes
    .filter((change) => (
      change.after?.kind === 'directory'
      && change.before?.kind !== 'directory'
    ))
    .sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  for (const change of directoriesToCreate) {
    const after = staged.entries.get(change.relativePath);
    if (!after || after.audit.kind !== 'directory') {
      throw new RuntimeError('workspace_changed');
    }
    add({
      kind: 'create_directory',
      relativePath: change.relativePath,
      before: null,
      after,
      backupName: null,
      preparedName: null,
      directoryModeBefore: null,
    });
  }

  const filesToInstall = manifest.changes
    .filter((change) => change.after?.kind === 'file')
    .sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  for (const change of filesToInstall) {
    const after = staged.entries.get(change.relativePath);
    if (!after || after.audit.kind !== 'file') throw new RuntimeError('workspace_changed');
    add({
      kind: 'install_file',
      relativePath: change.relativePath,
      before: null,
      after,
      backupName: null,
      preparedName: operationEntryName(operations.length),
      directoryModeBefore: null,
    });
  }

  const directoriesToSet = manifest.changes
    .filter((change) => change.after?.kind === 'directory')
    .sort((left, right) => comparePathsDeepestFirst(left.relativePath, right.relativePath));
  for (const change of directoriesToSet) {
    const after = staged.entries.get(change.relativePath);
    if (!after || after.audit.kind !== 'directory') {
      throw new RuntimeError('workspace_changed');
    }
    const before = change.before?.kind === 'directory'
      ? baseline.entries.get(change.relativePath) ?? null
      : null;
    const directoryModeBefore = before?.audit.kind === 'directory'
      ? before.audit.mode
      : 0o700;
    if (directoryModeBefore === after.audit.mode) continue;
    add({
      kind: 'set_directory_mode',
      relativePath: change.relativePath,
      before,
      after,
      backupName: null,
      preparedName: null,
      directoryModeBefore,
    });
  }
  return operations;
}

function operationEntryName(index: number): string {
  return index.toString(10).padStart(8, '0');
}

async function createApplyRecoveryBundle(input: {
  source: WorkspaceIdentity;
  journal: ApplyRecoveryJournal;
  stagedContents: Map<number, Buffer>;
}): Promise<ApplyRecoveryBundle> {
  const directoryName = `${APPLY_TEMPORARY_PREFIX}${input.journal.transactionId}${APPLY_RECOVERY_SUFFIX}`;
  const root = workspacePath(input.source.root, directoryName, []);
  let created = false;
  try {
    await mkdir(root, { mode: 0o700 });
    created = true;
    await chmod(root, 0o700);
    const identity = await captureWorkspaceIdentity(root);
    if (identity.device !== input.source.device) throw new RuntimeError('workspace_changed');
    const backupsRoot = join(root, APPLY_RECOVERY_BACKUPS);
    const preparedRoot = join(root, APPLY_RECOVERY_PREPARED);
    const displacedRoot = join(root, APPLY_RECOVERY_DISPLACED);
    for (const directory of [backupsRoot, preparedRoot, displacedRoot]) {
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const backupsIdentity = await captureWorkspaceIdentity(backupsRoot);
    const preparedIdentity = await captureWorkspaceIdentity(preparedRoot);
    const displacedIdentity = await captureWorkspaceIdentity(displacedRoot);
    for (const childIdentity of [
      backupsIdentity,
      preparedIdentity,
      displacedIdentity,
    ]) {
      if (childIdentity.device !== identity.device) {
        throw new RuntimeError('workspace_changed');
      }
    }
    const bundle: ApplyRecoveryBundle = {
      transactionId: input.journal.transactionId,
      directoryName,
      sourceRoot: input.source.root,
      root,
      identity,
      journalPath: join(root, APPLY_RECOVERY_PLAN),
      statePath: join(root, APPLY_RECOVERY_STATE),
      backupsRoot,
      backupsIdentity,
      preparedRoot,
      preparedIdentity,
      displacedRoot,
      displacedIdentity,
      operationCount: input.journal.operationCount,
      preparedEntries: new Map(),
    };
    for (const operation of input.journal.operations) {
      if (operation.kind !== 'install_file' || !operation.preparedName || !operation.after) {
        continue;
      }
      const content = input.stagedContents.get(operation.index);
      if (!content || operation.after.audit.kind !== 'file') {
        throw new RuntimeError('workspace_changed');
      }
      const preparedPath = join(preparedRoot, operation.preparedName);
      await writeExclusiveFile(preparedPath, content, operation.after.audit.mode);
      bundle.preparedEntries.set(
        operation.index,
        await inspectOwnedEntry(preparedPath, 'workspace_changed'),
      );
    }
    await writeBoundedJsonExclusive(
      bundle.journalPath,
      input.journal,
      MAX_APPLY_JOURNAL_BYTES,
    );
    await syncDirectory(preparedRoot);
    await syncDirectory(backupsRoot);
    await syncDirectory(displacedRoot);
    await syncDirectory(root);
    await syncDirectory(input.source.root);
    await assertRecoveryBundleIdentity(bundle);
    return bundle;
  } catch (error) {
    if (created) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      await syncDirectory(input.source.root).catch(() => undefined);
    }
    throw normalizeApplyError(error);
  }
}

function initialApplyRecoveryState(transactionId: string): ApplyRecoveryState {
  return {
    version: 1,
    transactionId,
    state: 'prepared',
    sourceState: 'baseline',
    activeOperationIndex: null,
    completedOperationCount: 0,
    rollbackCompletedCount: 0,
    conflictCount: 0,
    firstConflictPath: null,
  };
}

function recoveryFacts(
  input: { manifest: StagingWorkspaceManifest },
  bundle: ApplyRecoveryBundle,
  state: ApplyRecoveryState,
): StagingWorkspaceRecoveryFacts {
  return {
    version: 1,
    transactionId: bundle.transactionId,
    executionId: input.manifest.executionId,
    recoveryRoot: bundle.root,
    journalPath: bundle.journalPath,
    statePath: bundle.statePath,
    state: state.state,
    sourceState: state.sourceState,
    operationCount: bundle.operationCount,
    completedOperationCount: state.completedOperationCount,
  };
}

async function writeRecoveryState(
  bundle: ApplyRecoveryBundle,
  state: ApplyRecoveryState,
  exclusive = false,
): Promise<void> {
  assertSerializedBound(state, MAX_APPLY_STATE_BYTES);
  await assertRecoveryBundleIdentity(bundle);
  if (exclusive) {
    await writeBoundedJsonExclusive(bundle.statePath, state, MAX_APPLY_STATE_BYTES);
  } else {
    const temporaryPath = join(bundle.root, `state-${randomUUID()}.tmp`);
    try {
      await writeBoundedJsonExclusive(temporaryPath, state, MAX_APPLY_STATE_BYTES);
      await rename(temporaryPath, bundle.statePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
  await syncDirectory(bundle.root);
}

async function executeApplyOperation(
  input: {
    source: WorkspaceIdentity;
    protectedDirectoryNames: readonly string[];
  },
  bundle: ApplyRecoveryBundle,
  attempt: AttemptedApplyOperation,
): Promise<void> {
  const operation = attempt.operation;
  await assertWorkspaceIdentity(input.source);
  await assertRecoveryBundleIdentity(bundle);
  await assertParentDirectories(input.source, operation.relativePath);
  const target = workspacePath(
    input.source.root,
    operation.relativePath,
    input.protectedDirectoryNames,
  );
  const parent = sourceParentPath(input.source.root, operation.relativePath);

  if (operation.kind === 'backup_entry') {
    if (!operation.before || !operation.backupName) {
      throw new RuntimeError('workspace_changed');
    }
    await assertSourceEntryMatches(target, operation.before, true);
    const backupPath = join(bundle.backupsRoot, operation.backupName);
    await assertPathAbsent(backupPath);
    await rename(target, backupPath);
    attempt.mutated = true;
    await syncDirectory(parent);
    await syncDirectory(bundle.backupsRoot);
    const moved = await inspectOwnedEntry(backupPath, 'workspace_changed');
    if (!sameOwnedEntry(moved, operation.before)) {
      throw new RuntimeError('workspace_changed');
    }
    attempt.ownedResult = moved;
    return;
  }

  if (operation.kind === 'create_directory') {
    await assertPathAbsent(target);
    await mkdir(target, { mode: 0o700 });
    attempt.mutated = true;
    await syncDirectory(parent);
    const created = await inspectOwnedEntry(target, 'workspace_changed');
    if (created.audit.kind !== 'directory' || created.audit.mode !== 0o700) {
      throw new RuntimeError('workspace_changed');
    }
    attempt.ownedResult = created;
    return;
  }

  if (operation.kind === 'install_file') {
    if (!operation.after || !operation.preparedName) {
      throw new RuntimeError('workspace_changed');
    }
    const prepared = bundle.preparedEntries.get(operation.index);
    if (!prepared || !sameAuditEntry(prepared.audit, operation.after.audit)) {
      throw new RuntimeError('workspace_changed');
    }
    const preparedPath = join(bundle.preparedRoot, operation.preparedName);
    const currentPrepared = await inspectOwnedEntry(preparedPath, 'workspace_changed');
    if (!sameOwnedEntry(currentPrepared, prepared)) {
      throw new RuntimeError('workspace_changed');
    }
    await assertPathAbsent(target);
    await link(preparedPath, target);
    attempt.mutated = true;
    attempt.ownedResult = prepared;
    await unlink(preparedPath);
    await syncDirectory(parent);
    await syncDirectory(bundle.preparedRoot);
    const installed = await inspectOwnedEntry(target, 'workspace_changed');
    if (
      !sameOwnedEntry(installed, prepared)
      || !sameAuditEntry(installed.audit, operation.after.audit)
    ) throw new RuntimeError('workspace_changed');
    attempt.ownedResult = installed;
    return;
  }

  if (
    operation.kind !== 'set_directory_mode'
    || !operation.after
    || operation.after.audit.kind !== 'directory'
    || operation.directoryModeBefore === null
  ) throw new RuntimeError('workspace_changed');
  attempt.ownedResult = await changeDirectoryModeSafely({
    path: target,
    ...(operation.before ? { expected: operation.before } : {}),
    expectedMode: operation.directoryModeBefore,
    mode: operation.after.audit.mode,
    onMutated: () => {
      attempt.mutated = true;
    },
  });
}

async function rollbackApplyOperations(
  input: {
    source: WorkspaceIdentity;
    protectedDirectoryNames: readonly string[];
  },
  bundle: ApplyRecoveryBundle,
  attempted: readonly AttemptedApplyOperation[],
  initialState: ApplyRecoveryState,
): Promise<{ state: ApplyRecoveryState; conflictCount: number }> {
  let state = initialState;
  let conflictCount = 0;
  for (const attempt of [...attempted].reverse()) {
    if (!attempt.mutated) continue;
    state = {
      ...state,
      activeOperationIndex: attempt.operation.index,
    };
    await writeRecoveryState(bundle, state).catch(() => undefined);
    let rolledBack = false;
    try {
      rolledBack = await rollbackApplyOperation(input, bundle, attempt);
    } catch {
      rolledBack = false;
    }
    if (rolledBack) {
      state = {
        ...state,
        rollbackCompletedCount: state.rollbackCompletedCount + 1,
        activeOperationIndex: null,
      };
    } else {
      conflictCount += 1;
      state = {
        ...state,
        conflictCount,
        firstConflictPath: state.firstConflictPath ?? attempt.operation.relativePath,
        activeOperationIndex: null,
      };
    }
    await writeRecoveryState(bundle, state).catch(() => undefined);
  }
  return { state, conflictCount };
}

async function rollbackApplyOperation(
  input: {
    source: WorkspaceIdentity;
    protectedDirectoryNames: readonly string[];
  },
  bundle: ApplyRecoveryBundle,
  attempt: AttemptedApplyOperation,
): Promise<boolean> {
  const operation = attempt.operation;
  await assertWorkspaceIdentity(input.source);
  await assertRecoveryBundleIdentity(bundle);
  const target = workspacePath(
    input.source.root,
    operation.relativePath,
    input.protectedDirectoryNames,
  );
  const parent = sourceParentPath(input.source.root, operation.relativePath);

  if (operation.kind === 'backup_entry') {
    if (!operation.before || !operation.backupName) return false;
    const backupPath = join(bundle.backupsRoot, operation.backupName);
    const backup = await inspectOwnedEntry(backupPath, 'workspace_changed');
    if (!sameOwnedEntry(backup, operation.before)) return false;
    if (!(await isPathAbsent(target))) return false;
    if (operation.before.audit.kind === 'file') {
      try {
        await link(backupPath, target);
      } catch {
        return false;
      }
      await unlink(backupPath);
    } else {
      try {
        await mkdir(target, { mode: operation.before.audit.mode });
      } catch {
        return false;
      }
      try {
        await rmdir(backupPath);
      } catch {
        return false;
      }
    }
    await syncDirectory(parent);
    await syncDirectory(bundle.backupsRoot);
    return true;
  }

  if (operation.kind === 'set_directory_mode') {
    if (!attempt.ownedResult || operation.directoryModeBefore === null) return false;
    try {
      await changeDirectoryModeSafely({
        path: target,
        expected: attempt.ownedResult,
        expectedMode: attempt.ownedResult.audit.mode,
        mode: operation.directoryModeBefore,
        onMutated: () => undefined,
      });
      return true;
    } catch {
      return false;
    }
  }

  if (!attempt.ownedResult) return false;
  const current = await inspectOwnedEntryIfPresent(target);
  if (!current || !sameOwnedEntry(current, attempt.ownedResult)) return false;
  const displacedPath = join(
    bundle.displacedRoot,
    operationEntryName(operation.index),
  );
  if (!(await isPathAbsent(displacedPath))) return false;
  await rename(target, displacedPath);
  await syncDirectory(parent);
  await syncDirectory(bundle.displacedRoot);
  const displaced = await inspectOwnedEntry(displacedPath, 'workspace_changed');
  if (!sameOwnedEntry(displaced, attempt.ownedResult)) return false;
  if (displaced.audit.kind === 'file') await unlink(displacedPath);
  else await rmdir(displacedPath);
  await syncDirectory(bundle.displacedRoot);
  return true;
}

async function changeDirectoryModeSafely(input: {
  path: string;
  expected?: ScannedEntry;
  expectedMode: number;
  mode: number;
  onMutated(): void;
}): Promise<ScannedEntry> {
  const beforePath = await lstat(input.path, { bigint: true });
  const canonical = await realpath(input.path);
  if (
    !beforePath.isDirectory()
    || beforePath.isSymbolicLink()
    || canonical !== input.path
    || permissionMode(beforePath) !== input.expectedMode
    || (input.expected && !sameOwnedEntry(entryFromStats(beforePath), input.expected))
  ) throw new RuntimeError('workspace_changed');
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const directoryOnly = 'O_DIRECTORY' in constants ? constants.O_DIRECTORY : 0;
  const handle = await open(input.path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStatIdentity(beforePath, opened, false)) {
      throw new RuntimeError('workspace_changed');
    }
    await handle.chmod(input.mode);
    input.onMutated();
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(input.path, { bigint: true });
    if (
      !sameStatIdentity(after, currentPath, false)
      || permissionMode(after) !== input.mode
    ) throw new RuntimeError('workspace_changed');
    return entryFromStats(after);
  } finally {
    await handle.close();
  }
}

async function cleanupApplyRecoveryBundle(
  bundle: ApplyRecoveryBundle,
  operations: readonly ApplyOperation[],
  _attempted: readonly AttemptedApplyOperation[],
  outcome: 'committed' | 'rolled_back',
): Promise<void> {
  try {
    await assertRecoveryBundleIdentity(bundle);
    const rootEntries = (await readdir(bundle.root)).sort(comparePaths);
    const expectedRootEntries = [
      APPLY_RECOVERY_BACKUPS,
      APPLY_RECOVERY_DISPLACED,
      APPLY_RECOVERY_PLAN,
      APPLY_RECOVERY_PREPARED,
      APPLY_RECOVERY_STATE,
    ].sort(comparePaths);
    if (!isDeepStrictEqual(rootEntries, expectedRootEntries)) {
      throw new RuntimeError('workspace_recovery_required');
    }

    const plan = await readBoundedJson(bundle.journalPath, MAX_APPLY_JOURNAL_BYTES);
    const persistedState = await readBoundedJson(bundle.statePath, MAX_APPLY_STATE_BYTES);
    if (
      !isRecord(plan)
      || plan.transactionId !== bundle.transactionId
      || !isRecord(persistedState)
      || persistedState.transactionId !== bundle.transactionId
    ) throw new RuntimeError('workspace_recovery_required');

    const preparedByName = new Map<string, ScannedEntry>();
    for (const operation of operations) {
      if (!operation.preparedName) continue;
      const prepared = bundle.preparedEntries.get(operation.index);
      if (!prepared) throw new RuntimeError('workspace_recovery_required');
      preparedByName.set(operation.preparedName, prepared);
    }
    for (const name of await readdir(bundle.preparedRoot)) {
      const expected = preparedByName.get(name);
      if (!expected) throw new RuntimeError('workspace_recovery_required');
      const path = join(bundle.preparedRoot, name);
      const current = await inspectOwnedEntry(path, 'workspace_changed');
      if (!sameOwnedEntry(current, expected) || current.audit.kind !== 'file') {
        throw new RuntimeError('workspace_recovery_required');
      }
      await unlink(path);
    }
    await syncDirectory(bundle.preparedRoot);

    const displaced = await readdir(bundle.displacedRoot);
    if (displaced.length !== 0) throw new RuntimeError('workspace_recovery_required');

    const backupOperations = new Map<string, ApplyOperation>();
    for (const operation of operations) {
      if (operation.backupName) backupOperations.set(operation.backupName, operation);
    }
    const backupNames = await readdir(bundle.backupsRoot);
    if (outcome === 'rolled_back' && backupNames.length !== 0) {
      throw new RuntimeError('workspace_recovery_required');
    }
    for (const name of backupNames) {
      const operation = backupOperations.get(name);
      if (!operation?.before) throw new RuntimeError('workspace_recovery_required');
      const path = join(bundle.backupsRoot, name);
      const current = await inspectOwnedEntry(path, 'workspace_changed');
      if (!sameOwnedEntry(current, operation.before)) {
        throw new RuntimeError('workspace_recovery_required');
      }
      if (current.audit.kind === 'file') await unlink(path);
      else await rmdir(path);
    }
    if (
      outcome === 'committed'
      && backupNames.length !== backupOperations.size
    ) throw new RuntimeError('workspace_recovery_required');
    await syncDirectory(bundle.backupsRoot);

    await rmdir(bundle.preparedRoot);
    await rmdir(bundle.backupsRoot);
    await rmdir(bundle.displacedRoot);
    await unlink(bundle.journalPath);
    await unlink(bundle.statePath);
    await syncDirectory(bundle.root);
    await rmdir(bundle.root);
    await syncDirectory(bundle.sourceRoot);
  } catch {
    throw new RuntimeError('workspace_recovery_required');
  }
}

async function assertRecoveryBundleIdentity(bundle: ApplyRecoveryBundle): Promise<void> {
  const info = await lstat(bundle.root, { bigint: true });
  const current = await captureWorkspaceIdentity(bundle.root);
  if (
    current.root !== bundle.identity.root
    || current.device !== bundle.identity.device
    || current.inode !== bundle.identity.inode
    || !info.isDirectory()
    || info.isSymbolicLink()
    || permissionMode(info) !== 0o700
  ) throw new RuntimeError('workspace_recovery_required');
  for (const [directory, expected] of [
    [bundle.backupsRoot, bundle.backupsIdentity],
    [bundle.preparedRoot, bundle.preparedIdentity],
    [bundle.displacedRoot, bundle.displacedIdentity],
  ] as const) {
    const child = await lstat(directory, { bigint: true });
    const currentChild = await captureWorkspaceIdentity(directory);
    if (
      !child.isDirectory()
      || child.isSymbolicLink()
      || currentChild.root !== expected.root
      || currentChild.device !== expected.device
      || currentChild.inode !== expected.inode
      || permissionMode(child) !== 0o700
    ) throw new RuntimeError('workspace_recovery_required');
  }
}

async function writeBoundedJsonExclusive(
  path: string,
  value: unknown,
  maximumBytes: number,
): Promise<void> {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > maximumBytes) {
    throw new RuntimeError('workspace_changed');
  }
  await writeExclusiveFile(path, Buffer.from(serialized), 0o600);
}

async function readBoundedJson(path: string, maximumBytes: number): Promise<unknown> {
  const info = await lstat(path, { bigint: true });
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.nlink !== 1n
    || safeFileSize(info, 'workspace_changed') > maximumBytes
  ) throw new RuntimeError('workspace_recovery_required');
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new RuntimeError('workspace_recovery_required');
  }
}

function assertSerializedBound(value: unknown, maximumBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(value)) > maximumBytes) {
    throw new RuntimeError('workspace_changed');
  }
}

async function syncDirectory(path: string): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const directoryOnly = 'O_DIRECTORY' in constants ? constants.O_DIRECTORY : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertSourceEntryMatches(
  path: string,
  expected: ScannedEntry,
  requireExactFileIdentity: boolean,
): Promise<void> {
  if (expected.audit.kind === 'file') {
    if (requireExactFileIdentity) {
      await readVerifiedFile(path, expected, 'workspace_changed');
    } else {
      const current = await inspectOwnedEntry(path, 'workspace_changed');
      if (!sameOwnedEntry(current, expected)) throw new RuntimeError('workspace_changed');
    }
    return;
  }
  // Moving changed descendants legitimately changes ancestor directory times.
  await assertDirectoryMatches(path, expected, false);
}

async function inspectOwnedEntryIfPresent(path: string): Promise<ScannedEntry | null> {
  try {
    return await inspectOwnedEntry(path, 'workspace_changed');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

async function inspectOwnedEntry(
  path: string,
  errorCode: 'workspace_changed',
): Promise<ScannedEntry> {
  try {
    const pathInfo = await lstat(path, { bigint: true });
    if (pathInfo.isSymbolicLink()) throw new RuntimeError(errorCode);
    if (pathInfo.isDirectory()) {
      const canonical = await realpath(path);
      if (canonical !== path) throw new RuntimeError(errorCode);
      return entryFromStats(pathInfo);
    }
    if (!pathInfo.isFile() || pathInfo.nlink < 1n) throw new RuntimeError(errorCode);
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameStatIdentity(pathInfo, before, true)) {
        throw new RuntimeError(errorCode);
      }
      const content = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const currentPath = await lstat(path, { bigint: true });
      if (
        !sameStatIdentity(before, after, true)
        || !sameStatIdentity(after, currentPath, true)
        || content.byteLength !== safeFileSize(after, errorCode)
      ) throw new RuntimeError(errorCode);
      return {
        audit: {
          kind: 'file',
          mode: permissionMode(after),
          size: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex'),
        },
        identity: entryIdentity(after),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw error;
  }
}

function entryFromStats(info: BigIntStats): ScannedEntry {
  if (!info.isDirectory()) throw new RuntimeError('workspace_changed');
  return {
    audit: { kind: 'directory', mode: permissionMode(info) },
    identity: entryIdentity(info),
  };
}

function sameAuditEntry(left: StagingWorkspaceEntry, right: StagingWorkspaceEntry): boolean {
  return isDeepStrictEqual(left, right);
}

function sameOwnedEntry(left: ScannedEntry, right: ScannedEntry): boolean {
  return sameAuditEntry(left.audit, right.audit)
    && sameEntryIdentity(left.identity, right.identity, false);
}

function sameGuardedEntries(left: TreeSnapshot, right: TreeSnapshot): boolean {
  return isDeepStrictEqual(left.entries, right.entries)
    && isDeepStrictEqual(left.protectedPaths, right.protectedPaths);
}

function sourceParentPath(root: string, relativePath: string): string {
  const separatorIndex = relativePath.lastIndexOf('/');
  return separatorIndex < 0
    ? root
    : workspacePath(root, relativePath.slice(0, separatorIndex), []);
}

async function isPathAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return true;
    throw error;
  }
}

function normalizeApplyError(error: unknown): RuntimeError {
  return error instanceof RuntimeError
    ? error
    : new RuntimeError('workspace_changed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function copySnapshot(
  sourceRoot: string,
  stagingRoot: string,
  snapshot: TreeSnapshot,
): Promise<void> {
  const directories = [...snapshot.entries.entries()]
    .filter((entry): entry is [string, ScannedEntry & { audit: { kind: 'directory'; mode: number } }] => (
      entry[1].audit.kind === 'directory'
    ))
    .sort(([left], [right]) => comparePaths(left, right));
  for (const [relativePath] of directories) {
    await mkdir(workspacePath(stagingRoot, relativePath, []), { mode: 0o700 });
  }

  const files = [...snapshot.entries.entries()]
    .filter((entry) => entry[1].audit.kind === 'file')
    .sort(([left], [right]) => comparePaths(left, right));
  for (const [relativePath, entry] of files) {
    const content = await readVerifiedFile(
      workspacePath(sourceRoot, relativePath, []),
      entry,
      'workspace_changed',
    );
    await writeExclusiveFile(
      workspacePath(stagingRoot, relativePath, []),
      content,
      entry.audit.mode,
    );
  }

  for (const [relativePath, entry] of directories.reverse()) {
    await chmod(workspacePath(stagingRoot, relativePath, []), entry.audit.mode);
  }
}

async function scanTree(
  root: string,
  limits: StagingWorkspaceLimits,
  protectedDirectoryNames: readonly string[],
  mode: ScanMode,
  errorCode: 'workspace_changed' | 'workspace_invalid' | 'workspace_scan_failed',
  activeRecoveryDirectoryName?: string,
): Promise<TreeSnapshot> {
  try {
    const canonicalRoot = await realpath(root);
    if (canonicalRoot !== root) throw new RuntimeError(errorCode);
    const entries = new Map<string, ScannedEntry>();
    const protectedPaths = new Map<string, 'directory' | 'file'>();
    const counters = { entries: 0, bytes: 0 };
    const rootIdentity = await scanDirectory(root, [], 0);
    return { root: rootIdentity, entries, protectedPaths };

    async function scanDirectory(
      directory: string,
      segments: string[],
      depth: number,
    ): Promise<DirectoryIdentity> {
      if (depth > limits.maxDepth) throw new RuntimeError(errorCode);
      const before = await lstat(directory, { bigint: true });
      const canonical = await realpath(directory);
      if (
        !before.isDirectory()
        || before.isSymbolicLink()
        || canonical !== directory
        || !isPathWithin(root, canonical)
      ) throw new RuntimeError(errorCode);

      const handle = await opendir(directory);
      const childNames: string[] = [];
      try {
        for (;;) {
          const child = await handle.read();
          if (!child) break;
          childNames.push(child.name);
          if (childNames.length > limits.maxEntries + protectedPaths.size + 1) {
            throw new RuntimeError(errorCode);
          }
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      childNames.sort((left, right) => left.localeCompare(right, 'en'));

      for (const childName of childNames) {
        if (!isPortablePathComponent(childName)) throw new RuntimeError(errorCode);
        const childSegments = [...segments, childName];
        const relativePath = childSegments.join('/');
        const childPath = workspacePath(root, relativePath, []);
        const info = await lstat(childPath, { bigint: true });
        if (isApplyRecoveryNamespaceName(childName)) {
          if (
            mode === 'source'
            && segments.length === 0
            && childName === activeRecoveryDirectoryName
          ) {
            const canonicalRecoveryPath = await realpath(childPath);
            if (
              !info.isDirectory()
              || info.isSymbolicLink()
              || canonicalRecoveryPath !== childPath
            ) throw new RuntimeError(errorCode);
            continue;
          }
          throw new RuntimeError(errorCode);
        }
        const protectedEntry = isProtectedDirectoryName(
          childName,
          protectedDirectoryNames,
        );
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
          throw new RuntimeError(errorCode);
        }
        if (protectedEntry) {
          if (mode === 'staging') throw new RuntimeError(errorCode);
          protectedPaths.set(relativePath, info.isDirectory() ? 'directory' : 'file');
          continue;
        }

        counters.entries += 1;
        if (counters.entries > limits.maxEntries) throw new RuntimeError(errorCode);
        if (info.isDirectory()) {
          const directoryIdentity = await scanDirectory(childPath, childSegments, depth + 1);
          entries.set(relativePath, {
            audit: { kind: 'directory', mode: permissionMode(info) },
            identity: entryIdentity(directoryIdentity),
          });
          continue;
        }
        const size = safeFileSize(info, errorCode);
        if (
          size > limits.maxFileBytes
          || counters.bytes + size > limits.maxTotalBytes
        ) throw new RuntimeError(errorCode);
        const file = await scanRegularFile(childPath, info, errorCode);
        counters.bytes += file.audit.size;
        entries.set(relativePath, file);
      }
      const after = await lstat(directory, { bigint: true });
      if (!sameStatIdentity(before, after, true)) throw new RuntimeError(errorCode);
      return directoryIdentity(after);
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(errorCode);
  }
}

async function scanRegularFile(
  path: string,
  expectedPathInfo: BigIntStats,
  errorCode: 'workspace_changed' | 'workspace_invalid' | 'workspace_scan_failed',
): Promise<ScannedFileEntry> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || !sameStatIdentity(expectedPathInfo, before, false)
    ) throw new RuntimeError(errorCode);
    const size = safeFileSize(before, errorCode);
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(path, { bigint: true });
    if (
      content.byteLength !== size
      || !sameStatIdentity(before, after, true)
      || !sameStatIdentity(after, currentPath, true)
    ) throw new RuntimeError(errorCode);
    return {
      audit: {
        kind: 'file',
        mode: permissionMode(after),
        size,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
      identity: entryIdentity(after),
    };
  } finally {
    await handle.close();
  }
}

async function readVerifiedFile(
  path: string,
  expected: ScannedEntry,
  errorCode: 'workspace_changed' | 'workspace_scan_failed',
): Promise<Buffer> {
  if (expected.audit.kind !== 'file') throw new RuntimeError(errorCode);
  const pathInfo = await lstat(path, { bigint: true });
  const current = await scanRegularFile(path, pathInfo, errorCode);
  if (!isDeepStrictEqual(current, expected)) throw new RuntimeError(errorCode);
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameStatIdentity(before, after, true)
      || !sameEntryIdentity(entryIdentity(after), expected.identity)
      || content.byteLength !== expected.audit.size
      || createHash('sha256').update(content).digest('hex') !== expected.audit.sha256
    ) throw new RuntimeError(errorCode);
    return content;
  } finally {
    await handle.close();
  }
}

async function writeExclusiveFile(path: string, content: Buffer, mode: number): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile()
      || info.nlink !== 1n
      || safeFileSize(info, 'workspace_changed') !== content.byteLength
      || permissionMode(info) !== mode
    ) throw new RuntimeError('workspace_changed');
  } finally {
    await handle.close();
  }
}

function diffTrees(before: TreeSnapshot, after: TreeSnapshot): StagingWorkspaceChange[] {
  const paths = [...new Set([...before.entries.keys(), ...after.entries.keys()])]
    .sort(comparePaths);
  const changes: StagingWorkspaceChange[] = [];
  for (const relativePath of paths) {
    const previous = before.entries.get(relativePath)?.audit ?? null;
    const current = after.entries.get(relativePath)?.audit ?? null;
    if (previous === null && current !== null) {
      changes.push({
        relativePath,
        change: 'created',
        before: null,
        after: cloneAuditEntry(current),
      });
    } else if (previous !== null && current === null) {
      changes.push({
        relativePath,
        change: 'deleted',
        before: cloneAuditEntry(previous),
        after: null,
      });
    } else if (
      previous !== null
      && current !== null
      && !isDeepStrictEqual(previous, current)
    ) {
      changes.push({
        relativePath,
        change: 'modified',
        before: cloneAuditEntry(previous),
        after: cloneAuditEntry(current),
      });
    }
  }
  return changes;
}

function auditedTreeHash(snapshot: TreeSnapshot): string {
  const entries = [...snapshot.entries.entries()]
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([relativePath, entry]) => [relativePath, entry.audit]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function sameGuardedTree(left: TreeSnapshot, right: TreeSnapshot): boolean {
  return isDeepStrictEqual(left, right);
}

function sameAuditedTree(left: TreeSnapshot, right: TreeSnapshot): boolean {
  if (!isDeepStrictEqual(left.protectedPaths, right.protectedPaths) && right.protectedPaths.size > 0) {
    return false;
  }
  const leftEntries = [...left.entries.entries()].map(([path, entry]) => [path, entry.audit]);
  const rightEntries = [...right.entries.entries()].map(([path, entry]) => [path, entry.audit]);
  return isDeepStrictEqual(leftEntries, rightEntries);
}

function assertProtectedAncestorsUnchanged(
  changes: readonly StagingWorkspaceChange[],
  protectedPaths: readonly string[],
): void {
  for (const change of changes) {
    if (change.after?.kind === 'directory') continue;
    if (protectedPaths.some((path) => (
      path === change.relativePath || path.startsWith(`${change.relativePath}/`)
    ))) {
      throw new RuntimeError('workspace_changed');
    }
  }
}

async function assertPrivateStagingIdentity(
  expected: WorkspaceIdentity,
  requirePrivateMode = true,
): Promise<void> {
  try {
    const info = await lstat(expected.root, { bigint: true });
    const current = await captureWorkspaceIdentity(expected.root);
    if (
      current.root !== expected.root
      || current.device !== expected.device
      || current.inode !== expected.inode
      || !info.isDirectory()
      || info.isSymbolicLink()
      || (requirePrivateMode && permissionMode(info) !== 0o700)
    ) throw new RuntimeError('workspace_changed');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw error;
    if (error instanceof RuntimeError && error.code === 'workspace_changed') throw error;
    throw new RuntimeError('workspace_changed');
  }
}

async function assertParentDirectories(
  workspace: WorkspaceIdentity,
  relativePath: string,
): Promise<void> {
  await assertWorkspaceIdentity(workspace);
  const segments = validateRelativePath(relativePath, []);
  let current = workspace.root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    await assertRealDirectory(current);
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== path) {
    throw new RuntimeError('workspace_changed');
  }
}

async function assertDirectoryMatches(
  path: string,
  expected: ScannedEntry,
  includeTimes: boolean,
): Promise<void> {
  if (expected.audit.kind !== 'directory') throw new RuntimeError('workspace_changed');
  const info = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || canonical !== path
    || permissionMode(info) !== expected.audit.mode
    || !sameEntryIdentity(entryIdentity(info), expected.identity, includeTimes)
  ) throw new RuntimeError('workspace_changed');
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  throw new RuntimeError('workspace_changed');
}

async function canonicalDirectory(
  path: string,
  errorCode: 'workspace_invalid',
): Promise<string> {
  if (!isAbsolute(path) || hasControlCharacters(path)) throw new RuntimeError(errorCode);
  try {
    const canonical = await realpath(path);
    const info = await lstat(canonical);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RuntimeError(errorCode);
    return canonical;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(errorCode);
  }
}

async function assertPrivateStagingParent(path: string): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true });
    const uid = process.getuid?.();
    if (uid === undefined
      || !info.isDirectory()
      || info.isSymbolicLink()
      || info.uid !== BigInt(uid)
      || permissionMode(info) !== 0o700) {
      throw new RuntimeError('workspace_invalid');
    }
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'workspace_invalid') throw error;
    throw new RuntimeError('workspace_invalid');
  }
}

function workspacePath(
  root: string,
  relativePath: string,
  protectedDirectoryNames: readonly string[],
): string {
  const segments = validateRelativePath(relativePath, protectedDirectoryNames);
  const candidate = join(root, ...segments);
  if (!isPathWithin(root, candidate) || candidate === root) {
    throw new RuntimeError('workspace_changed');
  }
  return candidate;
}

function validateRelativePath(
  relativePath: string,
  protectedDirectoryNames: readonly string[],
): string[] {
  if (
    relativePath.length === 0
    || relativePath.startsWith('/')
    || relativePath.endsWith('/')
    || hasControlCharacters(relativePath)
  ) throw new RuntimeError('workspace_changed');
  const segments = relativePath.split('/');
  if (
    segments.some((segment) => (
      !isPortablePathComponent(segment)
        || isProtectedDirectoryName(segment, protectedDirectoryNames)
    ))
  ) throw new RuntimeError('workspace_changed');
  return segments;
}

function resolveProtectedDirectoryNames(input: readonly string[] | undefined): readonly string[] {
  const namesBySecurityKey = new Map<string, string>();
  for (const name of [REQUIRED_PROTECTED_DIRECTORY, ...(input ?? [])]) {
    if (!isPortablePathComponent(name)) throw new RuntimeError('execution_invalid');
    const key = portableNameSecurityKey(name);
    if (!namesBySecurityKey.has(key)) namesBySecurityKey.set(key, name);
  }
  const names = [...namesBySecurityKey.values()]
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (
    names.length > 32
  ) throw new RuntimeError('execution_invalid');
  return names;
}

function isProtectedDirectoryName(
  candidate: string,
  protectedDirectoryNames: readonly string[],
): boolean {
  const candidateKey = portableNameSecurityKey(candidate);
  return protectedDirectoryNames.some((name) => (
    portableNameSecurityKey(name) === candidateKey
  ));
}

function portableNameSecurityKey(value: string): string {
  // APFS commonly aliases case and canonical Unicode forms.  Treat both as a
  // security equivalence even on a case-sensitive test filesystem so a path
  // reviewed on one volume cannot become protected metadata on another.
  return value.normalize('NFKC').toLowerCase();
}

function isApplyRecoveryNamespaceName(candidate: string): boolean {
  return portableNameSecurityKey(candidate).startsWith(
    portableNameSecurityKey(APPLY_TEMPORARY_PREFIX),
  );
}

function resolveLimits(input: Partial<StagingWorkspaceLimits> | undefined): StagingWorkspaceLimits {
  const limits = { ...DEFAULT_STAGING_WORKSPACE_LIMITS, ...input };
  assertIntegerRange(limits.maxEntries, 1, 20_000);
  assertIntegerRange(limits.maxFileBytes, 1, 32 * 1024 * 1024);
  assertIntegerRange(limits.maxTotalBytes, 1, 256 * 1024 * 1024);
  assertIntegerRange(limits.maxDepth, 1, 64);
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new RuntimeError('execution_invalid');
  }
  return limits;
}

function assertIntegerRange(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RuntimeError('execution_invalid');
  }
}

function validateExecutionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}[A-Za-z0-9]$/u.test(value)) {
    throw new RuntimeError('execution_invalid');
  }
}

function cloneAuditEntry(entry: StagingWorkspaceEntry): StagingWorkspaceEntry {
  return { ...entry };
}

function directoryIdentity(info: BigIntStats): DirectoryIdentity {
  return { ...entryIdentity(info), mode: permissionMode(info) };
}

function entryIdentity(
  info: BigIntStats | DirectoryIdentity,
): EntryIdentity {
  if ('device' in info) {
    return {
      device: info.device,
      inode: info.inode,
      modifiedNanoseconds: info.modifiedNanoseconds,
      changedNanoseconds: info.changedNanoseconds,
    };
  }
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    modifiedNanoseconds: info.mtimeNs.toString(),
    changedNanoseconds: info.ctimeNs.toString(),
  };
}

function sameEntryIdentity(
  left: EntryIdentity,
  right: EntryIdentity,
  includeTimes = true,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && (!includeTimes || (
      left.modifiedNanoseconds === right.modifiedNanoseconds
      && left.changedNanoseconds === right.changedNanoseconds
    ));
}

function sameStatIdentity(
  left: BigIntStats,
  right: BigIntStats,
  includeTimes: boolean,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && (!includeTimes || (left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs));
}

function safeFileSize(
  info: BigIntStats,
  errorCode: 'workspace_changed' | 'workspace_invalid' | 'workspace_scan_failed',
): number {
  const size = Number(info.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new RuntimeError(errorCode);
  return size;
}

function permissionMode(info: BigIntStats): number {
  return Number(info.mode & 0o777n);
}

function isPortablePathComponent(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes(':')
    && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function comparePaths(left: string, right: string): number {
  const depth = pathDepth(left) - pathDepth(right);
  return depth === 0 ? left.localeCompare(right, 'en') : depth;
}

function comparePathsDeepestFirst(left: string, right: string): number {
  return -comparePaths(left, right);
}

function pathDepth(path: string): number {
  return path.split('/').length;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
