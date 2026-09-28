import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

const SMOKE_TIMEOUT_MS = 35_000;
const appDirectory = fileURLToPath(new URL('..', import.meta.url));

let electronProcess;
let electronOutput = '';
let processExited = false;
let smokeProfileDirectory;
let interruptedBy;
let resolveDebuggingPort;
let rejectDebuggingPort;
const debuggingPortPromise = new Promise((resolve, reject) => {
  resolveDebuggingPort = resolve;
  rejectDebuggingPort = reject;
});
const interruption = new Promise((_, reject) => {
  process.once('SIGINT', () => {
    interruptedBy = 'SIGINT';
    reject(new Error('electron_smoke_interrupted'));
  });
  process.once('SIGTERM', () => {
    interruptedBy = 'SIGTERM';
    reject(new Error('electron_smoke_interrupted'));
  });
});

try {
  smokeProfileDirectory = await mkdtemp(join(tmpdir(), 'roundtable-electron-smoke-'));
  electronProcess = spawn(electronPath, [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${smokeProfileDirectory}`,
    appDirectory,
  ], {
    cwd: appDirectory,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  electronProcess.once('exit', () => {
    processExited = true;
    rejectDebuggingPort(new Error('electron_exited_before_debugging_ready'));
  });
  electronProcess.once('error', () => {
    processExited = true;
    rejectDebuggingPort(new Error('electron_spawn_failed'));
  });
  electronProcess.stdout.on('data', rememberElectronOutput);
  electronProcess.stderr.on('data', rememberElectronOutput);

  await withTimeout(Promise.race([
    debuggingPortPromise.then(runSmoke),
    interruption,
  ]), SMOKE_TIMEOUT_MS, 'electron_smoke_timeout');
  await waitForProcessExit(electronProcess, 5_000);
  process.stdout.write('electron_smoke_ok\n');
} catch (error) {
  const message = error instanceof Error ? error.message : 'electron_smoke_failed';
  process.stderr.write(`[electron-smoke] ${message}\n`);
  if (electronOutput.trim()) {
    process.stderr.write(`${electronOutput.trim().slice(-4_000)}\n`);
  }
  process.exitCode = interruptedBy === 'SIGINT' ? 130 : interruptedBy === 'SIGTERM' ? 143 : 1;
} finally {
  await stopElectronProcess();
  if (smokeProfileDirectory) {
    await rm(smokeProfileDirectory, { recursive: true, force: true }).catch(() => {
      process.stderr.write('[electron-smoke] smoke_profile_cleanup_failed\n');
      if (!process.exitCode) process.exitCode = 1;
    });
  }
}

async function runSmoke(debuggingPort) {
  const target = await waitForRendererTarget(debuggingPort);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await withTimeout(cdp.command('Runtime.enable'), 5_000, 'runtime_enable_timeout');
    const evaluation = await evaluateRendererWhenReady(cdp);
    assertSmokeResult(evaluation);

    await withTimeout(cdp.command('Browser.close'), 5_000, 'browser_close_timeout')
      .catch(() => undefined);
  } finally {
    cdp.close();
  }
}

async function evaluateRendererWhenReady(cdp) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const evaluation = await withTimeout(cdp.command('Runtime.evaluate', {
      expression: `
        (async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (document.readyState === 'interactive' || document.readyState === 'complete')
              && window.roundtableDesktop
            ) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          const bridge = window.roundtableDesktop;
          if (!bridge) return { notReady: true };
          const info = await bridge.getSystemInfo();
          let catalog;
          let catalogError = null;
          try {
            catalog = await Promise.race([
              bridge.getRuntimeCatalog(),
              new Promise((_, reject) => setTimeout(
                () => reject(new Error('catalog_call_timeout')),
                20_000,
              )),
            ]);
          } catch (error) {
            catalogError = error instanceof Error ? error.message : 'runtime_catalog_failed';
          }
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const text = document.querySelector('[data-system-details]')?.textContent ?? '';
            if (text.includes('Electron')) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return {
            url: location.href,
            readyState: document.readyState,
            nodeRequireType: typeof window.require,
            nodeProcessType: typeof window.process,
            bridgeKeys: Object.keys(bridge).sort(),
            bridgeFrozen: Object.isFrozen(bridge),
            info: {
              product: info.product,
              protocolVersion: info.protocolVersion,
              electronVersion: info.electronVersion,
            },
            catalogError,
            providers: catalog?.providers.map((entry) => ({
              provider: entry.provider,
              available: entry.available,
            })),
            systemText: document.querySelector('[data-system-details]')?.textContent ?? '',
            styleUrls: Array.from(document.styleSheets, (sheet) => sheet.href),
            scriptUrls: Array.from(document.scripts, (script) => script.src),
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
      }), 22_000, 'renderer_evaluation_timeout');
      if (!evaluation.exceptionDetails && !evaluation.result?.value?.notReady) {
        return evaluation.result?.value;
      }
    } catch {
      // Navigation can replace the execution context while the first document loads.
    }
    await delay(100);
  }
  throw new Error('renderer_evaluation_failed');
}

