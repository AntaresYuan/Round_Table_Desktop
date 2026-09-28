import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_MACH_SERVICE,
  BROKER_IDENTIFIER,
  BROKER_LABEL,
  CLIENT_IDENTIFIER,
  DevelopmentGateError,
  SERVICE_UID_MAXIMUM,
  SYSTEM_MUTATION_STATES,
  TRANSACTION_JOURNAL_ROOT,
  administratorFailureResult,
  auditedResidualState,
  canaryLabelForRun,
  canaryPlistPathForRun,
  chooseFreeServiceUid,
  commandFailureDiagnostic,
  createAuthorizationLauncherArguments,
  createDryRunReport,
  createRecoveryProbeRecoveryContext,
  createRecoveryProbeManifest,
  directoryServicePermissionDenied,
  hostLabelForRun,
  installedOutputOwnership,
  parseCliArguments,
  parseDirectoryServiceProperty,
  parseDirectoryServiceIds,
  pinnedRequirementCdHash,
  protectedRoleAccountHomeMetadataMatches,
  publicError,
  readNativeAdministratorHelperHash,
  readNativeAuthorizationLauncherHash,
  recoveryCleanupDiagnostic,
  renderBrokerLaunchDaemon,
  renderCanaryLaunchDaemon,
  shouldRecoverJournalLegacyIdentity,
  validateAdminManifestShape,
  validateAdministratorTransactionResult,
  validateCanaryResult,
  validateHostGateLock,
  validateTransactionJournalShape,
  TRANSACTION_PHASES,
  RESIDUAL_STATES,
  isValidTransactionPhaseTransition,
  isRecoverablePendingJournalTransition,
} from '../scripts/run-service-uid-development-gate.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL(
  '../scripts/run-service-uid-development-gate.mjs',
  import.meta.url,
));
const runId = '0123456789abcdef0123456789abcdef';
const hostRoot = `/private/tmp/roundtable-p4-${runId}`;

