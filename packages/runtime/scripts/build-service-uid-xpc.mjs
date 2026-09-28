import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { arch as hostNodeArch } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, '..');
const sourceDirectory = join(packageDirectory, 'native', 'service-uid');
const BOOTSTRAP_PROBE_CONTRACT = 'bootstrap-probe-v0';
const BOOTSTRAP_PROBE_MACH_SERVICE =
  'com.roundtable.runtime.service-uid-bootstrap-probe-v0';
const BROKER_IDENTIFIER =
  'com.roundtable.desktop.service-uid-bootstrap-probe-v0-broker';
const CLIENT_IDENTIFIER =
  'com.roundtable.desktop.service-uid-bootstrap-probe-v0-client';
const ISOLATION_CANARY_IDENTIFIER = 'com.roundtable.desktop.service-uid-isolation-canary';
const MODES = new Set([
  'development-adhoc',
  'development-adhoc-pinned',
  'development-signed',
  'production',
]);

if (process.platform !== 'darwin') {
  throw new Error('service-uid bootstrap-probe-v0 binaries can only be built on macOS');
}

const options = parseArguments(process.argv.slice(2));
await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
const outputInfo = await stat(options.outputDirectory);
if (!outputInfo.isDirectory()) throw new Error('output directory is not a directory');

const suffix = `${process.pid}-${randomUUID()}`;
const outputs = {
  bootstrapProbeBroker: join(
    options.outputDirectory,
    'roundtable-service-uid-bootstrap-probe-v0-broker',
  ),
  bootstrapProbeClient: join(
    options.outputDirectory,
    'roundtable-service-uid-bootstrap-probe-v0-client',
  ),
  ...(options.mode === 'development-adhoc-pinned' ? {
    bootstrapProbeWrongClient: join(
      options.outputDirectory,
      'roundtable-service-uid-bootstrap-probe-v0-wrong-client',
    ),
  } : {}),
  bootstrapProbeSelftest: join(
    options.outputDirectory,
    'roundtable-service-uid-bootstrap-probe-v0-selftest',
  ),
  isolationCanary: join(options.outputDirectory, 'roundtable-service-uid-isolation-canary'),
  isolationCanarySelftest: join(
    options.outputDirectory,
    'roundtable-service-uid-isolation-canary-selftest',
  ),
};
const temporaryOutputs = Object.fromEntries(
  Object.entries(outputs).map(([name, path]) => [name, `${path}.tmp-${suffix}`]),
);

