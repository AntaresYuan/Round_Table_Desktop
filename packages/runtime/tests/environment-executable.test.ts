import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareRuntimeEnvironment } from '../src/environment.js';
import { assertExecutableUnchanged, resolveProviderExecutable } from '../src/executable.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.ROUNDTABLE_RUNTIME_CANARY_SECRET;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-runtime-'));
  temporaryDirectories.push(root);
  return root;
}

describe('runtime executable and environment boundaries', () => {
  it('resolves a fixed provider binary to a fingerprint and rejects replacement', async () => {
    const root = await temporaryRoot();
    const binary = join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
    await writeFile(binary, '#!/usr/bin/env node\n', { mode: 0o755 });
    if (process.platform !== 'win32') await chmod(binary, 0o755);

    const fingerprint = await resolveProviderExecutable('codex', [root]);
    expect(fingerprint.path).toBe(await realpath(binary));
    await expect(assertExecutableUnchanged(fingerprint)).resolves.toBeUndefined();

    await writeFile(binary, '#!/usr/bin/env node\n// replaced\n', 'utf8');
    await expect(assertExecutableUnchanged(fingerprint)).rejects.toThrow('executable_changed');
  });

  it('constructs env from an allowlist and only injects the selected provider secret', async () => {
    const root = await temporaryRoot();
    const home = join(root, 'home');
    const temporary = join(root, 'tmp');
    await mkdir(home, { mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    process.env.ROUNDTABLE_RUNTIME_CANARY_SECRET = 'must-not-cross-boundary';

    const prepared = await prepareRuntimeEnvironment(
      'codex',
      {
        provider: 'codex',
        path: process.execPath,
        device: '1',
        inode: '2',
        size: '3',
        modifiedNanoseconds: '4',
        sha256: '5',
      },
      {
        hostHomeDirectory: homedir(),
        homeDirectory: home,
        temporaryDirectory: temporary,
        redactionSecrets: [
          'auth-file-access-token',
          'auth-file-access-token',
          'auth-file-refresh-token',
        ],
        credential: {
          provider: 'codex',
          kind: 'openai-api-key',
          value: 'sk-test-runtime-secret',
        },
      },
      {},
    );

    expect(prepared.env.OPENAI_API_KEY).toBe('sk-test-runtime-secret');
    expect(prepared.env.ROUNDTABLE_RUNTIME_CANARY_SECRET).toBeUndefined();
    expect(prepared.env.NODE_OPTIONS).toBeUndefined();
    expect(prepared.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(Object.values(prepared.env)).not.toContain('auth-file-access-token');
    expect(Object.values(prepared.env)).not.toContain('auth-file-refresh-token');
    expect(prepared.secrets).toEqual([
      'auth-file-access-token',
      'auth-file-refresh-token',
      'sk-test-runtime-secret',
    ]);
  });

  it('rejects unbounded or malformed redaction-only secrets', async () => {
    const root = await temporaryRoot();
    const home = join(root, 'home');
    const temporary = join(root, 'tmp');
    await mkdir(home, { mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    const executable = {
      provider: 'codex' as const,
      path: process.execPath,
      device: '1',
      inode: '2',
      size: '3',
      modifiedNanoseconds: '4',
      sha256: '5',
    };

    await expect(prepareRuntimeEnvironment(
      'codex',
      executable,
      {
        hostHomeDirectory: homedir(),
        homeDirectory: home,
        temporaryDirectory: temporary,
        redactionSecrets: Array.from({ length: 33 }, (_, index) => `secret-value-${index}`),
      },
      {},
    )).rejects.toThrow('provider_credential_invalid');
  });
});
