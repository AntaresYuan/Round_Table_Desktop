#!/usr/bin/env node
/* ============================================================================
   capture-turn-timeline.mjs
   Records one mission run on a local Roundtable Web dev server as a
   `roundtable.turn-timeline` fixture: the ordered Turn snapshots that
   GET /api/orchestrator/history returns while the run progresses.
   See docs/architecture/macos-native-ui-parity-replay.md §3.

   Requires a dev server (`pnpm dev`, non-production) with the dev credentials
   provider enabled. The run is written to that server's data store like any
   other dev session.

   Usage:
     node scripts/capture-turn-timeline.mjs \
       --out apps/macos/Tests/Fixtures/TurnTimelines/feature-builder-local-dispatch.timeline.json \
       [--base-url http://localhost:3000] [--message "…"] [--workflow wf-feature-builder] \
       [--adapter local-dispatch] [--poll-ms 150] [--timeout-ms 300000]
   ============================================================================ */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const DEFAULT_MESSAGE =
  'Create a waitlist flow with email capture, validation, persistence, and a reviewed confirmation state.';

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://localhost:3000',
    message: DEFAULT_MESSAGE,
    workflow: 'wf-feature-builder',
    adapter: 'local-dispatch',
    pollMs: 150,
    timeoutMs: 300_000,
    out: null,
  };
  const keys = {
    '--base-url': 'baseUrl', '--message': 'message', '--workflow': 'workflow',
    '--adapter': 'adapter', '--poll-ms': 'pollMs', '--timeout-ms': 'timeoutMs', '--out': 'out',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    args[key] = key === 'pollMs' || key === 'timeoutMs' ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!args.out) throw new Error('--out is required');
  return args;
}

/* ---- minimal cookie-jar HTTP client --------------------------------------- */

function createClient(baseUrl) {
  const jar = new Map();
  async function request(path, { method = 'GET', json, form } = {}) {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form !== undefined) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(new URL(path, baseUrl), { method, headers, body, redirect: 'manual' });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  }
  return { request };
}

async function signInDev(client, email) {
  const csrf = await (await client.request('/api/auth/csrf')).json();
  const res = await client.request('/api/auth/callback/dev', {
    method: 'POST',
    form: { csrfToken: csrf.csrfToken, email, name: 'Timeline Capture', json: 'true' },
  });
  if (res.status >= 400) throw new Error(`dev sign-in failed: HTTP ${res.status}`);
  const session = await (await client.request('/api/auth/session')).json();
  if (!session?.user) throw new Error('dev sign-in did not produce a session (is this a non-production server?)');
}

async function postJson(client, path, json) {
  const res = await client.request(path, { method: 'POST', json });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(`${path} failed: ${data.error || `HTTP ${res.status}`}`);
  return data;
}

async function historyTurn(client, chatId, turnId) {
  const query = chatId ? `?${new URLSearchParams({ chatId })}` : '';
  const res = await client.request(`/api/orchestrator/history${query}`);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`history failed: ${data.error || `HTTP ${res.status}`}`);
  return (data.turns || []).find((turn) => turn.id === turnId) ?? null;
}

/* ---- redaction ------------------------------------------------------------- */

// Fixtures are committed and shared, so account ids and machine paths are
// replaced with stable placeholders. Content, structure and run ids are kept.
function redact(value, ctx) {
  if (typeof value === 'string') {
    let out = value;
    for (const [needle, replacement] of ctx.replacements) out = out.split(needle).join(replacement);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redact(item, ctx);
    return out;
  }
  return value;
}

function replacementsFor(turn, repoRoot) {
  const pairs = [];
  if (turn.dispatchWorkspacePath) pairs.push([turn.dispatchWorkspacePath, '$WORKSPACE']);
  pairs.push([repoRoot, '$REPO'], [homedir(), '$HOME']);
  if (turn.ownerId) pairs.push([turn.ownerId, 'user_fixture']);
  // Longest first so a workspace path inside the repo is not half-replaced.
  return pairs.filter(([needle]) => needle).sort((a, b) => b[0].length - a[0].length);
}

/* ---- capture ---------------------------------------------------------------- */

const hashOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function gateFor(turn) {
  if (turn.status !== 'done') return null;
  if (turn.needsClarification) return 'clarification';
  if (turn.approvalStatus !== 'approved' && turn.dispatchStatus === 'not_started') return 'plan_approval';
  if (turn.dispatchStatus === 'completed' && turn.mission?.finalDelivery?.status === 'ready') return 'delivery_decision';
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = createClient(args.baseUrl);
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
  await signInDev(client, `timeline-capture-${Date.now()}@roundtable.local`);

  const turnId = `live-capture-${Date.now()}`;
  const frames = [];
  let lastHash = null;
  let chatId = null;
  let startedAt = null;
  const record = (turn) => {
    const hash = hashOf(turn);
    if (hash === lastHash) return;
    lastHash = hash;
    const gate = gateFor(turn);
    frames.push({ atMs: Date.now() - startedAt, ...(gate ? { gate } : {}), turn });
    const gateNote = gate ? ` gate=${gate}` : '';
    process.stdout.write(`frame ${frames.length}: +${frames.at(-1).atMs}ms status=${turn.status} approval=${turn.approvalStatus ?? '-'} dispatch=${turn.dispatchStatus ?? '-'}${gateNote}\n`);
  };

  // Poll concurrently with the (synchronous) planning request so a pending
  // frame is captured when the server exposes one.
  const deadline = Date.now() + args.timeoutMs;
  let stopPolling = false;
  const poller = (async () => {
    while (!stopPolling && Date.now() < deadline) {
      const turn = await historyTurn(client, chatId, turnId).catch(() => null);
      if (turn) record(turn);
      await new Promise((r) => setTimeout(r, args.pollMs));
    }
  })();

  startedAt = Date.now();
  const planned = await postJson(client, '/api/orchestrator/turn', {
    message: args.message,
    turnId,
    workflowTemplateId: args.workflow,
    agentAdapter: args.adapter,
  });
  chatId = planned.localChatId ?? null;
  record(await historyTurn(client, chatId, turnId));

  if (frames.at(-1)?.gate === 'clarification') throw new Error('planner asked for clarification; pick a clearer --message');
  if (frames.at(-1)?.gate !== 'plan_approval') throw new Error('turn did not reach plan approval');

  await postJson(client, '/api/orchestrator/approval', {
    turnId, decision: 'approve', autoDispatch: true, agentAdapter: args.adapter,
  });
  while (Date.now() < deadline) {
    const turn = await historyTurn(client, chatId, turnId);
    if (turn) record(turn);
    if (turn?.dispatchStatus === 'completed' || turn?.dispatchStatus === 'failed') break;
    await new Promise((r) => setTimeout(r, args.pollMs));
  }
  stopPolling = true;
  await poller;

  const last = frames.at(-1)?.turn;
  if (last?.dispatchStatus !== 'completed') throw new Error(`run did not complete (dispatch=${last?.dispatchStatus})`);

  const ctx = { replacements: replacementsFor(last, repoRoot) };
  const timeline = {
    format: 'roundtable.turn-timeline',
    version: 1,
    source: {
      adapter: last.dispatchAdapter,
      workflowTemplateId: last.workflowTemplateId,
      provider: last.provider,
      model: last.model,
      capturedAt: new Date(startedAt).toISOString(),
      capturedWith: 'scripts/capture-turn-timeline.mjs',
    },
    frames: redact(frames, ctx),
  };
  const out = resolve(args.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(timeline, null, 2)}\n`);
  process.stdout.write(`wrote ${frames.length} frames to ${out}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