try {
  compile([
    join(sourceDirectory, 'protocol.c'),
    join(sourceDirectory, 'protocol-selftest.c'),
  ], temporaryOutputs.bootstrapProbeSelftest, []);
  const selftest = run(temporaryOutputs.bootstrapProbeSelftest, []);
  if (
    selftest.status !== 0
    || selftest.stdout
      !== 'service-uid-bootstrap-probe-v0 self-test ok (not a Phase 4 gate)\n'
    || selftest.stderr !== ''
  ) {
    throw new Error(
      `bootstrap-probe-v0 self-test failed: ${selftest.stderr}${selftest.stdout}`,
    );
  }
  compile([
    join(sourceDirectory, 'isolation-canary-input.c'),
    join(sourceDirectory, 'isolation-canary-selftest.c'),
  ], temporaryOutputs.isolationCanarySelftest, []);
  const canarySelftest = run(temporaryOutputs.isolationCanarySelftest, []);
  if (
    canarySelftest.status !== 0
    || canarySelftest.stdout !== 'service-uid-isolation-canary-v1 self-test ok\n'
    || canarySelftest.stderr !== ''
  ) {
    throw new Error(
      `isolation canary self-test failed: ${canarySelftest.stderr}${canarySelftest.stdout}`,
    );
  }

  compile([
    join(sourceDirectory, 'isolation-canary-input.c'),
    join(sourceDirectory, 'isolation-canary.c'),
  ], temporaryOutputs.isolationCanary, []);
  compile([
    join(sourceDirectory, 'protocol.c'),
    join(sourceDirectory, 'client.c'),
  ], temporaryOutputs.bootstrapProbeClient, [
    cStringDefinition(
      'RT_SERVICE_UID_BOOTSTRAP_PROBE_ACCEPTED_PEER_REQUIREMENT',
      options.clientRequirement,
    ),
    cStringDefinition('RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE', options.mode),
    `-DRT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD=${
      options.mode === 'production' ? '1' : '0'
    }`,
    `-DRT_SERVICE_UID_BOOTSTRAP_PROBE_PINNED_ADHOC_BUILD=${
      options.mode === 'development-adhoc-pinned' ? '1' : '0'
    }`,
    '-framework',
    'Security',
    '-framework',
    'CoreFoundation',
  ]);
  if (options.mode === 'development-adhoc-pinned') {
    compile([
      join(sourceDirectory, 'protocol.c'),
      join(sourceDirectory, 'client.c'),
    ], temporaryOutputs.bootstrapProbeWrongClient, [
      cStringDefinition(
        'RT_SERVICE_UID_BOOTSTRAP_PROBE_ACCEPTED_PEER_REQUIREMENT',
        options.clientRequirement,
      ),
      cStringDefinition(
        'RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE',
        options.mode,
      ),
      '-DRT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD=0',
      '-DRT_SERVICE_UID_BOOTSTRAP_PROBE_PINNED_ADHOC_BUILD=1',
      '-DRT_SERVICE_UID_BOOTSTRAP_PROBE_WRONG_FIXTURE=1',
      '-framework',
      'Security',
      '-framework',
      'CoreFoundation',
    ]);
  }

  compile([
    join(sourceDirectory, 'protocol.c'),
    join(sourceDirectory, 'broker.c'),
  ], temporaryOutputs.bootstrapProbeBroker, [
    cStringDefinition(
      'RT_SERVICE_UID_BOOTSTRAP_PROBE_ACCEPTED_PEER_REQUIREMENT',
      options.brokerRequirement,
    ),
    cStringDefinition('RT_SERVICE_UID_BOOTSTRAP_PROBE_SECURITY_MODE', options.mode),
    `-DRT_SERVICE_UID_BOOTSTRAP_PROBE_PRODUCTION_BUILD=${
      options.mode === 'production' ? '1' : '0'
    }`,
    `-DRT_SERVICE_UID_BOOTSTRAP_PROBE_PINNED_ADHOC_BUILD=${
      options.mode === 'development-adhoc-pinned' ? '1' : '0'
    }`,
    '-framework',
    'Security',
    '-framework',
    'CoreFoundation',
  ]);

  await Promise.all(Object.values(temporaryOutputs).map((path) => chmod(path, 0o755)));
  sign(
    temporaryOutputs.bootstrapProbeBroker,
    options.signingIdentity,
    BROKER_IDENTIFIER,
    options.keychain,
  );
  if (options.mode === 'development-adhoc-pinned') {
    sign(
      temporaryOutputs.bootstrapProbeWrongClient,
      options.signingIdentity,
      CLIENT_IDENTIFIER,
      options.keychain,
    );
  }
  sign(
    temporaryOutputs.bootstrapProbeClient,
    options.signingIdentity,
    CLIENT_IDENTIFIER,
    options.keychain,
  );
  sign(
    temporaryOutputs.isolationCanary,
    options.signingIdentity,
    ISOLATION_CANARY_IDENTIFIER,
    options.keychain,
  );
  verifySignature(
    temporaryOutputs.bootstrapProbeBroker,
    BROKER_IDENTIFIER,
    ownCodeRequirement(BROKER_IDENTIFIER, options),
    options,
  );
  if (options.mode === 'development-adhoc-pinned') {
    verifySignature(
      temporaryOutputs.bootstrapProbeWrongClient,
      CLIENT_IDENTIFIER,
      ownCodeRequirement(CLIENT_IDENTIFIER, options),
      options,
    );
  }
  verifySignature(
    temporaryOutputs.isolationCanary,
    ISOLATION_CANARY_IDENTIFIER,
    ownCodeRequirement(ISOLATION_CANARY_IDENTIFIER, options),
    options,
  );
  verifySignature(
    temporaryOutputs.bootstrapProbeClient,
    CLIENT_IDENTIFIER,
    ownCodeRequirement(CLIENT_IDENTIFIER, options),
    options,
  );
  const brokerCodeDirectoryHash = codeDirectoryHash(
    temporaryOutputs.bootstrapProbeBroker,
  );
  const clientCodeDirectoryHash = codeDirectoryHash(
    temporaryOutputs.bootstrapProbeClient,
  );
  const brokerRequirement = options.mode === 'development-adhoc-pinned'
    ? pinnedCodeRequirement(CLIENT_IDENTIFIER, clientCodeDirectoryHash)
    : options.brokerRequirement;
  const clientRequirement = options.mode === 'development-adhoc-pinned'
    ? pinnedCodeRequirement(BROKER_IDENTIFIER, brokerCodeDirectoryHash)
    : options.clientRequirement;
  if (options.mode === 'development-adhoc-pinned') {
    verifyRequirement(
      temporaryOutputs.bootstrapProbeClient,
      brokerRequirement,
    );
    verifyRequirement(
      temporaryOutputs.bootstrapProbeBroker,
      clientRequirement,
    );
    const wrongClientMatch = run(
      '/usr/bin/codesign',
      [
        '--verify',
        '--strict',
        `-R=${brokerRequirement}`,
        temporaryOutputs.bootstrapProbeWrongClient,
      ],
    );
    if (wrongClientMatch.status === 0) {
      throw new Error('wrong-CDHash client unexpectedly matches pinned requirement');
    }
  }

  const nonPrivilegedArguments = options.mode === 'production'
    ? []
    : options.mode === 'development-adhoc-pinned'
      ? [
        '--allowed-client-euid',
        '501',
        '--accepted-client-cdhash',
        clientCodeDirectoryHash,
      ]
      : ['--allowed-client-euid', '501'];
  const nonPrivileged = run(
    temporaryOutputs.bootstrapProbeBroker,
    nonPrivilegedArguments,
  );
  if (
    nonPrivileged.status !== 77
    || nonPrivileged.stdout !== ''
    || nonPrivileged.stderr
      !== 'service-uid-bootstrap-probe-v0-broker: privileged launch context required\n'
  ) throw new Error('bootstrap-probe-v0 privilege smoke test failed');

  for (const name of Object.keys(outputs)) {
    await rename(temporaryOutputs[name], outputs[name]);
  }
  const manifest = {
    manifestSchemaVersion: 1,
    artifactSet: BOOTSTRAP_PROBE_CONTRACT,
    probeVersion: 0,
    phase4Gate: false,
    implementsMacOsServiceUidV1: false,
    supportedProbeOperations: ['ping', 'status'],
    mode: options.mode,
    architecture: options.architecture,
    machService: BOOTSTRAP_PROBE_MACH_SERVICE,
    brokerIdentifier: BROKER_IDENTIFIER,
    clientIdentifier: CLIENT_IDENTIFIER,
    isolationCanaryIdentifier: ISOLATION_CANARY_IDENTIFIER,
    teamIdentifier: options.teamIdentifier,
    brokerCodeDirectoryHash,
    clientCodeDirectoryHash,
    brokerAcceptsClientRequirement: brokerRequirement,
    clientAcceptsBrokerRequirement: clientRequirement,
    artifacts: Object.fromEntries(await Promise.all(
      Object.entries(outputs).map(async ([name, path]) => {
        const bytes = await readFile(path);
        return [name, {
          name: path.slice(path.lastIndexOf('/') + 1),
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }];
      }),
    )),
  };
  await writeFile(
    join(options.outputDirectory, 'service-uid-bootstrap-probe-v0-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  process.stdout.write(
    `[runtime:${BOOTSTRAP_PROBE_CONTRACT}] built ${options.mode} ${options.architecture}; not a Phase 4 gate\n`,
  );
} finally {
  await Promise.all(Object.values(temporaryOutputs).map((path) => rm(path, { force: true })));
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) {
      throw new Error('invalid build arguments');
    }
    values.set(key, value);
  }
  const known = new Set([
    '--mode',
    '--output-dir',
    '--arch',
    '--signing-identity',
    '--team-identifier',
    '--keychain',
    '--broker-accepts-client-requirement',
    '--client-accepts-broker-requirement',
  ]);
  if ([...values.keys()].some((key) => !known.has(key))) {
    throw new Error('unknown build argument');
  }
  const mode = values.get('--mode');
  const outputDirectory = values.get('--output-dir');
  if (!MODES.has(mode) || !outputDirectory || !isAbsolute(outputDirectory)) {
    throw new Error('mode and absolute output directory are required');
  }
  const architecture = normalizeArchitecture(values.get('--arch') ?? hostArchitecture());
  const production = mode === 'production';
  const signedDevelopment = mode === 'development-signed';
  const pinnedAdhocDevelopment = mode === 'development-adhoc-pinned';
  const teamIdentifier = production
    ? requiredTeamIdentifier(values.get('--team-identifier'))
    : null;
  if (!production && values.has('--team-identifier')) {
    throw new Error('team identifier is accepted only in production mode');
  }
  const signingIdentity = production || signedDevelopment
    ? requiredSigningIdentity(values.get('--signing-identity'))
    : '-';
  const brokerRequirement = pinnedAdhocDevelopment
    ? `identifier "${CLIENT_IDENTIFIER}"`
    : production || signedDevelopment
    ? requiredRequirement(
      values.get('--broker-accepts-client-requirement'),
      CLIENT_IDENTIFIER,
      mode,
      teamIdentifier,
    )
    : `identifier "${CLIENT_IDENTIFIER}"`;
  const clientRequirement = pinnedAdhocDevelopment
    ? `identifier "${BROKER_IDENTIFIER}"`
    : production || signedDevelopment
    ? requiredRequirement(
      values.get('--client-accepts-broker-requirement'),
      BROKER_IDENTIFIER,
      mode,
      teamIdentifier,
    )
    : `identifier "${BROKER_IDENTIFIER}"`;
  if (
    signedDevelopment
    && extractDevelopmentLeafCertificateHash(brokerRequirement)
      !== extractDevelopmentLeafCertificateHash(clientRequirement)
  ) {
    throw new Error('development peers must bind the same test certificate');
  }
  if (pinnedAdhocDevelopment && [
    '--signing-identity',
    '--keychain',
    '--broker-accepts-client-requirement',
    '--client-accepts-broker-requirement',
  ].some((key) => values.has(key))) {
    throw new Error(
      'development-adhoc-pinned computes its signing identity and peer requirements',
    );
  }
  const keychain = values.get('--keychain');
  if (keychain !== undefined && (!isAbsolute(keychain) || hasControl(keychain))) {
    throw new Error('keychain must be an absolute path');
  }
  return {
    mode,
    outputDirectory,
    architecture,
    signingIdentity,
    teamIdentifier,
    brokerRequirement,
    clientRequirement,
    keychain,
  };
}

