import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import type { RuntimeCredential, RuntimeProvider } from '@roundtable/runtime';

const MAX_AUTH_FILE_BYTES = 128 * 1024;
const EXECUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}[A-Za-z0-9]$/u;

export type RuntimeSecretProvision = {
  homeDirectory: string;
  temporaryDirectory: string;
  hostHomeDirectory: string;
  credential?: RuntimeCredential;
  redactionSecrets: string[];
  cleanup(): Promise<void>;
};

type RuntimeSecretBrokerOptions = {
  stateRoot: string;
  sourceHome: string;
  environment?: Readonly<Record<string, string | undefined>> | undefined;
  readClaudeKeychain?: (() => Promise<string | null>) | undefined;
};

/**
 * Main-process-only broker. It projects a single provider credential into an
 * execution-specific private directory and never exposes values to Renderer.
 */
export class RuntimeSecretBroker {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #activeRoots = new Set<string>();
  #canonicalStateRoot: string | null = null;
  #canonicalSourceHome: string | null = null;

  constructor(private readonly options: RuntimeSecretBrokerOptions) {
    if (!isAbsolute(options.stateRoot) || !isAbsolute(options.sourceHome)) {
      throw new Error('runtime_secret_broker_invalid');
    }
    this.#environment = options.environment ?? process.env;
  }

