import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';
import { trackProcessTree } from '@roundtable/runtime';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const smokeRoot = await mkdtemp(join(tmpdir(), 'roundtable-runtime-electron-smoke-'));
let child;
let childTree;

try {
  const binaryDirectory = join(smokeRoot, 'bin');
  const workspace = join(smokeRoot, 'workspace');
  const sourceHome = join(smokeRoot, 'source-home');
  await Promise.all([
    mkdir(binaryDirectory, { mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 }),
    mkdir(sourceHome, { mode: 0o700 }),
  ]);
  const fixture = join(
    repositoryRoot,
    'packages',
    'runtime',
    'tests',
    'fixtures',
    'runtime-fixture.mjs',
  );
  const fixtureExecutable = join(binaryDirectory, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await copyFile(fixture, fixtureExecutable);
  await chmod(fixtureExecutable, 0o755);

  child = spawn(electronPath, [
    join(appDirectory, 'scripts', 'runtime-electron-smoke-main.cjs'),
    smokeRoot,
  ], {
    cwd: appDirectory,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.pid) throw new Error('runtime_electron_smoke_spawn_failed');
  childTree = trackProcessTree(child.pid);
  if (!(await childTree.ready)) throw new Error('runtime_electron_smoke_tracking_failed');
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = `${output}${String(chunk)}`.slice(-16_000);
  });
  child.stderr.on('data', (chunk) => {
    output = `${output}${String(chunk)}`.slice(-16_000);
  });
  const [exitCode] = await withTimeout(once(child, 'exit'), 60_000);
  if (exitCode !== 0 || !output.includes('runtime_electron_smoke_ok')) {
    throw new Error(output.trim() || 'runtime_electron_smoke_failed');
  }
  process.stdout.write('runtime_electron_smoke_ok\n');
} catch (error) {
  const message = error instanceof Error ? error.message : 'runtime_electron_smoke_failed';
  process.stderr.write(`[runtime-electron-smoke] ${message.slice(-4_000)}\n`);
  process.exitCode = 1;
} finally {
  const treeTermination = await stopTrackedElectronTree(childTree, child);
  childTree?.dispose();
  if (treeTermination === 'failed') {
    process.stderr.write('[runtime-electron-smoke] runtime_process_tree_cleanup_failed\n');
    process.exitCode = 1;
  } else {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

async function stopTrackedElectronTree(tree, electronChild) {
  if (!tree) {
    if (!electronChild?.pid) return 'not-required';
    try {
      if (process.platform !== 'win32') process.kill(-electronChild.pid, 'SIGKILL');
      else electronChild.kill('SIGKILL');
    } catch {
      // A missing direct process is not proof that every descendant exited.
    }
    return 'failed';
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await tree.terminate({ terminateGraceMs: 1_000, killConfirmMs: 5_000 });
      if (result === 'confirmed') return result;
    } catch {
      // Retry with the same retained best-effort process tracker.
    }
    try {
      if (process.platform !== 'win32' && electronChild?.pid) {
        process.kill(-electronChild.pid, 'SIGKILL');
      } else if (electronChild?.pid) {
        electronChild.kill('SIGKILL');
      }
    } catch {
      // The tracker performs the authoritative confirmation on the next attempt.
    }
  }
  return 'failed';
}

function withTimeout(promise, timeoutMs) {
  let timeout;
  const timed = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('runtime_electron_smoke_timeout')), timeoutMs);
    timeout.unref();
  });
  return Promise.race([promise, timed]).finally(() => clearTimeout(timeout));
}
