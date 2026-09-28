import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeSecretBroker } from '../src/secret-broker.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('runtime secret broker', () => {
  it('projects only the current Claude Keychain access token into a provider lease', async () => {
    const root = await temporaryRoot('claude-keychain');
    await mkdir(join(root, 'source-home'), { mode: 0o700 });
    const broker = new RuntimeSecretBroker({
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: {},
      readClaudeKeychain: async () => 'claude-keychain-access-token',
    });

    const lease = await broker.provision('claude-code', 'execution_claude_keychain_01');
    expect(lease.credential).toEqual({
      provider: 'claude-code',
      kind: 'claude-code-oauth-token',
      value: 'claude-keychain-access-token',
    });
    expect(lease.redactionSecrets).toEqual([]);
    await lease.cleanup();
  });

  it('selects one provider-scoped credential and removes its private lease', async () => {
    const root = await temporaryRoot('credential');
    await mkdir(join(root, 'source-home'), { mode: 0o700 });
    const broker = new RuntimeSecretBroker({
      stateRoot: join(root, 'state'),
      sourceHome: join(root, 'source-home'),
      environment: {
        ANTHROPIC_API_KEY: 'anthropic-api-key-value',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-token-value',
        AWS_SECRET_ACCESS_KEY: 'must-never-cross-the-broker',
      },
    });

    const lease = await broker.provision('claude-code', 'execution_secret_01');
    expect(lease.credential).toEqual({
      provider: 'claude-code',
      kind: 'anthropic-auth-token',
      value: 'anthropic-auth-token-value',
    });
    expect(lease.hostHomeDirectory).toBe(await realpath(join(root, 'source-home')));
    expect(JSON.stringify(lease)).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect((await stat(lease.homeDirectory)).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(lease.homeDirectory)).mode & 0o077).toBe(0);
    }

    const executionRoot = join(lease.homeDirectory, '..');
    await lease.cleanup();
    await expect(lstat(executionRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await lease.cleanup();
  });

  it('requires a scoped Codex API key and never projects the host login file', async () => {
    const root = await temporaryRoot('codex-login');
    const sourceHome = join(root, 'source-home');
    await mkdir(join(sourceHome, '.codex'), { recursive: true });
    const auth = JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: 'access-token-secret',
        refresh_token: 'refresh-token-secret',
      },
      last_refresh: '2026-08-23T00:00:00.000Z',
    });
    await writeFile(join(sourceHome, '.codex', 'auth.json'), auth, 'utf8');
    const broker = new RuntimeSecretBroker({
      stateRoot: join(root, 'state'),
      sourceHome,
      environment: { OPENAI_API_KEY: 'fixture-codex-api-key' },
    });

    const lease = await broker.provision('codex', 'execution_codex_01');
    expect(lease.credential).toEqual({
      provider: 'codex',
      kind: 'openai-api-key',
      value: 'fixture-codex-api-key',
    });
    expect(lease.redactionSecrets).toEqual([]);
    const copiedPath = join(lease.homeDirectory, '.codex', 'auth.json');
    await expect(lstat(copiedPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await broker.dispose();
  });

  it('does not treat a host Codex login file as a Runtime credential', async () => {
    const root = await temporaryRoot('host-login-rejected');
    const sourceHome = join(root, 'source-home');
    await mkdir(join(sourceHome, '.codex'), { recursive: true });
    await writeFile(join(sourceHome, '.codex', 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'host-access-token-secret',
        refresh_token: 'host-refresh-token-secret',
      },
    }), 'utf8');
    const broker = new RuntimeSecretBroker({
      stateRoot: join(root, 'state'),
      sourceHome,
      environment: {},
    });

    await expect(broker.isConfigured('codex')).resolves.toBe(false);
    await expect(broker.provision('codex', 'execution_codex_02'))
      .rejects.toThrow('runtime_provider_auth_missing');
  });

  it.skipIf(process.platform === 'win32')(
    'retains a failed cleanup lease so dispose can retry it',
    async () => {
      const root = await temporaryRoot('cleanup-retry');
      const sourceHome = join(root, 'source-home');
      const stateRoot = join(root, 'state');
      await mkdir(sourceHome, { mode: 0o700 });
      const broker = new RuntimeSecretBroker({
        stateRoot,
        sourceHome,
        environment: { OPENAI_API_KEY: 'fixture-provider-secret' },
      });
      const lease = await broker.provision('codex', 'execution_cleanup_retry_01');
      const executionRoot = join(lease.homeDirectory, '..');

      await chmod(stateRoot, 0o500);
      await expect(lease.cleanup()).rejects.toBeDefined();
      expect((await lstat(executionRoot)).isDirectory()).toBe(true);

      await chmod(stateRoot, 0o700);
      await expect(broker.dispose()).resolves.toBeUndefined();
      await expect(lstat(executionRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lease.cleanup()).resolves.toBeUndefined();
    },
  );
});

async function temporaryRoot(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `roundtable-broker-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}
