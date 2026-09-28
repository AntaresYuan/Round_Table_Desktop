const { app } = require('electron');
const { readFile } = require('node:fs/promises');
const { isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const smokeRoot = process.argv.at(-1);
const terminalStates = new Set(['succeeded', 'failed', 'stopped', 'timed_out']);

void app.whenReady().then(async () => {
  if (typeof smokeRoot !== 'string' || !isAbsolute(smokeRoot)) {
    throw new Error('runtime_smoke_root_invalid');
  }
  const desktopRoot = join(__dirname, '..');
  const [runtimeModule, authorityModule, grantsModule] = await Promise.all([
    import(pathToFileURL(join(desktopRoot, 'dist', 'utility-agent-runtime.js')).href),
    import(pathToFileURL(join(desktopRoot, 'dist', 'execution-authority.js')).href),
    import(pathToFileURL(join(desktopRoot, 'dist', 'workspace-grants.js')).href),
  ]);
  const runtime = new runtimeModule.UtilityAgentRuntime({
    modulePath: join(desktopRoot, 'dist', 'local-agent-runtime-child.mjs'),
    stateRoot: join(smokeRoot, 'state'),
    sourceHome: join(smokeRoot, 'source-home'),
    searchDirectories: [join(smokeRoot, 'bin')],
    environment: { OPENAI_API_KEY: 'roundtable-fixture-api-key' },
  });
  const grants = new grantsModule.WorkspaceGrantRegistry();
  const authority = new authorityModule.DesktopExecutionAuthority({ grants, runtime });
  const ownerId = 9001;
  const nonce = 'runtime-smoke-window-session-01';

  try {
    const workspace = await grants.grant(join(smokeRoot, 'workspace'), ownerId);
    const catalog = await authority.getCatalog();
    const codex = catalog.providers.find((entry) => entry.provider === 'codex');
    if (!codex?.available || codex.version !== 'roundtable-fixture 1.2.3') {
      const version = String(codex?.version ?? 'none').replace(/[^a-z0-9]+/giu, '_').slice(0, 80);
      throw new Error(`runtime_smoke_catalog_invalid:${Boolean(codex?.available)}:${version}`);
    }

    const preview = await authority.prepareMission({
      workspaceId: workspace.id,
      provider: 'codex',
      prompt: 'fixture:create-artifact',
    }, ownerId, nonce);
    await expectMissing(join(smokeRoot, 'workspace', 'provider-generated.txt'));
    const accepted = await authority.approveMission(preview.approvalId, ownerId, nonce);
    const completed = await waitForTerminal(authority, accepted.executionId, ownerId, nonce);
    if (completed.state !== 'succeeded') throw new Error('runtime_smoke_execution_failed');
    if (!completed.artifacts.some((artifact) => (
      artifact.relativePath === 'provider-generated.txt'
      && artifact.change === 'created'
      && artifact.scanStatus === 'scanned'
    ))) throw new Error('runtime_smoke_artifact_missing');
    const generated = await readFile(
      join(smokeRoot, 'workspace', 'provider-generated.txt'),
      'utf8',
    );
    if (!generated.includes('fixture:create-artifact')) {
      throw new Error('runtime_smoke_artifact_invalid');
    }

    const stopPreview = await authority.prepareMission({
      workspaceId: workspace.id,
      provider: 'codex',
      prompt: 'fixture:tree',
    }, ownerId, nonce);
    const stopAccepted = await authority.approveMission(stopPreview.approvalId, ownerId, nonce);
    await waitForState(authority, stopAccepted.executionId, ownerId, nonce, 'running');
    const pids = await waitForPids(join(smokeRoot, 'workspace', '.fixture-pids.json'));
    const stopped = await authority.stopExecution(stopAccepted.executionId, ownerId, nonce);
    if (stopped.state !== 'stopped' || stopped.treeTermination !== 'confirmed') {
      throw new Error('runtime_smoke_stop_unconfirmed');
    }
    if (processAlive(pids.parent) || processAlive(pids.grandchild)) {
      throw new Error('runtime_smoke_process_leak');
    }

    process.stdout.write('runtime_electron_smoke_ok\n');
  } finally {
    try {
      await runtime.shutdown();
    } finally {
      authority.dispose();
      app.quit();
    }
  }
}).catch((error) => {
  process.stderr.write(`[runtime-electron-smoke] ${stableMessage(error)}\n`);
  process.exitCode = 1;
  app.quit();
});

async function waitForTerminal(authority, executionId, ownerId, nonce) {
  const deadline = Date.now() + 20_000;
  do {
    const snapshot = authority.getExecution(executionId, ownerId, nonce);
    if (terminalStates.has(snapshot.state)) return snapshot;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('runtime_smoke_terminal_timeout');
}

async function waitForState(authority, executionId, ownerId, nonce, expectedState) {
  const deadline = Date.now() + 10_000;
  do {
    const snapshot = authority.getExecution(executionId, ownerId, nonce);
    if (snapshot.state === expectedState) return snapshot;
    if (terminalStates.has(snapshot.state)) throw new Error('runtime_smoke_early_terminal');
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('runtime_smoke_state_timeout');
}

async function expectMissing(path) {
  try {
    await readFile(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('runtime_spawned_before_approval');
}

async function waitForPids(path) {
  const deadline = Date.now() + 5_000;
  do {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (Number.isSafeInteger(value.parent) && Number.isSafeInteger(value.grandchild)) {
        return value;
      }
    } catch {
      // The fixture records the tree only after its grandchild is running.
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('runtime_smoke_pid_timeout');
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stableMessage(error) {
  return error instanceof Error && /^[a-z0-9_:-]{1,120}$/u.test(error.message)
    ? error.message
    : 'runtime_electron_smoke_failed';
}
