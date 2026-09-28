import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { RuntimeError } from './errors.js';
import type { ExecutableFingerprint, RuntimeProvider } from './types.js';

const POSIX_SEARCH_DIRECTORIES = Object.freeze([
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]);

const MACOS_CODEX_APP_EXECUTABLE = '/Applications/Codex.app/Contents/Resources/codex';

export async function resolveProviderExecutable(
  provider: RuntimeProvider,
  additionalSearchDirectories: readonly string[] = [],
): Promise<ExecutableFingerprint> {
  const directories = validatedSearchDirectories([
    ...additionalSearchDirectories,
    ...defaultSearchDirectories(),
  ]);
  const candidates = directories.flatMap((directory) => (
    executableNames(provider).map((name) => join(directory, name))
  ));
  if (provider === 'codex' && process.platform === 'darwin') {
    candidates.push(MACOS_CODEX_APP_EXECUTABLE);
  }

  for (const candidate of candidates) {
    try {
      return await fingerprintExecutable(provider, candidate);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'executable_invalid') continue;
      if (isMissingFileError(error)) continue;
      throw error;
    }
  }
  throw new RuntimeError('executable_not_found');
}

export async function assertExecutableUnchanged(
  expected: ExecutableFingerprint,
): Promise<void> {
  try {
    const current = await fingerprintExecutable(expected.provider, expected.path);
    if (
      current.path !== expected.path
      || current.device !== expected.device
      || current.inode !== expected.inode
      || current.size !== expected.size
      || current.modifiedNanoseconds !== expected.modifiedNanoseconds
      || current.sha256 !== expected.sha256
    ) {
      throw new RuntimeError('executable_changed');
    }
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'executable_changed') throw error;
    throw new RuntimeError('executable_changed');
  }
}

export function executableDirectory(executable: ExecutableFingerprint): string {
  return dirname(executable.path);
}

async function fingerprintExecutable(
  provider: RuntimeProvider,
  candidate: string,
): Promise<ExecutableFingerprint> {
  if (!isAbsolute(candidate) || hasControlCharacters(candidate)) {
    throw new RuntimeError('executable_invalid');
  }
  await access(candidate, constants.X_OK);
  const canonicalPath = await realpath(candidate);
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > 512n * 1024n * 1024n) {
      throw new RuntimeError('executable_invalid');
    }
    if (process.platform !== 'win32' && (before.mode & 0o111n) === 0n) {
      throw new RuntimeError('executable_invalid');
    }
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk as Buffer);
    }
    const after = await handle.stat({ bigint: true });
    const afterCanonicalPath = await realpath(candidate);
    if (
      canonicalPath !== afterCanonicalPath
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
    ) {
      throw new RuntimeError('executable_invalid');
    }
    return {
      provider,
      path: canonicalPath,
      device: after.dev.toString(),
      inode: after.ino.toString(),
      size: after.size.toString(),
      modifiedNanoseconds: after.mtimeNs.toString(),
      sha256: digest.digest('hex'),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function executableNames(provider: RuntimeProvider): string[] {
  const name = provider === 'claude-code' ? 'claude' : provider;
  return process.platform === 'win32' ? [`${name}.exe`] : [name];
}

function defaultSearchDirectories(): readonly string[] {
  if (process.platform !== 'win32') return POSIX_SEARCH_DIRECTORIES;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return systemRoot ? [join(systemRoot, 'System32')] : [];
}

function validatedSearchDirectories(directories: readonly string[]): string[] {
  const result: string[] = [];
  for (const directory of directories) {
    if (!isAbsolute(directory) || hasControlCharacters(directory)) {
      throw new RuntimeError('executable_invalid');
    }
    if (!result.includes(directory)) result.push(directory);
  }
  return result;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code));
}