function hostArchitecture() {
  // `uname -m` inherits Rosetta translation and can report x86_64 on Apple
  // silicon when this script is launched by an x64 Node binary.  The broker
  // and client are native OS integration binaries, so prefer the hardware
  // capability probe before consulting the current process architecture.
  const appleSilicon = spawnSync(
    '/usr/sbin/sysctl',
    ['-n', 'hw.optional.arm64'],
    { encoding: 'utf8' },
  );
  if (appleSilicon.status === 0 && appleSilicon.stdout.trim() === '1') {
    return 'arm64';
  }
  const result = spawnSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' });
  if (result.status === 0) return result.stdout.trim();
  return hostNodeArch();
}

function normalizeArchitecture(value) {
  if (value === 'arm64') return 'arm64';
  if (value === 'x64' || value === 'x86_64') return 'x86_64';
  throw new Error('architecture must be arm64 or x86_64');
}

function requiredBounded(value, label) {
  if (!value || value.length > 4096 || hasControl(value)) {
    throw new Error(`${label} is required and must be bounded`);
  }
  return value;
}

function requiredSigningIdentity(value) {
  const identity = requiredBounded(value, 'signing identity');
  if (identity === '-' || /^adhoc$/iu.test(identity)) {
    throw new Error('signed build modes require a non-ad-hoc signing identity');
  }
  return identity;
}