describe('service UID development gate harness', () => {
  it('is dry-run only unless the exact run flag is supplied', () => {
    expect(parseCliArguments([])).toEqual({ mode: 'dry-run' });
    expect(parseCliArguments(['--dry-run'])).toEqual({ mode: 'dry-run' });
    expect(parseCliArguments(['--run'])).toEqual({ mode: 'run' });
    expect(parseCliArguments([
      '--internal-admin-transaction',
      '/private/tmp/manifest.json',
    ])).toEqual({
      mode: 'admin-transaction',
      manifestPath: '/private/tmp/manifest.json',
    });
    expect(parseCliArguments([
      '--internal-admin-recovery-probe',
      '/private/tmp/manifest.json',
    ])).toEqual({
      mode: 'admin-recovery-probe',
      manifestPath: '/private/tmp/manifest.json',
    });
    for (const oldFlag of [
      '--internal-admin-trust',
      '--internal-admin-install',
      '--internal-admin-cleanup',
    ]) {
      expect(() => parseCliArguments([oldFlag, '/private/tmp/manifest.json']))
        .toThrow(DevelopmentGateError);
    }
    expect(() => parseCliArguments(['--run', 'unexpected'])).toThrow(
      DevelopmentGateError,
    );
    const report = createDryRunReport('darwin');
    expect(report.plannedChecks).toContain('sigkill-journal-recovery');
    expect(report).toMatchObject({
      result: 'planned_not_run',
      authorizationRequested: false,
      authorizationRequestCount: 0,
      systemMutationsPerformed: false,
      systemTrustModified: false,
      residualSystemState: false,
      residualState: 'unknown',
      supportedHost: true,
      topology: {
        administratorTransactions: 1,
        systemTrust: 'never-modified',
        peerRequirement: 'exact-identifier-and-code-directory-hash',
      },
      scope: { phase4CompletionClaimed: false },
    });
  });

  it('keeps residual state unknown when dry-run performs no system observation', () => {
    expect(RESIDUAL_STATES).toEqual([
      'absent', 'present', 'unknown', 'cleanup-incomplete', 'quarantined',
    ]);
    expect(createDryRunReport('darwin').residualState).toBe('unknown');
    expect(SYSTEM_MUTATION_STATES).toEqual([
      'none-observed', 'performed', 'unknown',
    ]);
    expect(createDryRunReport('darwin').systemMutationState).toBe(
      'none-observed',
    );
  });

  it('preserves validated root quarantine through the independent host audit', () => {
    expect(auditedResidualState(true, { residualState: 'quarantined' }))
      .toBe('quarantined');
    expect(auditedResidualState(true, { residualState: 'cleanup-incomplete' }))
      .toBe('cleanup-incomplete');
    expect(auditedResidualState(true, null)).toBe('present');
    expect(auditedResidualState(false, { residualState: 'quarantined' }))
      .toBe('absent');
  });

  it('accepts one exact host lock and rejects substituted ownership', () => {
    const lock = {
      schemaVersion: 1,
      kind: 'roundtable-service-uid-development-gate-host-lock-v1',
      pid: process.pid,
      uid: process.getuid(),
      gid: process.getgid(),
      ownershipToken: 'ab'.repeat(32),
      startedAt: '2026-09-11T00:00:00.000Z',
      notAfter: '2026-09-11T00:06:00.000Z',
    };
    expect(validateHostGateLock(lock)).toBe(lock);
    expect(() => validateHostGateLock({
      ...lock,
      uid: lock.uid + 1,
    })).toThrow('host_gate_lock_invalid');
    expect(() => validateHostGateLock({
      ...lock,
      extra: true,
    })).toThrow('host_gate_lock_invalid');
  });

  it('returns a strict fail-closed envelope for root preflight failures', () => {
    expect(administratorFailureResult(new DevelopmentGateError(
      'invalid_admin_manifest',
      'admin-preflight',
    ))).toEqual({
      schemaVersion: 1,
      action: 'admin-transaction',
      result: 'cleanup_incomplete',
      crashRecoveryVerified: false,
      systemMutationsPerformed: false,
      systemTrustModified: false,
      residualState: 'unknown',
      cleanup: {
        schemaVersion: 1,
        action: 'admin-rollback',
        result: 'cleanup_incomplete',
        stagingEvidence: 'not_observed',
        serviceUidZeroProcesses: false,
        accountRemoved: false,
        fixedResourcesRemoved: false,
        errors: ['invalid_admin_manifest'],
      },
      error: {
        code: 'invalid_admin_manifest',
        stage: 'admin-preflight',
      },
    });
  });

  it('accepts completion only with explicit crash-recovery evidence', () => {
    const completed = {
      schemaVersion: 1,
      action: 'admin-transaction',
      result: 'completed',
      crashRecoveryVerified: true,
      systemMutationsPerformed: true,
      systemTrustModified: false,
      residualState: 'absent',
      cleanup: {
        schemaVersion: 1,
        action: 'admin-rollback',
        result: 'cleaned',
        stagingEvidence: 'verified',
        serviceUidZeroProcesses: true,
        accountRemoved: true,
        fixedResourcesRemoved: true,
        errors: [],
      },
    };
    expect(validateAdministratorTransactionResult(completed)).toBe(completed);
    expect(() => validateAdministratorTransactionResult({
      ...completed,
      crashRecoveryVerified: false,
    })).toThrow('invalid_administrator_response');
    expect(() => validateAdministratorTransactionResult({
      ...completed,
      recoveryDiagnostic: true,
    })).toThrow('invalid_administrator_response');
  });

  it('builds one exact native authorization launcher invocation', () => {
    const packageDirectory = [
      '/private/var/tmp/roundtable-service-uid-development-gate-admin-',
      runId,
      '-',
      'ab'.repeat(16),
    ].join('');
    const targets = [
      'admin-helper',
      'node',
      'admin-runner.mjs',
      'admin-manifest.json',
      'broker',
      'canary',
    ].map((name) => `${packageDirectory}/${name}`);
    const modes = ['0500', '0500', '0500', '0400', '0500', '0500'];
    const inputs = targets.map((target, index) => [
      `/private/tmp/source-${index}`,
      target,
      'ab'.repeat(32),
      modes[index],
    ]);
    const argumentsList = createAuthorizationLauncherArguments(
      packageDirectory,
      inputs,
    );
    expect(argumentsList).toHaveLength(13);
    expect(argumentsList[0]).toBe(packageDirectory);
    expect(argumentsList.slice(1)).toEqual(inputs.flatMap(
      ([source, , hash]) => [source, hash],
    ));
    expect(argumentsList.join(' ')).not.toContain('/bin/sh');
    expect(() => createAuthorizationLauncherArguments(packageDirectory, [
      ...inputs.slice(0, 5),
      [
        '/private/tmp/source-5',
        '/private/tmp/substituted-canary',
        'ab'.repeat(32),
        '0500',
      ],
    ])).toThrow('invalid_sealed_input_set');
  });

  it('executes dry-run without entering the administrator path', async () => {
    const result = await execFileAsync(process.execPath, [scriptPath, '--dry-run'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'dry-run',
      result: 'planned_not_run',
      authorizationRequested: false,
      authorizationRequestCount: 0,
      systemMutationsPerformed: false,
      systemTrustModified: false,
      topology: {
        brokerLaunchDaemon: BROKER_LABEL,
        bootstrapMachService: BOOTSTRAP_MACH_SERVICE,
      },
    });
  });

  it('uses one administrator transaction and contains no trust-store mutation path', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain("'--internal-admin-transaction'");
    expect(source).toContain("'--internal-admin-recovery-probe'");
    expect(source).not.toContain("'--internal-admin-trust'");
    expect(source).not.toContain("'--internal-admin-install'");
    expect(source).not.toContain("'--internal-admin-cleanup'");
    expect(source).not.toContain('System.keychain');
    expect(source).not.toContain('add-trusted-cert');
    expect(source).not.toContain('remove-trusted-cert');
    expect(source).not.toContain('delete-certificate');
  });

  it('routes the single administrator transaction through the sealed native root helper', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain('roundtable-service-uid-admin-helper');
    expect(source).toContain('roundtable-service-uid-authorization-launcher');
    expect(source).toContain('sealed.helper');
    expect(source).toContain("[ADMIN_HELPER_SOURCE, sealed.helper");
    expect(source).toContain('sealed.helper,\n    sealed.node');
    expect(source).toContain('readNativeAdministratorHelperHash');
    expect(source).toContain('administrator_helper_hash_mismatch');
    expect(source).toContain('authorization_launcher_hash_mismatch');
    expect(source).toContain('NATIVE_ADMINISTRATOR_HELPER_MANIFEST');
    expect(source).toContain('NATIVE_AUTHORIZATION_LAUNCHER_MANIFEST');
    expect(source).not.toContain('osascript');
    expect(source).not.toContain('with administrator privileges');
    expect(await readNativeAdministratorHelperHash()).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readNativeAuthorizationLauncherHash()).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('keeps the native authorization protocol narrow before prompting', async () => {
    const launcherPath = fileURLToPath(new URL(
      `../native/bin/${process.arch}/roundtable-service-uid-authorization-launcher`,
      import.meta.url,
    ));
    const selfTest = await execFileAsync(launcherPath, ['--self-test'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(selfTest).toEqual(expect.objectContaining({
      stdout: 'roundtable-service-uid-authorization-launcher self-test ok\n',
      stderr: '',
    }));
    await expect(execFileAsync(launcherPath, [], {
      encoding: 'utf8',
      timeout: 5_000,
    })).rejects.toMatchObject({
      code: 64,
      stderr: expect.stringContaining('invalid fixed invocation'),
    });

    const launcherSource = await readFile(fileURLToPath(new URL(
      '../native/roundtable-service-uid-authorization-launcher.c',
      import.meta.url,
    )), 'utf8');
    const helperSource = await readFile(fileURLToPath(new URL(
      '../native/roundtable-service-uid-admin-helper.c',
      import.meta.url,
    )), 'utf8');
    expect(launcherSource.match(/kAuthorizationFlagInteractionAllowed/gu))
      .toHaveLength(1);
    expect(launcherSource).not.toContain('kAuthorizationFlagPreAuthorize');
    expect(launcherSource).toContain('AuthorizationMakeExternalForm');
    expect(launcherSource).toContain('AuthorizationExecuteWithPrivileges');
    expect(launcherSource).toContain('char *const shell_arguments[] = {"-s", NULL}');
    expect(launcherSource).not.toContain('char *const shell_arguments[] = {"-c"');
    expect(helperSource).toContain('AuthorizationCreateFromExternalForm');
    expect(helperSource).not.toContain('kAuthorizationFlagInteractionAllowed');
    expect(helperSource).toContain('unlink(path) == 0');
  });

  it('recovers only an exact prior installation marker before preflight', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain('recoverPreviousTransactionIfPresent(manifest)');
    expect(source).toContain('previous_transaction_cleanup_incomplete');
    expect(source).toContain('validateTransactionJournalShape(value)');
    expect(source).toContain('manifestSha256(manifest)');
    expect(source).toContain('recoverLegacyIdentityFromJournal(journal.manifest)');
    expect(source).toContain('journalLegacyIdentityMayRemain()');
    expect(source).toContain('journal.recoveryOriginPhase ?? interruptedPhase');
  });

  it('does not reinterpret a proven interrupted identity as embedded legacy residue', () => {
    expect(shouldRecoverJournalLegacyIdentity('candidate', true, true))
      .toBe(false);
    expect(shouldRecoverJournalLegacyIdentity('candidate', false, true))
      .toBe(true);
    expect(shouldRecoverJournalLegacyIdentity('absent', false, true))
      .toBe(false);
    expect(shouldRecoverJournalLegacyIdentity('candidate', false, false))
      .toBe(false);
  });

  it('binds a real SIGKILL recovery probe into the same administrator transaction', async () => {
    const manifest = validManifest();
    const probe = createRecoveryProbeManifest(
      manifest,
      manifest.legacyRecovery,
      Date.parse('2026-09-11T00:00:00.000Z'),
    );
    expect(probe.runId).toMatch(/^[a-f0-9]{32}$/u);
    expect(probe.runId).not.toBe(manifest.runId);
    expect(probe.ownershipToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(probe.ownershipToken).not.toBe(manifest.ownershipToken);
    expect(probe.transaction).toMatchObject({
      notAfter: '2026-09-11T00:00:01.000Z',
      maximumDurationMs: 300_000,
      recoveryJournalPresent: false,
    });
    expect(probe.transaction.testSet[0]).toBe('sigkill-journal-recovery');
    expect(probe.host.privateRoot).toContain(probe.runId);
    expect(() => createRecoveryProbeManifest(
      manifest,
      manifest.legacyRecovery,
      Date.parse(manifest.transaction.notAfter),
    )).toThrow('administrator_action_timeout');

    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain("process.kill(process.pid, 'SIGKILL')");
    expect(source).toContain('exerciseSigkillJournalRecovery(');
    expect(source).toContain("childResult.signal !== 'SIGKILL'");
    expect(source).toContain('host_root_recovery_journal_mismatch');
    expect(source).toContain('expectedLiveControllerPid: process.pid');
    expect(source).toContain('journal.controllerPid === process.pid');
  });

  it('recovers a SIGKILL probe with the probe journal state after earlier cleanup', () => {
    const interruptedEvidence = validInterruptedHostEvidence();
    const outer = {
      ...validManifest(),
      transaction: {
        ...validManifest().transaction,
        recoveryJournalPresent: true,
      },
      legacyRecovery: {
        state: 'interrupted-candidate',
        runId: interruptedEvidence.marker.runId,
        fingerprint: createHash('sha256')
          .update(JSON.stringify(interruptedEvidence))
          .digest('hex'),
        hostEvidence: interruptedEvidence,
      },
    };
    const absent = {
      state: 'absent',
      runId: null,
      fingerprint: null,
      hostEvidence: null,
    };
    const probe = createRecoveryProbeManifest(
      outer,
      absent,
      Date.parse('2026-09-11T00:00:00.000Z'),
    );
    const journal = {
      path: `${TRANSACTION_JOURNAL_ROOT}/phase4-transactions/active-transaction.json`,
      schemaVersion: 2,
      kind: 'roundtable-service-uid-admin-transaction-journal-v2',
      runId: probe.runId,
      ownershipToken: probe.ownershipToken,
      serviceUid: probe.serviceUid,
      administratorPid: 1234,
      controllerPid: 5678,
      startedAt: '2026-09-11T00:00:00.000Z',
      deadlineAt: probe.transaction.notAfter,
      phase: 'preflight',
      recoveryOriginPhase: null,
      manifest: probe,
      manifestSha256: createHash('sha256')
        .update(JSON.stringify(probe))
        .digest('hex'),
    };
    const context = createRecoveryProbeRecoveryContext(outer, journal);
    expect(context.runId).toBe(outer.runId);
    expect(context.ownershipToken).toBe(outer.ownershipToken);
    expect(context.legacyRecovery).toEqual(absent);
    expect(outer.legacyRecovery.state).toBe('interrupted-candidate');
    expect(() => createRecoveryProbeRecoveryContext(outer, {
      ...journal,
      path: '/private/tmp/substituted-journal.json',
    })).toThrow('recovery_probe_journal_mismatch');
  });

  it('uses a root-owned journal with monotonic phases and quarantine on cleanup failure', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain("roundtable-service-uid-admin-transaction-journal-v2");
    expect(TRANSACTION_JOURNAL_ROOT).toBe('/private/var/db/roundtable');
    expect(source).toContain("active-transaction.json");
    expect(source).toContain('recoverEmptyTransactionJournalScaffolding');
    expect(source).toContain('development_gate_already_running');
    expect(source).toContain('transaction_journal_ownership_mismatch');
    expect(source).toContain('transaction_journal_transition_invalid');
    expect(source).toContain("cleanup.result === 'cleaned' ? 'rolled-back' : 'quarantined'");
    expect(source).toContain('removeTransactionJournal(journal)');
    expect(source).toContain('const wallClockRemaining = Date.parse(manifest.transaction.notAfter) - Date.now()');
    expect(source).toContain('const transactionDeadline = performance.now() + Math.min(');
    expect(source).toContain("assertTransactionDeadline('bootstrap')");
    expect(source).toContain("assertTransactionDeadline('canary')");
    expect(source).toContain("|| stagingEvidence === 'not_written'");
    expect(source).toContain('stagingWasNotYetRequired');
  });

  it('accepts only forward journal transitions and terminal rollback outcomes', () => {
    expect(TRANSACTION_PHASES[0]).toBe('preflight');
    expect(isValidTransactionPhaseTransition('preflight', 'root-published')).toBe(true);
    expect(isValidTransactionPhaseTransition('preflight', 'host-acknowledged')).toBe(false);
    expect(isValidTransactionPhaseTransition('root-published', 'preflight')).toBe(false);
    expect(isValidTransactionPhaseTransition('host-acknowledged', 'rolling-back')).toBe(true);
    expect(isValidTransactionPhaseTransition('rolling-back', 'rolled-back')).toBe(true);
    expect(isValidTransactionPhaseTransition('rolling-back', 'quarantined')).toBe(true);
    expect(isValidTransactionPhaseTransition('preflight', 'quarantined')).toBe(false);
    expect(isValidTransactionPhaseTransition('quarantined', 'recovery-rolling-back'))
      .toBe(true);
    expect(isValidTransactionPhaseTransition('recovery-rolling-back', 'recovered'))
      .toBe(true);
  });

  it('binds a recovery journal to the complete frozen administrator manifest', () => {
    const manifest = validManifest();
    const journal = {
      schemaVersion: 2,
      kind: 'roundtable-service-uid-admin-transaction-journal-v2',
      runId: manifest.runId,
      ownershipToken: manifest.ownershipToken,
      serviceUid: manifest.serviceUid,
      administratorPid: 1234,
      controllerPid: 5678,
      startedAt: '2026-09-11T00:00:00.000Z',
      deadlineAt: '2026-09-11T00:05:00.000Z',
      phase: 'preflight',
      recoveryOriginPhase: null,
      manifest,
      manifestSha256: createHash('sha256')
        .update(JSON.stringify(manifest))
        .digest('hex'),
    };
    expect(validateTransactionJournalShape(journal)).toEqual(journal);
    const {
      recoveryOriginPhase: _legacyMissingOrigin,
      controllerPid: _legacyMissingController,
      ...legacyJournal
    } = journal;
    expect(validateTransactionJournalShape(legacyJournal)).toEqual(legacyJournal);
    expect(() => validateTransactionJournalShape({
      ...journal,
      serviceUid: manifest.serviceUid - 1,
    })).toThrow('transaction_journal_invalid');
    expect(() => validateTransactionJournalShape({
      ...journal,
      manifestSha256: '00'.repeat(32),
    })).toThrow('transaction_journal_invalid');
    expect(() => validateTransactionJournalShape({
      ...journal,
      extra: true,
    })).toThrow('transaction_journal_invalid');
  });

  it('accepts only one valid atomic pending journal transition', () => {
    const manifest = validManifest();
    const active = {
      schemaVersion: 2,
      kind: 'roundtable-service-uid-admin-transaction-journal-v2',
      runId: manifest.runId,
      ownershipToken: manifest.ownershipToken,
      serviceUid: manifest.serviceUid,
      administratorPid: 1234,
      controllerPid: 5678,
      startedAt: '2026-09-11T00:00:00.000Z',
      deadlineAt: '2026-09-11T00:05:00.000Z',
      phase: 'preflight',
      recoveryOriginPhase: null,
      manifest,
      manifestSha256: createHash('sha256')
        .update(JSON.stringify(manifest))
        .digest('hex'),
    };
    const pending = {
      ...active,
      phase: 'root-published',
      updatedAt: '2026-09-11T00:00:01.000Z',
    };
    expect(isRecoverablePendingJournalTransition(active, pending)).toBe(true);
    expect(isRecoverablePendingJournalTransition(active, {
      ...pending,
      ownershipToken: 'ef'.repeat(32),
    })).toBe(false);
    expect(isRecoverablePendingJournalTransition(active, {
      ...pending,
      controllerPid: active.controllerPid + 1,
    })).toBe(false);
    expect(isRecoverablePendingJournalTransition(active, {
      ...pending,
      phase: 'host-acknowledged',
    })).toBe(false);
    expect(isRecoverablePendingJournalTransition(active, {
      ...pending,
      updatedAt: '2026-09-10T23:59:59.000Z',
    })).toBe(false);
    expect(isRecoverablePendingJournalTransition(active, {
      ...pending,
      phase: 'recovery-rolling-back',
      recoveryOriginPhase: 'preflight',
    })).toBe(true);
    expect(isRecoverablePendingJournalTransition(active, {
      ...pending,
      phase: 'recovery-rolling-back',
      recoveryOriginPhase: 'identity-created',
    })).toBe(false);
  });

  it('preserves bounded cleanup diagnostics for a failed recovery', () => {
    expect(recoveryCleanupDiagnostic({
      errors: ['service_identity_ownership_mismatch'],
      serviceUidZeroProcesses: true,
      accountRemoved: false,
      fixedResourcesRemoved: true,
      stagingEvidence: 'not_present',
    })).toBe([
      'service_identity_ownership_mismatch',
      'account_removal_unproven',
      'staging_not_present',
    ].join(','));
  });

  it('reports a bounded, single-line administrator command diagnostic', () => {
    const diagnostic = commandFailureDiagnostic('/usr/bin/codesign', {
      status: 1,
      stdout: '',
      stderr: 'first line\nsecond\u0000line',
    });
    expect(diagnostic).toBe('codesign exited 1: first line second line');
    expect(publicError(new DevelopmentGateError(
      'command_failed',
      'build',
      diagnostic,
    ))).toEqual({
      code: 'command_failed',
      stage: 'build',
      diagnostic,
    });
  });

  it('accepts only an exact identifier-and-CDHash development pin', () => {
    const cdhash = 'ab'.repeat(20);
    expect(pinnedRequirementCdHash(
      `identifier "${CLIENT_IDENTIFIER}" and cdhash H"${cdhash.toUpperCase()}"`,
      CLIENT_IDENTIFIER,
    )).toBe(cdhash);
    expect(() => pinnedRequirementCdHash(
      `identifier "${CLIENT_IDENTIFIER}"`,
      CLIENT_IDENTIFIER,
    )).toThrow('invalid_pinned_peer_requirement');
    expect(() => pinnedRequirementCdHash(
      `identifier "${BROKER_IDENTIFIER}" and cdhash H"${cdhash}"`,
      CLIENT_IDENTIFIER,
    )).toThrow('invalid_pinned_peer_requirement');
  });

  it('renders the root broker and low-privilege canary as distinct jobs', () => {
    const manifest = validManifest();
    const broker = renderBrokerLaunchDaemon(manifest);
    const canary = renderCanaryLaunchDaemon(manifest);
    expect(broker).toContain(`<key>${BOOTSTRAP_MACH_SERVICE}</key>`);
    expect(broker).toContain('<string>--allowed-client-euid</string>');
    expect(broker).toContain('<string>501</string>');
    expect(broker).toContain('<string>--accepted-client-cdhash</string>');
    expect(broker).toContain(`<string>${'05'.repeat(20)}</string>`);
    expect(broker).not.toContain('<key>UserName</key>');
    expect(canary).toContain('<key>UserName</key>');
    expect(canary).toContain('<string>_roundtable_p4_gate</string>');
    expect(canary).toContain(`<string>${hostLabelForRun(runId)}</string>`);
    expect(canaryLabelForRun(runId).endsWith(runId)).toBe(true);
    expect(canaryPlistPathForRun(runId)).toBe(
      `/Library/LaunchDaemons/${canaryLabelForRun(runId)}.plist`,
    );
    expect(installedOutputOwnership(499)).toEqual({
      brokerStderr: { mode: 0o644, uid: 0, gid: 0 },
      canaryStdout: { mode: 0o600, uid: 499, gid: 499 },
      canaryStderr: { mode: 0o600, uid: 499, gid: 499 },
    });
    expect(() => installedOutputOwnership(501)).toThrow('invalid_admin_manifest');
  });

  it('accepts only an exact bounded administrator manifest', () => {
    expect(validateAdminManifestShape(validManifest())).toEqual(validManifest());
    expect(validateAdminManifestShape({
      ...validManifest(),
      serviceIdentity: {
        ...validManifest().serviceIdentity,
        userGeneratedUid: null,
      },
    })).toMatchObject({
      serviceIdentity: { userGeneratedUid: null },
    });
    expect(validateAdminManifestShape({
      ...validManifest(),
      legacyRecovery: {
        state: 'candidate',
        runId: '305d458c89ed546f9c3d2446642be2e4',
        fingerprint: 'ab'.repeat(32),
        hostEvidence: validLegacyHostEvidence(),
      },
    })).toMatchObject({ legacyRecovery: { state: 'candidate' } });
    expect(validateAdminManifestShape({
      ...validManifest(),
      transaction: {
        ...validManifest().transaction,
        recoveryJournalPresent: true,
      },
      legacyRecovery: {
        state: 'candidate',
        runId: '305d458c89ed546f9c3d2446642be2e4',
        fingerprint: 'ab'.repeat(32),
        hostEvidence: {
          ...validLegacyHostEvidence(),
          transactionJournalRootPresent: true,
        },
      },
    })).toMatchObject({
      transaction: { recoveryJournalPresent: true },
      legacyRecovery: {
        hostEvidence: { transactionJournalRootPresent: true },
      },
    });
    const partialLegacyEvidence = {
      ...validLegacyHostEvidence(),
      groupRecordsWithGid: [],
      transactionJournalRootPresent: true,
    };
    expect(validateAdminManifestShape({
      ...validManifest(),
      transaction: {
        ...validManifest().transaction,
        recoveryJournalPresent: true,
      },
      legacyRecovery: {
        state: 'candidate',
        runId: '305d458c89ed546f9c3d2446642be2e4',
        fingerprint: '88d1920a6637e76b6d315f96325f0e10ba09a9e765b1c2181b9af41cfb48ea62',
        hostEvidence: partialLegacyEvidence,
      },
    })).toMatchObject({
      legacyRecovery: {
        hostEvidence: { groupRecordsWithGid: [] },
      },
    });
    const interruptedHostEvidence = validInterruptedHostEvidence();
    const interruptedRecovery = {
      state: 'interrupted-candidate',
      runId: interruptedHostEvidence.marker.runId,
      fingerprint: createHash('sha256').update(
        JSON.stringify(interruptedHostEvidence),
      ).digest('hex'),
      hostEvidence: interruptedHostEvidence,
    };
    expect(validateAdminManifestShape({
      ...validManifest(),
      transaction: {
        ...validManifest().transaction,
        recoveryJournalPresent: true,
      },
      legacyRecovery: interruptedRecovery,
    })).toMatchObject({
      legacyRecovery: { state: 'interrupted-candidate' },
    });
    expect(() => validateAdminManifestShape({
      ...validManifest(),
      transaction: {
        ...validManifest().transaction,
        recoveryJournalPresent: true,
      },
      legacyRecovery: {
        ...interruptedRecovery,
        hostEvidence: {
          ...interruptedHostEvidence,
          serviceUidProcessCount: 1,
        },
      },
    })).toThrow('invalid_admin_manifest');
    const sysadminctlInterrupted = validSysadminctlInterruptedHostEvidence();
    expect(validateAdminManifestShape({
      ...validManifest(),
      transaction: {
        ...validManifest().transaction,
        recoveryJournalPresent: true,
      },
      legacyRecovery: {
        state: 'interrupted-candidate',
        runId: sysadminctlInterrupted.marker.runId,
        fingerprint: createHash('sha256').update(
          JSON.stringify(sysadminctlInterrupted),
        ).digest('hex'),
        hostEvidence: sysadminctlInterrupted,
      },
    })).toMatchObject({
      legacyRecovery: { state: 'interrupted-candidate' },
    });
    expect(() => validateAdminManifestShape({
      ...validManifest(),
      transaction: {
        ...validManifest().transaction,
        recoveryJournalPresent: true,
      },
      legacyRecovery: {
        state: 'interrupted-candidate',
        runId: sysadminctlInterrupted.marker.runId,
        fingerprint: createHash('sha256').update(
          JSON.stringify({
            ...sysadminctlInterrupted,
            observedUserGroupIds: [20, 12, 61, 701, 100, 80],
          }),
        ).digest('hex'),
        hostEvidence: {
          ...sysadminctlInterrupted,
          observedUserGroupIds: [20, 12, 61, 701, 100, 80],
        },
      },
    })).toThrow('invalid_admin_manifest');
    expect(() => validateAdminManifestShape({
      ...validManifest(),
      legacyRecovery: {
        state: 'candidate',
        runId: '305d458c89ed546f9c3d2446642be2e4',
        fingerprint: '88d1920a6637e76b6d315f96325f0e10ba09a9e765b1c2181b9af41cfb48ea62',
        hostEvidence: partialLegacyEvidence,
      },
    })).toThrow('invalid_admin_manifest');
    expect(() => validateAdminManifestShape({
      ...validManifest(),
      legacyRecovery: {
        state: 'candidate',
        runId: '0123456789abcdef0123456789abcdef',
        fingerprint: 'ab'.repeat(32),
        hostEvidence: validLegacyHostEvidence(),
      },
    })).toThrow('invalid_admin_manifest');
    expect(() => validateAdminManifestShape({
      ...validManifest(),
      legacyRecovery: {
        state: 'candidate',
        runId: '305d458c89ed546f9c3d2446642be2e4',
        fingerprint: 'ab'.repeat(32),
        hostEvidence: {
          ...validLegacyHostEvidence(),
          serviceUidProcessCount: 1,
        },
      },
    })).toThrow('invalid_admin_manifest');
    expect(() => validateAdminManifestShape({
      ...validManifest(),
      serviceIdentity: {
        userGeneratedUid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        groupGeneratedUid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      },
    })).toThrow('invalid_admin_manifest');
    expect(() => validateAdminManifestShape({
      ...validManifest(),
      legacyRecovery: {
        state: 'candidate',
        runId: '305d458c89ed546f9c3d2446642be2e4',
        fingerprint: null,
        hostEvidence: validLegacyHostEvidence(),
      },
    })).toThrow('invalid_admin_manifest');
    expect(() => validateAdminManifestShape({
      ...validManifest(),
      extra: true,
    })).toThrow('invalid_admin_manifest');
    expect(() => validateAdminManifestShape({
      ...validManifest(),
      host: { ...validManifest().host, socketPath: '/tmp/substituted.sock' },
    })).toThrow('invalid_admin_manifest');
  });

  it('selects an unused fixed-range UID and rejects malformed directory listings', () => {
    expect(chooseFreeServiceUid([SERVICE_UID_MAXIMUM], [SERVICE_UID_MAXIMUM - 1]))
      .toBe(SERVICE_UID_MAXIMUM - 2);
    expect(parseDirectoryServiceIds('_user 501\n_group 20\n')).toEqual([501, 20]);
    expect(() => parseDirectoryServiceIds('malformed\n')).toThrow(
      'invalid_directory_service_listing',
    );
  });

  it('parses both inline and indented dscl property values', () => {
    expect(parseDirectoryServiceProperty('UniqueID: 499\n', 'UniqueID'))
      .toBe('499');
    expect(parseDirectoryServiceProperty(
      'RealName:\n Roundtable Service UID Bootstrap Probe 0123\nRecordName: test\n',
      'RealName',
    )).toBe('Roundtable Service UID Bootstrap Probe 0123');
    expect(parseDirectoryServiceProperty(
      'dsAttrTypeNative:IsHidden: 1\n',
      'IsHidden',
    )).toBe('1');
    expect(() => parseDirectoryServiceProperty(
      'IsHidden: 1\ndsAttrTypeNative:IsHidden: 1\n',
      'IsHidden',
    )).toThrow('directory_service_property_missing');
    expect(() => parseDirectoryServiceProperty(
      'RealName:\n first\n second\n',
      'RealName',
    )).toThrow('directory_service_property_missing');
  });

  it('allows the role-account delete fallback only for exact dscl permission errors', async () => {
    expect(directoryServicePermissionDenied({
      status: 40,
      stdout: '',
      stderr: 'DS Error: -14120 (eDSPermissionError)',
    })).toBe(true);
    expect(directoryServicePermissionDenied({
      status: 1,
      stdout: '',
      stderr: 'eDSPermissionError',
    })).toBe(false);
    expect(directoryServicePermissionDenied({
      status: 40,
      stdout: '',
      stderr: 'unexpected failure',
    })).toBe(false);

    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain("'/Local/Default',\n      '-delete'");
    expect(source).toContain("'-deleteUser',\n        SERVICE_USER,\n      ]");
    expect(source).toContain("'-o',\n        'delete'");
    expect(source).toContain('assertRoleAccountDeleteFallbackEligible()');
    expect(source).toContain('assertProtectedRoleAccountHomeUnchanged');
    expect(source).not.toContain("'-keepHome'");
    expect(source).not.toContain("'-adminPassword'");
    expect(source).not.toContain("'-addUser', SERVICE_USER");
    expect(source).not.toContain("'-roleAccount'");
    expect(source).toContain("['UniqueID', String(manifest.serviceUid)]");
    expect(source).toContain('service_identity_privilege_mismatch');
    expect(source).toContain('userGeneratedUid: null');
  });

  it('accepts the macOS root:sys protected role-account home shape', () => {
    const info = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      gid: 3,
      mode: 0o40755,
    };
    expect(protectedRoleAccountHomeMetadataMatches(
      info,
      '/private/var/empty',
    )).toBe(true);
    expect(protectedRoleAccountHomeMetadataMatches(
      { ...info, gid: 0 },
      '/private/var/empty',
    )).toBe(false);
    expect(protectedRoleAccountHomeMetadataMatches(
      info,
      '/var/empty',
    )).toBe(false);
  });

  it('requires canary evidence to bind the intended host and nonzero denials', () => {
    const evidence = validCanaryEvidence();
    expect(validateCanaryResult(evidence, runId, 499, 1234, 501)).toBe(evidence);
    expect(() => validateCanaryResult(
      { ...evidence, hostPid: 1235 },
      runId,
      499,
      1234,
      501,
    )).toThrow('invalid_canary_result');
    expect(() => validateCanaryResult({
      ...evidence,
      tests: {
        ...evidence.tests,
        signal: { outcome: 'denied', code: 0 },
      },
    }, runId, 499, 1234, 501)).toThrow('invalid_canary_result');
  });
});

