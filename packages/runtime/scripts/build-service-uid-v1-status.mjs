import { createHash } from 'node:crypto';
import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('service-uid v1 status requires macOS');
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = join(scriptDirectory, '..', 'native', 'service-uid');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-dir');
if (outputIndex < 0 || !args[outputIndex + 1] || args.length !== 2) {
  throw new Error('usage: node build-service-uid-v1-status.mjs --output-dir DIRECTORY');
}
const outputDirectory = resolve(args[outputIndex + 1]);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const hardwareProbe = spawnSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' });
const hardwareArm64 = hardwareProbe.status === 0 && hardwareProbe.stdout.trim() === '1';
const targetArchitecture = hardwareArm64 ? 'arm64' : process.arch === 'x64' ? 'x86_64' : process.arch;

function compile(name, sources, extra = []) {
  const output = join(outputDirectory, name);
  const result = spawnSync('/usr/bin/clang', [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fblocks', '-mmacosx-version-min=13.0',
    '-arch', targetArchitecture, '-I', sourceDirectory,
    ...sources.map((source) => join(sourceDirectory, source)),
    ...extra, '-o', output,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`v1 status compile failed: ${result.stderr || result.stdout}`);
  return output;
}

const broker = compile('roundtable-service-uid-v1-status-broker', [
  'protocol-v1.c', 'response-v1.c', 'operation-response-v1.c', 'transport-v1.c', 'lifecycle-v1.c', 'broker-v1-core.c', 'service-v1-status.c',
], ['-framework', 'Security', '-framework', 'CoreFoundation']);
const client = compile('roundtable-service-uid-v1-status-client', [
  'protocol-v1.c', 'response-v1.c', 'client-v1-status.c',
]);
const operationClientSelftest = compile('roundtable-service-uid-v1-operation-client-selftest', [
  'protocol-v1.c', 'response-v1.c', 'transport-v1.c', 'operation-response-v1.c',
  'operation-client-v1.c', 'operation-client-v1-selftest.c',
]);
const protocolSelftest = compile('roundtable-service-uid-v1-protocol-selftest', [
  'protocol-v1.c', 'protocol-v1-selftest.c',
]);
const responseSelftest = compile('roundtable-service-uid-v1-response-selftest', [
  'response-v1.c', 'response-v1-selftest.c',
]);
const operationResponseSelftest = compile('roundtable-service-uid-v1-operation-response-selftest', [
  'protocol-v1.c', 'operation-response-v1.c', 'operation-response-v1-selftest.c',
]);
const transportSelftest = compile('roundtable-service-uid-v1-transport-selftest', [
  'protocol-v1.c', 'transport-v1.c', 'transport-v1-selftest.c',
]);
const lifecycleSelftest = compile('roundtable-service-uid-v1-lifecycle-selftest', [
  'lifecycle-v1.c', 'lifecycle-v1-selftest.c',
]);
const brokerCoreSelftest = compile('roundtable-service-uid-v1-broker-core-selftest', [
  'lifecycle-v1.c', 'broker-v1-core.c', 'broker-v1-core-selftest.c',
]);
for (const selftest of [protocolSelftest, responseSelftest, operationResponseSelftest, transportSelftest, lifecycleSelftest, brokerCoreSelftest, operationClientSelftest]) {
  const result = spawnSync(selftest, [], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`v1 status self-test failed: ${result.stderr || result.stdout}`);
}
await Promise.all([broker, client, operationClientSelftest, protocolSelftest, responseSelftest, transportSelftest, lifecycleSelftest, brokerCoreSelftest].map((path) => chmod(path, 0o755)));
const artifacts = {};
for (const path of [broker, client, operationClientSelftest, protocolSelftest, responseSelftest, operationResponseSelftest, transportSelftest, lifecycleSelftest, brokerCoreSelftest]) {
  const bytes = await readFile(path);
  artifacts[path.split('/').pop()] = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    architecture: targetArchitecture,
  };
}
await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  artifactSet: 'macos-service-uid-v1-status-uninstalled',
  contract: 'macos-service-uid-v1',
  phase4Gate: false,
  installed: false,
  architecture: targetArchitecture,
  artifacts,
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`[runtime:service-uid-v1-status] built uninstalled development status pair: ${outputDirectory}\n`);