function requiredTeamIdentifier(value) {
  const teamIdentifier = requiredBounded(value, 'team identifier');
  if (!/^[A-Z0-9]{10}$/u.test(teamIdentifier)) {
    throw new Error('team identifier must be exactly 10 uppercase alphanumeric characters');
  }
  return teamIdentifier;
}

function requiredRequirement(value, identifier, mode, teamIdentifier) {
  const requirement = requiredBounded(value, 'peer code-signing requirement');
  if (mode === 'production') {
    const expected = productionRequirement(identifier, teamIdentifier);
    if (requirement !== expected) {
      throw new Error(`production peer requirement must exactly equal: ${expected}`);
    }
    return requirement;
  }

  const escapedIdentifier = escapeRegExp(identifier);
  const developmentPattern = new RegExp(
    `^identifier "${escapedIdentifier}" and certificate leaf = H"[A-Fa-f0-9]{40}"$`,
    'u',
  );
  if (!developmentPattern.test(requirement)) {
    throw new Error(
      `development-signed peer requirement must exactly bind ${identifier} and one leaf certificate hash`,
    );
  }
  return requirement;
}

function productionRequirement(identifier, teamIdentifier) {
  return `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`;
}

function ownCodeRequirement(identifier, optionsValue) {
  if (optionsValue.mode === 'production') {
    return productionRequirement(identifier, optionsValue.teamIdentifier);
  }
  if (optionsValue.mode === 'development-signed') {
    const certificateHash = extractDevelopmentLeafCertificateHash(
      optionsValue.brokerRequirement,
    );
    return `identifier "${identifier}" and certificate leaf = H"${certificateHash}"`;
  }
  return `identifier "${identifier}"`;
}

