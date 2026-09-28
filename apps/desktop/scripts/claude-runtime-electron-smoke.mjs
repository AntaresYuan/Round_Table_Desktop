import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';
import { trackProcessTree } from '@roundtable/runtime';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
const smokeRoot = await mkdtemp(join(tmpdir(), 'roundtable-claude-runtime-smoke-'));
let child;
let childTree;
let networkCanary;

try {
  const workspaceRoot = join(smokeRoot, 'workspace');
  const outsideRoot = join(smokeRoot, 'outside-workspace');
  await Promise.all([
    mkdir(workspaceRoot, { mode: 0o700 }),
    mkdir(outsideRoot, { mode: 0o700 }),
  ]);
  const control = {
    workspaceMarker: `roundtable-claude-write-${randomUUID()}`,
    externalSentinel: `roundtable-claude-external-${randomUUID()}`,
    externalWriteAttempt: `roundtable-claude-external-write-${randomUUID()}`,
    networkResponse: `roundtable-claude-network-${randomUUID()}`,
  };
  networkCanary = await startLoopbackCanary(control.networkResponse);
  control.networkUrl = networkCanary.url;
  await Promise.all([
    writeFile(join(outsideRoot, 'sentinel.txt'), `${control.externalSentinel}\n`, { mode: 0o600 }),
    writeFile(join(smokeRoot, 'control.json'), `${JSON.stringify(control)}\n`, { mode: 0o600 }),
    initializeGitRepository(workspaceRoot),
  ]);

  child = spawn(electronPath, [
    join(appDirectory, 'scripts', 'claude-runtime-electron-smoke-main.cjs'),
    smokeRoot,
  ], {
    cwd: appDirectory,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.pid) throw new Error('claude_runtime_electron_spawn_failed');
  childTree = trackProcessTree(child.pid);
  if (!(await childTree.ready)) throw new Error('claude_runtime_electron_tracking_failed');
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = `${output}${String(chunk)}`.slice(-16_000);
  });
  child.stderr.on('data', (chunk) => {
    output = `${output}${String(chunk)}`.slice(-16_000);
  });
  const [exitCode] = await withTimeout(once(child, 'exit'), 240_000);
  if (exitCode !== 0 || !output.includes('claude_runtime_electron_smoke_ok')) {
    throw new Error(stableOutput(output) || 'claude_runtime_electron_smoke_failed');
  }
  const [externalWriteExists, externalWriteResult, networkResult] = await Promise.all([
    pathExists(join(outsideRoot, 'write-canary.txt')),
    readOptional(join(workspaceRoot, 'external-write-result.txt')),
    readOptional(join(workspaceRoot, 'network-result.txt')),
  ]);
  if (externalWriteExists) throw new Error('claude_external_write_containment_failed');
  if (externalWriteResult?.trim() !== 'BLOCKED') {
    throw new Error('claude_external_write_containment_inconclusive');
  }
  assertNetworkObservation({
    observedHit: networkCanary.observedHit(),
    reportedResult: networkResult?.trim() ?? null,
    response: control.networkResponse,
  });
  process.stdout.write('claude_runtime_electron_smoke_ok\n');
} catch (error) {
  const message = error instanceof Error ? error.message : 'claude_runtime_electron_smoke_failed';
  process.stderr.write(`[claude-runtime-smoke] ${message.slice(-4_000)}\n`);
  process.exitCode = 1;
} finally {
  const treeTermination = await stopTrackedElectronTree(childTree, child);
  childTree?.dispose();
  if (treeTermination === 'failed') {
    process.stderr.write('[claude-runtime-smoke] claude_runtime_process_tree_cleanup_failed\n');
    process.exitCode = 1;
  }
  await networkCanary?.close().catch(() => undefined);
  if (treeTermination !== 'failed') {
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

async function startLoopbackCanary(response) {
  const requestPath = `/roundtable-tool-egress/${randomUUID()}`;
  let hits = 0;
  const server = createServer((request, reply) => {
    if (request.method !== 'GET' || request.url !== requestPath) {
      reply.writeHead(404).end();
      return;
    }
    hits += 1;
    reply.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    reply.end(`${response}\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('claude_network_canary_start_failed');
  }
  return {
    url: `http://127.0.0.1:${address.port}${requestPath}`,
    observedHit: () => hits > 0,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function assertNetworkObservation({ observedHit, reportedResult, response }) {
  if (observedHit && reportedResult !== response) {
    throw new Error('claude_network_observation_inconsistent');
  }
  if (!observedHit && reportedResult !== 'BLOCKED') {
    throw new Error('claude_network_observation_inconsistent');
  }
}

async function initializeGitRepository(workspaceRoot) {
  const git = spawn('/usr/bin/git', ['init', '--quiet'], {
    cwd: workspaceRoot,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: 'ignore',
    shell: false,
  });
  const [exitCode] = await once(git, 'exit');
  if (exitCode !== 0) throw new Error('claude_smoke_git_init_failed');
}

function withTimeout(promise, timeoutMs) {
  let timeout;
  const timed = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('claude_runtime_electron_smoke_timeout')), timeoutMs);
    timeout.unref();
  });
  return Promise.race([promise, timed]).finally(() => clearTimeout(timeout));
}

function stableOutput(output) {
  const lines = output.split(/\r?\n/u).filter((line) => (
    /^\[(?:claude-runtime-smoke|desktop)\] [a-z0-9_:-]{1,120}$/u.test(line)
  ));
  return lines.join('\n');
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
