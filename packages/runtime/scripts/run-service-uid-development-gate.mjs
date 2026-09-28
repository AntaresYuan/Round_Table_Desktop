import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const getuid = () => process.getuid?.();
const getgid = () => process.getgid?.();
const geteuid = () => process.geteuid?.();
const getegid = () => process.getegid?.();

export const GATE_SCHEMA_VERSION = 1;
export const RESIDUAL_STATES = Object.freeze([
  'absent',
  'present',
  'unknown',
  'cleanup-incomplete',
  'quarantined',
]);
export const SYSTEM_MUTATION_STATES = Object.freeze([
  'none-observed',
  'performed',
  'unknown',
]);
export const DEVELOPMENT_GATE_ID =
  'com.roundtable.runtime.service-uid-development-gate';
export const BROKER_LABEL = `${DEVELOPMENT_GATE_ID}.broker`;
export const BOOTSTRAP_MACH_SERVICE =
  'com.roundtable.runtime.service-uid-bootstrap-probe-v0';
export const SERVICE_USER = '_roundtable_p4_gate';
export const SERVICE_GROUP = '_roundtable_p4_gate';
export const SERVICE_UID_MINIMUM = 450;
export const SERVICE_UID_MAXIMUM = 499;
export const INSTALL_ROOT =
  '/Library/Application Support/RoundtableServiceUIDDevelopmentGate';
export const BROKER_PLIST_PATH =
  `/Library/LaunchDaemons/${BROKER_LABEL}.plist`;
export const TRANSACTION_JOURNAL_ROOT = '/private/var/db/roundtable';
const TRANSACTION_JOURNAL_DIRECTORY =
  `${TRANSACTION_JOURNAL_ROOT}/phase4-transactions`;
const TRANSACTION_JOURNAL_PATH =
  `${TRANSACTION_JOURNAL_DIRECTORY}/active-transaction.json`;
const TRANSACTION_JOURNAL_KIND =
  'roundtable-service-uid-admin-transaction-journal-v2';

// The only legacy identity this development transaction may recover. These
// values are independent root-side evidence; a host manifest cannot expand
// the deletion scope by changing a name, UID, or GeneratedUID.
const LEGACY_RESIDUE_RUN_ID =
  '305d458c89ed546f9c3d2446642be2e4';
const LEGACY_RESIDUE_USER_GENERATED_UID =
  'DB7A6144-7A6B-4FA8-8A32-533382462E23';
const LEGACY_RESIDUE_GROUP_GENERATED_UID =
  'EFFE2CC5-B8A5-456D-8F00-696AC4E1036C';
const LEGACY_RESIDUE_FINGERPRINT =
  '88d1920a6637e76b6d315f96325f0e10ba09a9e765b1c2181b9af41cfb48ea62';

const HOST_LABEL_PREFIX = 'com.roundtable.runtime.isolation-canary.host.';
const CANARY_LABEL_PREFIX = `${DEVELOPMENT_GATE_ID}.canary.`;
const CANARY_WRITE_PREFIX = '.roundtable-service-uid-canary-';
export const CLIENT_IDENTIFIER =
  'com.roundtable.desktop.service-uid-bootstrap-probe-v0-client';
export const BROKER_IDENTIFIER =
  'com.roundtable.desktop.service-uid-bootstrap-probe-v0-broker';
const CANARY_IDENTIFIER =
  'com.roundtable.desktop.service-uid-isolation-canary';
const BUILD_SCRIPT = join(scriptDirectory, 'build-service-uid-xpc.mjs');
const ADMIN_HELPER_SOURCE = join(
  scriptDirectory,
  '..',
  'native',
  'bin',
  process.arch,
  'roundtable-service-uid-admin-helper',
);
const ADMIN_HELPER_MANIFEST_SOURCE = join(
  scriptDirectory,
  '..',
  'src',
  'native-helper-manifest.ts',
);
const AUTHORIZATION_LAUNCHER_SOURCE = join(
  scriptDirectory,
  '..',
  'native',
  'bin',
  process.arch,
  'roundtable-service-uid-authorization-launcher',
);
const ADMIN_PACKAGE_PREFIX =
  '/private/var/tmp/roundtable-service-uid-development-gate-admin-';
const HOST_GATE_LOCK_PATH =
  '/private/tmp/roundtable-service-uid-development-gate.host-lock';
const ROLE_ACCOUNT_HOME = '/private/var/empty';
const SYSTEM_WHEEL_GROUP_ID = 0;
const ROLE_ACCOUNT_HOME_GROUP_ID = 3;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_GUI_DOMAIN_OUTPUT_BYTES = 512 * 1024;
const MAX_REPORT_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_ADMIN_SOURCE_BYTES = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const ADMIN_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const RECOVERY_PROBE_DEADLINE_MS = 1_000;
const RECOVERY_PROBE_PROCESS_TIMEOUT_MS = 5_000;
const CLIENT_TIMEOUT_MS = 8_000;
const FIXTURE_READY_TIMEOUT_MS = 10_000;
const CANARY_TIMEOUT_MS = 15_000;
const HOST_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;
const HOST_CANARY_CONTENT = 'roundtable-host-only-canary-v1\n';
const STAGING_CANARY_CONTENT =
  'roundtable-service-uid-isolation-canary-v1\n';
const REQUIRED_CANARY_DENIALS = [
  'procargs',
  'signal',
  'launchdControl',
  'unixSocket',
  'hostCanaryRead',
];
const ADMIN_TRANSACTION_TEST_SET = Object.freeze([
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
]);
const ADMIN_TRANSACTION_CLEANUP_SET = Object.freeze([
  'system-jobs-booted-out',
  'service-uid-zero-processes',
  'owned-account-removed',
  'staging-inspected-and-removed',
  'fixed-files-removed',
  'journal-removed',
  'sealed-administrator-package-removed',
]);

export const TRANSACTION_PHASES = Object.freeze([
  'preflight',
  'legacy-recovered',
  'root-published',
  'identity-created',
  'files-installed',
  'jobs-bootstrapped',
  'canary-passed',
  'host-acknowledged',
  'rolling-back',
  'rolled-back',
  'quarantined',
  'recovery-rolling-back',
  'recovered',
]);

const TOOLS = Object.freeze({
  codesign: '/usr/bin/codesign',
  dscl: '/usr/bin/dscl',
  dseditgroup: '/usr/sbin/dseditgroup',
  launchctl: '/bin/launchctl',
  install: '/usr/bin/install',
  id: '/usr/bin/id',
  plutil: '/usr/bin/plutil',
  ps: '/bin/ps',
  shasum: '/usr/bin/shasum',
  sysadminctl: '/usr/sbin/sysadminctl',
  xcrun: '/usr/bin/xcrun',
});

export class DevelopmentGateError extends Error {
  constructor(code, stage, message = code) {
    super(message);
    this.name = 'DevelopmentGateError';
    this.code = code;
    this.stage = stage;
  }
}

export function parseCliArguments(argumentsList) {
  if (argumentsList.length === 0 || (
    argumentsList.length === 1 && argumentsList[0] === '--dry-run'
  )) {
    return { mode: 'dry-run' };
  }
  if (argumentsList.length === 1 && argumentsList[0] === '--run') {
    return { mode: 'run' };
  }
  if (argumentsList.length === 1 && argumentsList[0] === '--help') {
    return { mode: 'help' };
  }
  if (
    argumentsList.length === 2
    && argumentsList[0] === '--internal-admin-transaction'
  ) {
    return {
      mode: 'admin-transaction',
      manifestPath: argumentsList[1],
    };
  }
  if (
    argumentsList.length === 2
    && argumentsList[0] === '--internal-admin-recovery-probe'
  ) {
    return {
      mode: 'admin-recovery-probe',
      manifestPath: argumentsList[1],
    };
  }
  throw new DevelopmentGateError(
    'invalid_arguments',
    'arguments',
    'expected no arguments, --dry-run, or --run',
  );
}

export function createDryRunReport(platform = process.platform) {
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    gate: 'macos-service-uid-development-fixture-v1',
    mode: 'dry-run',
    result: 'planned_not_run',
    authorizationRequested: false,
    authorizationRequestCount: 0,
    systemMutationsPerformed: false,
    systemMutationState: 'none-observed',
    systemTrustModified: false,
    residualSystemState: false,
    residualState: 'unknown',
    supportedHost: platform === 'darwin',
    explicitRunFlagRequired: true,
    topology: {
      signing: 'development-adhoc-client-cdhash-pinned',
      systemTrust: 'never-modified',
      administratorTransactions: 1,
      peerRequirement: 'exact-identifier-and-code-directory-hash',
      brokerLaunchDaemon: BROKER_LABEL,
      bootstrapMachService: BOOTSTRAP_MACH_SERVICE,
      serviceIdentity: {
        name: SERVICE_USER,
        uidRange: [SERVICE_UID_MINIMUM, SERVICE_UID_MAXIMUM],
        hidden: true,
        loginShell: '/usr/bin/false',
        home: '/var/empty',
      },
      canaryLaunchDaemon: `${CANARY_LABEL_PREFIX}<32-lower-hex-run-id>`,
      cleanupOrder: [
        'bootout-user-and-system-jobs',
        'prove-service-uid-zero-processes',
        'delete-owned-account-and-fixed-resources',
      ],
    },
    plannedChecks: [
      'sigkill-journal-recovery',
      'signed-client-ping-and-status',
      'same-identifier-wrong-cdhash-client-rejected',
      'broker-stderr-empty',
      'cross-uid-procargs-denied',
      'cross-uid-signal-denied',
      'cross-uid-gui-launchd-control-denied',
      'cross-uid-private-socket-denied',
      'cross-uid-host-file-read-denied',
      'service-owned-staging-write-succeeded',
      'host-fixtures-unchanged',
      'service-uid-zero-processes',
    ],
    scope: scopeDisclaimer(),
  };
}

export function canaryLabelForRun(runId) {
  requireRunId(runId);
  return `${CANARY_LABEL_PREFIX}${runId}`;
}

export function hostLabelForRun(runId) {
  requireRunId(runId);
  return `${HOST_LABEL_PREFIX}${runId}`;
}

export function canaryPlistPathForRun(runId) {
  return `/Library/LaunchDaemons/${canaryLabelForRun(runId)}.plist`;
}

export function installedOutputOwnership(serviceUid) {
  if (!Number.isSafeInteger(serviceUid)
    || serviceUid < SERVICE_UID_MINIMUM
    || serviceUid > SERVICE_UID_MAXIMUM) throw manifestError();
  return {
    brokerStderr: { mode: 0o644, uid: 0, gid: 0 },
    canaryStdout: { mode: 0o600, uid: serviceUid, gid: serviceUid },
    canaryStderr: { mode: 0o600, uid: serviceUid, gid: serviceUid },
  };
}

export function renderBrokerLaunchDaemon(manifest) {
  const checked = validateAdminManifestShape(manifest);
  const paths = installedPaths(checked.runId);
  return renderPlist({
    Label: BROKER_LABEL,
    ProgramArguments: [
      paths.broker,
      '--allowed-client-euid',
      String(checked.host.uid),
      '--accepted-client-cdhash',
      checked.codeDirectoryHashes.client,
    ],
    MachServices: { [BOOTSTRAP_MACH_SERVICE]: true },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: 'Background',
    ThrottleInterval: 5,
    Umask: 0o077,
    StandardOutPath: '/dev/null',
    StandardErrorPath: paths.brokerStderr,
  });
}

export function renderCanaryLaunchDaemon(manifest) {
  const checked = validateAdminManifestShape(manifest);
  const paths = installedPaths(checked.runId);
  return renderPlist({
    Label: canaryLabelForRun(checked.runId),
    ProgramArguments: [
      paths.canary,
      '--host-pid',
      String(checked.host.pid),
      '--host-uid',
      String(checked.host.uid),
      '--launchd-label',
      hostLabelForRun(checked.runId),
      '--unix-socket',
      checked.host.socketPath,
      '--host-canary',
      checked.host.canaryPath,
      '--staging-directory',
      paths.staging,
      '--run-id',
      checked.runId,
    ],
    UserName: SERVICE_USER,
    GroupName: SERVICE_GROUP,
    WorkingDirectory: paths.staging,
    EnvironmentVariables: {
      HOME: '/var/empty',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      TMPDIR: paths.staging,
    },
    RunAtLoad: true,
    KeepAlive: false,
    LaunchOnlyOnce: true,
    ProcessType: 'Background',
    ThrottleInterval: 5,
    Umask: 0o077,
    StandardOutPath: paths.canaryStdout,
    StandardErrorPath: paths.canaryStderr,
  });
}

export function validateAdminManifestShape(value) {
  if (!isPlainObject(value)) {
    throw manifestError();
  }
  requireExactKeys(value, [
    'schemaVersion',
    'kind',
    'runId',
    'ownershipToken',
    'serviceUid',
    'serviceIdentity',
    'transaction',
    'host',
    'codeDirectoryHashes',
    'sources',
    'legacyRecovery',
  ]);
  if (
    value.schemaVersion !== GATE_SCHEMA_VERSION
    || value.kind !== 'roundtable-service-uid-development-gate-admin-transaction-v5'
  ) throw manifestError();
  requireRunId(value.runId);
  if (!/^[a-f0-9]{64}$/u.test(value.ownershipToken)) throw manifestError();
  if (!Number.isSafeInteger(value.serviceUid)
    || value.serviceUid < SERVICE_UID_MINIMUM
    || value.serviceUid > SERVICE_UID_MAXIMUM) throw manifestError();
  if (!isPlainObject(value.serviceIdentity)) throw manifestError();
  requireExactKeys(value.serviceIdentity, [
    'userGeneratedUid',
    'groupGeneratedUid',
  ]);
  const generatedUidPattern =
    /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/u;
  if ((value.serviceIdentity.userGeneratedUid !== null
      && !generatedUidPattern.test(value.serviceIdentity.userGeneratedUid))
    || !generatedUidPattern.test(value.serviceIdentity.groupGeneratedUid)
    || value.serviceIdentity.userGeneratedUid
      === value.serviceIdentity.groupGeneratedUid) throw manifestError();
  if (!isPlainObject(value.transaction)) throw manifestError();
  requireExactKeys(value.transaction, [
    'notAfter',
    'maximumDurationMs',
    'recoveryJournalPresent',
    'testSet',
    'cleanupSet',
  ]);
  if (typeof value.transaction.notAfter !== 'string'
    || Number.isNaN(Date.parse(value.transaction.notAfter))
    || value.transaction.maximumDurationMs !== ADMIN_AUTHORIZATION_TIMEOUT_MS
    || typeof value.transaction.recoveryJournalPresent !== 'boolean'
    || !arraysEqual(value.transaction.testSet, ADMIN_TRANSACTION_TEST_SET)
    || !arraysEqual(value.transaction.cleanupSet, ADMIN_TRANSACTION_CLEANUP_SET)) {
    throw manifestError();
  }

  if (!isPlainObject(value.legacyRecovery)) throw manifestError();
  requireExactKeys(value.legacyRecovery, [
    'state',
    'runId',
    'fingerprint',
    'hostEvidence',
  ]);
  if (!['absent', 'candidate', 'interrupted-candidate', 'unknown'].includes(
    value.legacyRecovery.state,
  )) {
    throw manifestError();
  }
  if (value.legacyRecovery.state === 'candidate') {
    if (value.legacyRecovery.runId !== LEGACY_RESIDUE_RUN_ID
      || !/^[a-f0-9]{64}$/u.test(value.legacyRecovery.fingerprint)
      || !isValidLegacyHostEvidence(value.legacyRecovery.hostEvidence)
      || (value.legacyRecovery.hostEvidence.groupRecordsWithGid.length === 0
        && (!value.transaction.recoveryJournalPresent
          || !value.legacyRecovery.hostEvidence.transactionJournalRootPresent))) {
      throw manifestError();
    }
  } else if (value.legacyRecovery.state === 'interrupted-candidate') {
    if (!value.transaction.recoveryJournalPresent
      || !/^[a-f0-9]{32}$/u.test(value.legacyRecovery.runId)
      || !/^[a-f0-9]{64}$/u.test(value.legacyRecovery.fingerprint)
      || !isValidInterruptedHostEvidence(value.legacyRecovery.hostEvidence)
      || createHash('sha256').update(JSON.stringify(
        value.legacyRecovery.hostEvidence,
      )).digest('hex') !== value.legacyRecovery.fingerprint) {
      throw manifestError();
    }
  } else if (value.legacyRecovery.runId !== null
    || value.legacyRecovery.fingerprint !== null
    || value.legacyRecovery.hostEvidence !== null) {
    throw manifestError();
  }

  if (!isPlainObject(value.host)) throw manifestError();
  requireExactKeys(value.host, [
    'uid',
    'gid',
    'username',
    'pid',
    'instanceId',
    'privateRoot',
    'socketPath',
    'canaryPath',
  ]);
  for (const numberKey of ['uid', 'gid', 'pid']) {
    if (!Number.isSafeInteger(value.host[numberKey])
      || value.host[numberKey] <= 0) throw manifestError();
  }
  if (value.host.uid === value.serviceUid) throw manifestError();
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(value.host.username)) {
    throw manifestError();
  }
  if (!/^[a-f0-9-]{36}$/u.test(value.host.instanceId)) throw manifestError();
  const expectedPrivateRoot = hostPrivateRootForRun(value.runId);
  if (value.host.privateRoot !== expectedPrivateRoot
    || value.host.socketPath !== join(expectedPrivateRoot, 'control.sock')
    || value.host.canaryPath !== join(expectedPrivateRoot, 'host-canary.txt')) {
    throw manifestError();
  }

  if (!isPlainObject(value.codeDirectoryHashes)) throw manifestError();
  requireExactKeys(value.codeDirectoryHashes, ['broker', 'client']);
  if (!/^[a-f0-9]{40}$/u.test(value.codeDirectoryHashes.broker)
    || !/^[a-f0-9]{40}$/u.test(value.codeDirectoryHashes.client)) {
    throw manifestError();
  }

  if (!isPlainObject(value.sources)) throw manifestError();
  requireExactKeys(value.sources, ['broker', 'canary']);
  for (const sourceName of ['broker', 'canary']) {
    const source = value.sources[sourceName];
    if (!isPlainObject(source)) throw manifestError();
    requireExactKeys(source, ['path', 'sha256']);
    if (!boundedAbsolutePath(source.path)
      || !/^[a-f0-9]{64}$/u.test(source.sha256)) throw manifestError();
  }
  return value;
}

async function main() {
  let parsed;
  try {
    parsed = parseCliArguments(process.argv.slice(2));
  } catch (error) {
    emitReport(failureReport('dry-run', error, false));
    process.exitCode = 64;
    return;
  }

  if (parsed.mode === 'help') {
    process.stdout.write(
      'Usage: node run-service-uid-development-gate.mjs [--dry-run|--run]\n',
    );
    return;
  }
  if (parsed.mode === 'dry-run') {
    emitReport(createDryRunReport());
    return;
  }
  if (parsed.mode === 'admin-transaction') {
    try {
      const result = await runAsAdministrator(parsed.manifestPath);
      emitReport(result);
    } catch (error) {
      emitReport(administratorFailureResult(error));
    }
    return;
  }
  if (parsed.mode === 'admin-recovery-probe') {
    try {
      await runAdministratorRecoveryProbe(parsed.manifestPath);
      process.exitCode = 70;
    } catch (error) {
      process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
      process.exitCode = 71;
    }
    return;
  }

  const { report, exitCode } = await runDevelopmentGate();
  emitReport(report);
  process.exitCode = exitCode;
}