function validManifest() {
  return {
    schemaVersion: 1,
    kind: 'roundtable-service-uid-development-gate-admin-transaction-v5',
    runId,
    ownershipToken: 'cd'.repeat(32),
    serviceUid: 499,
    serviceIdentity: {
      userGeneratedUid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      groupGeneratedUid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
    },
    transaction: {
      notAfter: '2026-09-11T00:05:00.000Z',
      maximumDurationMs: 300_000,
      recoveryJournalPresent: false,
      testSet: [
        'sigkill-journal-recovery',
        'pinned-client-ping',
        'pinned-client-status',
        'wrong-cdhash-client-rejected',
        'cross-uid-procargs-denied',
        'cross-uid-signal-denied',
        'cross-uid-launchd-control-denied',
        'cross-uid-private-socket-denied',
        'cross-uid-host-file-read-denied',
        'service-uid-staging-write',
        'host-fixture-unchanged',
      ],
      cleanupSet: [
        'system-jobs-booted-out',
        'service-uid-zero-processes',
        'owned-account-removed',
        'staging-inspected-and-removed',
        'fixed-files-removed',
        'journal-removed',
        'sealed-administrator-package-removed',
      ],
    },
    codeDirectoryHashes: {
      broker: '04'.repeat(20),
      client: '05'.repeat(20),
    },
    host: {
      uid: 501,
      gid: 20,
      username: 'roundtable-test',
      pid: 1234,
      instanceId: '01234567-89ab-cdef-0123-456789abcdef',
      privateRoot: hostRoot,
      socketPath: `${hostRoot}/control.sock`,
      canaryPath: `${hostRoot}/host-canary.txt`,
    },
    sources: {
      broker: { path: '/private/tmp/broker', sha256: '01'.repeat(32) },
      canary: { path: '/private/tmp/canary', sha256: '02'.repeat(32) },
    },
    legacyRecovery: {
      state: 'absent',
      runId: null,
      fingerprint: null,
      hostEvidence: null,
    },
  };
}

