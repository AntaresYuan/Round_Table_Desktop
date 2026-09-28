import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const buildScript = fileURLToPath(
  new URL('../scripts/build-service-uid-xpc.mjs', import.meta.url),
);
const nativeDirectory = fileURLToPath(new URL('../native/service-uid/', import.meta.url));
const temporaryDirectories: string[] = [];
const teamIdentifier = 'ABCDE12345';
const brokerIdentifier = 'com.roundtable.desktop.service-uid-bootstrap-probe-v0-broker';
const clientIdentifier = 'com.roundtable.desktop.service-uid-bootstrap-probe-v0-client';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('service-UID native contract naming boundary', () => {
  it('keeps bootstrap-probe-v0 disjoint from the Phase 4 lifecycle contract', async () => {
    const [header, broker, client, buildSource, readme] = await Promise.all([
      readFile(join(nativeDirectory, 'protocol.h'), 'utf8'),
      readFile(join(nativeDirectory, 'broker.c'), 'utf8'),
      readFile(join(nativeDirectory, 'client.c'), 'utf8'),
      readFile(buildScript, 'utf8'),
      readFile(join(nativeDirectory, 'README.md'), 'utf8'),
    ]);

    expect(header).toContain('com.roundtable.runtime.service-uid-bootstrap-probe-v0');
    expect(header).toContain('RT_SERVICE_UID_BOOTSTRAP_PROBE_MACH_SERVICE');
    expect(header).toContain('RT_SERVICE_UID_BOOTSTRAP_PROBE_VERSION UINT64_C(0)');
    expect(header).not.toContain('#define RT_SERVICE_UID_MACH_SERVICE');
    expect(header).not.toContain('RT_SERVICE_UID_PROTOCOL_VERSION');
    expect(buildSource).toContain("artifactSet: BOOTSTRAP_PROBE_CONTRACT");
    expect(buildSource).toContain('phase4Gate: false');
    expect(buildSource).toContain('implementsMacOsServiceUidV1: false');
    expect(broker).toContain('production bootstrap probes do not accept identity via argv');
    expect(client).not.toContain('broker_asid == AU_DEFAUDITSID');
    expect(readme).toContain('Not a Phase 4 gate');
    expect(readme).toContain('do not implement `macos-service-uid-v1`');
  });
});