async function runDevelopmentGate() {
  const report = {
    schemaVersion: GATE_SCHEMA_VERSION,
    gate: 'macos-service-uid-development-fixture-v1',
    mode: 'run',
    result: 'failed',
    authorizationRequested: false,
    authorizationRequestCount: 0,
    authorizationCompleted: false,
    systemMutationsPerformed: false,
    systemMutationState: 'none-observed',
    systemTrustModified: false,
    residualSystemState: false,
    residualState: 'unknown',
    runId: null,
    serviceUid: null,
    signing: {
      mode: 'development-adhoc-pinned',
      pinnedAdhocBuildVerified: false,
      wrongCdHashFixtureVerified: false,
    },
    checks: {
      journalCrashRecovery: false,
      pinnedClientPing: false,
      pinnedClientStatus: false,
      wrongCdHashClientRejected: false,
      pinnedClientStillHealthy: false,
      brokerStderrEmpty: false,
      canaryDenials: false,
      stagingWriteReported: false,
      hostProcessUnaffected: false,
      hostLaunchdUnaffected: false,
      privateSocketUnaffected: false,
      hostFileUnaffected: false,
      serviceUidZeroProcesses: false,
    },
    cleanup: {
      hostLaunchAgentBootedOut: true,
      administratorTransactionFinished: true,
      administratorCleanupComplete: true,
      administratorPackageRemoved: true,
      temporaryFilesRemoved: true,
    },
    scope: scopeDisclaimer(),
  };

  let runId;
  let workingDirectory;
  let hostFixture;
  let manifest;
  let administratorTransaction;
  let administratorResult;
  let administratorReady = false;
  let hostAcknowledgementWritten = false;
  let hostGateLock = null;
  let primaryError = null;

  try {
    requireRunnableHost();
    hostGateLock = await acquireHostGateLock();
    const host = await readHostIdentity();
    await preflightTools();
    const serviceUid = chooseFreeServiceUid(
      listDirectoryServiceIds('/Users', 'UniqueID'),
      listDirectoryServiceIds('/Groups', 'PrimaryGroupID'),
    );
    const legacyRecovery = await captureLegacyRecoveryEvidence();
    const recoveryJournalPresent = await pathExists(TRANSACTION_JOURNAL_ROOT);
    await preflightFixedResources(legacyRecovery);

    runId = randomBytes(16).toString('hex');
    report.runId = runId;
    report.serviceUid = serviceUid;
    workingDirectory = await mkdtemp(join(
      await realpath(tmpdir()),
      'roundtable-service-uid-development-gate-',
    ));
    await chmod(workingDirectory, 0o700);

    const build = await buildDevelopmentPinnedAdhocArtifacts(workingDirectory);
    report.signing.pinnedAdhocBuildVerified = true;
    report.signing.wrongCdHashFixtureVerified = true;
    hostFixture = await startHostFixture(workingDirectory, runId, host);
    const before = await observeHostFixture(hostFixture, host.uid);
    manifest = createAdminManifest({
      runId,
      serviceUid,
      host,
      hostFixture,
      build,
      legacyRecovery,
      recoveryJournalPresent,
    });
    const manifestPath = join(workingDirectory, 'admin-manifest.json');
    await writeExclusiveJson(manifestPath, manifest, 0o600);
    await loadInvocationManifest(manifestPath);
    administratorTransaction = await beginAdministratorTransaction(manifestPath);
    report.authorizationRequested = true;
    report.authorizationRequestCount = 1;
    report.systemMutationState = 'unknown';
    report.cleanup.administratorTransactionFinished = false;
    report.cleanup.administratorCleanupComplete = false;
    report.cleanup.administratorPackageRemoved = false;
    const ready = await waitForAdministratorReady(
      administratorTransaction,
      manifest,
    );
    administratorReady = true;
    report.authorizationCompleted = true;
    report.systemMutationsPerformed = true;
    report.systemMutationState = 'performed';
    report.checks.canaryDenials = ready.canaryDenials;
    report.checks.stagingWriteReported = ready.stagingWriteReported;
    report.checks.brokerStderrEmpty = ready.brokerStderrEmpty;

    await runExpectedClient(
      build.client,
      'ping',
      `${runId.slice(0, 24)}-ping`,
      build.brokerCdHash,
    );
    report.checks.pinnedClientPing = true;
    await runExpectedClient(
      build.client,
      'status',
      `${runId.slice(0, 22)}-status`,
      build.brokerCdHash,
    );
    report.checks.pinnedClientStatus = true;
    await runRejectedClient(
      build.wrongClient,
      `${runId.slice(0, 20)}-wrong-signature`,
      build.brokerCdHash,
    );
    report.checks.wrongCdHashClientRejected = true;
    await runExpectedClient(
      build.client,
      'status',
      `${runId.slice(0, 20)}-after-negative`,
      build.brokerCdHash,
    );
    report.checks.pinnedClientStillHealthy = true;

    await delay(500);
    const after = await observeHostFixture(hostFixture, host.uid);
    report.checks.hostProcessUnaffected =
      before.pid === after.pid
      && before.instanceId === after.instanceId
      && before.signalCount === 0
      && after.signalCount === 0;
    report.checks.hostLaunchdUnaffected =
      before.launchd.pid === after.launchd.pid
      && before.launchd.runs === after.launchd.runs;
    report.checks.privateSocketUnaffected =
      before.acceptedConnections === 0
      && after.acceptedConnections === 0;
    report.checks.hostFileUnaffected =
      before.hostCanarySha256 === after.hostCanarySha256
      && before.hostCanaryMetadata === after.hostCanaryMetadata;
    if (!report.checks.hostProcessUnaffected
      || !report.checks.hostLaunchdUnaffected
      || !report.checks.privateSocketUnaffected
      || !report.checks.hostFileUnaffected) {
      throw new DevelopmentGateError(
        'host_fixture_changed',
        'host-observation',
      );
    }

    await writeHostAcknowledgement(manifest, 'passed');
    await readHostAcknowledgement(manifest);
    hostAcknowledgementWritten = true;
    administratorResult = await administratorTransaction.completion;
    applyAdministratorResult(report, administratorResult);
    if (administratorResult.result !== 'completed') {
      throw administratorResultError(administratorResult);
    }

    await proveHostSocketStillListening(hostFixture);
    const selfProbe = await readHostFixtureState(hostFixture.statePath);
    if (selfProbe.acceptedConnections !== 1) {
      throw new DevelopmentGateError(
        'host_socket_self_probe_failed',
        'host-observation',
      );
    }
    report.checks.serviceUidZeroProcesses =
      (await waitForUidProcessCount(serviceUid, 0, 3_000)).length === 0;
    if (!report.checks.serviceUidZeroProcesses) {
      throw new DevelopmentGateError(
        'service_uid_processes_remain',
        'host-observation',
      );
    }
  } catch (error) {
    primaryError = normalizeError(error);
  } finally {
    if (administratorTransaction && !administratorResult) {
      if (administratorReady && !hostAcknowledgementWritten && manifest) {
        try {
          await writeHostAcknowledgement(manifest, 'failed');
          hostAcknowledgementWritten = true;
        } catch (error) {
          primaryError ??= normalizeError(error);
        }
      }
      try {
        administratorResult = await administratorTransaction.completion;
        applyAdministratorResult(report, administratorResult);
        if (administratorResult.result !== 'completed') {
          primaryError ??= administratorResultError(administratorResult);
        }
      } catch (error) {
        // A rejected completion only proves that the host lost a trustworthy
        // result. It does not prove that the privileged process exited or that
        // its cleanup ran. Keep both facts fail-closed until root evidence is
        // independently observed.
        report.authorizationCompleted = false;
        report.systemMutationState = 'unknown';
        report.cleanup.administratorTransactionFinished = false;
        report.cleanup.administratorCleanupComplete = false;
        primaryError ??= normalizeError(error);
      }
    }

    if (hostFixture) {
      try {
        await stopHostFixture(hostFixture);
        report.cleanup.hostLaunchAgentBootedOut = true;
      } catch (error) {
        report.cleanup.hostLaunchAgentBootedOut = false;
        primaryError ??= normalizeError(error);
      }
    }

    if (manifest) {
      try {
        const exactPackageAbsent = !administratorTransaction?.packageDirectory
          || !await pathExists(administratorTransaction.packageDirectory);
        report.cleanup.administratorPackageRemoved = exactPackageAbsent
          && !await administratorPackagesExistForRun(manifest.runId);
        if (!report.cleanup.administratorPackageRemoved) {
          primaryError ??= new DevelopmentGateError(
            'administrator_package_remains',
            'cleanup',
          );
        }
      } catch (error) {
        report.cleanup.administratorPackageRemoved = false;
        primaryError ??= normalizeError(error);
      }
    }

    if (report.serviceUid !== null) {
      try {
        report.checks.serviceUidZeroProcesses =
          listProcessesForUid(report.serviceUid).length === 0;
      } catch (error) {
        report.checks.serviceUidZeroProcesses = false;
        primaryError ??= normalizeError(error);
      }
    }

    if (hostFixture?.privateRoot) {
      try {
        await removeOwnedHostPrivateRoot(hostFixture, getuid());
      } catch (error) {
        report.cleanup.temporaryFilesRemoved = false;
        primaryError ??= normalizeError(error);
      }
    }
    if (workingDirectory) {
      try {
        await removeOwnedTemporaryDirectory(workingDirectory, getuid());
      } catch (error) {
        report.cleanup.temporaryFilesRemoved = false;
        primaryError ??= normalizeError(error);
      }
    }
    if (hostGateLock) {
      try {
        await releaseHostGateLock(hostGateLock);
      } catch (error) {
        report.cleanup.temporaryFilesRemoved = false;
        primaryError ??= normalizeError(error);
      }
    }
    if (manifest) {
      try {
        report.residualSystemState = await systemResourcesExist(manifest);
        report.residualState = auditedResidualState(
          report.residualSystemState,
          administratorResult,
        );
        if (!report.residualSystemState && !report.systemMutationsPerformed) {
          report.cleanup.administratorCleanupComplete = true;
        }
        if (report.residualSystemState) {
          report.cleanup.administratorCleanupComplete = false;
          primaryError ??= new DevelopmentGateError(
            'residual_system_state_detected',
            'cleanup',
          );
        }
      } catch (error) {
        report.residualSystemState = true;
        report.residualState = 'unknown';
        report.cleanup.administratorCleanupComplete = false;
        primaryError ??= normalizeError(error);
      }
    }
  }

  if (administratorResult?.cleanup?.stagingEvidence === 'verified') {
    report.checks.stagingWriteReported = true;
  }
  const allChecksPassed = Object.values(report.checks).every(Boolean);
  const allCleanupPassed = Object.values(report.cleanup).every(Boolean);
  if (primaryError === null && allChecksPassed && allCleanupPassed) {
    report.result = 'fixture_gate_passed';
    return { report, exitCode: 0 };
  }
  report.result = allCleanupPassed ? 'failed' : 'cleanup_incomplete';
  report.error = publicError(primaryError ?? new DevelopmentGateError(
    'required_check_failed',
    'verification',
  ));
  return { report, exitCode: 1 };
}

async function acquireHostGateLock() {
  const startedAtMs = Date.now();
  const record = {
    schemaVersion: GATE_SCHEMA_VERSION,
    kind: 'roundtable-service-uid-development-gate-host-lock-v1',
    pid: process.pid,
    uid: getuid(),
    gid: getgid(),
    ownershipToken: randomBytes(32).toString('hex'),
    startedAt: new Date(startedAtMs).toISOString(),
    notAfter: new Date(
      startedAtMs + ADMIN_AUTHORIZATION_TIMEOUT_MS + 60_000,
    ).toISOString(),
  };
  validateHostGateLock(record);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeExclusiveJson(
        HOST_GATE_LOCK_PATH,
        record,
        0o600,
        getuid(),
        getgid(),
      );
      const persisted = await readHostGateLock();
      if (JSON.stringify(persisted) !== JSON.stringify(record)) {
        throw new DevelopmentGateError(
          'host_gate_lock_ownership_mismatch',
          'host-preflight',
        );
      }
      return record;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt !== 0) throw error;
      const existing = await readHostGateLock();
      if (processIsAlive(existing.pid)) {
        throw new DevelopmentGateError(
          'development_gate_already_running',
          'host-preflight',
        );
      }
      await unlink(HOST_GATE_LOCK_PATH);
    }
  }
  throw new DevelopmentGateError(
    'host_gate_lock_unavailable',
    'host-preflight',
  );
}

async function readHostGateLock() {
  const info = await lstat(HOST_GATE_LOCK_PATH);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.uid !== getuid() || info.gid !== getgid()
    || (info.mode & 0o777) !== 0o600
    || await realpath(HOST_GATE_LOCK_PATH) !== HOST_GATE_LOCK_PATH
    || info.size <= 0 || info.size > 2 * 1024) {
    throw new DevelopmentGateError(
      'host_gate_lock_ownership_mismatch',
      'host-preflight',
    );
  }
  let value;
  try {
    value = JSON.parse(await readBoundedText(HOST_GATE_LOCK_PATH, 2 * 1024));
  } catch (error) {
    if (error instanceof DevelopmentGateError) throw error;
    throw new DevelopmentGateError(
      'host_gate_lock_invalid',
      'host-preflight',
    );
  }
  return validateHostGateLock(value);
}

export function validateHostGateLock(value) {
  if (!isPlainObject(value)) {
    throw new DevelopmentGateError('host_gate_lock_invalid', 'host-preflight');
  }
  try {
    requireExactKeys(value, [
      'schemaVersion',
      'kind',
      'pid',
      'uid',
      'gid',
      'ownershipToken',
      'startedAt',
      'notAfter',
    ]);
  } catch {
    throw new DevelopmentGateError('host_gate_lock_invalid', 'host-preflight');
  }
  const startedAt = Date.parse(value.startedAt);
  const notAfter = Date.parse(value.notAfter);
  if (value.schemaVersion !== GATE_SCHEMA_VERSION
    || value.kind !== 'roundtable-service-uid-development-gate-host-lock-v1'
    || !Number.isSafeInteger(value.pid) || value.pid <= 1
    || value.uid !== getuid() || value.gid !== getgid()
    || !/^[a-f0-9]{64}$/u.test(value.ownershipToken)
    || !Number.isFinite(startedAt) || !Number.isFinite(notAfter)
    || notAfter <= startedAt
    || notAfter - startedAt
      > ADMIN_AUTHORIZATION_TIMEOUT_MS + 60_000) {
    throw new DevelopmentGateError('host_gate_lock_invalid', 'host-preflight');
  }
  return value;
}

async function releaseHostGateLock(expected) {
  const observed = await readHostGateLock();
  if (observed.pid !== expected.pid
    || observed.ownershipToken !== expected.ownershipToken) {
    throw new DevelopmentGateError(
      'host_gate_lock_ownership_mismatch',
      'cleanup',
    );
  }
  await unlink(HOST_GATE_LOCK_PATH);
}

function scopeDisclaimer() {
  return {
    fixtureBootstrapProbeOnly: true,
    administratorShellIsIsolationEvidence: false,
    privilegedAuthorizationModel: 'single-bounded-transaction',
    developmentPeerPinning: 'adhoc-exact-cdhash',
    systemTrustStoreModified: false,
    realProviderGate: 'not_exercised',
    providerLifecycleGate: 'not_exercised',
    stagingDiffApplyGate: 'not_exercised',
    releaseInstallationGate: 'not_exercised',
    phase4CompletionClaimed: false,
  };
}

function requireRunnableHost() {
  if (process.platform !== 'darwin') {
    throw new DevelopmentGateError(
      'unsupported_platform',
      'preflight',
      'the privileged development gate requires macOS',
    );
  }
  if (typeof getuid !== 'function' || getuid() === 0) {
    throw new DevelopmentGateError(
      'login_user_required',
      'preflight',
      'run the gate as the logged-in non-root user',
    );
  }
}

async function readHostIdentity() {
  const uid = getuid();
  const gid = getgid();
  const username = userInfo().username;
  if (!Number.isSafeInteger(uid) || uid <= 0
    || !Number.isSafeInteger(gid) || gid <= 0
    || !/^[A-Za-z0-9._-]{1,64}$/u.test(username)) {
    throw new DevelopmentGateError(
      'invalid_host_identity',
      'preflight',
    );
  }
  const gui = runCommand(TOOLS.launchctl, ['print', `gui/${uid}`], {
    stage: 'preflight',
    maxBuffer: MAX_GUI_DOMAIN_OUTPUT_BYTES,
  });
  const auditSession = parsePositiveField(gui.stdout, 'asid');
  if (auditSession === null) {
    throw new DevelopmentGateError(
      'interactive_gui_audit_session_required',
      'preflight',
    );
  }
  return { uid, gid, username, auditSession };
}

async function preflightTools() {
  for (const toolPath of Object.values(TOOLS)) {
    try {
      await stat(toolPath);
    } catch {
      throw new DevelopmentGateError(
        'required_tool_missing',
        'preflight',
        basename(toolPath),
      );
    }
  }
  runCommand(TOOLS.xcrun, ['--find', 'clang'], { stage: 'preflight' });
}

async function preflightFixedResources(legacyRecovery) {
  const interruptedCandidate = legacyRecovery?.state === 'interrupted-candidate';
  if (await pathExists(BROKER_PLIST_PATH)
    || (await pathExists(INSTALL_ROOT) && !interruptedCandidate)) {
    throw new DevelopmentGateError(
      'fixed_resource_already_exists',
      'preflight',
    );
  }
  const fixedAccountPresent = directoryServiceRecordExists('/Users', SERVICE_USER)
    || directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  if (fixedAccountPresent
    && !['candidate', 'interrupted-candidate'].includes(legacyRecovery?.state)) {
    throw new DevelopmentGateError(
      'fixed_account_name_already_exists',
      'preflight',
    );
  }
  const brokerJob = runCommandAllowFailure(
    TOOLS.launchctl,
    ['print', `system/${BROKER_LABEL}`],
    { stage: 'preflight' },
  );
  if (brokerJob.status === 0) {
    throw new DevelopmentGateError(
      'fixed_launchd_job_already_exists',
      'preflight',
    );
  }
}

export function chooseFreeServiceUid(userRecords, groupRecords) {
  const used = new Set([
    ...normalizeIdRecords(userRecords),
    ...normalizeIdRecords(groupRecords),
  ]);
  for (let candidate = SERVICE_UID_MAXIMUM;
    candidate >= SERVICE_UID_MINIMUM;
    candidate -= 1) {
    if (!used.has(candidate)) return candidate;
  }
  throw new DevelopmentGateError(
    'no_free_service_uid',
    'preflight',
  );
}

function normalizeIdRecords(records) {
  if (typeof records === 'string') return parseDirectoryServiceIds(records);
  if (!Array.isArray(records)
    || records.some((value) => !Number.isSafeInteger(value))) {
    throw new DevelopmentGateError(
      'invalid_directory_service_listing',
      'preflight',
    );
  }
  return records;
}

function listDirectoryServiceIds(recordType, property) {
  const result = runCommand(TOOLS.dscl, ['.', '-list', recordType, property], {
    stage: 'preflight',
  });
  return parseDirectoryServiceIds(result.stdout);
}

export function parseDirectoryServiceIds(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_COMMAND_OUTPUT_BYTES) {
    throw new DevelopmentGateError(
      'invalid_directory_service_listing',
      'preflight',
    );
  }
  const ids = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^\S+\s+(-?\d+)\s*$/u.exec(line);
    if (!match) {
      throw new DevelopmentGateError(
        'invalid_directory_service_listing',
        'preflight',
      );
    }
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) throw manifestError();
    ids.push(value);
  }
  return ids;
}

export async function buildDevelopmentPinnedAdhocArtifacts(workingDirectory) {
  const outputDirectory = join(workingDirectory, 'pinned-adhoc-build');
  await mkdir(outputDirectory, { mode: 0o700 });
  await execCommand(BUILD_SCRIPT, [
    '--mode',
    'development-adhoc-pinned',
    '--output-dir',
    outputDirectory,
  ], { stage: 'build', command: process.execPath, timeout: COMMAND_TIMEOUT_MS });

  const broker = join(
    outputDirectory,
    'roundtable-service-uid-bootstrap-probe-v0-broker',
  );
  const client = join(
    outputDirectory,
    'roundtable-service-uid-bootstrap-probe-v0-client',
  );
  const wrongClient = join(
    outputDirectory,
    'roundtable-service-uid-bootstrap-probe-v0-wrong-client',
  );
  const canary = join(
    outputDirectory,
    'roundtable-service-uid-isolation-canary',
  );
  const buildManifest = JSON.parse(await readBoundedText(
    join(outputDirectory, 'service-uid-bootstrap-probe-v0-manifest.json'),
    MAX_MANIFEST_BYTES,
  ));
  if (buildManifest.artifactSet !== 'bootstrap-probe-v0'
    || buildManifest.probeVersion !== 0
    || buildManifest.phase4Gate !== false
    || buildManifest.implementsMacOsServiceUidV1 !== false
    || buildManifest.machService !== BOOTSTRAP_MACH_SERVICE
    || buildManifest.mode !== 'development-adhoc-pinned'
    || buildManifest.brokerIdentifier !== BROKER_IDENTIFIER
    || buildManifest.clientIdentifier !== CLIENT_IDENTIFIER
    || buildManifest.isolationCanaryIdentifier !== CANARY_IDENTIFIER
    || !/^[a-f0-9]{40}$/u.test(buildManifest.brokerCodeDirectoryHash)
    || !/^[a-f0-9]{40}$/u.test(buildManifest.clientCodeDirectoryHash)) {
    throw new DevelopmentGateError(
      'signed_build_manifest_mismatch',
      'build',
    );
  }
  const clientCdHash = pinnedRequirementCdHash(
    buildManifest.brokerAcceptsClientRequirement,
    CLIENT_IDENTIFIER,
  );
  const brokerCdHash = pinnedRequirementCdHash(
    buildManifest.clientAcceptsBrokerRequirement,
    BROKER_IDENTIFIER,
  );
  if (clientCdHash !== buildManifest.clientCodeDirectoryHash
    || brokerCdHash !== buildManifest.brokerCodeDirectoryHash) {
    throw new DevelopmentGateError('signed_build_cdhash_mismatch', 'build');
  }

  for (const [artifactName, artifactPath] of [
    ['bootstrapProbeBroker', broker],
    ['bootstrapProbeClient', client],
    ['bootstrapProbeWrongClient', wrongClient],
    ['isolationCanary', canary],
  ]) {
    const expected = buildManifest.artifacts?.[artifactName]?.sha256;
    if (!/^[a-f0-9]{64}$/u.test(expected)
      || await sha256File(artifactPath) !== expected) {
      throw new DevelopmentGateError(
        'signed_build_artifact_mismatch',
        'build',
      );
    }
  }
  verifyCodeRequirement(
    broker,
    `identifier "${BROKER_IDENTIFIER}"`,
  );
  verifyCodeRequirement(
    client,
    buildManifest.brokerAcceptsClientRequirement,
  );
  verifyCodeRequirement(
    canary,
    `identifier "${CANARY_IDENTIFIER}"`,
  );
  if (codeDirectoryHash(client) !== clientCdHash) {
    throw new DevelopmentGateError('client_cdhash_mismatch', 'build');
  }
  if (codeDirectoryHash(broker) !== brokerCdHash) {
    throw new DevelopmentGateError('broker_cdhash_mismatch', 'build');
  }

  const unexpectedMatch = runCommandAllowFailure(TOOLS.codesign, [
    '--verify',
    '--strict',
    `-R=${buildManifest.brokerAcceptsClientRequirement}`,
    wrongClient,
  ], { stage: 'build' });
  if (unexpectedMatch.status === 0) {
    throw new DevelopmentGateError(
      'wrong_signature_fixture_matches',
      'build',
    );
  }
  verifyCodeRequirement(wrongClient, `identifier "${CLIENT_IDENTIFIER}"`);

  return {
    broker,
    brokerSha256: await sha256File(broker),
    brokerCdHash,
    canary,
    canarySha256: await sha256File(canary),
    client,
    clientCdHash,
    wrongClient,
  };
}

export function pinnedRequirementCdHash(requirement, identifier) {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(
    `^identifier "${escapedIdentifier}" and cdhash H"([A-Fa-f0-9]{40})"$`,
    'u',
  );
  const match = pattern.exec(requirement);
  if (!match) {
    throw new DevelopmentGateError('invalid_pinned_peer_requirement', 'build');
  }
  return match[1].toLowerCase();
}

function codeDirectoryHash(binaryPath) {
  const result = runCommand(TOOLS.codesign, [
    '-d',
    '--verbose=4',
    binaryPath,
  ], { stage: 'build' });
  const description = `${result.stdout}${result.stderr}`;
  const match = /(?:^|\n)CDHash=([A-Fa-f0-9]{40})(?:\n|$)/u.exec(description);
  if (!match) throw new DevelopmentGateError('cdhash_missing', 'build');
  return match[1].toLowerCase();
}

function verifyCodeRequirement(binaryPath, requirement) {
  runCommand(TOOLS.codesign, [
    '--verify',
    '--strict',
    '--verbose=2',
    `-R=${requirement}`,
    binaryPath,
  ], { stage: 'build' });
}