function validLegacyHostEvidence() {
  return {
    serviceUid: 499,
    userRecordsWithUid: ['_roundtable_p4_gate'],
    groupRecordsWithGid: ['_roundtable_p4_gate'],
    serviceUidProcessCount: 0,
    brokerJobPresent: false,
    legacyCanaryJobPresent: false,
    installRootPresent: false,
    brokerPlistPresent: false,
    legacyCanaryPlistPresent: false,
    transactionJournalRootPresent: false,
  };
}

function validInterruptedHostEvidence() {
  const interruptedRunId = 'abcdef0123456789abcdef0123456789';
  return {
    serviceUid: 498,
    userRecordsWithUid: ['_roundtable_p4_gate'],
    groupRecordsWithGid: ['_roundtable_p4_gate'],
    observedUserGeneratedUid: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
    observedUserUid: '498',
    observedUserPrimaryGid: '498',
    observedUserGroupIds: [498, 12, 61, 701, 100],
    userProperties: {
      RealName: null,
      UserShell: null,
      NFSHomeDirectory: null,
      IsHidden: null,
    },
    groupGeneratedUid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
    groupRealName: `Roundtable Service UID Bootstrap Probe ${interruptedRunId}`,
    groupHidden: '1',
    groupMembershipAbsent: true,
    userMissingProperties: [
      'RealName', 'UserShell', 'NFSHomeDirectory', 'IsHidden',
    ],
    serviceUidProcessCount: 0,
    brokerJobPresent: false,
    canaryJobPresent: false,
    installRootEntries: ['ownership.json'],
    brokerPlistPresent: false,
    canaryPlistPresent: false,
    transactionJournalRootPresent: true,
    marker: {
      schemaVersion: 1,
      kind: 'roundtable-service-uid-development-gate-install-v4',
      runId: interruptedRunId,
      ownershipToken: 'ef'.repeat(32),
      serviceUid: 498,
      serviceIdentity: {
        userGeneratedUid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        groupGeneratedUid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      },
      codeDirectoryHashes: {
        broker: '04'.repeat(20),
        client: '05'.repeat(20),
      },
      manifestSha256: 'ab'.repeat(32),
    },
  };
}

