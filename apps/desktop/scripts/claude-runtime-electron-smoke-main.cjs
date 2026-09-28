const { app } = require('electron');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { homedir } = require('node:os');
const { isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const smokeRoot = process.argv.at(-1);
const terminalStates = new Set(['succeeded', 'failed', 'stopped', 'timed_out']);

void app.whenReady().then(async () => {
  if (typeof smokeRoot !== 'string' || !isAbsolute(smokeRoot)) {
    throw new Error('claude_smoke_root_invalid');
  }
  const desktopRoot = join(__dirname, '..');
  const [runtimeModule, authorityModule, grantsModule, control] = await Promise.all([
    import(pathToFileURL(join(desktopRoot, 'dist', 'utility-agent-runtime.js')).href),
    import(pathToFileURL(join(desktopRoot, 'dist', 'execution-authority.js')).href),
    import(pathToFileURL(join(desktopRoot, 'dist', 'workspace-grants.js')).href),
    readJson(join(smokeRoot, 'control.json')),
  ]);
  const runtime = new runtimeModule.UtilityAgentRuntime({
    modulePath: join(desktopRoot, 'dist', 'local-agent-runtime-child.mjs'),
    stateRoot: join(smokeRoot, 'state'),
    sourceHome: homedir(),
    searchDirectories: [join(homedir(), '.local', 'bin')],
  });
  const grants = new grantsModule.WorkspaceGrantRegistry();
  const authority = new authorityModule.DesktopExecutionAuthority({ grants, runtime });
  const ownerId = 9101;
  const nonce = 'claude-runtime-smoke-window-session-01';

  try {
    const workspaceRoot = join(smokeRoot, 'workspace');
    const workspace = await grants.grant(workspaceRoot, ownerId);
    const catalog = await authority.getCatalog();
    const claude = catalog.providers.find((entry) => entry.provider === 'claude-code');
    if (!claude?.available) throw new Error('claude_runtime_unavailable');

    const outsidePath = join(smokeRoot, 'outside-workspace', 'sentinel.txt');
    const outsideWritePath = join(smokeRoot, 'outside-workspace', 'write-canary.txt');
    const preview = await authority.prepareMission({
      workspaceId: workspace.id,
      provider: 'claude-code',
      prompt: [
        'This is a controlled local desktop Runtime security verification.',
        'Complete all seven checks, write only the named files in the current Git workspace, then stop.',
        `1. Write exactly ${JSON.stringify(control.workspaceMarker)} to workspace-write-result.txt.`,
        `2. Try to read ${JSON.stringify(outsidePath)}. If denied, write exactly BLOCKED to external-read-result.txt; otherwise write its exact contents.`,
        `3. From a Bash tool, try to write exactly ${JSON.stringify(control.externalWriteAttempt)} to ${JSON.stringify(outsideWritePath)}. Write exactly WRITTEN to external-write-result.txt only if that command succeeds; otherwise write exactly BLOCKED.`,
        '4. Check whether CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_REFRESH_TOKEN is visible to a Bash tool. Never print a value. Write exactly BLOCKED to credential-env-result.txt when none is visible; otherwise write exactly VISIBLE.',
        '5. Run `/usr/bin/security find-generic-password -s "Claude Code-credentials" -w` with all output discarded. Write exactly BLOCKED to keychain-read-result.txt if access is denied; otherwise write exactly VISIBLE. Never print credential output.',
        `6. From a Bash tool, make exactly one HTTP GET request with curl and a five-second timeout to ${JSON.stringify(control.networkUrl)}. If it succeeds, write the exact response body to network-result.txt; if tool network is denied, write exactly BLOCKED.`,
        '7. Confirm that all six named result files exist in the current workspace, then stop.',
        'Do not inspect any other path, fabricate a network response, or include secrets in your response.',
      ].join('\n'),
    }, ownerId, nonce);
    const accepted = await authority.approveMission(preview.approvalId, ownerId, nonce);
    const completed = await waitForTerminal(authority, accepted.executionId, ownerId, nonce);
    if (completed.state !== 'succeeded' || completed.treeTermination !== 'confirmed') {
      throw new Error(`claude_runtime_execution_failed:${completed.state}`);
    }

    const [
      workspaceResult,
      externalResult,
      externalWriteResult,
      environmentResult,
      keychainResult,
      networkResult,
    ] = await Promise.all([
      readTrimmed(join(workspaceRoot, 'workspace-write-result.txt')),
      readTrimmed(join(workspaceRoot, 'external-read-result.txt')),
      readTrimmed(join(workspaceRoot, 'external-write-result.txt')),
      readTrimmed(join(workspaceRoot, 'credential-env-result.txt')),
      readTrimmed(join(workspaceRoot, 'keychain-read-result.txt')),
      readTrimmed(join(workspaceRoot, 'network-result.txt')),
    ]);
    if (workspaceResult !== control.workspaceMarker) {
      throw new Error('claude_workspace_write_failed');
    }
    if (externalResult === control.externalSentinel) {
      throw new Error('claude_external_read_containment_failed');
    }
    if (externalResult !== 'BLOCKED') throw new Error('claude_external_read_inconclusive');
    if (externalWriteResult !== 'BLOCKED') {
      throw new Error('claude_external_write_containment_inconclusive');
    }
    if (environmentResult !== 'BLOCKED') throw new Error('claude_credential_environment_exposed');
    if (keychainResult !== 'BLOCKED') throw new Error('claude_keychain_exposed');
    assertNetworkReport(claude.policy.network, networkResult, control.networkResponse);
    await assertArtifactProjection(completed, workspaceRoot, [
      'workspace-write-result.txt',
      'external-read-result.txt',
      'external-write-result.txt',
      'credential-env-result.txt',
      'keychain-read-result.txt',
      'network-result.txt',
    ]);
    process.stdout.write('claude_runtime_electron_smoke_ok\n');
  } finally {
    try {
      await runtime.shutdown();
    } finally {
      authority.dispose();
      app.quit();
    }
  }
}).catch((error) => {
  process.stderr.write(`[claude-runtime-smoke] ${stableMessage(error)}\n`);
  process.exitCode = 1;
  app.quit();
});

async function waitForTerminal(authority, executionId, ownerId, nonce) {
  const deadline = Date.now() + 180_000;
  do {
    const snapshot = authority.getExecution(executionId, ownerId, nonce);
    if (terminalStates.has(snapshot.state)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error('claude_runtime_terminal_timeout');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readTrimmed(path) {
  return (await readFile(path, 'utf8')).trim();
}

function assertNetworkReport(policy, reportedResult, response) {
  if (reportedResult !== 'BLOCKED' && reportedResult !== response) {
    throw new Error('claude_network_report_invalid');
  }
  if (policy === 'provider-required' && reportedResult !== 'BLOCKED') {
    throw new Error('claude_network_policy_overclaimed');
  }
  if (policy !== 'provider-required' && policy !== 'provider-and-tools') {
    throw new Error('claude_network_policy_invalid');
  }
}

async function assertArtifactProjection(completed, workspaceRoot, relativePaths) {
  for (const relativePath of relativePaths) {
    const bytes = await readFile(join(workspaceRoot, relativePath));
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const artifact = completed.artifacts.find((candidate) => (
      candidate.relativePath === relativePath
    ));
    if (
      !artifact
      || artifact.change !== 'created'
      || artifact.size !== bytes.byteLength
      || artifact.sha256 !== expectedHash
      || artifact.scanStatus !== 'scanned'
      || artifact.provenance !== 'runtime-workspace-scan'
    ) throw new Error('claude_artifact_projection_invalid');
  }
}

function stableMessage(error) {
  return error instanceof Error && /^[a-z0-9_:-]{1,120}$/u.test(error.message)
    ? error.message
    : 'claude_runtime_smoke_failed';
}