describe.skipIf(process.platform !== 'darwin')('service-UID bootstrap-probe-v0 build smoke', () => {
  it('builds a clearly non-gating development probe and ignores Rosetta process architecture', async () => {
    const outputDirectory = await temporaryOutput();
    const buildResult = await execFileAsync(process.execPath, [
      buildScript,
      '--mode',
      'development-adhoc',
      '--output-dir',
      outputDirectory,
    ], { timeout: 30_000 });

    const manifest = JSON.parse(await readFile(
      join(outputDirectory, 'service-uid-bootstrap-probe-v0-manifest.json'),
      'utf8',
    )) as {
      manifestSchemaVersion: number;
      artifactSet: string;
      probeVersion: number;
      phase4Gate: boolean;
      implementsMacOsServiceUidV1: boolean;
      supportedProbeOperations: string[];
      mode: string;
      architecture: string;
      machService: string;
      teamIdentifier: unknown;
      artifacts: Record<string, { name: string; sha256: string }>;
    };
    const expectedArchitecture = await nativeHardwareArchitecture();
    expect(buildResult.stderr).toBe('');
    expect(buildResult.stdout).toBe(
      `[runtime:bootstrap-probe-v0] built development-adhoc ${expectedArchitecture}; not a Phase 4 gate\n`,
    );
    expect(manifest).toMatchObject({
      manifestSchemaVersion: 1,
      artifactSet: 'bootstrap-probe-v0',
      probeVersion: 0,
      phase4Gate: false,
      implementsMacOsServiceUidV1: false,
      supportedProbeOperations: ['ping', 'status'],
      mode: 'development-adhoc',
      architecture: expectedArchitecture,
      machService: 'com.roundtable.runtime.service-uid-bootstrap-probe-v0',
      teamIdentifier: null,
    });
    expect(Object.keys(manifest.artifacts)).toEqual([
      'bootstrapProbeBroker',
      'bootstrapProbeClient',
      'bootstrapProbeSelftest',
      'isolationCanary',
      'isolationCanarySelftest',
    ]);
    expect(Object.values(manifest.artifacts).map(({ name }) => name)).toEqual([
      'roundtable-service-uid-bootstrap-probe-v0-broker',
      'roundtable-service-uid-bootstrap-probe-v0-client',
      'roundtable-service-uid-bootstrap-probe-v0-selftest',
      'roundtable-service-uid-isolation-canary',
      'roundtable-service-uid-isolation-canary-selftest',
    ]);
    for (const artifact of Object.values(manifest.artifacts)) {
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    const canary = join(outputDirectory, manifest.artifacts.isolationCanary.name);
    await expect(execFileAsync(canary, ['--invalid'], { timeout: 5_000 }))
      .rejects.toMatchObject({
        code: 64,
        stdout: '{"schemaVersion":1,"result":"invalid_invocation"}\n',
        stderr: '',
      });
    await expect(execFileAsync(canary, [
      '--roundtable-null-bootstrap-worker',
      '--invalid',
    ], { timeout: 5_000 })).rejects.toMatchObject({
      code: 66,
      stdout: '{"schemaVersion":1,"result":"invalid_bootstrap_context"}\n',
      stderr: '',
    });
  });

  it('pins both ad-hoc peers by exact CDHash and rejects a same-identifier fixture', async () => {
    const outputDirectory = await temporaryOutput();
    await execFileAsync(process.execPath, [
      buildScript,
      '--mode',
      'development-adhoc-pinned',
      '--output-dir',
      outputDirectory,
    ], { timeout: 30_000 });
    const manifest = JSON.parse(await readFile(
      join(outputDirectory, 'service-uid-bootstrap-probe-v0-manifest.json'),
      'utf8',
    )) as {
      mode: string;
      brokerCodeDirectoryHash: string;
      clientCodeDirectoryHash: string;
      brokerAcceptsClientRequirement: string;
      clientAcceptsBrokerRequirement: string;
      artifacts: Record<string, { name: string }>;
    };
    expect(manifest.mode).toBe('development-adhoc-pinned');
    expect(manifest.brokerCodeDirectoryHash).toMatch(/^[a-f0-9]{40}$/u);
    expect(manifest.clientCodeDirectoryHash).toMatch(/^[a-f0-9]{40}$/u);
    expect(manifest.brokerAcceptsClientRequirement).toBe(
      `identifier "${clientIdentifier}" and cdhash H"${manifest.clientCodeDirectoryHash.toUpperCase()}"`,
    );
    expect(manifest.clientAcceptsBrokerRequirement).toBe(
      `identifier "${brokerIdentifier}" and cdhash H"${manifest.brokerCodeDirectoryHash.toUpperCase()}"`,
    );
    const client = join(
      outputDirectory,
      manifest.artifacts.bootstrapProbeClient.name,
    );
    const wrongClient = join(
      outputDirectory,
      manifest.artifacts.bootstrapProbeWrongClient.name,
    );
    await expect(execFileAsync('/usr/bin/codesign', [
      '--verify',
      '--strict',
      `-R=${manifest.brokerAcceptsClientRequirement}`,
      client,
    ])).resolves.toBeDefined();
    await expect(execFileAsync('/usr/bin/codesign', [
      '--verify',
      '--strict',
      `-R=${manifest.brokerAcceptsClientRequirement}`,
      wrongClient,
    ])).rejects.toBeDefined();
  });

  it('rejects an ad-hoc identity in production before compiling', async () => {
    const outputDirectory = await temporaryOutput();
    await expect(build([
      '--mode',
      'production',
      '--output-dir',
      outputDirectory,
      '--signing-identity',
      '-',
      '--team-identifier',
      teamIdentifier,
      '--broker-accepts-client-requirement',
      productionRequirement(clientIdentifier),
      '--client-accepts-broker-requirement',
      productionRequirement(brokerIdentifier),
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('non-ad-hoc signing identity'),
    });
  });

  it('rejects boolean requirement injection in production before signing', async () => {
    const outputDirectory = await temporaryOutput();
    const weakClient = `identifier "${clientIdentifier}" or (anchor apple generic and certificate leaf[subject.OU] = "NOTATEAM")`;
    const weakBroker = `identifier "${brokerIdentifier}" or (anchor apple generic and certificate leaf[subject.OU] = "NOTATEAM")`;
    await expect(build([
      '--mode',
      'production',
      '--output-dir',
      outputDirectory,
      '--signing-identity',
      'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      '--team-identifier',
      teamIdentifier,
      '--broker-accepts-client-requirement',
      weakClient,
      '--client-accepts-broker-requirement',
      weakBroker,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('must exactly equal'),
    });
  });

  it('rejects a development requirement that is not one exact certificate binding', async () => {
    const outputDirectory = await temporaryOutput();
    await expect(build([
      '--mode',
      'development-signed',
      '--output-dir',
      outputDirectory,
      '--signing-identity',
      'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      '--broker-accepts-client-requirement',
      `identifier "${clientIdentifier}" or true`,
      '--client-accepts-broker-requirement',
      `identifier "${brokerIdentifier}" or true`,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('must exactly bind'),
    });
  });
});

async function temporaryOutput(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'roundtable-service-uid-build-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function build(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [buildScript, ...args], {
    timeout: 30_000,
  });
}

function productionRequirement(identifier: string): string {
  return `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`;
}

async function nativeHardwareArchitecture(): Promise<'arm64' | 'x86_64'> {
  const result = await execFileAsync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']);
  return result.stdout.trim() === '1' ? 'arm64' : 'x86_64';
}
