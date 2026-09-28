import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const index = process.argv.indexOf('--manifest');
if (index < 0 || !process.argv[index + 1] || process.argv.length !== 4) {
  throw new Error('usage: node verify-service-uid-v1-status-manifest.mjs --manifest FILE');
}
const manifestPath = resolve(process.argv[index + 1]);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1
  || manifest.artifactSet !== 'macos-service-uid-v1-status-uninstalled'
  || manifest.contract !== 'macos-service-uid-v1'
  || manifest.phase4Gate !== false
  || manifest.installed !== false
  || !['arm64', 'x86_64'].includes(manifest.architecture)
  || !manifest.artifacts || typeof manifest.artifacts !== 'object') {
  throw new Error('invalid v1 status manifest');
}
for (const [name, artifact] of Object.entries(manifest.artifacts)) {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)
    || !artifact || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    || artifact.architecture !== manifest.architecture) throw new Error('invalid v1 status artifact manifest');
  const path = join(dirname(manifestPath), name);
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error(`v1 status artifact hash mismatch: ${name}`);
  }
  const file = spawnSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' });
  if (file.status !== 0 || !file.stdout.includes(`Mach-O 64-bit executable ${manifest.architecture}`)) {
    throw new Error(`v1 status artifact architecture mismatch: ${name}`);
  }
}
process.stdout.write('service-uid-v1 status manifest verified (uninstalled, not a Phase 4 gate)\n');