function assertSmokeResult(result) {
  if (!result || typeof result !== 'object') throw new Error('renderer_result_missing');
  if (result.url !== 'roundtable://app/index.html') throw new Error('custom_protocol_not_loaded');
  if (!['interactive', 'complete'].includes(result.readyState)) {
    throw new Error('renderer_document_not_ready');
  }
  if (result.nodeRequireType !== 'undefined' || result.nodeProcessType !== 'undefined') {
    throw new Error('renderer_node_isolation_failed');
  }
  if (!result.bridgeFrozen) throw new Error('preload_bridge_not_frozen');
  if (JSON.stringify(result.bridgeKeys) !== JSON.stringify([
    'approveMission',
    'getExecution',
    'getRuntimeCatalog',
    'getSystemInfo',
    'listWorkspaceEntries',
    'onExecutionEvent',
    'prepareMission',
    'selectWorkspace',
    'stopExecution',
  ])) {
    throw new Error('preload_bridge_surface_invalid');
  }
  if (
    result.info?.product !== 'roundtable'
    || result.info?.protocolVersion !== 1
    || typeof result.info?.electronVersion !== 'string'
  ) {
    throw new Error('first_ipc_call_failed');
  }
  if (JSON.stringify(result.providers?.map((entry) => entry.provider)) !== JSON.stringify([
    'codex',
    'claude-code',
    'opencode',
  ])) {
    throw new Error(result.catalogError ? `runtime_catalog_invalid:${result.catalogError}` : 'runtime_catalog_invalid');
  }
  if (!result.systemText.includes('Electron')) throw new Error('renderer_module_not_initialized');
  if (!result.styleUrls.some((url) => url === 'roundtable://app/styles.css')) {
    throw new Error('renderer_styles_not_loaded');
  }
  if (!result.scriptUrls.some((url) => url === 'roundtable://app/renderer.js')) {
    throw new Error('renderer_script_not_loaded');
  }
}

async function waitForRendererTarget(debuggingPort) {
  const endpoint = `http://127.0.0.1:${debuggingPort}/json/list`;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (processExited) throw new Error('electron_exited_before_renderer_ready');
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((candidate) => (
          candidate.type === 'page'
          && candidate.url === 'roundtable://app/index.html'
          && typeof candidate.webSocketDebuggerUrl === 'string'
        ));
        if (target) return target;
      }
    } catch {
      // Electron has not opened the DevTools endpoint yet.
    }
    await delay(100);
  }
  throw new Error('renderer_debug_target_unavailable');
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('cdp_connection_failed')), {
      once: true,
    });
  });

  let commandId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const handlers = pending.get(message.id);
    if (!handlers) return;
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error('cdp_command_failed'));
    else handlers.resolve(message.result ?? {});
  });
  socket.addEventListener('close', () => {
    for (const handlers of pending.values()) {
      handlers.reject(new Error('cdp_connection_closed'));
    }
    pending.clear();
  });

  return {
    command(method, params = {}) {
      const id = ++commandId;
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error('cdp_connection_closed'));
          return;
        }
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    },
  };
}

function rememberElectronOutput(chunk) {
  electronOutput = `${electronOutput}${String(chunk)}`.slice(-16_000);
  const endpoint = electronOutput.match(
    /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//u,
  );
  if (endpoint?.[1]) resolveDebuggingPort(Number(endpoint[1]));
}

async function waitForProcessExit(child, timeoutMs) {
  if (processExited) return;
  await withTimeout(
    once(child, 'exit'),
    timeoutMs,
    'electron_did_not_exit_after_browser_close',
  );
}

async function stopElectronProcess() {
  if (!electronProcess || processExited || !electronProcess.pid) return;
  try {
    if (process.platform === 'win32') await killWindowsProcessTree(electronProcess.pid);
    else process.kill(-electronProcess.pid, 'SIGTERM');
  } catch {
    electronProcess.kill('SIGTERM');
  }
  await withTimeout(once(electronProcess, 'exit'), 2_000, 'electron_stop_timeout')
    .catch(() => undefined);
  if (!processExited) {
    try {
      if (process.platform === 'win32') await killWindowsProcessTree(electronProcess.pid);
      else process.kill(-electronProcess.pid, 'SIGKILL');
    } catch {
      electronProcess.kill('SIGKILL');
    }
    await withTimeout(once(electronProcess, 'exit'), 2_000, 'electron_kill_timeout')
      .catch(() => undefined);
  }
}

async function killWindowsProcessTree(processId) {
  const killer = spawn('taskkill', ['/pid', String(processId), '/T', '/F'], {
    stdio: 'ignore',
  });
  await withTimeout(once(killer, 'exit'), 2_000, 'taskkill_timeout');
}

function withTimeout(promise, timeoutMs, code) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(code)), timeoutMs);
    timeout.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