function validSysadminctlInterruptedHostEvidence() {
  const evidence = validInterruptedHostEvidence();
  const interruptedRunId = evidence.marker.runId;
  return {
    ...evidence,
    serviceUid: 499,
    userRecordsWithUid: ['_roundtable_p4_gate'],
    groupRecordsWithGid: ['_roundtable_p4_gate'],
    observedUserUid: '499',
    observedUserPrimaryGid: '20',
    observedUserGroupIds: [20, 12, 61, 701, 100],
    userProperties: {
      RealName: `Roundtable Service UID Bootstrap Probe ${interruptedRunId}`,
      UserShell: '/usr/bin/false',
      NFSHomeDirectory: '/var/empty',
      IsHidden: '1',
    },
    userMissingProperties: [],
    marker: {
      ...evidence.marker,
      serviceUid: 499,
      serviceIdentity: {
        ...evidence.marker.serviceIdentity,
        userGeneratedUid: null,
      },
    },
  };
}

function validCanaryEvidence() {
  const denied = { outcome: 'denied', code: 1 };
  return {
    schemaVersion: 1,
    result: 'passed',
    hostPid: 1234,
    hostUid: 501,
    serviceUid: 499,
    tests: {
      procargs: { ...denied },
      signal: { ...denied },
      launchdControl: { ...denied },
      unixSocket: { ...denied },
      hostCanaryRead: { ...denied },
      stagingWrite: { outcome: 'succeeded', code: 0 },
    },
  };
}