async function startHostFixture(workingDirectory, runId, host) {
  const privateRoot = hostPrivateRootForRun(runId);
  await mkdir(privateRoot, { mode: 0o700 });
  const ownerToken = randomBytes(32).toString('hex');
  const ownerMarkerPath = join(privateRoot, '.owner-token');
  await writeFile(ownerMarkerPath, `${ownerToken}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  const canaryPath = join(privateRoot, 'host-canary.txt');
  await writeFile(canaryPath, HOST_CANARY_CONTENT, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  const socketPath = join(privateRoot, 'control.sock');
  const statePath = join(privateRoot, 'state.json');
  const fixtureScriptPath = join(workingDirectory, 'host-fixture.mjs');
  const launchAgentPath = join(workingDirectory, 'host-fixture.plist');
  const instanceId = randomUUID();
  await writeFile(fixtureScriptPath, hostFixtureSource(), {
    encoding: 'utf8',
    mode: 0o500,
    flag: 'wx',
  });
  const label = hostLabelForRun(runId);
  await writeFile(launchAgentPath, renderPlist({
    Label: label,
    ProgramArguments: [
      process.execPath,
      fixtureScriptPath,
      statePath,
      socketPath,
      instanceId,
    ],
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: 'Background',
    ThrottleInterval: 5,
    Umask: 0o077,
    StandardOutPath: '/dev/null',
    StandardErrorPath: '/dev/null',
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  runCommand(TOOLS.plutil, ['-lint', launchAgentPath], {
    stage: 'host-fixture',
  });

  const target = `gui/${host.uid}/${label}`;
  if (runCommandAllowFailure(
    TOOLS.launchctl,
    ['print', target],
    { stage: 'host-fixture' },
  ).status === 0) {
    throw new DevelopmentGateError(
      'host_launchd_label_collision',
      'host-fixture',
    );
  }
  runCommand(TOOLS.launchctl, [
    'bootstrap',
    `gui/${host.uid}`,
    launchAgentPath,
  ], { stage: 'host-fixture' });

  const fixture = {
    privateRoot,
    ownerToken,
    canaryPath,
    socketPath,
    statePath,
    launchAgentPath,
    label,
    target,
    instanceId,
    hostUid: host.uid,
    bootstrapped: true,
  };
  try {
    await waitForHostFixtureReady(fixture);
    return fixture;
  } catch (error) {
    await stopHostFixture(fixture).catch(() => {});
    throw error;
  }
}

function hostFixtureSource() {
  return `import { randomUUID } from 'node:crypto';
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

if (process.argv.length !== 5) process.exit(64);
const [, , statePath, socketPath, expectedInstanceId] = process.argv;
if (!/^[a-f0-9-]{36}$/u.test(expectedInstanceId)) process.exit(64);
const state = {
  schemaVersion: 1,
  pid: process.pid,
  instanceId: randomUUID(),
  expectedInstanceId,
  signalCount: 0,
  acceptedConnections: 0,
  ready: false,
};
function save() {
  const temporary = statePath + '.tmp-' + process.pid;
  writeFileSync(temporary, JSON.stringify(state) + '\\n', { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, statePath);
}
process.on('SIGUSR1', () => {
  state.signalCount += 1;
  save();
});
const server = createServer((connection) => {
  state.acceptedConnections += 1;
  save();
  connection.destroy();
});
server.listen(socketPath, () => {
  state.ready = true;
  save();
});
function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
`;
}

async function waitForHostFixtureReady(fixture) {
  const deadline = Date.now() + FIXTURE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const stateValue = await readHostFixtureState(fixture.statePath);
      const socketInfo = await lstat(fixture.socketPath);
      if (stateValue.ready
        && stateValue.expectedInstanceId === fixture.instanceId
        && socketInfo.isSocket()) return;
    } catch {
      // launchd may not have created the fixture files yet.
    }
    await delay(50);
  }
  throw new DevelopmentGateError(
    'host_fixture_start_timeout',
    'host-fixture',
  );
}

async function observeHostFixture(fixture, hostUid) {
  const stateValue = await readHostFixtureState(fixture.statePath);
  if (!stateValue.ready
    || stateValue.expectedInstanceId !== fixture.instanceId
    || stateValue.signalCount < 0
    || stateValue.acceptedConnections < 0) {
    throw new DevelopmentGateError(
      'invalid_host_fixture_state',
      'host-observation',
    );
  }
  process.kill(stateValue.pid, 0);
  const launchd = launchdSnapshot(fixture.target);
  if (launchd.pid !== stateValue.pid) {
    throw new DevelopmentGateError(
      'host_launchd_pid_mismatch',
      'host-observation',
    );
  }
  const hostCanary = await lstat(fixture.canaryPath);
  if (!hostCanary.isFile()
    || hostCanary.isSymbolicLink()
    || hostCanary.uid !== hostUid
    || hostCanary.nlink !== 1
    || (hostCanary.mode & 0o777) !== 0o600) {
    throw new DevelopmentGateError(
      'invalid_host_canary_metadata',
      'host-observation',
    );
  }
  const socketInfo = await lstat(fixture.socketPath);
  if (!socketInfo.isSocket() || socketInfo.uid !== hostUid) {
    throw new DevelopmentGateError(
      'invalid_host_socket_metadata',
      'host-observation',
    );
  }
  return {
    pid: stateValue.pid,
    instanceId: stateValue.instanceId,
    signalCount: stateValue.signalCount,
    acceptedConnections: stateValue.acceptedConnections,
    launchd,
    hostCanarySha256: await sha256File(fixture.canaryPath),
    hostCanaryMetadata: [
      hostCanary.uid,
      hostCanary.gid,
      hostCanary.mode & 0o777,
      hostCanary.size,
      hostCanary.ino,
      hostCanary.nlink,
    ].join(':'),
  };
}

async function readHostFixtureState(statePath) {
  const value = JSON.parse(await readBoundedText(statePath, 4 * 1024));
  if (!isPlainObject(value)) throw manifestError();
  requireExactKeys(value, [
    'schemaVersion',
    'pid',
    'instanceId',
    'expectedInstanceId',
    'signalCount',
    'acceptedConnections',
    'ready',
  ]);
  if (value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid) || value.pid <= 1
    || !/^[a-f0-9-]{36}$/u.test(value.instanceId)
    || !/^[a-f0-9-]{36}$/u.test(value.expectedInstanceId)
    || !Number.isSafeInteger(value.signalCount)
    || !Number.isSafeInteger(value.acceptedConnections)
    || typeof value.ready !== 'boolean') throw manifestError();
  return value;
}

function launchdSnapshot(target) {
  const result = runCommand(TOOLS.launchctl, ['print', target], {
    stage: 'host-observation',
  });
  const pid = parsePositiveField(result.stdout, 'pid');
  const runs = parsePositiveField(result.stdout, 'runs');
  if (pid === null || runs === null) {
    throw new DevelopmentGateError(
      'launchd_snapshot_incomplete',
      'host-observation',
    );
  }
  return { pid, runs };
}

async function stopHostFixture(fixture) {
  if (!fixture.bootstrapped) return;
  const printed = runCommandAllowFailure(
    TOOLS.launchctl,
    ['print', fixture.target],
    { stage: 'cleanup' },
  );
  if (printed.status === 0) {
    if (!printed.stdout.includes(fixture.launchAgentPath)) {
      throw new DevelopmentGateError(
        'host_launchd_ownership_mismatch',
        'cleanup',
      );
    }
    runCommand(TOOLS.launchctl, ['bootout', fixture.target], {
      stage: 'cleanup',
    });
  }
  fixture.bootstrapped = false;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (runCommandAllowFailure(
      TOOLS.launchctl,
      ['print', fixture.target],
      { stage: 'cleanup' },
    ).status !== 0) return;
    await delay(50);
  }
  throw new DevelopmentGateError(
    'host_launchd_bootout_timeout',
    'cleanup',
  );
}

async function proveHostSocketStillListening(fixture) {
  await new Promise((accept, reject) => {
    const socket = createConnection(fixture.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new DevelopmentGateError(
        'host_socket_self_probe_timeout',
        'host-observation',
      ));
    }, 1_000);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      accept();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const stateValue = await readHostFixtureState(fixture.statePath);
    if (stateValue.acceptedConnections === 1) return;
    await delay(25);
  }
}

function createAdminManifest({
  runId,
  serviceUid,
  host,
  hostFixture,
  build,
  legacyRecovery,
  recoveryJournalPresent = false,
  ownershipToken = randomBytes(32).toString('hex'),
}) {
  return validateAdminManifestShape({
    schemaVersion: GATE_SCHEMA_VERSION,
    kind: 'roundtable-service-uid-development-gate-admin-transaction-v5',
    runId,
    ownershipToken,
    serviceUid,
    serviceIdentity: {
      // Directory Services creates the user UUID. Ownership is bound before
      // creation by the random runId, UID/GID, full name, manifest hash, root
      // journal, and root-owned installation marker, then recaptured exactly.
      userGeneratedUid: null,
      groupGeneratedUid: randomUUID().toUpperCase(),
    },
    transaction: {
      notAfter: new Date(Date.now() + ADMIN_AUTHORIZATION_TIMEOUT_MS).toISOString(),
      maximumDurationMs: ADMIN_AUTHORIZATION_TIMEOUT_MS,
      recoveryJournalPresent,
      testSet: [...ADMIN_TRANSACTION_TEST_SET],
      cleanupSet: [...ADMIN_TRANSACTION_CLEANUP_SET],
    },
    codeDirectoryHashes: {
      broker: build.brokerCdHash,
      client: build.clientCdHash,
    },
    host: {
      uid: host.uid,
      gid: host.gid,
      username: host.username,
      pid: hostFixtureStatePid(hostFixture),
      instanceId: hostFixture.instanceId,
      privateRoot: hostFixture.privateRoot,
      socketPath: hostFixture.socketPath,
      canaryPath: hostFixture.canaryPath,
    },
    sources: {
      broker: { path: build.broker, sha256: build.brokerSha256 },
      canary: { path: build.canary, sha256: build.canarySha256 },
    },
    legacyRecovery,
  });
}

export async function captureLegacyRecoveryEvidence() {
  const userExists = directoryServiceRecordExists('/Users', SERVICE_USER);
  const groupExists = directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  if (!userExists && !groupExists) {
    return {
      state: 'absent',
      runId: null,
      fingerprint: null,
      hostEvidence: null,
    };
  }
  if (!userExists) {
    return {
      state: 'unknown',
      runId: null,
      fingerprint: null,
      hostEvidence: null,
    };
  }
  if (await pathExists(INSTALL_ROOT)
    && await pathExists(TRANSACTION_JOURNAL_ROOT)) {
    try {
      return await captureInterruptedTransactionRecoveryEvidence();
    } catch {
      return {
        state: 'unknown',
        runId: null,
        fingerprint: null,
        hostEvidence: null,
      };
    }
  }
  try {
    const userRunId = readDirectoryServiceProperty(`/Users/${SERVICE_USER}`, 'RealName')
      .replace(/^Roundtable Service UID Bootstrap Probe /u, '');
    const groupRunId = groupExists
      ? readDirectoryServiceProperty(`/Groups/${SERVICE_GROUP}`, 'RealName')
        .replace(/^Roundtable Service UID Bootstrap Probe /u, '')
      : null;
    if (userRunId !== LEGACY_RESIDUE_RUN_ID
      || (groupExists && groupRunId !== LEGACY_RESIDUE_RUN_ID)) {
      return {
        state: 'unknown',
        runId: null,
        fingerprint: null,
        hostEvidence: null,
      };
    }
    if (!groupExists) assertLegacyUserFields();
    const fingerprint = groupExists
      ? legacyIdentityFingerprint()
      : LEGACY_RESIDUE_FINGERPRINT;
    const hostEvidence = await captureLegacyHostEvidence();
    if (!isValidLegacyHostEvidence(hostEvidence)) throw manifestError();
    if (!groupExists && !hostEvidence.transactionJournalRootPresent) {
      throw manifestError();
    }
    return {
      state: 'candidate',
      runId: LEGACY_RESIDUE_RUN_ID,
      fingerprint,
      hostEvidence,
    };
  } catch {
    try {
      return await captureInterruptedTransactionRecoveryEvidence();
    } catch {
      return {
        state: 'unknown',
        runId: null,
        fingerprint: null,
        hostEvidence: null,
      };
    }
  }
}

export async function captureInterruptedTransactionRecoveryEvidence() {
  if (!await pathExists(INSTALL_ROOT)
    || !await pathExists(TRANSACTION_JOURNAL_ROOT)) throw manifestError();
  const marker = await readHostInstallationMarker();
  const userPath = `/Users/${SERVICE_USER}`;
  const groupPath = `/Groups/${SERVICE_GROUP}`;
  const expectedRealName = serviceRealName(marker.runId);
  const userGeneratedUid = readDirectoryServiceProperty(userPath, 'GeneratedUID');
  const observedUserUid = readOptionalDirectoryServiceProperty(userPath, 'UniqueID');
  const observedUserPrimaryGid = readOptionalDirectoryServiceProperty(
    userPath,
    'PrimaryGroupID',
  );
  const userProperties = Object.fromEntries([
    'RealName', 'UserShell', 'NFSHomeDirectory', 'IsHidden',
  ].map((property) => [
    property,
    readOptionalDirectoryServiceProperty(userPath, property),
  ]));
  const missingUserProperties = [
    'RealName', 'UserShell', 'NFSHomeDirectory', 'IsHidden',
  ].filter((property) => directoryServicePropertyIsMissing(userPath, property));
  const membership = runCommand(TOOLS.dscl, [
    '.', '-read', groupPath, 'GroupMembership', 'GroupMembers',
  ], { stage: 'directory-service' }).stdout;
  const installEntries = (await readdir(INSTALL_ROOT)).sort();
  const hostEvidence = {
    serviceUid: marker.serviceUid,
    userRecordsWithUid: directoryServiceRecordsWithId(
      '/Users', 'UniqueID', marker.serviceUid,
    ),
    groupRecordsWithGid: directoryServiceRecordsWithId(
      '/Groups', 'PrimaryGroupID', marker.serviceUid,
    ),
    observedUserGeneratedUid: userGeneratedUid,
    observedUserUid,
    observedUserPrimaryGid,
    observedUserGroupIds: directoryServiceGroupIdsForUser(SERVICE_USER),
    userProperties,
    groupGeneratedUid: readDirectoryServiceProperty(groupPath, 'GeneratedUID'),
    groupRealName: readDirectoryServiceProperty(groupPath, 'RealName'),
    groupHidden: readDirectoryServiceProperty(groupPath, 'IsHidden'),
    groupMembershipAbsent:
      !/(?:^|\n)(?:GroupMembership|GroupMembers):/u.test(membership),
    userMissingProperties: missingUserProperties,
    serviceUidProcessCount: listProcessesForUid(marker.serviceUid).length,
    brokerJobPresent: launchdJobExists(BROKER_LABEL),
    canaryJobPresent: launchdJobExists(canaryLabelForRun(marker.runId)),
    installRootEntries: installEntries,
    brokerPlistPresent: await pathExists(BROKER_PLIST_PATH),
    canaryPlistPresent: await pathExists(canaryPlistPathForRun(marker.runId)),
    transactionJournalRootPresent: true,
    marker,
  };
  if (hostEvidence.groupRealName !== expectedRealName
    || !isValidInterruptedHostEvidence(hostEvidence)) throw manifestError();
  return {
    state: 'interrupted-candidate',
    runId: marker.runId,
    fingerprint: createHash('sha256').update(
      JSON.stringify(hostEvidence),
    ).digest('hex'),
    hostEvidence,
  };
}

async function readHostInstallationMarker() {
  const rootInfo = await lstat(INSTALL_ROOT);
  const markerPath = join(INSTALL_ROOT, 'ownership.json');
  const markerInfo = await lstat(markerPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || rootInfo.uid !== 0 || rootInfo.gid !== 0
    || (rootInfo.mode & 0o777) !== 0o755
    || await realpath(INSTALL_ROOT) !== INSTALL_ROOT
    || !markerInfo.isFile() || markerInfo.isSymbolicLink()
    || markerInfo.nlink !== 1 || markerInfo.uid !== 0 || markerInfo.gid !== 0
    || (markerInfo.mode & 0o777) !== 0o444) throw manifestError();
  const marker = JSON.parse(await readBoundedText(markerPath, 4 * 1024));
  if (!isPlainObject(marker)) throw manifestError();
  requireExactKeys(marker, [
    'schemaVersion', 'kind', 'runId', 'ownershipToken', 'serviceUid',
    'serviceIdentity', 'codeDirectoryHashes', 'manifestSha256',
  ]);
  if (marker.schemaVersion !== GATE_SCHEMA_VERSION
    || marker.kind !== 'roundtable-service-uid-development-gate-install-v4'
    || !/^[a-f0-9]{32}$/u.test(marker.runId)
    || !/^[a-f0-9]{64}$/u.test(marker.ownershipToken)
    || !Number.isSafeInteger(marker.serviceUid)
    || marker.serviceUid < SERVICE_UID_MINIMUM
    || marker.serviceUid > SERVICE_UID_MAXIMUM
    || !isPlainObject(marker.serviceIdentity)
    || !isPlainObject(marker.codeDirectoryHashes)
    || !/^[a-f0-9]{64}$/u.test(marker.manifestSha256)) throw manifestError();
  requireExactKeys(marker.serviceIdentity, [
    'userGeneratedUid', 'groupGeneratedUid',
  ]);
  requireExactKeys(marker.codeDirectoryHashes, ['broker', 'client']);
  const generatedUid = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/u;
  if ((marker.serviceIdentity.userGeneratedUid !== null
      && !generatedUid.test(marker.serviceIdentity.userGeneratedUid))
    || !generatedUid.test(marker.serviceIdentity.groupGeneratedUid)
    || !/^[a-f0-9]{40}$/u.test(marker.codeDirectoryHashes.broker)
    || !/^[a-f0-9]{40}$/u.test(marker.codeDirectoryHashes.client)) {
    throw manifestError();
  }
  return marker;
}

function directoryServicePropertyIsMissing(recordPath, property) {
  const result = runCommandAllowFailure(
    TOOLS.dscl,
    ['.', '-read', recordPath, property],
    { stage: 'directory-service' },
  );
  return result.status === 0
    && `${result.stdout}${result.stderr}`.trim() === `No such key: ${property}`;
}

function readOptionalDirectoryServiceProperty(recordPath, property) {
  if (directoryServicePropertyIsMissing(recordPath, property)) return null;
  return readDirectoryServiceProperty(recordPath, property);
}

function directoryServiceGroupIdsForUser(username) {
  const result = runCommand(TOOLS.id, ['-G', username], {
    stage: 'directory-service',
  });
  const values = result.stdout.trim().split(/\s+/u).map(Number);
  if (values.length === 0
    || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw manifestError();
  }
  return values;
}

function interruptedUserStateIsRecoverable(value) {
  const expected = {
    RealName: serviceRealName(value.marker.runId),
    UserShell: '/usr/bin/false',
    NFSHomeDirectory: '/var/empty',
    IsHidden: '1',
  };
  const properties = value.userProperties;
  const missing = value.userMissingProperties;
  const oldGeneratedUidOverwrite =
    value.marker.serviceIdentity.userGeneratedUid !== null
    && value.observedUserGeneratedUid
      !== value.marker.serviceIdentity.userGeneratedUid
    && value.observedUserUid === String(value.serviceUid)
    && value.observedUserPrimaryGid === String(value.serviceUid)
    && Object.values(properties).every((entry) => entry === null)
    && arraysEqual(missing, [
      'RealName', 'UserShell', 'NFSHomeDirectory', 'IsHidden',
    ]);
  const sysadminctlCommitInterrupted =
    value.marker.serviceIdentity.userGeneratedUid === null
    && value.observedUserUid === String(value.serviceUid)
    && value.observedUserPrimaryGid === '20'
    && JSON.stringify(properties) === JSON.stringify(expected)
    && missing.length === 0
    && arraysEqual(value.observedUserGroupIds, [20, 12, 61, 701, 100]);
  const dsclFieldOrder = [
    'RealName', 'UserShell', 'NFSHomeDirectory', 'IsHidden',
  ];
  const firstMissing = dsclFieldOrder.findIndex(
    (property) => properties[property] === null,
  );
  const prefixLength = firstMissing === -1 ? dsclFieldOrder.length : firstMissing;
  const dsclPropertiesArePrefix = dsclFieldOrder.every((property, index) => (
    index < prefixLength
      ? properties[property] === expected[property]
      : properties[property] === null
  ));
  const dsclTransactionInterrupted =
    value.marker.serviceIdentity.userGeneratedUid === null
    && [null, String(value.serviceUid)].includes(value.observedUserUid)
    && [null, String(value.serviceUid)].includes(value.observedUserPrimaryGid)
    && (value.observedUserUid === String(value.serviceUid)
      || value.userRecordsWithUid.length === 0)
    && (value.observedUserUid === null
      || arraysEqual(value.userRecordsWithUid, [SERVICE_USER]))
    && dsclPropertiesArePrefix
    && arraysEqual(missing, dsclFieldOrder.slice(prefixLength));
  return oldGeneratedUidOverwrite
    || sysadminctlCommitInterrupted
    || dsclTransactionInterrupted;
}

function isValidInterruptedHostEvidence(value) {
  if (!isPlainObject(value) || !isPlainObject(value.marker)) return false;
  try {
    requireExactKeys(value, [
      'serviceUid', 'userRecordsWithUid', 'groupRecordsWithGid',
      'observedUserGeneratedUid', 'observedUserUid',
      'observedUserPrimaryGid', 'observedUserGroupIds', 'userProperties',
      'groupGeneratedUid', 'groupRealName',
      'groupHidden', 'groupMembershipAbsent', 'userMissingProperties',
      'serviceUidProcessCount', 'brokerJobPresent', 'canaryJobPresent',
      'installRootEntries', 'brokerPlistPresent', 'canaryPlistPresent',
      'transactionJournalRootPresent', 'marker',
    ]);
    requireExactKeys(value.marker, [
      'schemaVersion', 'kind', 'runId', 'ownershipToken', 'serviceUid',
      'serviceIdentity', 'codeDirectoryHashes', 'manifestSha256',
    ]);
    if (!isPlainObject(value.marker.serviceIdentity)
      || !isPlainObject(value.marker.codeDirectoryHashes)) return false;
    requireExactKeys(value.marker.serviceIdentity, [
      'userGeneratedUid', 'groupGeneratedUid',
    ]);
    requireExactKeys(value.marker.codeDirectoryHashes, ['broker', 'client']);
    requireExactKeys(value.userProperties, [
      'RealName', 'UserShell', 'NFSHomeDirectory', 'IsHidden',
    ]);
  } catch {
    return false;
  }
  const generatedUid = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/u;
  return value.marker.schemaVersion === GATE_SCHEMA_VERSION
    && value.marker.kind === 'roundtable-service-uid-development-gate-install-v4'
    && /^[a-f0-9]{32}$/u.test(value.marker.runId)
    && /^[a-f0-9]{64}$/u.test(value.marker.ownershipToken)
    && /^[a-f0-9]{64}$/u.test(value.marker.manifestSha256)
    && /^[a-f0-9]{40}$/u.test(value.marker.codeDirectoryHashes.broker)
    && /^[a-f0-9]{40}$/u.test(value.marker.codeDirectoryHashes.client)
    && (value.marker.serviceIdentity.userGeneratedUid === null
      || generatedUid.test(value.marker.serviceIdentity.userGeneratedUid))
    && generatedUid.test(value.marker.serviceIdentity.groupGeneratedUid)
    && Number.isSafeInteger(value.serviceUid)
    && value.serviceUid === value.marker.serviceUid
    && Array.isArray(value.userRecordsWithUid)
    && (arraysEqual(value.userRecordsWithUid, [SERVICE_USER])
      || value.userRecordsWithUid.length === 0)
    && Array.isArray(value.groupRecordsWithGid)
    && arraysEqual(value.groupRecordsWithGid, [SERVICE_GROUP])
    && generatedUid.test(value.observedUserGeneratedUid)
    && Array.isArray(value.observedUserGroupIds)
    && value.observedUserGroupIds.length > 0
    && value.observedUserGroupIds.length <= 16
    && value.observedUserGroupIds.every(
      (groupId) => Number.isSafeInteger(groupId) && groupId >= 0,
    )
    && !value.observedUserGroupIds.includes(0)
    && !value.observedUserGroupIds.includes(80)
    && value.groupGeneratedUid === value.marker.serviceIdentity.groupGeneratedUid
    && value.groupRealName === serviceRealName(value.marker.runId)
    && value.groupHidden === '1'
    && value.groupMembershipAbsent === true
    && interruptedUserStateIsRecoverable(value)
    && value.serviceUidProcessCount === 0
    && value.brokerJobPresent === false
    && value.canaryJobPresent === false
    && arraysEqual(value.installRootEntries, ['ownership.json'])
    && value.brokerPlistPresent === false
    && value.canaryPlistPresent === false
    && value.transactionJournalRootPresent === true;
}

async function captureLegacyHostEvidence() {
  const hostEvidence = {
    serviceUid: 499,
    userRecordsWithUid: directoryServiceRecordsWithId(
      '/Users',
      'UniqueID',
      499,
    ),
    groupRecordsWithGid: directoryServiceRecordsWithId(
      '/Groups',
      'PrimaryGroupID',
      499,
    ),
    serviceUidProcessCount: listProcessesForUid(499).length,
    brokerJobPresent: launchdJobExists(BROKER_LABEL),
    legacyCanaryJobPresent: launchdJobExists(
      canaryLabelForRun(LEGACY_RESIDUE_RUN_ID),
    ),
    installRootPresent: await pathExists(INSTALL_ROOT),
    brokerPlistPresent: await pathExists(BROKER_PLIST_PATH),
    legacyCanaryPlistPresent: await pathExists(
      canaryPlistPathForRun(LEGACY_RESIDUE_RUN_ID),
    ),
    transactionJournalRootPresent: await pathExists(
      TRANSACTION_JOURNAL_ROOT,
    ),
  };
  return hostEvidence;
}

function isValidLegacyHostEvidence(value) {
  if (!isPlainObject(value)) return false;
  try {
    requireExactKeys(value, [
      'serviceUid',
      'userRecordsWithUid',
      'groupRecordsWithGid',
      'serviceUidProcessCount',
      'brokerJobPresent',
      'legacyCanaryJobPresent',
      'installRootPresent',
      'brokerPlistPresent',
      'legacyCanaryPlistPresent',
      'transactionJournalRootPresent',
    ]);
  } catch {
    return false;
  }
  const groupEvidenceMatches = Array.isArray(value.groupRecordsWithGid)
    && (value.groupRecordsWithGid.length === 1
      ? value.groupRecordsWithGid[0] === SERVICE_GROUP
      : value.groupRecordsWithGid.length === 0
        && value.transactionJournalRootPresent === true);
  return value.serviceUid === 499
    && Array.isArray(value.userRecordsWithUid)
    && value.userRecordsWithUid.length === 1
    && value.userRecordsWithUid[0] === SERVICE_USER
    && groupEvidenceMatches
    && value.serviceUidProcessCount === 0
    && value.brokerJobPresent === false
    && value.legacyCanaryJobPresent === false
    && value.installRootPresent === false
    && value.brokerPlistPresent === false
    && value.legacyCanaryPlistPresent === false
    && typeof value.transactionJournalRootPresent === 'boolean';
}

function launchdJobExists(label) {
  return runCommandAllowFailure(
    TOOLS.launchctl,
    ['print', `system/${label}`],
    { stage: 'directory-service' },
  ).status === 0;
}

async function assertLegacyHostEvidence(
  recovery,
  { currentJournalAllowed, expectedJournalPresent = null },
) {
  if (recovery.state !== 'candidate') return;
  const observed = await captureLegacyHostEvidence();
  const expected = recovery.hostEvidence;
  const keys = Object.keys(expected).filter(
    (key) => key !== 'transactionJournalRootPresent',
  );
  const safetyEvidenceMatches = keys.every((key) => (
    JSON.stringify(observed[key]) === JSON.stringify(expected[key])
  ));
  const expectedJournal = expectedJournalPresent === null
    ? currentJournalAllowed ? true : expected.transactionJournalRootPresent
    : expectedJournalPresent;
  const journalEvidenceMatches = observed.transactionJournalRootPresent
      === expectedJournal
    && (!expectedJournal || await pathExists(TRANSACTION_JOURNAL_PATH));
  if (!safetyEvidenceMatches || !journalEvidenceMatches) {
    throw new DevelopmentGateError(
      'legacy_host_root_evidence_mismatch',
      'admin-identity',
    );
  }
}

function legacyIdentityFingerprint() {
  const membership = runCommand(TOOLS.dscl, [
    '.', '-read', `/Groups/${SERVICE_GROUP}`, 'GroupMembership', 'GroupMembers',
  ], { stage: 'admin-identity' }).stdout;
  if (/(?:^|\n)(?:GroupMembership|GroupMembers):/u.test(membership)) {
    throw new DevelopmentGateError('legacy_identity_group_membership_present', 'admin-identity');
  }
  const fields = {
    user: {
      name: SERVICE_USER,
      UniqueID: readDirectoryServiceProperty(`/Users/${SERVICE_USER}`, 'UniqueID'),
      PrimaryGroupID: readDirectoryServiceProperty(`/Users/${SERVICE_USER}`, 'PrimaryGroupID'),
      RealName: readDirectoryServiceProperty(`/Users/${SERVICE_USER}`, 'RealName'),
      UserShell: readDirectoryServiceProperty(`/Users/${SERVICE_USER}`, 'UserShell'),
      NFSHomeDirectory: readDirectoryServiceProperty(`/Users/${SERVICE_USER}`, 'NFSHomeDirectory'),
      IsHidden: readDirectoryServiceProperty(`/Users/${SERVICE_USER}`, 'IsHidden'),
      GeneratedUID: readDirectoryServiceProperty(`/Users/${SERVICE_USER}`, 'GeneratedUID'),
    },
    group: {
      name: SERVICE_GROUP,
      PrimaryGroupID: readDirectoryServiceProperty(`/Groups/${SERVICE_GROUP}`, 'PrimaryGroupID'),
      RealName: readDirectoryServiceProperty(`/Groups/${SERVICE_GROUP}`, 'RealName'),
      IsHidden: readDirectoryServiceProperty(`/Groups/${SERVICE_GROUP}`, 'IsHidden'),
      GeneratedUID: readDirectoryServiceProperty(`/Groups/${SERVICE_GROUP}`, 'GeneratedUID'),
      membership: 'absent',
    },
  };
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function hostFixtureStatePid(fixture) {
  const snapshot = launchdSnapshot(fixture.target);
  return snapshot.pid;
}

async function beginAdministratorTransaction(manifestPath) {
  const manifest = await loadInvocationManifest(manifestPath);
  const packageDirectory = `${ADMIN_PACKAGE_PREFIX}${manifest.runId}-${
    randomBytes(16).toString('hex')
  }`;
  const sealed = sealedAdminPackagePaths(packageDirectory);
  const administratorHelperSha256 = await sha256File(ADMIN_HELPER_SOURCE);
  const expectedAdministratorHelperSha256 = await readNativeAdministratorHelperHash();
  if (administratorHelperSha256 !== expectedAdministratorHelperSha256) {
    throw new DevelopmentGateError('administrator_helper_hash_mismatch', 'authorization');
  }
  const authorizationLauncherSha256 = await sha256File(
    AUTHORIZATION_LAUNCHER_SOURCE,
  );
  const expectedAuthorizationLauncherSha256 =
    await readNativeAuthorizationLauncherHash();
  if (authorizationLauncherSha256 !== expectedAuthorizationLauncherSha256) {
    throw new DevelopmentGateError(
      'authorization_launcher_hash_mismatch',
      'authorization',
    );
  }
  const copyInputs = [
    [ADMIN_HELPER_SOURCE, sealed.helper, administratorHelperSha256, '0500'],
    [process.execPath, sealed.node, await sha256File(process.execPath), '0500'],
    [scriptPath, sealed.script, await sha256File(scriptPath), '0500'],
    [manifestPath, sealed.manifest, await sha256File(manifestPath), '0400'],
    [
      manifest.sources.broker.path,
      sealed.broker,
      manifest.sources.broker.sha256,
      '0500',
    ],
    [
      manifest.sources.canary.path,
      sealed.canary,
      manifest.sources.canary.sha256,
      '0500',
    ],
  ];
  const launcherArguments = createAuthorizationLauncherArguments(
    packageDirectory,
    copyInputs,
  );
  const child = spawn(AUTHORIZATION_LAUNCHER_SOURCE, launcherArguments, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { settled: false, value: null, error: null };
  const rawCompletion = collectAdministratorTransaction(child);
  const completion = rawCompletion.then(
    (value) => {
      state.settled = true;
      state.value = value;
      return value;
    },
    (error) => {
      state.settled = true;
      state.error = normalizeError(error);
      throw state.error;
    },
  );
  void completion.catch(() => undefined);
  return { completion, state, packageDirectory };
}

export function createAuthorizationLauncherArguments(
  packageDirectory,
  copyInputs,
) {
  const sealed = sealedAdminPackagePaths(packageDirectory);
  if (!Array.isArray(copyInputs) || copyInputs.length !== 6) {
    throw new DevelopmentGateError('invalid_sealed_input_set', 'authorization');
  }
  const expectedTargets = [
    sealed.helper,
    sealed.node,
    sealed.script,
    sealed.manifest,
    sealed.broker,
    sealed.canary,
  ];
  const expectedModes = ['0500', '0500', '0500', '0400', '0500', '0500'];
  const launcherArguments = [packageDirectory];
  copyInputs.forEach((input, index) => {
    if (!Array.isArray(input) || input.length !== 4) {
      throw new DevelopmentGateError('invalid_sealed_input_set', 'authorization');
    }
    const [source, target, expectedHash, mode] = input;
    if (!boundedAbsolutePath(source)
      || target !== expectedTargets[index]
      || mode !== expectedModes[index]
      || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new DevelopmentGateError('invalid_sealed_input_set', 'authorization');
    }
    launcherArguments.push(source, expectedHash);
  });
  return launcherArguments;
}

export async function readNativeAdministratorHelperHash() {
  const source = await readFile(ADMIN_HELPER_MANIFEST_SOURCE, 'utf8');
  const architecturePattern = new RegExp(
    `NATIVE_ADMINISTRATOR_HELPER_MANIFEST[\\s\\S]*?${escapeRegExp(process.arch)}: Object\\.freeze\\(\\{[\\s\\S]*?sha256: '([a-f0-9]{64})'`,
    'u',
  );
  const match = architecturePattern.exec(source);
  if (!match?.[1]) {
    throw new DevelopmentGateError('administrator_helper_manifest_missing', 'authorization');
  }
  return match[1];
}

export async function readNativeAuthorizationLauncherHash() {
  const source = await readFile(ADMIN_HELPER_MANIFEST_SOURCE, 'utf8');
  const architecturePattern = new RegExp(
    `NATIVE_AUTHORIZATION_LAUNCHER_MANIFEST[\\s\\S]*?${escapeRegExp(process.arch)}: Object\\.freeze\\(\\{[\\s\\S]*?sha256: '([a-f0-9]{64})'`,
    'u',
  );
  const match = architecturePattern.exec(source);
  if (!match?.[1]) {
    throw new DevelopmentGateError(
      'authorization_launcher_manifest_missing',
      'authorization',
    );
  }
  return match[1];
}

async function collectAdministratorTransaction(child) {
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, ADMIN_AUTHORIZATION_TIMEOUT_MS);
  timer.unref();
  const append = (target) => (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
      child.kill('SIGTERM');
      return;
    }
    target.push(chunk);
  };
  child.stdout.on('data', append(stdout));
  child.stderr.on('data', append(stderr));
  let result;
  try {
    result = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => accept({ status, signal }));
    });
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    throw new DevelopmentGateError(
      'administrator_action_timeout',
      'authorization',
    );
  }
  if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
    throw new DevelopmentGateError(
      'administrator_output_too_large',
      'authorization',
    );
  }
  const output = Buffer.concat(stdout).toString('utf8').trim();
  const diagnostic = sanitizeDiagnostic(
    Buffer.concat(stderr).toString('utf8'),
  );
  if (result.status !== 0 || result.signal !== null) {
    throw new DevelopmentGateError(
      'administrator_action_failed',
      'authorization',
      diagnostic || 'administrator_action_failed',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new DevelopmentGateError(
      'invalid_administrator_response',
      'authorization',
    );
  }
  validateAdministratorTransactionResult(parsed);
  return parsed;
}

async function waitForAdministratorReady(transaction, manifest) {
  const deadline = Date.now() + ADMIN_AUTHORIZATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await readAdministratorReady(manifest).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (ready !== null) return ready;
    if (transaction.state.settled) {
      if (transaction.state.error) throw transaction.state.error;
      throw administratorResultError(transaction.state.value);
    }
    await delay(50);
  }
  throw new DevelopmentGateError(
    'administrator_ready_timeout',
    'authorization',
  );
}

function administratorReadyPath(manifest) {
  return join(manifest.host.privateRoot, `.admin-ready-${manifest.runId}.json`);
}

function hostAcknowledgementPath(manifest) {
  return join(manifest.host.privateRoot, `.host-ack-${manifest.runId}.json`);
}

async function writeAdministratorReady(manifest, checks) {
  await writePublishedJson(administratorReadyPath(manifest), {
    schemaVersion: GATE_SCHEMA_VERSION,
    kind: 'roundtable-service-uid-administrator-ready-v1',
    runId: manifest.runId,
    ownershipToken: manifest.ownershipToken,
    canaryDenials: checks.canaryDenials,
    stagingWriteReported: checks.stagingWriteReported,
    brokerStderrEmpty: checks.brokerStderrEmpty,
  }, 0o444, 0, 0);
}

async function readAdministratorReady(manifest) {
  const path = administratorReadyPath(manifest);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o777) !== 0o444
    || info.size <= 0 || info.size > 4 * 1024
    || await realpath(path) !== path) {
    throw new DevelopmentGateError('invalid_administrator_ready', 'handshake');
  }
  const value = JSON.parse(await readBoundedText(path, 4 * 1024));
  if (!isPlainObject(value)) {
    throw new DevelopmentGateError('invalid_administrator_ready', 'handshake');
  }
  requireExactKeys(value, [
    'schemaVersion',
    'kind',
    'runId',
    'ownershipToken',
    'canaryDenials',
    'stagingWriteReported',
    'brokerStderrEmpty',
  ]);
  if (value.schemaVersion !== GATE_SCHEMA_VERSION
    || value.kind !== 'roundtable-service-uid-administrator-ready-v1'
    || value.runId !== manifest.runId
    || value.ownershipToken !== manifest.ownershipToken
    || value.canaryDenials !== true
    || value.stagingWriteReported !== true
    || value.brokerStderrEmpty !== true) {
    throw new DevelopmentGateError('invalid_administrator_ready', 'handshake');
  }
  return value;
}

async function writeHostAcknowledgement(manifest, result) {
  if (!['passed', 'failed'].includes(result)
    || getuid() !== manifest.host.uid || getgid() !== manifest.host.gid) {
    throw new DevelopmentGateError('invalid_host_acknowledgement', 'handshake');
  }
  await writePublishedJson(hostAcknowledgementPath(manifest), {
    schemaVersion: GATE_SCHEMA_VERSION,
    kind: 'roundtable-service-uid-host-acknowledgement-v1',
    runId: manifest.runId,
    ownershipToken: manifest.ownershipToken,
    result,
  }, 0o600, manifest.host.uid, manifest.host.gid);
}

async function waitForHostAcknowledgement(manifest) {
  const deadline = Date.now() + HOST_ACKNOWLEDGEMENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const value = await readHostAcknowledgement(manifest);
      return value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  throw new DevelopmentGateError(
    'host_acknowledgement_timeout',
    'handshake',
  );
}

async function readHostAcknowledgement(manifest) {
  const path = hostAcknowledgementPath(manifest);
  const info = await lstat(path);
  const canonicalPath = await realpath(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.uid !== manifest.host.uid || info.gid !== manifest.host.gid
    || (info.mode & 0o777) !== 0o600
    || info.size <= 0 || info.size > 4 * 1024
    || canonicalPath !== path) {
    throw new DevelopmentGateError(
      'invalid_host_acknowledgement',
      'handshake',
      `metadata uid=${info.uid} gid=${info.gid} mode=${(
        info.mode & 0o777
      ).toString(8)} nlink=${info.nlink} size=${info.size} canonical=${canonicalPath}`,
    );
  }
  let value;
  try {
    value = JSON.parse(await readBoundedText(path, 4 * 1024));
  } catch {
    throw new DevelopmentGateError(
      'invalid_host_acknowledgement',
      'handshake',
      'host acknowledgement JSON parse failed',
    );
  }
  if (!isPlainObject(value)) {
    throw new DevelopmentGateError(
      'invalid_host_acknowledgement',
      'handshake',
      `payload=${JSON.stringify(value)}`,
    );
  }
  try {
    requireExactKeys(value, [
      'schemaVersion',
      'kind',
      'runId',
      'ownershipToken',
      'result',
    ]);
  } catch {
    throw new DevelopmentGateError(
      'invalid_host_acknowledgement',
      'handshake',
      `keys=${Object.keys(value).sort().join(',')}`,
    );
  }
  if (value.schemaVersion !== GATE_SCHEMA_VERSION
    || value.kind !== 'roundtable-service-uid-host-acknowledgement-v1'
    || value.runId !== manifest.runId
    || value.ownershipToken !== manifest.ownershipToken
    || !['passed', 'failed'].includes(value.result)) {
    throw new DevelopmentGateError(
      'invalid_host_acknowledgement',
      'handshake',
      `payload=${JSON.stringify(value)}`,
    );
  }
  return value;
}

async function removeOwnedHandshakeFiles(manifest) {
  const readyPath = administratorReadyPath(manifest);
  if (await pathExists(readyPath)) {
    await readAdministratorReady(manifest);
    await unlink(readyPath);
  }
  const acknowledgementPath = hostAcknowledgementPath(manifest);
  if (await pathExists(acknowledgementPath)) {
    const info = await lstat(acknowledgementPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || info.uid !== manifest.host.uid || info.gid !== manifest.host.gid
      || (info.mode & 0o777) !== 0o600
      || info.size <= 0 || info.size > 4 * 1024
      || await realpath(acknowledgementPath) !== acknowledgementPath) {
      throw new DevelopmentGateError(
        'invalid_host_acknowledgement',
        'cleanup',
      );
    }
    await unlink(acknowledgementPath);
  }
  for (const pendingPath of [`${readyPath}.next`, `${acknowledgementPath}.next`]) {
    if (!await pathExists(pendingPath)) continue;
    const info = await lstat(pendingPath);
    const metadataMatches = (info.uid === 0 && info.gid === 0
        && (info.mode & 0o777) === 0o444)
      || (info.uid === manifest.host.uid && info.gid === manifest.host.gid
        && (info.mode & 0o777) === 0o600);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || !metadataMatches
      || await realpath(pendingPath) !== pendingPath) {
      throw new DevelopmentGateError('invalid_handshake_pending_file', 'cleanup');
    }
    await unlink(pendingPath);
  }
}

function cleanAdministratorCleanupResult() {
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    action: 'admin-rollback',
    result: 'cleaned',
    stagingEvidence: 'not_observed',
    serviceUidZeroProcesses: true,
    accountRemoved: true,
    fixedResourcesRemoved: true,
    errors: [],
  };
}

export function validateAdministratorTransactionResult(value) {
  if (!isPlainObject(value)) {
    throw new DevelopmentGateError('invalid_administrator_response', 'authorization');
  }
  const expectedKeys = [
    'schemaVersion',
    'action',
    'result',
    'crashRecoveryVerified',
    'systemMutationsPerformed',
    'systemTrustModified',
    'residualState',
    'cleanup',
    ...(value.result === 'completed' ? [] : ['error']),
  ];
  try {
    requireExactKeys(value, expectedKeys);
  } catch {
    throw new DevelopmentGateError(
      'invalid_administrator_response',
      'authorization',
    );
  }
  if (value.schemaVersion !== GATE_SCHEMA_VERSION
    || value.action !== 'admin-transaction'
    || !['completed', 'failed', 'cleanup_incomplete'].includes(value.result)
    || typeof value.crashRecoveryVerified !== 'boolean'
    || (value.result === 'completed' && !value.crashRecoveryVerified)
    || typeof value.systemMutationsPerformed !== 'boolean'
    || value.systemTrustModified !== false
    || !RESIDUAL_STATES.includes(value.residualState)
    || !isPlainObject(value.cleanup)
    || !['cleaned', 'cleanup_incomplete'].includes(value.cleanup.result)) {
    throw new DevelopmentGateError('invalid_administrator_response', 'authorization');
  }
  validateAdministratorCleanupResult(value.cleanup);
  if (value.result !== 'completed'
    && (!isPlainObject(value.error)
      || typeof value.error.code !== 'string'
      || typeof value.error.stage !== 'string')) {
    throw new DevelopmentGateError('invalid_administrator_response', 'authorization');
  }
  if (value.result !== 'completed') {
    const hasDiagnostic = Object.hasOwn(value.error, 'diagnostic');
    try {
      requireExactKeys(value.error, [
        'code',
        'stage',
        ...(hasDiagnostic ? ['diagnostic'] : []),
      ]);
    } catch {
      throw new DevelopmentGateError(
        'invalid_administrator_response',
        'authorization',
      );
    }
    if (!/^[a-z0-9_]{1,80}$/u.test(value.error.code)
      || !/^[a-z0-9-]{1,80}$/u.test(value.error.stage)
      || (hasDiagnostic
        && (typeof value.error.diagnostic !== 'string'
          || value.error.diagnostic.length > 1024))) {
      throw new DevelopmentGateError(
        'invalid_administrator_response',
        'authorization',
      );
    }
  }
  return value;
}

function validateAdministratorCleanupResult(value) {
  try {
    requireExactKeys(value, [
      'schemaVersion',
      'action',
      'result',
      'stagingEvidence',
      'serviceUidZeroProcesses',
      'accountRemoved',
      'fixedResourcesRemoved',
      'errors',
    ]);
  } catch {
    throw new DevelopmentGateError(
      'invalid_administrator_response',
      'authorization',
    );
  }
  if (value.schemaVersion !== GATE_SCHEMA_VERSION
    || !['admin-rollback', 'admin-cleanup'].includes(value.action)
    || !['cleaned', 'cleanup_incomplete'].includes(value.result)
    || !['not_observed', 'not_present', 'not_written', 'verified'].includes(
      value.stagingEvidence,
    )
    || typeof value.serviceUidZeroProcesses !== 'boolean'
    || typeof value.accountRemoved !== 'boolean'
    || typeof value.fixedResourcesRemoved !== 'boolean'
    || !Array.isArray(value.errors)
    || value.errors.length > 8
    || value.errors.some((entry) => (
      typeof entry !== 'string' || !/^[a-z0-9_]{1,80}$/u.test(entry)
    ))) {
    throw new DevelopmentGateError(
      'invalid_administrator_response',
      'authorization',
    );
  }
  if (value.result === 'cleaned'
    && (!value.serviceUidZeroProcesses
      || !value.accountRemoved
      || !value.fixedResourcesRemoved
      || value.errors.length !== 0)) {
    throw new DevelopmentGateError(
      'invalid_administrator_response',
      'authorization',
    );
  }
}

function applyAdministratorResult(report, result) {
  validateAdministratorTransactionResult(result);
  report.authorizationCompleted = true;
  report.checks.journalCrashRecovery = result.crashRecoveryVerified;
  report.systemMutationsPerformed ||= result.systemMutationsPerformed;
  report.systemMutationState = report.systemMutationsPerformed
    ? 'performed'
    : 'none-observed';
  report.residualState = result.residualState;
  report.cleanup.administratorTransactionFinished = true;
  report.cleanup.administratorCleanupComplete = result.cleanup.result === 'cleaned';
  report.checks.serviceUidZeroProcesses =
    result.cleanup.serviceUidZeroProcesses === true;
}

export function auditedResidualState(resourcesExist, administratorResult) {
  if (resourcesExist === false) return 'absent';
  if (resourcesExist !== true) return 'unknown';
  return ['quarantined', 'cleanup-incomplete'].includes(
    administratorResult?.residualState,
  )
    ? administratorResult.residualState
    : 'present';
}

function administratorResultError(result) {
  if (isPlainObject(result?.error)) {
    return new DevelopmentGateError(
      result.error.code,
      result.error.stage,
      typeof result.error.diagnostic === 'string'
        ? result.error.diagnostic
        : result.error.code,
    );
  }
  return new DevelopmentGateError(
    'administrator_transaction_failed',
    'authorization',
  );
}

async function loadInvocationManifest(manifestPath) {
  if (!boundedAbsolutePath(manifestPath)) throw manifestError();
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.uid !== getuid() || info.size <= 0 || info.size > MAX_MANIFEST_BYTES
    || (info.mode & 0o077) !== 0 || await realpath(manifestPath) !== manifestPath) {
    throw manifestError();
  }
  const directoryPath = dirname(manifestPath);
  const directoryInfo = await lstat(directoryPath);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || directoryInfo.uid !== getuid() || (directoryInfo.mode & 0o077) !== 0
    || await realpath(directoryPath) !== directoryPath) throw manifestError();
  return validateAdminManifestShape(JSON.parse(
    await readBoundedText(manifestPath, MAX_MANIFEST_BYTES),
  ));
}

async function runAsAdministrator(manifestPath) {
  requireAdministratorContext();
  const { manifest, packageDirectory } = await loadAndValidateAdminManifest(manifestPath);
  const wallClockRemaining = Date.parse(manifest.transaction.notAfter) - Date.now();
  if (wallClockRemaining <= 0) {
    throw new DevelopmentGateError(
      'administrator_action_timeout',
      'admin-preflight',
    );
  }
  const transactionDeadline = performance.now() + Math.min(
    wallClockRemaining,
    manifest.transaction.maximumDurationMs,
  );
  const assertTransactionDeadline = (stage) => {
    if (performance.now() >= transactionDeadline) {
      throw new DevelopmentGateError('administrator_action_timeout', stage);
    }
  };
  const sealedSources = sealedAdminPackagePaths(packageDirectory);
  const paths = installedPaths(manifest.runId);
  const brokerPlist = renderBrokerLaunchDaemon(manifest);
  const canaryPlist = renderCanaryLaunchDaemon(manifest);
  let primaryError = null;
  let topologyOwned = false;
  let systemMutationsPerformed = false;
  let cleanup = cleanAdministratorCleanupResult();
  let journal = null;
  let crashRecoveryVerified = false;
  try {
    assertTransactionDeadline('admin-preflight');
    // A previous authorized transaction has a different random runId. Recover
    // it from its root-owned journal and embedded frozen manifest before this
    // run checks the singleton topology. A fixed installation without exactly
    // one valid journal remains foreign and fails closed below.
    // Recovery can mutate the root-owned journal before it returns or throws.
    // Preserve that fact in the completion envelope even when recovery fails
    // closed part way through.
    if (manifest.transaction.recoveryJournalPresent) {
      systemMutationsPerformed = true;
    }
    const previousRecovery = await recoverPreviousTransactionIfPresent(manifest);
    if (previousRecovery.recovered) systemMutationsPerformed = true;
    if (previousRecovery.recovered
      !== manifest.transaction.recoveryJournalPresent) {
      throw new DevelopmentGateError(
        'host_root_recovery_journal_mismatch',
        'admin-recovery',
      );
    }
    let currentLegacyRecovered = manifest.legacyRecovery.state === 'candidate'
      && previousRecovery.legacyRecovered;
    if (currentLegacyRecovered
      && previousRecovery.legacyFingerprint !== manifest.legacyRecovery.fingerprint) {
      throw new DevelopmentGateError(
        'previous_legacy_recovery_mismatch',
        'admin-recovery',
      );
    }
    await assertAdminResourcesAbsent(manifest);
    await verifyAdminSources(manifest, sealedSources);
    if (!currentLegacyRecovered) {
      await assertLegacyHostEvidence(manifest.legacyRecovery, {
        currentJournalAllowed: false,
        expectedJournalPresent: false,
      });
    }
    assertTransactionDeadline('admin-preflight');
    // From this point the controlled child may publish the root-owned active
    // journal before it is deliberately terminated. Conservatively report a
    // system mutation even if later recovery evidence is incomplete.
    systemMutationsPerformed = true;
    const recoveryProof = await exerciseSigkillJournalRecovery(
      manifest,
      sealedSources,
    );
    crashRecoveryVerified = recoveryProof.verified;
    currentLegacyRecovered ||= manifest.legacyRecovery.state === 'candidate'
      && recoveryProof.legacyRecovered;
    if (!crashRecoveryVerified) {
      throw new DevelopmentGateError(
        'sigkill_journal_recovery_failed',
        'admin-recovery-probe',
      );
    }
    await assertAdminResourcesAbsent(manifest);
    assertTransactionDeadline('admin-recovery-probe');
    journal = await beginTransactionJournal(manifest);
    if (currentLegacyRecovered) {
      journal = await advanceTransactionJournal(journal, 'legacy-recovered');
    } else if (await recoverLegacyIdentityIfProven(manifest)) {
      systemMutationsPerformed = true;
      journal = await advanceTransactionJournal(journal, 'legacy-recovered');
    }
    // Treat the installation root as potentially owned as soon as publication
    // is attempted. `createInstallationRoot` publishes by rename; if the
    // post-publish verification throws, cleanup must still inspect and recover
    // that root instead of losing the ownership flag.
    topologyOwned = true;
    await createInstallationRoot(manifest, paths);
    assertTransactionDeadline('admin-install');
    systemMutationsPerformed = true;
    journal = await advanceTransactionJournal(journal, 'root-published');
    createServiceIdentity(manifest);
    journal = await advanceTransactionJournal(journal, 'identity-created');
    await createInstalledDirectoriesAndFiles(manifest, paths, sealedSources);
    assertTransactionDeadline('admin-install');
    journal = await advanceTransactionJournal(journal, 'files-installed');
    await writeExclusiveFile(BROKER_PLIST_PATH, brokerPlist, 0o644, 0, 0);
    await writeExclusiveFile(
      canaryPlistPathForRun(manifest.runId),
      canaryPlist,
      0o644,
      0,
      0,
    );
    runCommand(TOOLS.plutil, ['-lint', BROKER_PLIST_PATH], {
      stage: 'admin-install',
    });
    runCommand(TOOLS.plutil, [
      '-lint',
      canaryPlistPathForRun(manifest.runId),
    ], { stage: 'admin-install' });
    runCommand(TOOLS.launchctl, [
      'bootstrap',
      'system',
      BROKER_PLIST_PATH,
    ], { stage: 'admin-install' });
    runCommand(TOOLS.launchctl, [
      'bootstrap',
      'system',
      canaryPlistPathForRun(manifest.runId),
    ], { stage: 'admin-install' });
    await waitForBroker(BROKER_LABEL);
    assertTransactionDeadline('bootstrap');
    journal = await advanceTransactionJournal(journal, 'jobs-bootstrapped');
    const canary = await waitForCanaryResult(
      manifest.runId,
      manifest.serviceUid,
      manifest.host.pid,
      manifest.host.uid,
    );
    const canaryDenials = REQUIRED_CANARY_DENIALS.every(
      (name) => canary.tests[name]?.outcome === 'denied',
    );
    const stagingWriteReported =
      canary.tests.stagingWrite?.outcome === 'succeeded';
    const brokerStderrEmpty =
      await readBoundedText(paths.brokerStderr, 4 * 1024) === '';
    if (!canaryDenials || !stagingWriteReported || canary.result !== 'passed') {
      throw new DevelopmentGateError(
        'cross_uid_canary_did_not_pass',
        'canary',
      );
    }
    if (!brokerStderrEmpty) {
      throw new DevelopmentGateError('broker_stderr_not_empty', 'xpc');
    }
    journal = await advanceTransactionJournal(journal, 'canary-passed');
    assertTransactionDeadline('canary');
    await writeAdministratorReady(manifest, {
      canaryDenials,
      stagingWriteReported,
      brokerStderrEmpty,
    });
    const acknowledgement = await waitForHostAcknowledgement(manifest);
    if (acknowledgement.result !== 'passed') {
      throw new DevelopmentGateError(
        'host_verification_failed',
        'host-acknowledgement',
      );
    }
    assertTransactionDeadline('host-acknowledgement');
    journal = await advanceTransactionJournal(journal, 'host-acknowledged');
  } catch (error) {
    primaryError = normalizeError(error);
  } finally {
    try {
      const rollbackOriginPhase = journal?.phase ?? null;
      if (journal) journal = await advanceTransactionJournal(journal, 'rolling-back');
      if (topologyOwned) {
        cleanup = await cleanupInstalledTopology(manifest, {
          rollback: true,
          transactionPhase: rollbackOriginPhase,
        });
      } else {
        cleanup = await observeAdministratorCleanup(manifest);
      }
      await removeOwnedHandshakeFiles(manifest);
      if (journal) {
        journal = await advanceTransactionJournal(
          journal,
          cleanup.result === 'cleaned' ? 'rolled-back' : 'quarantined',
        );
        if (cleanup.result === 'cleaned') await removeTransactionJournal(journal);
      }
    } catch (error) {
      cleanup = {
        ...cleanup,
        result: 'cleanup_incomplete',
        errors: [publicError(error).code],
      };
      if (journal) {
        await advanceTransactionJournal(journal, 'quarantined').catch(() => undefined);
      }
    }
  }
  const transactionJournalRemains = await pathExists(TRANSACTION_JOURNAL_ROOT);
  if (transactionJournalRemains) {
    cleanup = {
      ...cleanup,
      result: 'cleanup_incomplete',
      fixedResourcesRemoved: false,
      errors: [...new Set([
        ...cleanup.errors,
        'transaction_journal_remains',
      ])].slice(0, 8),
    };
  }
  const cleanupComplete = cleanup.result === 'cleaned';
  const residualState = cleanupComplete
    ? cleanup.stagingEvidence === 'verified' ? 'absent' : 'unknown'
    : journal?.phase === 'quarantined' || transactionJournalRemains
      ? 'quarantined'
      : 'cleanup-incomplete';
  const effectiveError = primaryError ?? (cleanupComplete
    ? null
    : new DevelopmentGateError(
      'administrator_cleanup_incomplete',
      'cleanup',
    ));
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    action: 'admin-transaction',
    result: primaryError === null && cleanupComplete
      ? 'completed'
      : cleanupComplete ? 'failed' : 'cleanup_incomplete',
    crashRecoveryVerified,
    systemMutationsPerformed,
    systemTrustModified: false,
    residualState,
    cleanup,
    ...(effectiveError ? { error: publicError(effectiveError) } : {}),
  };
}

function recoveryProbeIdentity(manifest) {
  const checked = validateAdminManifestShape(manifest);
  return {
    runId: createHash('sha256').update(
      `roundtable-p4-recovery-probe-run-v1:${checked.runId}:${checked.ownershipToken}`,
    ).digest('hex').slice(0, 32),
    ownershipToken: createHash('sha256').update(
      `roundtable-p4-recovery-probe-owner-v1:${checked.runId}:${checked.ownershipToken}`,
    ).digest('hex'),
  };
}

function currentLegacyRecoveryForProbe(manifest) {
  const userExists = directoryServiceRecordExists('/Users', SERVICE_USER);
  const groupExists = directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  if (!userExists && !groupExists) {
    return {
      state: 'absent',
      runId: null,
      fingerprint: null,
      hostEvidence: null,
    };
  }
  if (!userExists || !groupExists
    || manifest.legacyRecovery.state !== 'candidate') {
    throw new DevelopmentGateError(
      'recovery_probe_legacy_state_ambiguous',
      'admin-recovery-probe',
    );
  }
  return {
    ...manifest.legacyRecovery,
    hostEvidence: {
      ...manifest.legacyRecovery.hostEvidence,
      transactionJournalRootPresent: false,
    },
  };
}

export function createRecoveryProbeManifest(
  manifest,
  legacyRecovery,
  now = Date.now(),
) {
  const checked = validateAdminManifestShape(manifest);
  const identity = recoveryProbeIdentity(checked);
  const privateRoot = hostPrivateRootForRun(identity.runId);
  const probeDeadline = Math.min(
    now + RECOVERY_PROBE_DEADLINE_MS,
    Date.parse(checked.transaction.notAfter),
  );
  if (!Number.isSafeInteger(now) || probeDeadline <= now) {
    throw new DevelopmentGateError(
      'administrator_action_timeout',
      'admin-recovery-probe',
    );
  }
  return validateAdminManifestShape({
    ...checked,
    runId: identity.runId,
    ownershipToken: identity.ownershipToken,
    transaction: {
      ...checked.transaction,
      notAfter: new Date(probeDeadline).toISOString(),
      recoveryJournalPresent: false,
    },
    host: {
      ...checked.host,
      privateRoot,
      socketPath: join(privateRoot, 'control.sock'),
      canaryPath: join(privateRoot, 'host-canary.txt'),
    },
    legacyRecovery,
  });
}

async function runAdministratorRecoveryProbe(manifestPath) {
  requireAdministratorContext();
  const { manifest } = await loadAndValidateAdminManifest(manifestPath);
  if (await pathExists(TRANSACTION_JOURNAL_ROOT)) {
    throw new DevelopmentGateError(
      'recovery_probe_requires_clean_journal_root',
      'admin-recovery-probe',
    );
  }
  const legacyRecovery = currentLegacyRecoveryForProbe(manifest);
  if (legacyRecovery.state === 'candidate') {
    await assertLegacyHostEvidence(legacyRecovery, {
      currentJournalAllowed: false,
      expectedJournalPresent: false,
    });
    if (assertLegacyIdentityFields() !== legacyRecovery.fingerprint) {
      throw new DevelopmentGateError(
        'legacy_identity_ownership_mismatch',
        'admin-recovery-probe',
      );
    }
  }
  const probeManifest = createRecoveryProbeManifest(
    manifest,
    legacyRecovery,
  );
  await beginTransactionJournal(probeManifest, {
    controllerPid: process.ppid,
  });
  process.kill(process.pid, 'SIGKILL');
  throw new DevelopmentGateError(
    'sigkill_probe_survived',
    'admin-recovery-probe',
  );
}

async function exerciseSigkillJournalRecovery(manifest, sealedSources) {
  if (Date.parse(manifest.transaction.notAfter) - Date.now()
    <= RECOVERY_PROBE_DEADLINE_MS + 250) {
    throw new DevelopmentGateError(
      'administrator_action_timeout',
      'admin-recovery-probe',
    );
  }
  if (await pathExists(TRANSACTION_JOURNAL_ROOT)) {
    throw new DevelopmentGateError(
      'recovery_probe_requires_clean_journal_root',
      'admin-recovery-probe',
    );
  }
  const child = spawn(sealedSources.node, [
    sealedSources.script,
    '--internal-admin-recovery-probe',
    sealedSources.manifest,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      HOME: '/var/empty',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      TMPDIR: dirname(sealedSources.manifest),
    },
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new DevelopmentGateError(
      'recovery_probe_spawn_failed',
      'admin-recovery-probe',
    );
  }
  const childPid = child.pid;
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let timedOut = false;
  const append = (target) => (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) target.push(chunk);
  };
  child.stdout.on('data', append(stdout));
  child.stderr.on('data', append(stderr));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, RECOVERY_PROBE_PROCESS_TIMEOUT_MS);
  timer.unref();
  let childResult;
  try {
    childResult = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => accept({ status, signal }));
    });
  } finally {
    clearTimeout(timer);
  }

  let journal;
  try {
    journal = await readTransactionJournal();
  } catch (error) {
    throw new DevelopmentGateError(
      'recovery_probe_journal_missing_or_invalid',
      'admin-recovery-probe',
      publicError(error).code,
    );
  }
  const expectedIdentity = recoveryProbeIdentity(manifest);
  const journalMatches = journal.runId === expectedIdentity.runId
    && journal.ownershipToken === expectedIdentity.ownershipToken
    && journal.administratorPid === childPid
    && journal.controllerPid === process.pid
    && journal.phase === 'preflight';
  if (!journalMatches) {
    throw new DevelopmentGateError(
      'recovery_probe_journal_mismatch',
      'admin-recovery-probe',
    );
  }
  const remaining = Date.parse(journal.deadlineAt) - Date.now();
  if (remaining > RECOVERY_PROBE_DEADLINE_MS) {
    throw new DevelopmentGateError(
      'recovery_probe_deadline_invalid',
      'admin-recovery-probe',
    );
  }
  if (remaining >= 0) await delay(remaining + 10);
  // Recover the probe against the recovery evidence frozen in the probe's
  // own validated journal. The outer manifest describes state at the start
  // of the administrator transaction and may be stale after an earlier
  // cross-run recovery removed an interrupted identity.
  const recoveryContext = createRecoveryProbeRecoveryContext(manifest, journal);
  const recovered = await recoverPreviousTransactionIfPresent(recoveryContext, {
    expectedLiveControllerPid: process.pid,
    expectedRunId: expectedIdentity.runId,
    expectedOwnershipToken: expectedIdentity.ownershipToken,
  });
  if (timedOut
    || outputBytes > MAX_COMMAND_OUTPUT_BYTES
    || stdout.length !== 0
    || stderr.length !== 0
    || childResult.status !== null
    || childResult.signal !== 'SIGKILL'
    || !recovered.recovered
    || recovered.runId !== expectedIdentity.runId
    || recovered.administratorPid !== childPid
    || recovered.interruptedPhase !== 'preflight'
    || await pathExists(TRANSACTION_JOURNAL_ROOT)) {
    throw new DevelopmentGateError(
      'sigkill_journal_recovery_failed',
      'admin-recovery-probe',
      sanitizeDiagnostic(Buffer.concat(stderr).toString('utf8'))
        || 'sigkill_journal_recovery_failed',
    );
  }
  return {
    verified: true,
    legacyRecovered: recovered.legacyRecovered,
  };
}

export function createRecoveryProbeRecoveryContext(manifest, probeJournal) {
  const checkedManifest = validateAdminManifestShape(manifest);
  if (!isPlainObject(probeJournal)
    || probeJournal.path !== TRANSACTION_JOURNAL_PATH) {
    throw new DevelopmentGateError(
      'recovery_probe_journal_mismatch',
      'admin-recovery-probe',
    );
  }
  const { path: _canonicalPath, ...persistedJournal } = probeJournal;
  const checkedJournal = validateTransactionJournalShape(persistedJournal);
  const expectedIdentity = recoveryProbeIdentity(checkedManifest);
  if (checkedJournal.runId !== expectedIdentity.runId
    || checkedJournal.ownershipToken !== expectedIdentity.ownershipToken
    || checkedJournal.phase !== 'preflight') {
    throw new DevelopmentGateError(
      'recovery_probe_journal_mismatch',
      'admin-recovery-probe',
    );
  }
  return validateAdminManifestShape({
    ...checkedManifest,
    legacyRecovery: checkedJournal.manifest.legacyRecovery,
  });
}

async function recoverPreviousTransactionIfPresent(
  currentManifest,
  {
    expectedLiveControllerPid = null,
    expectedRunId = null,
    expectedOwnershipToken = null,
  } = {},
) {
  if (!await pathExists(TRANSACTION_JOURNAL_ROOT)) {
    return {
      recovered: false,
      legacyRecovered: false,
      legacyFingerprint: null,
      runId: null,
      administratorPid: null,
      interruptedPhase: null,
    };
  }
  if (!await pathExists(TRANSACTION_JOURNAL_PATH)) {
    await recoverEmptyTransactionJournalScaffolding();
    return {
      recovered: true,
      legacyRecovered: false,
      legacyFingerprint: null,
      runId: null,
      administratorPid: null,
      interruptedPhase: 'empty-scaffolding',
    };
  }
  let journal = await readTransactionJournal();
  if (journal.runId === currentManifest.runId
    || journal.ownershipToken === currentManifest.ownershipToken) {
    throw new DevelopmentGateError(
      'transaction_identity_collision',
      'admin-recovery',
    );
  }
  const liveControllerExpected = Number.isSafeInteger(expectedLiveControllerPid)
    && expectedLiveControllerPid > 1
    && journal.controllerPid === expectedLiveControllerPid
    && journal.runId === expectedRunId
    && journal.ownershipToken === expectedOwnershipToken;
  if (Number.isSafeInteger(journal.controllerPid)
    && processIsAlive(journal.controllerPid)
    && !liveControllerExpected) {
    throw new DevelopmentGateError(
      'previous_transaction_still_running',
      'admin-recovery',
    );
  }
  if (processIsAlive(journal.administratorPid)) {
    throw new DevelopmentGateError(
      'previous_transaction_still_running',
      'admin-recovery',
    );
  }
  const terminal = ['rolled-back', 'quarantined', 'recovered'].includes(
    journal.phase,
  );
  if (!terminal && Date.now() < Date.parse(journal.deadlineAt)) {
    throw new DevelopmentGateError(
      'previous_transaction_deadline_not_reached',
      'admin-recovery',
    );
  }
  const interruptedPhase = journal.phase;
  const recoveryOriginPhase = journal.recoveryOriginPhase ?? interruptedPhase;
  const interruptedEvidence = currentManifest.legacyRecovery.state
      === 'interrupted-candidate'
    ? currentManifest.legacyRecovery
    : null;
  if (interruptedEvidence !== null) {
    await assertInterruptedTransactionRecoveryEvidence(
      interruptedEvidence,
      journal,
      recoveryOriginPhase,
    );
  }
  const recoveredRunId = journal.runId;
  const recoveredAdministratorPid = journal.administratorPid;
  const legacyRecovered = journal.manifest.legacyRecovery.state === 'candidate';
  const legacyFingerprint = legacyRecovered
    ? journal.manifest.legacyRecovery.fingerprint
    : null;
  if (journal.phase !== 'recovery-rolling-back') {
    journal = await advanceTransactionJournal(journal, 'recovery-rolling-back');
  }
  try {
    // An interrupted-candidate is an identity created by this journal after
    // its embedded legacy recovery completed. `root-published` is reachable
    // only after the legacy identity has been removed, and the marker binds
    // the current fixed-name identity to this journal. Do not reinterpret
    // that newer identity as the embedded UID 499 legacy candidate merely
    // because the singleton account name is present.
    const embeddedLegacyIdentityMayRemain = interruptedEvidence === null
      && journal.manifest.legacyRecovery.state === 'candidate'
      && journalLegacyIdentityMayRemain();
    if (shouldRecoverJournalLegacyIdentity(
      journal.manifest.legacyRecovery.state,
      interruptedEvidence !== null,
      embeddedLegacyIdentityMayRemain,
    )) {
      await recoverLegacyIdentityFromJournal(journal.manifest);
    }
    const cleanup = await cleanupInstalledTopology(journal.manifest, {
      rollback: true,
      transactionPhase: recoveryOriginPhase,
      interruptedEvidence,
    });
    await removeOwnedHandshakeFiles(journal.manifest);
    if (cleanup.result !== 'cleaned') {
      throw new DevelopmentGateError(
        'previous_transaction_cleanup_incomplete',
        'admin-recovery',
        recoveryCleanupDiagnostic(cleanup),
      );
    }
    journal = await advanceTransactionJournal(journal, 'recovered');
    await removeTransactionJournal(journal);
    return {
      recovered: true,
      legacyRecovered,
      legacyFingerprint,
      runId: recoveredRunId,
      administratorPid: recoveredAdministratorPid,
      interruptedPhase,
    };
  } catch (error) {
    if (journal.phase === 'recovery-rolling-back') {
      await advanceTransactionJournal(journal, 'quarantined').catch(() => undefined);
    }
    throw error;
  }
}

async function assertInterruptedTransactionRecoveryEvidence(
  recovery,
  journal,
  recoveryOriginPhase,
) {
  if (recoveryOriginPhase !== 'root-published'
    || recovery.runId !== journal.runId
    || recovery.hostEvidence.marker.runId !== journal.runId
    || recovery.hostEvidence.marker.ownershipToken !== journal.ownershipToken
    || recovery.hostEvidence.marker.serviceUid !== journal.serviceUid
    || JSON.stringify(recovery.hostEvidence.marker.serviceIdentity)
      !== JSON.stringify(journal.manifest.serviceIdentity)
    || JSON.stringify(recovery.hostEvidence.marker.codeDirectoryHashes)
      !== JSON.stringify(journal.manifest.codeDirectoryHashes)
    || recovery.hostEvidence.marker.manifestSha256 !== journal.manifestSha256) {
    throw new DevelopmentGateError(
      'interrupted_transaction_evidence_mismatch',
      'admin-recovery',
    );
  }
  const observed = await captureInterruptedTransactionRecoveryEvidence();
  if (observed.state !== 'interrupted-candidate'
    || observed.runId !== recovery.runId
    || observed.fingerprint !== recovery.fingerprint
    || JSON.stringify(observed.hostEvidence)
      !== JSON.stringify(recovery.hostEvidence)) {
    throw new DevelopmentGateError(
      'interrupted_transaction_host_root_evidence_mismatch',
      'admin-recovery',
    );
  }
  assertOwnedInterruptedServiceIdentity(journal.manifest, recovery);
}

function journalLegacyIdentityMayRemain() {
  const fixedUserExists = directoryServiceRecordExists('/Users', SERVICE_USER);
  const fixedGroupExists = directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  const usersWithLegacyUid = directoryServiceRecordsWithId(
    '/Users',
    'UniqueID',
    499,
  );
  const groupsWithLegacyGid = directoryServiceRecordsWithId(
    '/Groups',
    'PrimaryGroupID',
    499,
  );
  return fixedUserExists || fixedGroupExists
    || usersWithLegacyUid.length > 0 || groupsWithLegacyGid.length > 0;
}

export function shouldRecoverJournalLegacyIdentity(
  embeddedRecoveryState,
  interruptedTransactionProven,
  legacyIdentityMayRemain,
) {
  return embeddedRecoveryState === 'candidate'
    && interruptedTransactionProven === false
    && legacyIdentityMayRemain === true;
}

export function recoveryCleanupDiagnostic(cleanup) {
  const details = [
    ...(Array.isArray(cleanup?.errors) ? cleanup.errors : []),
    ...(cleanup?.serviceUidZeroProcesses === true ? [] : ['process_state_unproven']),
    ...(cleanup?.accountRemoved === true ? [] : ['account_removal_unproven']),
    ...(cleanup?.fixedResourcesRemoved === true ? [] : ['resource_removal_unproven']),
    `staging_${cleanup?.stagingEvidence ?? 'unknown'}`,
  ];
  return [...new Set(details)].slice(0, 8).join(',');
}

async function recoverEmptyTransactionJournalScaffolding() {
  const rootInfo = await lstat(TRANSACTION_JOURNAL_ROOT);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || rootInfo.uid !== 0 || rootInfo.gid !== 0
    || (rootInfo.mode & 0o777) !== 0o700
    || await realpath(TRANSACTION_JOURNAL_ROOT) !== TRANSACTION_JOURNAL_ROOT) {
    throw new DevelopmentGateError(
      'transaction_journal_ownership_mismatch',
      'admin-recovery',
    );
  }
  const rootEntries = await readdir(TRANSACTION_JOURNAL_ROOT);
  if (rootEntries.length === 0) {
    await rmdir(TRANSACTION_JOURNAL_ROOT);
    return;
  }
  if (rootEntries.length !== 1
    || rootEntries[0] !== basename(TRANSACTION_JOURNAL_DIRECTORY)) {
    throw new DevelopmentGateError(
      'transaction_journal_recovery_required',
      'admin-recovery',
    );
  }
  const directoryInfo = await lstat(TRANSACTION_JOURNAL_DIRECTORY);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || directoryInfo.uid !== 0 || directoryInfo.gid !== 0
    || (directoryInfo.mode & 0o777) !== 0o700
    || await realpath(TRANSACTION_JOURNAL_DIRECTORY)
      !== TRANSACTION_JOURNAL_DIRECTORY
    || (await readdir(TRANSACTION_JOURNAL_DIRECTORY)).length !== 0) {
    throw new DevelopmentGateError(
      'transaction_journal_ownership_mismatch',
      'admin-recovery',
    );
  }
  await rmdir(TRANSACTION_JOURNAL_DIRECTORY);
  await rmdir(TRANSACTION_JOURNAL_ROOT);
}

async function beginTransactionJournal(
  manifest,
  { controllerPid = process.pid } = {},
) {
  if (!Number.isSafeInteger(controllerPid) || controllerPid <= 1) {
    throw new DevelopmentGateError(
      'transaction_controller_invalid',
      'admin-journal',
    );
  }
  await ensureTransactionJournalDirectories();
  const entries = await readdir(TRANSACTION_JOURNAL_DIRECTORY);
  if (entries.length !== 0) {
    throw new DevelopmentGateError(
      'transaction_journal_recovery_required',
      'admin-journal',
    );
  }
  const journal = {
    schemaVersion: 2,
    kind: TRANSACTION_JOURNAL_KIND,
    runId: manifest.runId,
    ownershipToken: manifest.ownershipToken,
    serviceUid: manifest.serviceUid,
    administratorPid: process.pid,
    controllerPid,
    startedAt: new Date().toISOString(),
    deadlineAt: manifest.transaction.notAfter,
    phase: 'preflight',
    recoveryOriginPhase: null,
    manifest,
    manifestSha256: manifestSha256(manifest),
  };
  try {
    await writeExclusiveJson(TRANSACTION_JOURNAL_PATH, journal, 0o600, 0, 0);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new DevelopmentGateError(
        'transaction_already_active',
        'admin-journal',
      );
    }
    throw error;
  }
  return { path: TRANSACTION_JOURNAL_PATH, ...journal };
}

async function ensureTransactionJournalDirectories() {
  await mkdir(TRANSACTION_JOURNAL_ROOT, { recursive: true, mode: 0o700 });
  await mkdir(TRANSACTION_JOURNAL_DIRECTORY, { recursive: true, mode: 0o700 });
  await assertTransactionJournalDirectories();
}

async function assertTransactionJournalDirectories() {
  for (const directory of [
    TRANSACTION_JOURNAL_ROOT,
    TRANSACTION_JOURNAL_DIRECTORY,
  ]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o777) !== 0o700
      || await realpath(directory) !== directory) {
      throw new DevelopmentGateError(
        'transaction_journal_ownership_mismatch',
        'admin-journal',
      );
    }
  }
}

async function readTransactionJournal() {
  await assertTransactionJournalDirectories();
  const entries = await readdir(TRANSACTION_JOURNAL_DIRECTORY);
  const activeName = basename(TRANSACTION_JOURNAL_PATH);
  const pendingPath = `${TRANSACTION_JOURNAL_PATH}.next`;
  const pendingName = basename(pendingPath);
  const sortedEntries = [...entries].sort();
  const activeOnly = sortedEntries.length === 1
    && sortedEntries[0] === activeName;
  const activeAndPending = sortedEntries.length === 2
    && sortedEntries[0] === activeName
    && sortedEntries[1] === pendingName;
  if (!activeOnly && !activeAndPending) {
    throw new DevelopmentGateError(
      'transaction_journal_recovery_required',
      'admin-recovery',
    );
  }
  const active = await readTransactionJournalFile(TRANSACTION_JOURNAL_PATH);
  if (!activeAndPending) {
    return { path: TRANSACTION_JOURNAL_PATH, ...active };
  }
  const pending = await readTransactionJournalFile(pendingPath);
  if (!isRecoverablePendingJournalTransition(active, pending)) {
    throw new DevelopmentGateError(
      'transaction_journal_pending_transition_invalid',
      'admin-recovery',
    );
  }
  await rename(pendingPath, TRANSACTION_JOURNAL_PATH);
  return { path: TRANSACTION_JOURNAL_PATH, ...pending };
}

export function isRecoverablePendingJournalTransition(active, pending) {
  const currentTimestamp = active.updatedAt ?? active.startedAt;
  const activeHasRecoveryOrigin = Object.hasOwn(active, 'recoveryOriginPhase');
  const pendingHasRecoveryOrigin = Object.hasOwn(pending, 'recoveryOriginPhase');
  const entersRollback = [
    'rolling-back',
    'recovery-rolling-back',
  ].includes(pending.phase);
  const expectedRecoveryOrigin = activeHasRecoveryOrigin
    ? active.recoveryOriginPhase ?? (entersRollback ? active.phase : null)
    : entersRollback ? active.phase : undefined;
  const recoveryOriginMatches = entersRollback
    ? pendingHasRecoveryOrigin
      && pending.recoveryOriginPhase === expectedRecoveryOrigin
    : activeHasRecoveryOrigin === pendingHasRecoveryOrigin
      && (!activeHasRecoveryOrigin
        || pending.recoveryOriginPhase === active.recoveryOriginPhase);
  const activeHasController = Object.hasOwn(active, 'controllerPid');
  const pendingHasController = Object.hasOwn(pending, 'controllerPid');
  const controllerMatches = activeHasController === pendingHasController
    && (!activeHasController || pending.controllerPid === active.controllerPid);
  return pending.runId === active.runId
    && pending.ownershipToken === active.ownershipToken
    && pending.serviceUid === active.serviceUid
    && pending.administratorPid === active.administratorPid
    && controllerMatches
    && pending.startedAt === active.startedAt
    && pending.deadlineAt === active.deadlineAt
    && pending.manifestSha256 === active.manifestSha256
    && JSON.stringify(pending.manifest) === JSON.stringify(active.manifest)
    && recoveryOriginMatches
    && typeof pending.updatedAt === 'string'
    && Date.parse(pending.updatedAt) >= Date.parse(currentTimestamp)
    && isValidTransactionPhaseTransition(active.phase, pending.phase);
}

async function readTransactionJournalFile(journalPath) {
  const info = await lstat(journalPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o777) !== 0o600
    || info.size <= 0 || info.size > MAX_MANIFEST_BYTES * 2
    || await realpath(journalPath) !== journalPath) {
    throw new DevelopmentGateError(
      'transaction_journal_ownership_mismatch',
      'admin-recovery',
    );
  }
  let value;
  try {
    value = JSON.parse(await readBoundedText(
      journalPath,
      MAX_MANIFEST_BYTES * 2,
    ));
  } catch (error) {
    if (error instanceof DevelopmentGateError) throw error;
    throw new DevelopmentGateError(
      'transaction_journal_invalid',
      'admin-recovery',
    );
  }
  return validateTransactionJournalShape(value);
}

export function validateTransactionJournalShape(value) {
  if (!isPlainObject(value)) {
    throw new DevelopmentGateError(
      'transaction_journal_invalid',
      'admin-recovery',
    );
  }
  const hasUpdatedAt = Object.hasOwn(value, 'updatedAt');
  const hasRecoveryOriginPhase = Object.hasOwn(value, 'recoveryOriginPhase');
  const hasControllerPid = Object.hasOwn(value, 'controllerPid');
  let manifest;
  try {
    requireExactKeys(value, [
      'schemaVersion',
      'kind',
      'runId',
      'ownershipToken',
      'serviceUid',
      'administratorPid',
      ...(hasControllerPid ? ['controllerPid'] : []),
      'startedAt',
      'deadlineAt',
      'phase',
      ...(hasRecoveryOriginPhase ? ['recoveryOriginPhase'] : []),
      'manifest',
      'manifestSha256',
      ...(hasUpdatedAt ? ['updatedAt'] : []),
    ]);
    manifest = validateAdminManifestShape(value.manifest);
  } catch {
    throw new DevelopmentGateError(
      'transaction_journal_invalid',
      'admin-recovery',
    );
  }
  const timestamps = [value.startedAt, value.deadlineAt];
  if (hasUpdatedAt) timestamps.push(value.updatedAt);
  if (value.schemaVersion !== 2
    || value.kind !== TRANSACTION_JOURNAL_KIND
    || value.runId !== manifest.runId
    || value.ownershipToken !== manifest.ownershipToken
    || value.serviceUid !== manifest.serviceUid
    || !Number.isSafeInteger(value.administratorPid)
    || value.administratorPid <= 0
    || (hasControllerPid
      && (!Number.isSafeInteger(value.controllerPid)
        || value.controllerPid <= 1))
    || !TRANSACTION_PHASES.includes(value.phase)
    || (hasRecoveryOriginPhase
      && value.recoveryOriginPhase !== null
      && !TRANSACTION_PHASES.includes(value.recoveryOriginPhase))
    || timestamps.some((timestamp) => (
      typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))
    ))
    || Date.parse(value.deadlineAt) <= Date.parse(value.startedAt)
    || value.manifestSha256 !== manifestSha256(manifest)) {
    throw new DevelopmentGateError(
      'transaction_journal_invalid',
      'admin-recovery',
    );
  }
  return value;
}

function manifestSha256(manifest) {
  return createHash('sha256').update(JSON.stringify(
    validateAdminManifestShape(manifest),
  )).digest('hex');
}

async function advanceTransactionJournal(journal, nextPhase) {
  if (!journal?.path || journal.path !== TRANSACTION_JOURNAL_PATH
    || !TRANSACTION_PHASES.includes(nextPhase)) {
    throw new DevelopmentGateError('transaction_journal_invalid', 'admin-journal');
  }
  if (!isValidTransactionPhaseTransition(journal.phase, nextPhase)) {
    throw new DevelopmentGateError('transaction_journal_transition_invalid', 'admin-journal');
  }
  const { path, ...persisted } = journal;
  const entersRollback = [
    'rolling-back',
    'recovery-rolling-back',
  ].includes(nextPhase);
  const updated = validateTransactionJournalShape({
    ...persisted,
    phase: nextPhase,
    ...(Object.hasOwn(persisted, 'recoveryOriginPhase') || entersRollback
      ? {
          recoveryOriginPhase: persisted.recoveryOriginPhase
            ?? (entersRollback ? persisted.phase : null),
        }
      : {}),
    updatedAt: new Date().toISOString(),
  });
  const temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(updated)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await chown(temporary, 0, 0);
  await rename(temporary, path);
  return { path, ...updated };
}

export function isValidTransactionPhaseTransition(currentPhase, nextPhase) {
  const allowed = {
    preflight: ['legacy-recovered', 'root-published', 'rolling-back', 'recovery-rolling-back'],
    'legacy-recovered': ['root-published', 'rolling-back', 'recovery-rolling-back'],
    'root-published': ['identity-created', 'rolling-back', 'recovery-rolling-back'],
    'identity-created': ['files-installed', 'rolling-back', 'recovery-rolling-back'],
    'files-installed': ['jobs-bootstrapped', 'rolling-back', 'recovery-rolling-back'],
    'jobs-bootstrapped': ['canary-passed', 'rolling-back', 'recovery-rolling-back'],
    'canary-passed': ['host-acknowledged', 'rolling-back', 'recovery-rolling-back'],
    'host-acknowledged': ['rolling-back', 'recovery-rolling-back'],
    'rolling-back': ['rolled-back', 'quarantined', 'recovery-rolling-back'],
    'rolled-back': ['recovery-rolling-back'],
    quarantined: ['recovery-rolling-back'],
    'recovery-rolling-back': ['recovered', 'quarantined'],
    recovered: [],
  };
  return Array.isArray(allowed[currentPhase])
    && allowed[currentPhase].includes(nextPhase);
}

async function removeTransactionJournal(journal) {
  if (journal?.path !== TRANSACTION_JOURNAL_PATH) {
    throw new DevelopmentGateError('transaction_journal_invalid', 'admin-journal');
  }
  await unlinkIfPresentNoFollow(journal.path);
  for (const directory of [
    TRANSACTION_JOURNAL_DIRECTORY,
    TRANSACTION_JOURNAL_ROOT,
  ]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o777) !== 0o700
      || (await readdir(directory)).length !== 0) {
      throw new DevelopmentGateError(
        'transaction_journal_cleanup_incomplete',
        'admin-journal',
      );
    }
    await rmdir(directory);
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw new DevelopmentGateError(
      'transaction_process_state_unknown',
      'admin-recovery',
    );
  }
}

async function loadAndValidateAdminManifest(manifestPath) {
  if (!boundedAbsolutePath(manifestPath)) throw manifestError();
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()
    || info.size <= 0 || info.size > MAX_MANIFEST_BYTES
    || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o777) !== 0o400) throw manifestError();
  const manifest = validateAdminManifestShape(JSON.parse(
    await readBoundedText(manifestPath, MAX_MANIFEST_BYTES),
  ));
  const canonicalPath = await realpath(manifestPath);
  if (canonicalPath !== manifestPath) throw manifestError();
  const packageDirectory = dirname(manifestPath);
  const directoryInfo = await lstat(packageDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || directoryInfo.uid !== 0 || directoryInfo.gid !== 0
    || (directoryInfo.mode & 0o777) !== 0o700
    || await realpath(packageDirectory) !== packageDirectory
    || manifestPath !== join(packageDirectory, 'admin-manifest.json')
    || !packageDirectory.startsWith(`${ADMIN_PACKAGE_PREFIX}${manifest.runId}-`)
    || !/^[a-f0-9]{32}$/u.test(
      packageDirectory.slice(`${ADMIN_PACKAGE_PREFIX}${manifest.runId}-`.length),
    )) throw manifestError();
  return { manifest, manifestPath, packageDirectory };
}

function requireAdministratorContext() {
  if (process.platform !== 'darwin'
    || typeof getuid !== 'function'
    || getuid() !== 0 || geteuid() !== 0
    || getgid() !== 0 || getegid() !== 0) {
    throw new DevelopmentGateError(
      'administrator_context_required',
      'admin-preflight',
    );
  }
}

async function assertAdminResourcesAbsent(manifest) {
  const fixedPaths = [
    INSTALL_ROOT,
    installationTemporaryRoot(manifest),
    BROKER_PLIST_PATH,
    canaryPlistPathForRun(manifest.runId),
    administratorReadyPath(manifest),
    hostAcknowledgementPath(manifest),
  ];
  if (await anyPathExists(fixedPaths)) {
    throw new DevelopmentGateError(
      'fixed_resource_already_exists',
      'admin-preflight',
    );
  }
  const legacyRecordsPresent = directoryServiceRecordExists('/Users', SERVICE_USER)
    || directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  if (legacyRecordsPresent && manifest.legacyRecovery.state !== 'candidate') {
    throw new DevelopmentGateError(
      'fixed_account_name_already_exists',
      'admin-preflight',
    );
  }
  const userIds = listDirectoryServiceIds('/Users', 'UniqueID');
  const groupIds = listDirectoryServiceIds('/Groups', 'PrimaryGroupID');
  if (userIds.includes(manifest.serviceUid)
    || groupIds.includes(manifest.serviceUid)) {
    throw new DevelopmentGateError(
      'service_uid_no_longer_free',
      'admin-preflight',
    );
  }
  for (const target of [
    `system/${BROKER_LABEL}`,
    `system/${canaryLabelForRun(manifest.runId)}`,
  ]) {
    if (runCommandAllowFailure(
      TOOLS.launchctl,
      ['print', target],
      { stage: 'admin-preflight' },
    ).status === 0) {
      throw new DevelopmentGateError(
        'launchd_job_already_exists',
        'admin-preflight',
      );
    }
  }
}

async function recoverLegacyIdentityIfProven(manifest) {
  const recovery = manifest.legacyRecovery;
  const userExists = directoryServiceRecordExists('/Users', SERVICE_USER);
  const groupExists = directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  if (recovery.state === 'absent') {
    if (userExists || groupExists) {
      throw new DevelopmentGateError('legacy_identity_unexpected', 'admin-identity');
    }
    return false;
  }
  if (recovery.state === 'interrupted-candidate') {
    if (userExists || groupExists || await pathExists(INSTALL_ROOT)) {
      throw new DevelopmentGateError(
        'interrupted_transaction_recovery_incomplete',
        'admin-recovery',
      );
    }
    return false;
  }
  if (recovery.state !== 'candidate'
    || recovery.runId !== LEGACY_RESIDUE_RUN_ID
    || !userExists || !groupExists) {
    throw new DevelopmentGateError('legacy_identity_ownership_unknown', 'admin-identity');
  }
  await assertLegacyHostEvidence(recovery, { currentJournalAllowed: true });
  const rootFingerprint = assertLegacyIdentityFields();
  if (rootFingerprint !== recovery.fingerprint) {
    throw new DevelopmentGateError('legacy_identity_ownership_mismatch', 'admin-identity');
  }
  await deleteDirectoryServiceIdentityRecords({
    userExists,
    groupExists,
    stage: 'admin-legacy-recovery',
  });
  if (directoryServiceRecordExists('/Users', SERVICE_USER)
    || directoryServiceRecordExists('/Groups', SERVICE_GROUP)) {
    throw new DevelopmentGateError('legacy_identity_recovery_incomplete', 'admin-identity');
  }
  return true;
}

async function recoverLegacyIdentityFromJournal(manifest) {
  const recovery = manifest.legacyRecovery;
  if (recovery.state === 'absent') {
    if (directoryServiceRecordExists('/Users', SERVICE_USER)
      || directoryServiceRecordExists('/Groups', SERVICE_GROUP)) {
      throw new DevelopmentGateError(
        'legacy_identity_unexpected',
        'admin-recovery',
      );
    }
    return;
  }
  if (recovery.state !== 'candidate'
    || recovery.runId !== LEGACY_RESIDUE_RUN_ID
    || !isValidLegacyHostEvidence(recovery.hostEvidence)) {
    throw new DevelopmentGateError(
      'legacy_identity_ownership_unknown',
      'admin-recovery',
    );
  }
  const userExists = directoryServiceRecordExists('/Users', SERVICE_USER);
  const groupExists = directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  await assertLegacyRecoveryEnvironment(recovery, { userExists, groupExists });
  if (userExists) assertLegacyUserFields();
  if (groupExists) assertLegacyGroupFields();
  if (userExists && groupExists
    && legacyIdentityFingerprint() !== recovery.fingerprint) {
    throw new DevelopmentGateError(
      'legacy_identity_ownership_mismatch',
      'admin-recovery',
    );
  }
  await deleteDirectoryServiceIdentityRecords({
    userExists,
    groupExists,
    stage: 'admin-recovery',
  });
  if (directoryServiceRecordExists('/Users', SERVICE_USER)
    || directoryServiceRecordExists('/Groups', SERVICE_GROUP)) {
    throw new DevelopmentGateError(
      'legacy_identity_recovery_incomplete',
      'admin-recovery',
    );
  }
}

async function assertLegacyRecoveryEnvironment(
  recovery,
  { userExists, groupExists },
) {
  const expected = recovery.hostEvidence;
  const userRecordsWithUid = directoryServiceRecordsWithId('/Users', 'UniqueID', 499);
  const groupRecordsWithGid = directoryServiceRecordsWithId(
    '/Groups',
    'PrimaryGroupID',
    499,
  );
  const safe = listProcessesForUid(499).length === 0
    && !launchdJobExists(BROKER_LABEL)
    && !launchdJobExists(canaryLabelForRun(LEGACY_RESIDUE_RUN_ID))
    && !await pathExists(INSTALL_ROOT)
    && !await pathExists(BROKER_PLIST_PATH)
    && !await pathExists(canaryPlistPathForRun(LEGACY_RESIDUE_RUN_ID))
    && userRecordsWithUid.length === (userExists ? 1 : 0)
    && (!userExists || userRecordsWithUid[0] === SERVICE_USER)
    && groupRecordsWithGid.length === (groupExists ? 1 : 0)
    && (!groupExists || groupRecordsWithGid[0] === SERVICE_GROUP)
    && expected.serviceUid === 499
    && expected.serviceUidProcessCount === 0;
  if (!safe) {
    throw new DevelopmentGateError(
      'legacy_host_root_evidence_mismatch',
      'admin-recovery',
    );
  }
}

function assertLegacyIdentityFields() {
  assertLegacyUserFields();
  assertLegacyGroupFields();
  const usersWithUid = directoryServiceRecordsWithId('/Users', 'UniqueID', 499);
  const groupsWithGid = directoryServiceRecordsWithId('/Groups', 'PrimaryGroupID', 499);
  if (usersWithUid.length !== 1 || usersWithUid[0] !== SERVICE_USER
    || groupsWithGid.length !== 1 || groupsWithGid[0] !== SERVICE_GROUP) {
    throw new DevelopmentGateError('legacy_identity_not_unique', 'admin-identity');
  }
  return legacyIdentityFingerprint();
}

function assertLegacyUserFields() {
  const expectedRealName = `Roundtable Service UID Bootstrap Probe ${LEGACY_RESIDUE_RUN_ID}`;
  const userProperties = {
    UniqueID: '499',
    PrimaryGroupID: '499',
    RealName: expectedRealName,
    UserShell: '/usr/bin/false',
    NFSHomeDirectory: '/var/empty',
    IsHidden: '1',
  };
  for (const [property, expected] of Object.entries(userProperties)) {
    if (readDirectoryServiceProperty(
      `/Users/${SERVICE_USER}`,
      property,
    ) !== expected) {
      throw new DevelopmentGateError(
        'legacy_identity_ownership_mismatch',
        'admin-identity',
      );
    }
  }
  if (readDirectoryServiceProperty(
    `/Users/${SERVICE_USER}`,
    'GeneratedUID',
  ) !== LEGACY_RESIDUE_USER_GENERATED_UID) {
    throw new DevelopmentGateError(
      'legacy_identity_ownership_mismatch',
      'admin-identity',
    );
  }
}

function assertLegacyGroupFields() {
  const expectedRealName = `Roundtable Service UID Bootstrap Probe ${LEGACY_RESIDUE_RUN_ID}`;
  const groupProperties = {
    PrimaryGroupID: '499',
    RealName: expectedRealName,
    IsHidden: '1',
  };
  for (const [property, expected] of Object.entries(groupProperties)) {
    if (readDirectoryServiceProperty(
      `/Groups/${SERVICE_GROUP}`,
      property,
    ) !== expected) {
      throw new DevelopmentGateError(
        'legacy_identity_ownership_mismatch',
        'admin-identity',
      );
    }
  }
  const membership = runCommand(TOOLS.dscl, [
    '.',
    '-read',
    `/Groups/${SERVICE_GROUP}`,
    'GroupMembership',
    'GroupMembers',
  ], { stage: 'admin-identity' });
  if (/(?:^|\n)(?:GroupMembership|GroupMembers):/u.test(membership.stdout)) {
    throw new DevelopmentGateError('legacy_identity_group_membership_present', 'admin-identity');
  }
  if (readDirectoryServiceProperty(
    `/Groups/${SERVICE_GROUP}`,
    'GeneratedUID',
  ) !== LEGACY_RESIDUE_GROUP_GENERATED_UID) {
    throw new DevelopmentGateError('legacy_identity_ownership_mismatch', 'admin-identity');
  }
}

async function verifyAdminSources(manifest, sealedSources) {
  for (const sourceName of ['broker', 'canary']) {
    const expected = manifest.sources[sourceName];
    const sourcePath = sealedSources[sourceName];
    const info = await lstat(sourcePath);
    const expectedMode = 0o500;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o777) !== expectedMode
      || info.size <= 0 || info.size > MAX_ADMIN_SOURCE_BYTES
      || await realpath(sourcePath) !== sourcePath
      || await sha256File(sourcePath) !== expected.sha256) {
      throw new DevelopmentGateError(
        'admin_source_verification_failed',
        'admin-preflight',
      );
    }
  }
  verifyCodeRequirement(
    sealedSources.broker,
    `identifier "${BROKER_IDENTIFIER}"`,
  );
  verifyCodeRequirement(
    sealedSources.canary,
    `identifier "${CANARY_IDENTIFIER}"`,
  );
  if (codeDirectoryHash(sealedSources.broker)
    !== manifest.codeDirectoryHashes.broker) {
    throw new DevelopmentGateError(
      'admin_source_cdhash_mismatch',
      'admin-preflight',
    );
  }
}

async function createInstallationRoot(manifest, paths) {
  const temporaryRoot = installationTemporaryRoot(manifest);
  let created = false;
  try {
    await mkdir(temporaryRoot, { mode: 0o700 });
    created = true;
    await chown(temporaryRoot, 0, 0);
    await chmod(temporaryRoot, 0o700);
    await writeExclusiveJson(join(temporaryRoot, 'ownership.json'), {
      schemaVersion: GATE_SCHEMA_VERSION,
      kind: 'roundtable-service-uid-development-gate-install-v4',
      runId: manifest.runId,
      ownershipToken: manifest.ownershipToken,
      serviceUid: manifest.serviceUid,
      serviceIdentity: manifest.serviceIdentity,
      codeDirectoryHashes: manifest.codeDirectoryHashes,
      manifestSha256: manifestSha256(manifest),
    }, 0o444, 0, 0);
    await chmod(temporaryRoot, 0o755);
    await rename(temporaryRoot, INSTALL_ROOT);
    created = false;
    if (!await installationRootOwnedByManifest(manifest, paths)) {
      throw new DevelopmentGateError(
        'installation_root_publish_failed',
        'admin-install',
      );
    }
  } catch (error) {
    if (created) {
      await removeOwnedInstallationTemporaryRoot(manifest).catch(() => undefined);
    }
    throw error;
  }
}

function createServiceIdentity(manifest) {
  const realName = serviceRealName(manifest.runId);
  const groupRecord = `/Groups/${SERVICE_GROUP}`;
  for (const [key, value] of [
    ['GeneratedUID', manifest.serviceIdentity.groupGeneratedUid],
    ['PrimaryGroupID', String(manifest.serviceUid)],
    ['RealName', realName],
    ['Password', '*'],
    ['IsHidden', '1'],
  ]) {
    runCommand(TOOLS.dscl, ['.', '-create', groupRecord, key, value], {
      stage: 'admin-install',
    });
  }
  const userRecord = `/Users/${SERVICE_USER}`;
  runCommand(TOOLS.dscl, ['.', '-create', userRecord], {
    stage: 'admin-install',
  });
  for (const [key, value] of [
    ['RealName', realName],
    ['UniqueID', String(manifest.serviceUid)],
    ['PrimaryGroupID', String(manifest.serviceUid)],
    ['Password', '*'],
    ['UserShell', '/usr/bin/false'],
    ['NFSHomeDirectory', '/var/empty'],
    ['IsHidden', '1'],
  ]) {
    runCommand(TOOLS.dscl, ['.', '-create', userRecord, key, value], {
      stage: 'admin-install',
    });
  }
  assertOwnedServiceIdentity(manifest);
  const matchingUsers = directoryServiceRecordsWithId(
    '/Users',
    'UniqueID',
    manifest.serviceUid,
  );
  const matchingGroups = directoryServiceRecordsWithId(
    '/Groups',
    'PrimaryGroupID',
    manifest.serviceUid,
  );
  if (matchingUsers.length !== 1 || matchingUsers[0] !== SERVICE_USER
    || matchingGroups.length !== 1 || matchingGroups[0] !== SERVICE_GROUP) {
    throw new DevelopmentGateError(
      'service_identity_not_unique',
      'admin-install',
    );
  }
}

async function createInstalledDirectoriesAndFiles(manifest, paths, sealedSources) {
  for (const [directoryPath, mode, uid, gid] of [
    [paths.bin, 0o755, 0, 0],
    [paths.results, 0o755, 0, 0],
    [paths.staging, 0o700, manifest.serviceUid, manifest.serviceUid],
  ]) {
    await mkdir(directoryPath, { mode });
    await chown(directoryPath, uid, gid);
    await chmod(directoryPath, mode);
  }
  for (const [source, target, expectedHash] of [
    [sealedSources.broker, paths.broker, manifest.sources.broker.sha256],
    [sealedSources.canary, paths.canary, manifest.sources.canary.sha256],
  ]) {
    await writeExclusiveFile(
      target,
      await readFile(source),
      0o555,
      0,
      0,
    );
    if (await sha256File(target) !== expectedHash) {
      throw new DevelopmentGateError(
        'installed_binary_hash_mismatch',
        'admin-install',
      );
    }
  }
  verifyCodeRequirement(
    paths.broker,
    `identifier "${BROKER_IDENTIFIER}"`,
  );
  verifyCodeRequirement(
    paths.canary,
    `identifier "${CANARY_IDENTIFIER}"`,
  );
  if (codeDirectoryHash(paths.broker) !== manifest.codeDirectoryHashes.broker) {
    throw new DevelopmentGateError('installed_binary_cdhash_mismatch', 'admin-install');
  }
  const outputOwnership = installedOutputOwnership(manifest.serviceUid);
  for (const [outputPath, ownership] of [
    [paths.brokerStderr, outputOwnership.brokerStderr],
    [paths.canaryStdout, outputOwnership.canaryStdout],
    [paths.canaryStderr, outputOwnership.canaryStderr],
  ]) {
    await writeExclusiveFile(
      outputPath,
      '',
      ownership.mode,
      ownership.uid,
      ownership.gid,
    );
  }
}

async function cleanupInstalledTopology(
  manifest,
  { rollback, transactionPhase = null, interruptedEvidence = null },
) {
  const paths = installedPaths(manifest.runId);
  const errors = [];
  let stagingEvidence = 'not_observed';
  let zeroProcesses = false;

  const rootOwned = await installationRootOwnedByManifest(manifest, paths)
    .catch((error) => {
      errors.push(publicError(error).code);
      return false;
    });
  if (!rootOwned && await pathExists(INSTALL_ROOT)) {
    return {
      schemaVersion: GATE_SCHEMA_VERSION,
      action: rollback ? 'admin-rollback' : 'admin-cleanup',
      result: 'cleanup_incomplete',
      stagingEvidence,
      serviceUidZeroProcesses: false,
      accountRemoved: false,
      fixedResourcesRemoved: false,
      errors: ['installation_ownership_mismatch'],
    };
  }

  for (const [label, expectedProgram] of [
    [canaryLabelForRun(manifest.runId), paths.canary],
    [BROKER_LABEL, paths.broker],
  ]) {
    try {
      bootoutOwnedSystemJob(label, expectedProgram);
    } catch (error) {
      errors.push(publicError(error).code);
    }
  }

  try {
    zeroProcesses = (await waitForUidProcessCount(
      manifest.serviceUid,
      0,
      5_000,
    )).length === 0;
    if (!zeroProcesses) errors.push('service_uid_processes_remain');
  } catch (error) {
    errors.push(publicError(error).code);
  }

  if (rootOwned) {
    try {
      stagingEvidence = await inspectStagingEvidence(manifest, paths);
    } catch (error) {
      errors.push(publicError(error).code);
    }
  }

  let identityDeletionAttempted = false;
  if (zeroProcesses) {
    try {
      identityDeletionAttempted = true;
      await deleteOwnedServiceIdentity(manifest, interruptedEvidence);
    } catch (error) {
      errors.push(publicError(error).code);
    }
  }

  const accountGone = !directoryServiceRecordExists('/Users', SERVICE_USER)
    && !directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  const mayRemoveInstallation = !rootOwned
    || (zeroProcesses && identityDeletionAttempted && accountGone);
  if (mayRemoveInstallation && (rootOwned || !await pathExists(INSTALL_ROOT))) {
    try {
      await removeOwnedInstalledFiles(manifest, paths);
    } catch (error) {
      errors.push(publicError(error).code);
    }
  }
  try {
    await removeOwnedInstallationTemporaryRoot(manifest);
  } catch (error) {
    errors.push(publicError(error).code);
  }

  const resourcesGone = !(await anyPathExists([
    INSTALL_ROOT,
    installationTemporaryRoot(manifest),
    BROKER_PLIST_PATH,
    canaryPlistPathForRun(manifest.runId),
  ]));
  const stagingWasNotYetRequired = ['preflight', 'legacy-recovered',
    'root-published', 'identity-created'].includes(transactionPhase);
  const stagingClear = !rootOwned
    || stagingEvidence === 'verified'
    || stagingEvidence === 'not_written'
    || (stagingEvidence === 'not_present' && stagingWasNotYetRequired);
  const complete = zeroProcesses && accountGone && resourcesGone
    && stagingClear && errors.length === 0;
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    action: rollback ? 'admin-rollback' : 'admin-cleanup',
    result: complete ? 'cleaned' : 'cleanup_incomplete',
    stagingEvidence,
    serviceUidZeroProcesses: zeroProcesses,
    accountRemoved: accountGone,
    fixedResourcesRemoved: resourcesGone,
    errors: errors.slice(0, 8),
  };
}

async function observeAdministratorCleanup(manifest) {
  const serviceUidZeroProcesses = listProcessesForUid(
    manifest.serviceUid,
  ).length === 0;
  const accountRemoved = !directoryServiceRecordExists('/Users', SERVICE_USER)
    && !directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  const fixedResourcesRemoved = !await anyPathExists([
    INSTALL_ROOT,
    installationTemporaryRoot(manifest),
    BROKER_PLIST_PATH,
    canaryPlistPathForRun(manifest.runId),
  ]) && !launchdJobExists(BROKER_LABEL)
    && !launchdJobExists(canaryLabelForRun(manifest.runId));
  const errors = [
    ...(serviceUidZeroProcesses ? [] : ['service_uid_processes_remain']),
    ...(accountRemoved ? [] : ['service_identity_remains']),
    ...(fixedResourcesRemoved ? [] : ['fixed_resources_remain']),
  ];
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    action: 'admin-rollback',
    result: errors.length === 0 ? 'cleaned' : 'cleanup_incomplete',
    stagingEvidence: 'not_observed',
    serviceUidZeroProcesses,
    accountRemoved,
    fixedResourcesRemoved,
    errors,
  };
}

async function installationRootOwnedByManifest(manifest, paths) {
  if (!await pathExists(INSTALL_ROOT)) return false;
  const rootInfo = await lstat(INSTALL_ROOT);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || rootInfo.uid !== 0 || rootInfo.gid !== 0
    || (rootInfo.mode & 0o777) !== 0o755
    || await realpath(INSTALL_ROOT) !== INSTALL_ROOT) {
    throw new DevelopmentGateError(
      'installation_ownership_mismatch',
      'cleanup',
    );
  }
  await assertOwnershipMarker(manifest, paths.ownership);
  return true;
}

async function assertOwnershipMarker(manifest, markerPath) {
  const ownershipInfo = await lstat(markerPath);
  if (!ownershipInfo.isFile() || ownershipInfo.isSymbolicLink()
    || ownershipInfo.nlink !== 1
    || ownershipInfo.uid !== 0 || ownershipInfo.gid !== 0
    || (ownershipInfo.mode & 0o777) !== 0o444) {
    throw new DevelopmentGateError(
      'installation_ownership_mismatch',
      'cleanup',
    );
  }
  const marker = JSON.parse(await readBoundedText(markerPath, 4 * 1024));
  if (!isPlainObject(marker)) {
    throw new DevelopmentGateError(
      'installation_ownership_mismatch',
      'cleanup',
    );
  }
  requireExactKeys(marker, [
    'schemaVersion',
    'kind',
    'runId',
    'ownershipToken',
    'serviceUid',
    'serviceIdentity',
    'codeDirectoryHashes',
    'manifestSha256',
  ]);
  if (!isPlainObject(marker.codeDirectoryHashes)) {
    throw new DevelopmentGateError(
      'installation_ownership_mismatch',
      'cleanup',
    );
  }
  requireExactKeys(marker.codeDirectoryHashes, ['broker', 'client']);
  if (!isPlainObject(marker.serviceIdentity)) {
    throw new DevelopmentGateError(
      'installation_ownership_mismatch',
      'cleanup',
    );
  }
  requireExactKeys(marker.serviceIdentity, [
    'userGeneratedUid',
    'groupGeneratedUid',
  ]);
  if (marker.schemaVersion !== GATE_SCHEMA_VERSION
    || marker.kind !== 'roundtable-service-uid-development-gate-install-v4'
    || marker.runId !== manifest.runId
    || marker.ownershipToken !== manifest.ownershipToken
    || marker.serviceUid !== manifest.serviceUid
    || marker.serviceIdentity.userGeneratedUid
      !== manifest.serviceIdentity.userGeneratedUid
    || marker.serviceIdentity.groupGeneratedUid
      !== manifest.serviceIdentity.groupGeneratedUid
    || marker.manifestSha256 !== manifestSha256(manifest)
    || marker.codeDirectoryHashes.broker
      !== manifest.codeDirectoryHashes.broker
    || marker.codeDirectoryHashes.client
      !== manifest.codeDirectoryHashes.client) {
    throw new DevelopmentGateError(
      'installation_ownership_mismatch',
      'cleanup',
    );
  }
}

async function removeOwnedInstallationTemporaryRoot(manifest) {
  const temporaryRoot = installationTemporaryRoot(manifest);
  if (!await pathExists(temporaryRoot)) return;
  const info = await lstat(temporaryRoot);
  if (!info.isDirectory() || info.isSymbolicLink()
    || info.uid !== 0 || info.gid !== SYSTEM_WHEEL_GROUP_ID
    || ![0o700, 0o755].includes(info.mode & 0o777)
    || await realpath(temporaryRoot) !== temporaryRoot) {
    throw new DevelopmentGateError(
      'installation_temporary_root_ownership_mismatch',
      'cleanup',
    );
  }
  const entries = await readdir(temporaryRoot);
  if (entries.length > 1
    || (entries.length === 1 && entries[0] !== 'ownership.json')) {
    throw new DevelopmentGateError(
      'installation_temporary_root_ownership_mismatch',
      'cleanup',
    );
  }
  if (entries.length === 1) {
    const markerPath = join(temporaryRoot, 'ownership.json');
    await assertOwnershipMarker(manifest, markerPath);
    await unlink(markerPath);
  }
  await rmdir(temporaryRoot);
}

function bootoutOwnedSystemJob(label, expectedProgram) {
  const target = `system/${label}`;
  const printed = runCommandAllowFailure(
    TOOLS.launchctl,
    ['print', target],
    { stage: 'cleanup' },
  );
  if (printed.status !== 0) return;
  if (!printed.stdout.includes(expectedProgram)) {
    throw new DevelopmentGateError(
      'system_launchd_ownership_mismatch',
      'cleanup',
    );
  }
  runCommand(TOOLS.launchctl, ['bootout', target], { stage: 'cleanup' });
  if (runCommandAllowFailure(
    TOOLS.launchctl,
    ['print', target],
    { stage: 'cleanup' },
  ).status === 0) {
    throw new DevelopmentGateError(
      'system_launchd_bootout_failed',
      'cleanup',
    );
  }
}

async function inspectStagingEvidence(manifest, paths) {
  if (!await pathExists(paths.staging)) return 'not_present';
  const stagingInfo = await lstat(paths.staging);
  if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()
    || stagingInfo.uid !== manifest.serviceUid
    || stagingInfo.gid !== manifest.serviceUid
    || (stagingInfo.mode & 0o777) !== 0o700
    || await realpath(paths.staging) !== paths.staging) {
    throw new DevelopmentGateError(
      'staging_metadata_mismatch',
      'cleanup',
    );
  }
  const entries = await readdir(paths.staging);
  const expectedName = `${CANARY_WRITE_PREFIX}${manifest.runId}`;
  if (entries.length === 0) return 'not_written';
  if (entries.length !== 1 || entries[0] !== expectedName) {
    throw new DevelopmentGateError(
      'unexpected_staging_content',
      'cleanup',
    );
  }
  const canaryPath = join(paths.staging, expectedName);
  const info = await lstat(canaryPath);
  if (!info.isFile() || info.isSymbolicLink()
    || info.uid !== manifest.serviceUid
    || info.gid !== manifest.serviceUid
    || info.nlink !== 1
    || (info.mode & 0o777) !== 0o600
    || await readBoundedText(canaryPath, 256) !== STAGING_CANARY_CONTENT) {
    throw new DevelopmentGateError(
      'staging_evidence_mismatch',
      'cleanup',
    );
  }
  return 'verified';
}

async function deleteOwnedServiceIdentity(manifest, interruptedEvidence = null) {
  const userExists = directoryServiceRecordExists('/Users', SERVICE_USER);
  const groupExists = directoryServiceRecordExists('/Groups', SERVICE_GROUP);
  const presentRecordTypes = [
    ...(groupExists ? ['/Groups'] : []),
    ...(userExists ? ['/Users'] : []),
  ];
  if (presentRecordTypes.length > 0) {
    if (interruptedEvidence !== null) {
      assertOwnedInterruptedServiceIdentity(manifest, interruptedEvidence);
    } else {
      assertOwnedServiceIdentity(manifest, presentRecordTypes);
    }
  }
  await deleteDirectoryServiceIdentityRecords({
    userExists,
    groupExists,
    stage: 'cleanup',
    interruptedEvidence,
  });
}

function assertOwnedInterruptedServiceIdentity(identitySource, recovery) {
  if (!isValidInterruptedHostEvidence(recovery?.hostEvidence)
    || identitySource.runId !== recovery.runId
    || identitySource.serviceUid !== recovery.hostEvidence.serviceUid
    || identitySource.serviceIdentity.groupGeneratedUid
      !== recovery.hostEvidence.groupGeneratedUid
    || !directoryServiceRecordExists('/Users', SERVICE_USER)
    || !directoryServiceRecordExists('/Groups', SERVICE_GROUP)) {
    throw new DevelopmentGateError(
      'interrupted_service_identity_ownership_mismatch',
      'admin-recovery',
    );
  }
  const userPath = `/Users/${SERVICE_USER}`;
  const groupPath = `/Groups/${SERVICE_GROUP}`;
  const expectedUser = {
    GeneratedUID: recovery.hostEvidence.observedUserGeneratedUid,
    UniqueID: recovery.hostEvidence.observedUserUid,
    PrimaryGroupID: recovery.hostEvidence.observedUserPrimaryGid,
  };
  const expectedGroup = {
    PrimaryGroupID: String(identitySource.serviceUid),
    GeneratedUID: identitySource.serviceIdentity.groupGeneratedUid,
    RealName: serviceRealName(identitySource.runId),
    IsHidden: '1',
  };
  for (const [property, expected] of Object.entries(expectedUser)) {
    if (readOptionalDirectoryServiceProperty(userPath, property) !== expected) {
      throw new DevelopmentGateError(
        'interrupted_service_identity_ownership_mismatch',
        'admin-recovery',
      );
    }
  }
  for (const [property, expected] of Object.entries(
    recovery.hostEvidence.userProperties,
  )) {
    if (readOptionalDirectoryServiceProperty(userPath, property) !== expected) {
      throw new DevelopmentGateError(
        'interrupted_service_identity_ownership_mismatch',
        'admin-recovery',
      );
    }
  }
  if (!arraysEqual(
    directoryServiceGroupIdsForUser(SERVICE_USER),
    recovery.hostEvidence.observedUserGroupIds,
  )) {
    throw new DevelopmentGateError(
      'interrupted_service_identity_ownership_mismatch',
      'admin-recovery',
    );
  }
  for (const property of recovery.hostEvidence.userMissingProperties) {
    if (!directoryServicePropertyIsMissing(userPath, property)) {
      throw new DevelopmentGateError(
        'interrupted_service_identity_ownership_mismatch',
        'admin-recovery',
      );
    }
  }
  for (const [property, expected] of Object.entries(expectedGroup)) {
    if (readDirectoryServiceProperty(groupPath, property) !== expected) {
      throw new DevelopmentGateError(
        'interrupted_service_identity_ownership_mismatch',
        'admin-recovery',
      );
    }
  }
  const membership = runCommand(TOOLS.dscl, [
    '.', '-read', groupPath, 'GroupMembership', 'GroupMembers',
  ], { stage: 'admin-recovery' }).stdout;
  if (/(?:^|\n)(?:GroupMembership|GroupMembers):/u.test(membership)
    || !arraysEqual(directoryServiceRecordsWithId(
      '/Users', 'UniqueID', identitySource.serviceUid,
    ), recovery.hostEvidence.userRecordsWithUid)
    || !arraysEqual(directoryServiceRecordsWithId(
      '/Groups', 'PrimaryGroupID', identitySource.serviceUid,
    ), [SERVICE_GROUP])) {
    throw new DevelopmentGateError(
      'interrupted_service_identity_ownership_mismatch',
      'admin-recovery',
    );
  }
}

async function deleteDirectoryServiceIdentityRecords({
  userExists,
  groupExists,
  stage,
  interruptedEvidence = null,
}) {
  if (userExists) {
    let deletionDiagnostic = null;
    const direct = runCommandAllowFailure(TOOLS.dscl, [
      '/Local/Default',
      '-delete',
      `/Users/${SERVICE_USER}`,
    ], { stage });
    if (direct.status !== 0) {
      if (!directoryServicePermissionDenied(direct)) {
        throw new DevelopmentGateError(
          'directory_service_user_delete_failed',
          stage,
          commandFailureDiagnostic(TOOLS.dscl, direct),
        );
      }
      let protectedHome = null;
      if (interruptedEvidence === null) {
        assertRoleAccountDeleteFallbackEligible();
        protectedHome = await captureProtectedRoleAccountHome();
      } else {
        assertOwnedInterruptedServiceIdentity(
          interruptedEvidence.hostEvidence.marker,
          interruptedEvidence,
        );
      }
      const roleAccountDelete = runCommandAllowFailure(TOOLS.sysadminctl, [
        '-deleteUser',
        SERVICE_USER,
      ], { stage });
      if (roleAccountDelete.status !== 0) {
        throw new DevelopmentGateError(
          'directory_service_user_delete_failed',
          stage,
          commandFailureDiagnostic(TOOLS.sysadminctl, roleAccountDelete),
        );
      }
      deletionDiagnostic = [
        commandFailureDiagnostic(TOOLS.dscl, direct),
        `${basename(TOOLS.sysadminctl)} exited 0 but the user record remained`,
      ].join('; ');
      if (protectedHome !== null) {
        await assertProtectedRoleAccountHomeUnchanged(protectedHome);
      }
    }
    await waitForDirectoryServiceRecordAbsent(
      '/Users',
      SERVICE_USER,
      stage,
      deletionDiagnostic,
    );
  }

  if (groupExists
    && directoryServiceRecordExists('/Groups', SERVICE_GROUP)) {
    let deletionDiagnostic = null;
    const direct = runCommandAllowFailure(TOOLS.dscl, [
      '/Local/Default',
      '-delete',
      `/Groups/${SERVICE_GROUP}`,
    ], { stage });
    if (direct.status !== 0) {
      if (!directoryServicePermissionDenied(direct)) {
        throw new DevelopmentGateError(
          'directory_service_group_delete_failed',
          stage,
          commandFailureDiagnostic(TOOLS.dscl, direct),
        );
      }
      const groupDelete = runCommandAllowFailure(TOOLS.dseditgroup, [
        '-q',
        '-o',
        'delete',
        '-n',
        '/Local/Default',
        SERVICE_GROUP,
      ], { stage });
      if (groupDelete.status !== 0) {
        throw new DevelopmentGateError(
          'directory_service_group_delete_failed',
          stage,
          commandFailureDiagnostic(TOOLS.dseditgroup, groupDelete),
        );
      }
      deletionDiagnostic = [
        commandFailureDiagnostic(TOOLS.dscl, direct),
        `${basename(TOOLS.dseditgroup)} exited 0 but the group record remained`,
      ].join('; ');
    }
    await waitForDirectoryServiceRecordAbsent(
      '/Groups',
      SERVICE_GROUP,
      stage,
      deletionDiagnostic,
    );
  }
}

function assertRoleAccountDeleteFallbackEligible() {
  const uid = Number(readDirectoryServiceProperty(
    `/Users/${SERVICE_USER}`,
    'UniqueID',
  ));
  const primaryGid = Number(readDirectoryServiceProperty(
    `/Users/${SERVICE_USER}`,
    'PrimaryGroupID',
  ));
  if (!Number.isSafeInteger(uid)
    || uid < SERVICE_UID_MINIMUM || uid > SERVICE_UID_MAXIMUM
    || primaryGid !== uid
    || readDirectoryServiceProperty(
      `/Users/${SERVICE_USER}`,
      'NFSHomeDirectory',
    ) !== '/var/empty'
    || readDirectoryServiceProperty(
      `/Users/${SERVICE_USER}`,
      'UserShell',
    ) !== '/usr/bin/false'
    || readDirectoryServiceProperty(
      `/Users/${SERVICE_USER}`,
      'IsHidden',
    ) !== '1') {
    throw new DevelopmentGateError(
      'role_account_delete_fallback_rejected',
      'admin-identity',
    );
  }
}

async function captureProtectedRoleAccountHome() {
  const info = await lstat(ROLE_ACCOUNT_HOME);
  if (!protectedRoleAccountHomeMetadataMatches(
    info,
    await realpath('/var/empty'),
  )) {
    throw new DevelopmentGateError(
      'protected_role_account_home_mismatch',
      'admin-identity',
    );
  }
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    gid: info.gid,
    mode: info.mode & 0o777,
  };
}

export function protectedRoleAccountHomeMetadataMatches(info, canonicalPath) {
  return info.isDirectory() && !info.isSymbolicLink()
    && info.uid === 0
    && info.gid === ROLE_ACCOUNT_HOME_GROUP_ID
    && (info.mode & 0o777) === 0o755
    && canonicalPath === ROLE_ACCOUNT_HOME;
}

async function assertProtectedRoleAccountHomeUnchanged(expected) {
  const observed = await captureProtectedRoleAccountHome();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new DevelopmentGateError(
      'protected_role_account_home_changed',
      'admin-identity',
    );
  }
}

export function directoryServicePermissionDenied(result) {
  if (!isPlainObject(result) || !Number.isSafeInteger(result.status)) return false;
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return result.status === 40
    && /(?:eDSPermissionError|-14120)/u.test(output);
}

async function waitForDirectoryServiceRecordAbsent(
  recordType,
  name,
  stage,
  diagnostic = null,
) {
  const deadline = performance.now() + 5_000;
  do {
    if (!directoryServiceRecordExists(recordType, name)) return;
    await delay(50);
  } while (performance.now() < deadline);
  throw new DevelopmentGateError(
    recordType === '/Users'
      ? 'directory_service_user_delete_failed'
      : 'directory_service_group_delete_failed',
    stage,
    diagnostic ?? 'directory service reported success but the record remained',
  );
}

function assertOwnedServiceIdentity(
  manifest,
  requiredRecordTypes = ['/Groups', '/Users'],
) {
  const expectedRealName = serviceRealName(manifest.runId);
  const expectations = [
    ['/Groups', SERVICE_GROUP, {
      PrimaryGroupID: String(manifest.serviceUid),
      GeneratedUID: manifest.serviceIdentity.groupGeneratedUid,
      RealName: expectedRealName,
      IsHidden: '1',
    }],
    ['/Users', SERVICE_USER, {
      UniqueID: String(manifest.serviceUid),
      PrimaryGroupID: String(manifest.serviceUid),
      RealName: expectedRealName,
      UserShell: '/usr/bin/false',
      NFSHomeDirectory: '/var/empty',
      IsHidden: '1',
    }],
  ];
  for (const [recordType, name, properties] of expectations.filter(
    ([recordType]) => requiredRecordTypes.includes(recordType),
  )) {
    if (!directoryServiceRecordExists(recordType, name)) {
      throw new DevelopmentGateError(
        'service_identity_ownership_mismatch',
        'admin-identity',
      );
    }
    for (const [property, expected] of Object.entries(properties)) {
      if (readDirectoryServiceProperty(
        `${recordType}/${name}`,
        property,
      ) !== expected) {
        throw new DevelopmentGateError(
          'service_identity_ownership_mismatch',
          'admin-identity',
        );
      }
    }
    if (recordType === '/Users') {
      const observedGeneratedUid = readDirectoryServiceProperty(
        `${recordType}/${name}`,
        'GeneratedUID',
      );
      const generatedUidPattern =
        /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/u;
      if (!generatedUidPattern.test(observedGeneratedUid)
        || (manifest.serviceIdentity.userGeneratedUid !== null
          && observedGeneratedUid
            !== manifest.serviceIdentity.userGeneratedUid)) {
        throw new DevelopmentGateError(
          'service_identity_ownership_mismatch',
          'admin-identity',
        );
      }
    }
  }
  if (requiredRecordTypes.includes('/Groups')) {
    const membership = runCommand(TOOLS.dscl, [
      '.',
      '-read',
      `/Groups/${SERVICE_GROUP}`,
      'GroupMembership',
      'GroupMembers',
    ], { stage: 'admin-identity' });
    if (/(?:^|\n)(?:GroupMembership|GroupMembers):/u.test(membership.stdout)) {
      throw new DevelopmentGateError(
        'service_identity_group_membership_present',
        'admin-identity',
      );
    }
  }
  if (requiredRecordTypes.includes('/Users')) {
    const expectedGroupIds = [manifest.serviceUid, 12, 61, 701, 100];
    if (!arraysEqual(
      directoryServiceGroupIdsForUser(SERVICE_USER),
      expectedGroupIds,
    )) {
      throw new DevelopmentGateError(
        'service_identity_privilege_mismatch',
        'admin-identity',
      );
    }
  }
  const matchingUsers = directoryServiceRecordsWithId(
    '/Users',
    'UniqueID',
    manifest.serviceUid,
  );
  const matchingGroups = directoryServiceRecordsWithId(
    '/Groups',
    'PrimaryGroupID',
    manifest.serviceUid,
  );
  const userExpected = requiredRecordTypes.includes('/Users');
  const groupExpected = requiredRecordTypes.includes('/Groups');
  if (matchingUsers.length !== (userExpected ? 1 : 0)
    || (userExpected && matchingUsers[0] !== SERVICE_USER)
    || matchingGroups.length !== (groupExpected ? 1 : 0)
    || (groupExpected && matchingGroups[0] !== SERVICE_GROUP)) {
    throw new DevelopmentGateError(
      'service_identity_not_unique',
      'admin-identity',
    );
  }
}

async function removeOwnedInstalledFiles(manifest, paths) {
  for (const [plistPath, expected] of [
    [BROKER_PLIST_PATH, renderBrokerLaunchDaemon(manifest)],
    [canaryPlistPathForRun(manifest.runId), renderCanaryLaunchDaemon(manifest)],
  ]) {
    if (!await pathExists(plistPath)) continue;
    const info = await lstat(plistPath);
    if (!info.isFile() || info.isSymbolicLink()
      || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o777) !== 0o644
      || await realpath(plistPath) !== plistPath
      || await readBoundedText(plistPath, MAX_MANIFEST_BYTES) !== expected) {
      throw new DevelopmentGateError(
        'installed_plist_ownership_mismatch',
        'cleanup',
      );
    }
    await unlink(plistPath);
  }

  const stagingEntry = join(
    paths.staging,
    `${CANARY_WRITE_PREFIX}${manifest.runId}`,
  );
  const stagingEvidence = await inspectStagingEvidence(manifest, paths);
  if (stagingEvidence === 'verified') await unlink(stagingEntry);
  await removeDirectoryIfEmpty(paths.staging);
  const outputOwnership = installedOutputOwnership(manifest.serviceUid);
  for (const [filePath, maximumBytes, ownership] of [
    [paths.brokerStderr, 4 * 1024, outputOwnership.brokerStderr],
    [paths.canaryStdout, 8 * 1024, outputOwnership.canaryStdout],
    [paths.canaryStderr, 4 * 1024, outputOwnership.canaryStderr],
  ]) await removeOwnedOutputFile(filePath, maximumBytes, ownership);
  await removeDirectoryIfEmpty(paths.results);
  for (const [filePath, expectedHash] of [
    [paths.broker, manifest.sources.broker.sha256],
    [paths.canary, manifest.sources.canary.sha256],
  ]) {
    if (!await pathExists(filePath)) continue;
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()
      || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o777) !== 0o555
      || await realpath(filePath) !== filePath
      || await sha256File(filePath) !== expectedHash) {
      throw new DevelopmentGateError(
        'installed_binary_ownership_mismatch',
        'cleanup',
      );
    }
    await unlink(filePath);
  }
  await removeDirectoryIfEmpty(paths.bin);
  await unlinkIfPresentNoFollow(paths.ownership);
  await removeDirectoryIfEmpty(INSTALL_ROOT);
}

async function removeOwnedOutputFile(filePath, maximumBytes, ownership) {
  if (!await pathExists(filePath)) return;
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.uid !== ownership.uid || info.gid !== ownership.gid
    || (info.mode & 0o777) !== ownership.mode
    || info.size < 0 || info.size > maximumBytes
    || await realpath(filePath) !== filePath) {
    throw new DevelopmentGateError(
      'installed_output_ownership_mismatch',
      'cleanup',
    );
  }
  await unlink(filePath);
}

async function waitForBroker(label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const printed = runCommandAllowFailure(
      TOOLS.launchctl,
      ['print', `system/${label}`],
      { stage: 'xpc' },
    );
    if (printed.status === 0 && printed.stdout.includes('state = running')) return;
    await delay(50);
  }
  throw new DevelopmentGateError('broker_start_timeout', 'xpc');
}

async function runExpectedClient(clientPath, operation, requestId, brokerCdHash) {
  const result = await execCommand(clientPath, [
    operation,
    requestId,
    '--accepted-broker-cdhash',
    brokerCdHash,
  ], {
    stage: 'xpc',
    timeout: CLIENT_TIMEOUT_MS,
  });
  const expected = `service-uid-bootstrap-probe-v0 ok ${operation} development-adhoc-pinned (not a Phase 4 gate)\n`;
  if (result.stdout !== expected || result.stderr !== '') {
    throw new DevelopmentGateError(
      'signed_client_response_mismatch',
      'xpc',
    );
  }
}

async function runRejectedClient(clientPath, requestId, brokerCdHash) {
  let rejected = false;
  try {
    const result = await execCommand(clientPath, [
      'ping',
      requestId,
      '--accepted-broker-cdhash',
      brokerCdHash,
    ], {
      stage: 'xpc-negative',
      timeout: CLIENT_TIMEOUT_MS,
    });
    rejected = result.status !== 0
      && !result.stdout.includes('service-uid-bootstrap-probe-v0 ok');
  } catch (error) {
    if (error instanceof DevelopmentGateError
      && error.code === 'command_failed') rejected = true;
    else throw error;
  }
  if (!rejected) {
    throw new DevelopmentGateError(
      'wrong_signature_client_not_rejected',
      'xpc-negative',
    );
  }
}

async function waitForCanaryResult(
  runId,
  serviceUid,
  expectedHostPid,
  expectedHostUid,
) {
  const paths = installedPaths(runId);
  const deadline = Date.now() + CANARY_TIMEOUT_MS;
  let text = '';
  while (Date.now() < deadline) {
    try {
      text = await readBoundedText(paths.canaryStdout, 8 * 1024);
      if (text.endsWith('\n') && text.length > 1) break;
    } catch {
      // launchd may not have opened the output yet.
    }
    await delay(50);
  }
  if (!text.endsWith('\n') || text.length <= 1) {
    throw new DevelopmentGateError(
      'canary_result_timeout',
      'canary',
    );
  }
  const stderr = await readBoundedText(paths.canaryStderr, 4 * 1024);
  if (stderr !== '') {
    throw new DevelopmentGateError(
      'canary_stderr_not_empty',
      'canary',
    );
  }
  let value;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new DevelopmentGateError(
      'invalid_canary_result',
      'canary',
    );
  }
  try {
    validateCanaryResult(
      value,
      runId,
      serviceUid,
      expectedHostPid,
      expectedHostUid,
    );
  } catch (error) {
    if (error instanceof DevelopmentGateError
      && error.code === 'invalid_canary_result') {
      throw new DevelopmentGateError(
        'invalid_canary_result',
        'canary',
        `canary=${JSON.stringify(value)}`,
      );
    }
    throw error;
  }
  return value;
}

export function validateCanaryResult(
  value,
  runId,
  serviceUid,
  expectedHostPid,
  expectedHostUid,
) {
  requireRunId(runId);
  if (!isPlainObject(value)) throw canaryError();
  requireExactKeys(value, [
    'schemaVersion',
    'result',
    'hostPid',
    'hostUid',
    'serviceUid',
    'tests',
  ]);
  if (value.schemaVersion !== 1
    || value.result !== 'passed'
    || value.serviceUid !== serviceUid
    || value.hostPid !== expectedHostPid
    || value.hostUid !== expectedHostUid
    || !Number.isSafeInteger(value.hostPid) || value.hostPid <= 1
    || !Number.isSafeInteger(value.hostUid) || value.hostUid <= 0
    || !isPlainObject(value.tests)) throw canaryError();
  requireExactKeys(value.tests, [
    ...REQUIRED_CANARY_DENIALS,
    'stagingWrite',
  ]);
  for (const testName of REQUIRED_CANARY_DENIALS) {
    validateCanaryTest(value.tests[testName], 'denied');
  }
  validateCanaryTest(value.tests.stagingWrite, 'succeeded');
  return value;
}

function validateCanaryTest(value, expectedOutcome) {
  if (!isPlainObject(value)) throw canaryError();
  requireExactKeys(value, ['outcome', 'code']);
  if (value.outcome !== expectedOutcome
    || !Number.isSafeInteger(value.code)
    || value.code < 0 || value.code > 255
    || (expectedOutcome === 'denied' && value.code === 0)
    || (expectedOutcome === 'succeeded' && value.code !== 0)) throw canaryError();
}

function listProcessesForUid(uid) {
  if (!Number.isSafeInteger(uid) || uid < SERVICE_UID_MINIMUM
    || uid > SERVICE_UID_MAXIMUM) {
    throw new DevelopmentGateError(
      'invalid_service_uid',
      'process-observation',
    );
  }
  const result = runCommand(TOOLS.ps, ['-axo', 'uid=,pid='], {
    stage: 'process-observation',
  });
  const pids = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^\s*(-?\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) {
      throw new DevelopmentGateError(
        'invalid_process_listing',
        'process-observation',
      );
    }
    if (Number(match[1]) === uid) pids.push(Number(match[2]));
  }
  return pids;
}

async function waitForUidProcessCount(uid, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pids = listProcessesForUid(uid);
  while (pids.length !== expectedCount && Date.now() < deadline) {
    await delay(50);
    pids = listProcessesForUid(uid);
  }
  return pids;
}

async function removeOwnedHostPrivateRoot(fixture, expectedUid) {
  if (!await pathExists(fixture.privateRoot)) return;
  const info = await lstat(fixture.privateRoot);
  const marker = await readBoundedText(
    join(fixture.privateRoot, '.owner-token'),
    256,
  );
  if (!info.isDirectory() || info.isSymbolicLink()
    || info.uid !== expectedUid || (info.mode & 0o077) !== 0
    || marker !== `${fixture.ownerToken}\n`
    || fixture.privateRoot !== hostPrivateRootForRun(
      fixture.label.slice(HOST_LABEL_PREFIX.length),
    )) {
    throw new DevelopmentGateError(
      'host_private_root_ownership_mismatch',
      'cleanup',
    );
  }
  await rm(fixture.privateRoot, { recursive: true, force: false });
}

async function removeOwnedTemporaryDirectory(directoryPath, expectedUid) {
  const canonicalTmp = await realpath(tmpdir());
  const canonicalDirectory = await realpath(directoryPath).catch(() => null);
  if (canonicalDirectory === null) return;
  const info = await lstat(canonicalDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()
    || info.uid !== expectedUid || (info.mode & 0o077) !== 0
    || !canonicalDirectory.startsWith(
      `${canonicalTmp}/roundtable-service-uid-development-gate-`,
    )) {
    throw new DevelopmentGateError(
      'temporary_directory_ownership_mismatch',
      'cleanup',
    );
  }
  await rm(canonicalDirectory, { recursive: true, force: false });
}

function installedPaths(runId) {
  requireRunId(runId);
  const bin = join(INSTALL_ROOT, 'bin');
  const results = join(INSTALL_ROOT, 'results');
  return {
    bin,
    results,
    staging: join(INSTALL_ROOT, 'staging'),
    broker: join(bin, 'roundtable-service-uid-bootstrap-probe-v0-broker'),
    canary: join(bin, 'roundtable-service-uid-isolation-canary'),
    ownership: join(INSTALL_ROOT, 'ownership.json'),
    brokerStderr: join(results, 'broker.stderr'),
    canaryStdout: join(results, `canary-${runId}.stdout`),
    canaryStderr: join(results, `canary-${runId}.stderr`),
  };
}

function installationTemporaryRoot(manifest) {
  requireRunId(manifest.runId);
  if (!/^[a-f0-9]{64}$/u.test(manifest.ownershipToken)) throw manifestError();
  return `${INSTALL_ROOT}.installing-${manifest.runId}-${
    manifest.ownershipToken.slice(0, 16)
  }`;
}

function sealedAdminPackagePaths(packageDirectory) {
  if (!boundedAbsolutePath(packageDirectory)
    || !packageDirectory.startsWith(ADMIN_PACKAGE_PREFIX)) {
    throw manifestError();
  }
  return {
    node: join(packageDirectory, 'node'),
    helper: join(packageDirectory, 'admin-helper'),
    script: join(packageDirectory, 'admin-runner.mjs'),
    manifest: join(packageDirectory, 'admin-manifest.json'),
    broker: join(packageDirectory, 'broker'),
    canary: join(packageDirectory, 'canary'),
  };
}

function hostPrivateRootForRun(runId) {
  requireRunId(runId);
  return `/private/tmp/roundtable-p4-${runId}`;
}

function serviceRealName(runId) {
  return `Roundtable Service UID Bootstrap Probe ${runId}`;
}

function directoryServiceRecordExists(recordType, name) {
  const listing = runCommand(TOOLS.dscl, ['.', '-list', recordType], {
    stage: 'directory-service',
  });
  return listing.stdout.split('\n').some((line) => line.trim() === name);
}

function directoryServiceRecordsWithId(recordType, property, id) {
  const result = runCommand(TOOLS.dscl, ['.', '-list', recordType, property], {
    stage: 'directory-service',
  });
  const records = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^(\S+)\s+(-?\d+)\s*$/u.exec(line);
    if (!match) {
      throw new DevelopmentGateError(
        'invalid_directory_service_listing',
        'directory-service',
      );
    }
    if (Number(match[2]) === id) records.push(match[1]);
  }
  return records;
}

function readDirectoryServiceProperty(record, property) {
  const result = runCommand(TOOLS.dscl, ['.', '-read', record, property], {
    stage: 'directory-service',
  });
  return parseDirectoryServiceProperty(result.stdout, property);
}

export function parseDirectoryServiceProperty(output, property) {
  if (typeof output !== 'string'
    || typeof property !== 'string'
    || !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(property)
    || Buffer.byteLength(output) > MAX_COMMAND_OUTPUT_BYTES) {
    throw new DevelopmentGateError(
      'directory_service_property_missing',
      'directory-service',
    );
  }
  const lines = output.split('\n');
  const prefixes = [`${property}:`, `dsAttrTypeNative:${property}:`];
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const prefix = prefixes.find((candidate) => lines[index].startsWith(candidate));
    if (prefix) matches.push({ index, prefix });
  }
  if (matches.length !== 1) {
    throw new DevelopmentGateError(
      'directory_service_property_missing',
      'directory-service',
    );
  }
  const { index, prefix } = matches[0];
  const inline = lines[index].slice(prefix.length).trim();
  if (inline !== '') return inline;
  const continuation = [];
  for (let offset = index + 1; offset < lines.length; offset += 1) {
    const line = lines[offset];
    if (!/^\s+/u.test(line)) break;
    const value = line.trim();
    if (value !== '') continuation.push(value);
  }
  if (continuation.length !== 1) {
    throw new DevelopmentGateError(
      'directory_service_property_missing',
      'directory-service',
    );
  }
  return continuation[0];
}

function renderPlist(value) {
  const body = plistValue(value, 1);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    body,
    '</plist>',
    '',
  ].join('\n');
}

function plistValue(value, depth) {
  const indent = '  '.repeat(depth);
  if (typeof value === 'string') return `${indent}<string>${xmlEscape(value)}</string>`;
  if (typeof value === 'boolean') return `${indent}<${value ? 'true' : 'false'}/>`;
  if (Number.isSafeInteger(value)) return `${indent}<integer>${value}</integer>`;
  if (Array.isArray(value)) {
    return [
      `${indent}<array>`,
      ...value.map((entry) => plistValue(entry, depth + 1)),
      `${indent}</array>`,
    ].join('\n');
  }
  if (isPlainObject(value)) {
    const lines = [`${indent}<dict>`];
    for (const [key, entry] of Object.entries(value)) {
      lines.push(`${'  '.repeat(depth + 1)}<key>${xmlEscape(key)}</key>`);
      lines.push(plistValue(entry, depth + 1));
    }
    lines.push(`${indent}</dict>`);
    return lines.join('\n');
  }
  throw new DevelopmentGateError('invalid_plist_value', 'plist');
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function writeExclusiveJson(path, value, mode, uid, gid) {
  return writeExclusiveFile(
    path,
    `${JSON.stringify(value)}\n`,
    mode,
    uid,
    gid,
  );
}

async function writePublishedJson(path, value, mode, uid, gid) {
  const pendingPath = `${path}.next`;
  await writeExclusiveJson(pendingPath, value, mode, uid, gid);
  try {
    if (await pathExists(path)) {
      throw new DevelopmentGateError('handshake_publish_conflict', 'handshake');
    }
    await rename(pendingPath, path);
  } catch (error) {
    await unlinkIfPresentNoFollow(pendingPath).catch(() => undefined);
    throw error;
  }
}

async function writeExclusiveFile(path, data, mode, uid, gid) {
  const handle = await open(path, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
  if (uid !== undefined && gid !== undefined) await chown(path, uid, gid);
}

async function readBoundedText(path, maximumBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()
    || info.size < 0 || info.size > maximumBytes) {
    throw new DevelopmentGateError('bounded_read_rejected', 'filesystem');
  }
  return readFile(path, 'utf8');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function unlinkIfPresentNoFollow(path) {
  try {
    await lstat(path);
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function removeDirectoryIfEmpty(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new DevelopmentGateError(
        'cleanup_path_is_not_directory',
        'cleanup',
      );
    }
    if ((await readdir(path)).length !== 0) {
      throw new DevelopmentGateError(
        'cleanup_directory_not_empty',
        'cleanup',
      );
    }
    await rmdir(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function anyPathExists(paths) {
  for (const path of paths) {
    if (await pathExists(path)) return true;
  }
  return false;
}

async function systemResourcesExist(manifest) {
  if (await anyPathExists([
    INSTALL_ROOT,
    installationTemporaryRoot(manifest),
    TRANSACTION_JOURNAL_ROOT,
    BROKER_PLIST_PATH,
    canaryPlistPathForRun(manifest.runId),
    administratorReadyPath(manifest),
    hostAcknowledgementPath(manifest),
  ])) return true;
  if (await administratorPackagesExistForRun(manifest.runId)) return true;
  if (directoryServiceRecordExists('/Users', SERVICE_USER)
    || directoryServiceRecordExists('/Groups', SERVICE_GROUP)) return true;
  return [
    `system/${BROKER_LABEL}`,
    `system/${canaryLabelForRun(manifest.runId)}`,
  ].some((target) => runCommandAllowFailure(
    TOOLS.launchctl,
    ['print', target],
    { stage: 'cleanup-observation' },
  ).status === 0);
}

async function administratorPackagesExistForRun(runId) {
  requireRunId(runId);
  const prefix = basename(`${ADMIN_PACKAGE_PREFIX}${runId}-`);
  return (await readdir(dirname(ADMIN_PACKAGE_PREFIX))).some((entry) => (
    entry.startsWith(prefix)
  ));
}

function parsePositiveField(output, field) {
  const match = new RegExp(`(?:^|\\n)\\s*${field} = (\\d+)\\s*(?:\\n|$)`, 'u')
    .exec(output);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function runCommand(
  command,
  args,
  {
    stage,
    timeout = COMMAND_TIMEOUT_MS,
    maxBuffer = MAX_COMMAND_OUTPUT_BYTES,
  },
) {
  const result = runCommandAllowFailure(command, args, {
    stage,
    timeout,
    maxBuffer,
  });
  if (result.status !== 0) {
    throw new DevelopmentGateError(
      'command_failed',
      stage,
      commandFailureDiagnostic(command, result),
    );
  }
  return result;
}

export function commandFailureDiagnostic(command, result) {
  const status = Number.isSafeInteger(result?.status) ? result.status : 'unknown';
  const output = sanitizeDiagnostic(
    `${result?.stderr ?? ''} ${result?.stdout ?? ''}`,
  );
  return `${basename(command)} exited ${status}${output ? `: ${output}` : ''}`;
}

function sanitizeDiagnostic(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1024);
}

function runCommandAllowFailure(
  command,
  args,
  {
    stage,
    timeout = COMMAND_TIMEOUT_MS,
    maxBuffer = MAX_COMMAND_OUTPUT_BYTES,
  },
) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT'
      ? 'command_timeout'
      : 'command_execution_failed';
    throw new DevelopmentGateError(code, stage, basename(command));
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function execCommand(
  executable,
  args,
  {
    stage,
    command = executable,
    timeout = COMMAND_TIMEOUT_MS,
  },
) {
  try {
    const result = await execFileAsync(command, command === executable
      ? args
      : [executable, ...args], {
      encoding: 'utf8',
      timeout,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error?.code === 'ETIMEDOUT' || error?.killed) {
      throw new DevelopmentGateError('command_timeout', stage);
    }
    const diagnostic = typeof error?.stderr === 'string'
      ? error.stderr.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 1024)
      : '';
    throw new DevelopmentGateError(
      'command_failed',
      stage,
      diagnostic || 'command_failed',
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function boundedAbsolutePath(value) {
  return typeof value === 'string'
    && value.length >= 2
    && value.length <= 1023
    && isAbsolute(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !value.split('/').some((component) => component === '..');
}

function requireRunId(runId) {
  if (!/^[a-f0-9]{32}$/u.test(runId)) throw manifestError();
}

function requireExactKeys(object, expectedKeys) {
  const observed = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (observed.length !== expected.length
    || observed.some((key, index) => key !== expected[index])) {
    throw manifestError();
  }
}

function arraysEqual(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function manifestError() {
  return new DevelopmentGateError(
    'invalid_admin_manifest',
    'admin-preflight',
  );
}

function canaryError() {
  return new DevelopmentGateError('invalid_canary_result', 'canary');
}

function normalizeError(error) {
  if (error instanceof DevelopmentGateError) return error;
  const errno = isPlainObject(error) || error instanceof Error
    ? error.code
    : undefined;
  if (typeof errno === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(errno)) {
    return new DevelopmentGateError(
      `system_${errno.toLowerCase()}`,
      'internal',
    );
  }
  const diagnostic = error instanceof Error
    ? sanitizeDiagnostic(`${error.name}: ${error.message}`)
    : '';
  return new DevelopmentGateError(
    'unexpected_failure',
    'internal',
    diagnostic || 'unexpected_failure',
  );
}

export function publicError(error) {
  const normalized = normalizeError(error);
  const result = { code: normalized.code, stage: normalized.stage };
  const diagnostic = sanitizeDiagnostic(normalized.message);
  if (diagnostic && diagnostic !== normalized.code) {
    result.diagnostic = diagnostic;
  }
  return result;
}

function failureReport(mode, error, authorizationRequested) {
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    gate: 'macos-service-uid-development-fixture-v1',
    mode,
    result: 'failed',
    authorizationRequested,
    authorizationRequestCount: authorizationRequested ? 1 : 0,
    systemMutationsPerformed: false,
    systemMutationState: authorizationRequested ? 'unknown' : 'none-observed',
    systemTrustModified: false,
    residualState: 'unknown',
    error: publicError(error),
    scope: scopeDisclaimer(),
  };
}

export function administratorFailureResult(error) {
  const normalized = normalizeError(error);
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    action: 'admin-transaction',
    result: 'cleanup_incomplete',
    crashRecoveryVerified: false,
    systemMutationsPerformed: false,
    systemTrustModified: false,
    residualState: 'unknown',
    cleanup: {
      schemaVersion: GATE_SCHEMA_VERSION,
      action: 'admin-rollback',
      result: 'cleanup_incomplete',
      stagingEvidence: 'not_observed',
      serviceUidZeroProcesses: false,
      accountRemoved: false,
      fixedResourcesRemoved: false,
      errors: [normalized.code],
    },
    error: publicError(normalized),
  };
}

function emitReport(report) {
  let serialized = `${JSON.stringify(report)}\n`;
  if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) {
    serialized = `${JSON.stringify(failureReport(
      report?.mode ?? 'unknown',
      new DevelopmentGateError('report_too_large', 'report'),
      Boolean(report?.authorizationRequested),
    ))}\n`;
  }
  process.stdout.write(serialized);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) await main();