function pinnedCodeRequirement(identifier, cdhash) {
  if (!/^[a-f0-9]{40}$/iu.test(cdhash)) {
    throw new Error('ad-hoc Code Directory hash must contain 40 hexadecimal characters');
  }
  return `identifier "${identifier}" and cdhash H"${cdhash.toUpperCase()}"`;
}

function codeDirectoryHash(path) {
  const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const description = `${details.stdout}${details.stderr}`;
  const match = /(?:^|\n)CDHash=([A-Fa-f0-9]{40})(?:\n|$)/u.exec(description);
  if (details.error || details.status !== 0 || !match) {
    throw details.error ?? new Error('signed artifact Code Directory hash missing');
  }
  return match[1].toLowerCase();
}

function verifyRequirement(path, requirement) {
  const result = spawnSync('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--verbose=2',
    `-R=${requirement}`,
    path,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`code requirement verification failed: ${result.stderr}`);
  }
}

function extractDevelopmentLeafCertificateHash(requirement) {
  const match = / certificate leaf = H"([A-Fa-f0-9]{40})"$/u.exec(requirement);
  if (!match) throw new Error('development leaf certificate hash missing');
  return match[1];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function cStringDefinition(name, value) {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `-D${name}=\"${escaped}\"`;
}

function compile(sources, output, extraArguments) {
  const result = spawnSync('/usr/bin/xcrun', [
    'clang',
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fblocks',
    '-mmacosx-version-min=13.0',
    '-arch',
    options.architecture,
    ...sources,
    '-o',
    output,
    ...extraArguments,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`native compilation failed: ${result.stderr}`);
  }
}

function sign(path, identity, identifier, keychain) {
  const args = [
    '--force',
    '--sign',
    identity,
    '--identifier',
    identifier,
    '--options',
    'runtime',
  ];
  if (keychain) args.push('--keychain', keychain);
  args.push(path);
  const result = spawnSync('/usr/bin/codesign', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`code signing failed: ${result.stderr}`);
  }
}

function verifySignature(path, identifier, requirement, optionsValue) {
  const result = spawnSync('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--verbose=2',
    `-R=${requirement}`,
    path,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`signature verification failed: ${result.stderr}`);
  }

  const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const description = `${details.stdout}${details.stderr}`;
  if (
    details.error
    || details.status !== 0
    || !description.includes(`Identifier=${identifier}\n`)
    || !/flags=0x[0-9a-f]+\([^\n]*runtime[^\n]*\)/iu.test(description)
  ) throw new Error('signed artifact identity or Hardened Runtime verification failed');
  if (optionsValue.mode === 'production' && (
    /Signature=adhoc/iu.test(description)
    || description.includes('TeamIdentifier=not set')
    || !description.includes(`TeamIdentifier=${optionsValue.teamIdentifier}\n`)
  )) throw new Error('production artifact is not signed by the configured Team ID');
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
}

function hasControl(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