  async isConfigured(provider: RuntimeProvider): Promise<boolean> {
    return (await this.#resolveCredential(provider)) !== undefined;
  }

  async provision(
    provider: RuntimeProvider,
    executionId: string,
  ): Promise<RuntimeSecretProvision> {
    if (!EXECUTION_ID_PATTERN.test(executionId)) {
      throw new Error('runtime_secret_broker_invalid');
    }
    const [stateRoot, hostHomeDirectory] = await Promise.all([
      this.#prepareStateRoot(),
      this.#prepareSourceHome(),
    ]);
    const executionRoot = resolve(stateRoot, `execution-${executionId}-${randomUUID()}`);
    assertDirectChild(stateRoot, executionRoot);
    await mkdir(executionRoot, { mode: 0o700 });
    await chmod(executionRoot, 0o700);
    this.#activeRoots.add(executionRoot);

    let cleaned = false;
    let cleanupPromise: Promise<void> | null = null;
    const cleanup = async () => {
      if (cleaned) return;
      cleanupPromise ??= rm(executionRoot, { recursive: true, force: true }).then(() => {
        cleaned = true;
        this.#activeRoots.delete(executionRoot);
      }).catch((error: unknown) => {
        cleanupPromise = null;
        throw error;
      });
      await cleanupPromise;
    };

    try {
      const homeDirectory = join(executionRoot, 'home');
      const temporaryDirectory = join(executionRoot, 'tmp');
      await Promise.all([
        mkdir(homeDirectory, { mode: 0o700 }),
        mkdir(temporaryDirectory, { mode: 0o700 }),
      ]);
      const credential = await this.#resolveCredential(provider);
      if (!credential) throw new Error('runtime_provider_auth_missing');
      return {
        homeDirectory,
        temporaryDirectory,
        hostHomeDirectory,
        credential,
        redactionSecrets: [],
        cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    await Promise.all([...this.#activeRoots].map(async (executionRoot) => {
      try {
        await rm(executionRoot, { recursive: true, force: true });
        this.#activeRoots.delete(executionRoot);
      } catch (error) {
        failures.push(error);
      }
    }));
    if (failures.length > 0) throw new Error('runtime_secret_cleanup_failed');
  }

  async #prepareStateRoot(): Promise<string> {
    if (this.#canonicalStateRoot) return this.#canonicalStateRoot;
    await mkdir(this.options.stateRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.stateRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('runtime_secret_broker_invalid');
    }
    const canonical = await realpath(this.options.stateRoot);
    await chmod(canonical, 0o700);
    const verified = await lstat(canonical);
    const currentUid = process.getuid?.();
    if (
      !verified.isDirectory()
      || verified.isSymbolicLink()
      || verified.dev !== info.dev
      || verified.ino !== info.ino
      || (process.platform !== 'win32' && currentUid !== undefined
        && verified.uid !== currentUid)
    ) throw new Error('runtime_secret_broker_invalid');
    if (process.platform !== 'win32' && (verified.mode & 0o077) !== 0) {
      throw new Error('runtime_secret_broker_invalid');
    }
    this.#canonicalStateRoot = canonical;
    return canonical;
  }

  async #resolveCredential(provider: RuntimeProvider): Promise<RuntimeCredential | undefined> {
    const environmentCredential = selectedCredential(provider, this.#environment);
    if (environmentCredential) return environmentCredential;
    if (
      provider !== 'claude-code'
      || (process.platform !== 'darwin' && !this.options.readClaudeKeychain)
    ) return undefined;
    const value = await (this.options.readClaudeKeychain ?? readClaudeKeychainAccessToken)();
    return value ? { provider, kind: 'claude-code-oauth-token', value } : undefined;
  }

  async #prepareSourceHome(): Promise<string> {
    if (this.#canonicalSourceHome) return this.#canonicalSourceHome;
    const info = await lstat(this.options.sourceHome);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('runtime_secret_broker_invalid');
    }
    const canonical = await realpath(this.options.sourceHome);
    const verified = await lstat(canonical);
    const currentUid = process.getuid?.();
    if (
      !verified.isDirectory()
      || verified.isSymbolicLink()
      || verified.dev !== info.dev
      || verified.ino !== info.ino
      || (process.platform !== 'win32' && currentUid !== undefined
        && verified.uid !== currentUid)
    ) throw new Error('runtime_secret_broker_invalid');
    this.#canonicalSourceHome = canonical;
    return canonical;
  }

}

function selectedCredential(
  provider: RuntimeProvider,
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeCredential | undefined {
  if (provider === 'codex') {
    const value = validSecret(environment.OPENAI_API_KEY);
    return value ? { provider, kind: 'openai-api-key', value } : undefined;
  }
  if (provider === 'claude-code') {
    const choices = [
      ['CLAUDE_CODE_OAUTH_TOKEN', 'claude-code-oauth-token'],
      ['ANTHROPIC_AUTH_TOKEN', 'anthropic-auth-token'],
      ['ANTHROPIC_API_KEY', 'anthropic-api-key'],
    ] as const;
    for (const [name, kind] of choices) {
      const value = validSecret(environment[name]);
      if (value) return { provider, kind, value };
    }
    return undefined;
  }
  const openAi = validSecret(environment.OPENAI_API_KEY);
  if (openAi) return { provider, kind: 'openai-api-key', value: openAi };
  const anthropic = validSecret(environment.ANTHROPIC_API_KEY);
  return anthropic ? { provider, kind: 'anthropic-api-key', value: anthropic } : undefined;
}

function validSecret(value: string | undefined): string | null {
  return typeof value === 'string'
    && value.length >= 8
    && Buffer.byteLength(value, 'utf8') <= 16 * 1024
    && !/[\u0000\r\n]/u.test(value)
    ? value
    : null;
}

function assertDirectChild(parent: string, candidate: string): void {
  if (!candidate.startsWith(`${parent}${sep}`) || dirname(candidate) !== parent) {
    throw new Error('runtime_secret_broker_invalid');
  }
}

async function readClaudeKeychainAccessToken(): Promise<string | null> {
  const securityPath = '/usr/bin/security';
  try {
    const canonical = await realpath(securityPath);
    const info = await lstat(canonical);
    if (
      canonical !== securityPath
      || !info.isFile()
      || info.uid !== 0
      || (info.mode & 0o022) !== 0
      || (info.mode & 0o111) === 0
    ) return null;
  } catch {
    return null;
  }

  return new Promise((resolvePromise) => {
    let settled = false;
    let observedBytes = 0;
    const chunks: Buffer[] = [];
    const child = spawn(securityPath, [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, 2_000);
    timeout.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      observedBytes += chunk.byteLength;
      if (observedBytes > MAX_AUTH_FILE_BYTES) {
        child.kill('SIGKILL');
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', () => finish(null));
    child.once('close', (exitCode) => {
      if (exitCode !== 0) {
        finish(null);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(null);
        return;
      }
      const root = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
      const oauth = root?.claudeAiOauth;
      const oauthRecord = oauth && typeof oauth === 'object' && !Array.isArray(oauth)
        ? oauth as Record<string, unknown>
        : null;
      const token = validSecret(typeof oauthRecord?.accessToken === 'string'
        ? oauthRecord.accessToken
        : undefined);
      const expiresAt = oauthRecord?.expiresAt;
      finish(
        token
        && typeof expiresAt === 'number'
        && Number.isFinite(expiresAt)
        && expiresAt > Date.now() + 60_000
          ? token
          : null,
      );
    });

    function finish(value: string | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(value);
    }
  });
}
