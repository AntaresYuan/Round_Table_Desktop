import { mkdir, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import { RuntimeError } from './errors.js';
import type {
  ExecutableFingerprint,
  RuntimeCredential,
  RuntimeEnvironmentPolicy,
  RuntimeProvider,
} from './types.js';

export type PreparedRuntimeEnvironment = {
  env: NodeJS.ProcessEnv;
  secrets: string[];
  hostHomeDirectory: string;
  homeDirectory: string;
  temporaryDirectory: string;
};

export async function prepareRuntimeEnvironment(
  provider: RuntimeProvider,
  executable: ExecutableFingerprint,
  policy: RuntimeEnvironmentPolicy,
  fixedEnvironment: Readonly<Record<string, string>>,
): Promise<PreparedRuntimeEnvironment> {
  const hostHomeDirectory = await validateHostHomeDirectory(policy.hostHomeDirectory);
  const homeDirectory = await preparePrivateDirectory(policy.homeDirectory);
  const temporaryDirectory = await preparePrivateDirectory(policy.temporaryDirectory);
  const env: NodeJS.ProcessEnv = {
    PATH: trustedPath(executable.path),
    HOME: homeDirectory,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
  };

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new RuntimeError('execution_invalid');
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
    env.ComSpec = join(systemRoot, 'System32', 'cmd.exe');
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    env.USERPROFILE = homeDirectory;
  }

  if (provider === 'opencode') {
    const requiredNames = [
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_PERMISSION',
      'OPENCODE_DISABLE_DEFAULT_PLUGINS',
      'OPENCODE_DISABLE_LSP_DOWNLOAD',
      'OPENCODE_DISABLE_CLAUDE_CODE',
      'OPENCODE_DISABLE_AUTOUPDATE',
      'OPENCODE_AUTO_SHARE',
    ] as const;
    if (
      Object.keys(fixedEnvironment).length !== requiredNames.length
      || requiredNames.some((name) => !fixedEnvironment[name])
    ) {
      throw new RuntimeError('execution_invalid');
    }
    for (const name of requiredNames) env[name] = fixedEnvironment[name];
    env.XDG_CONFIG_HOME = join(homeDirectory, '.config');
    env.XDG_CACHE_HOME = join(homeDirectory, '.cache');
    env.XDG_DATA_HOME = join(homeDirectory, '.local', 'share');
  } else if (Object.keys(fixedEnvironment).length > 0) {
    throw new RuntimeError('execution_invalid');
  }

  const secrets = mergeRedactionSecrets(
    validateRedactionSecrets(policy.redactionSecrets),
    applyCredential(env, provider, policy.credential),
  );
  if (hostHomeDirectory === homeDirectory) throw new RuntimeError('execution_invalid');
  return { env, secrets, hostHomeDirectory, homeDirectory, temporaryDirectory };
}

function applyCredential(
  env: NodeJS.ProcessEnv,
  provider: RuntimeProvider,
  credential: RuntimeCredential | undefined,
): string[] {
  if (!credential) return [];
  if (credential.provider !== provider || !isSafeSecret(credential.value)) {
    throw new RuntimeError('provider_credential_invalid');
  }

  if (credential.provider === 'codex') {
    env.OPENAI_API_KEY = credential.value;
  } else if (credential.provider === 'claude-code') {
    const name = {
      'anthropic-api-key': 'ANTHROPIC_API_KEY',
      'anthropic-auth-token': 'ANTHROPIC_AUTH_TOKEN',
      'claude-code-oauth-token': 'CLAUDE_CODE_OAUTH_TOKEN',
    }[credential.kind];
    env[name] = credential.value;
  } else {
    const name = credential.kind === 'openai-api-key'
      ? 'OPENAI_API_KEY'
      : 'ANTHROPIC_API_KEY';
    env[name] = credential.value;
  }
  return [credential.value];
}

async function preparePrivateDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory) || hasControlCharacters(directory)) {
    throw new RuntimeError('execution_invalid');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directory);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new RuntimeError('execution_invalid');
  if (process.platform !== 'win32' && (info.mode & 0o077n) !== 0n) {
    throw new RuntimeError('execution_invalid');
  }
  return canonical;
}

async function validateHostHomeDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory) || hasControlCharacters(directory)) {
    throw new RuntimeError('execution_invalid');
  }
  const canonical = await realpath(directory);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory() || canonical !== directory) {
    throw new RuntimeError('execution_invalid');
  }
  return canonical;
}

function trustedPath(executablePath: string): string {
  const directories = process.platform === 'win32'
    ? [dirname(executablePath), join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32')]
    : [dirname(executablePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set(directories)].join(delimiter);
}

function isSafeSecret(secret: string): boolean {
  return secret.length >= 8
    && Buffer.byteLength(secret, 'utf8') <= 16 * 1024
    && !/[\u0000\r\n]/u.test(secret);
}

function validateRedactionSecrets(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new RuntimeError('provider_credential_invalid');
  }
  const result: string[] = [];
  let totalBytes = 0;
  for (const secret of value) {
    if (typeof secret !== 'string' || !isSafeSecret(secret)) {
      throw new RuntimeError('provider_credential_invalid');
    }
    if (result.includes(secret)) continue;
    totalBytes += Buffer.byteLength(secret, 'utf8');
    if (totalBytes > 64 * 1024) throw new RuntimeError('provider_credential_invalid');
    result.push(secret);
  }
  return result;
}

function mergeRedactionSecrets(left: readonly string[], right: readonly string[]): string[] {
  const merged = [...new Set([...left, ...right])];
  const totalBytes = merged.reduce((total, secret) => (
    total + Buffer.byteLength(secret, 'utf8')
  ), 0);
  if (merged.length > 32 || totalBytes > 64 * 1024) {
    throw new RuntimeError('provider_credential_invalid');
  }
  return merged;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
