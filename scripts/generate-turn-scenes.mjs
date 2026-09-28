#!/usr/bin/env node
/* ============================================================================
   generate-turn-scenes.mjs
   Projects every frame of a `roundtable.turn-timeline` fixture through the
   Web's own scene projection (src/ui/lib/live-scene.js) and writes the result
   as golden scenes for the native SceneProjector tests.
   See docs/architecture/macos-native-ui-parity-replay.md §3.3.

   Run with tsx (live-scene.js uses extensionless ESM imports):
     pnpm exec tsx scripts/generate-turn-scenes.mjs <timeline.json> [--check]

   Writes <name>.scenes.json next to <name>.timeline.json. With --check it
   exits non-zero when the committed golden file is stale instead.
   ============================================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  buildLocalScene,
  planningMessageDuration,
  storedTurnToLiveTurn,
} from '../src/ui/lib/live-scene.js';
import { RT } from '../src/ui/lib/rt.js';

const [timelinePath, flag] = process.argv.slice(2);
if (!timelinePath || !timelinePath.endsWith('.timeline.json')) {
  process.stderr.write('usage: generate-turn-scenes.mjs <name>.timeline.json [--check]\n');
  process.exit(2);
}
const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
if (timeline.format !== 'roundtable.turn-timeline' || timeline.version !== 1) {
  throw new Error(`unsupported timeline: ${timeline.format} v${timeline.version}`);
}

// The Web palettizes colors per theme; the projection only reads identity and
// role, so the fixture agents are RT.AGENTS without presentation fields. The
// projection depends on their order (role lookup, role round-robin), so the
// golden lists them as an array.
const agents = Object.fromEntries(Object.entries(RT.AGENTS).map(([id, agent]) => [id, {
  agentId: agent.agentId,
  role: agent.role,
  displayName: agent.displayName,
  mention: agent.mention,
  ...(agent.pm ? { pm: true } : {}),
}]));
// In live mode the Web passes sceneAt(0) as the base scene; the projection
// only reads its status keys and resets every seat to idle.
const baseScene = () => ({ status: Object.fromEntries(Object.keys(agents).map((id) => [id, 'idle'])) });

// Keep the fields buildLocalScene owns. `placed` carries whole artifacts
// (including a generated run log stamped with the current time), so goldens
// keep only their identity.
function projectScene(scene) {
  return {
    live: scene.live,
    started: scene.started,
    status: scene.status,
    speech: scene.speech,
    planPosted: scene.planPosted,
    work: scene.work,
    run: scene.run,
    tasks: scene.tasks,
    placed: scene.placed.map(({ art, ownerAgentId }) => ({
      id: art.id, title: art.title, kind: art.kind, version: art.version, ownerAgentId,
    })),
  };
}

const steps = [];
const push = (id, frameIndex, liveTurn, playback) => {
  const turn = { ...liveTurn, meetingPlaybackComplete: playback.meetingComplete };
  steps.push({ id, frameIndex, playback, scene: projectScene(buildLocalScene(baseScene(), [turn], agents, playback)) });
};

// Before the planning request returns, the Web shows a client-only pending
// turn (id, message, status) with no result; the server never stores it.
const first = timeline.frames[0].turn;
push('pending', null, {
  id: first.id, chatId: first.localChatId, message: first.message,
  createdAt: first.createdAt, status: 'pending', serverConfirmed: false,
}, { meetingMessageIndex: 0, meetingComplete: true });

const played = new Set();
timeline.frames.forEach((frame, frameIndex) => {
  const liveTurn = storedTurnToLiveTurn(frame.turn);
  const messages = frame.turn.planningMeeting?.messages || [];
  // The Web plays the meeting once, when the planned turn first arrives.
  if (messages.length > 0 && !played.has(frame.turn.id)) {
    played.add(frame.turn.id);
    messages.forEach((_, index) => {
      push(`frame-${frameIndex}/meeting-${index}`, frameIndex, liveTurn, { meetingMessageIndex: index, meetingComplete: false });
    });
  }
  push(`frame-${frameIndex}`, frameIndex, liveTurn, { meetingMessageIndex: 0, meetingComplete: true });
});

const meetingDurationsMs = Object.fromEntries(timeline.frames.flatMap((frame) => (
  (frame.turn.planningMeeting?.messages || []).map((message) => [message.id, planningMessageDuration(message.content)])
)));

const golden = {
  format: 'roundtable.turn-scenes',
  version: 1,
  timeline: basename(timelinePath),
  generatedWith: 'scripts/generate-turn-scenes.mjs',
  agents: Object.values(agents),
  meetingDurationsMs,
  steps,
};

const outPath = resolve(timelinePath.replace(/\.timeline\.json$/, '.scenes.json'));
const text = `${JSON.stringify(golden, null, 2)}\n`;
if (flag === '--check') {
  let current = null;
  try { current = readFileSync(outPath, 'utf8'); } catch { /* missing counts as stale */ }
  if (current !== text) {
    process.stderr.write(`${outPath} is stale; rerun without --check\n`);
    process.exit(1);
  }
  process.stdout.write(`${basename(outPath)} is up to date (${steps.length} steps)\n`);
} else {
  writeFileSync(outPath, text);
  process.stdout.write(`wrote ${steps.length} steps to ${outPath}\n`);
}
