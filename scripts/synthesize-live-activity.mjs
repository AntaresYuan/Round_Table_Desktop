#!/usr/bin/env node
/* ============================================================================
   synthesize-live-activity.mjs
   Derives a SYNTHETIC `roundtable.turn-timeline` with `liveActivity` frames from
   a recorded local-dispatch timeline, so the native UI can be checked against
   the Web's running-agent views (now-doing bubbles, transcript feeds) without
   running real agent CLIs. See docs/architecture/macos-native-ui-parity-replay.md §3.2.

   Every transcript entry comes from the task's recorded dispatch events
   (thinking_delta → thinking, tool_use → status "Using <tool>", text_delta →
   response). Tasks start once their dependencies finish; tasks whose
   dependencies finish together run concurrently, as the Web orchestrator
   schedules them. The output is marked `synthetic: true`.

   Usage:
     node scripts/synthesize-live-activity.mjs <recorded>.timeline.json <out>.timeline.json [--step-ms 1500]
   ============================================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [inputPath, outputPath, flag, flagValue] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  process.stderr.write('usage: synthesize-live-activity.mjs <recorded>.timeline.json <out>.timeline.json [--step-ms N]\n');
  process.exit(2);
}
const stepMs = flag === '--step-ms' ? Number(flagValue) : 1500;
const recorded = JSON.parse(readFileSync(inputPath, 'utf8'));
const frames = recorded.frames;
const planned = frames.find((frame) => frame.gate === 'plan_approval');
const running = frames.find((frame) => frame.turn.dispatchStatus === 'running');
const completed = frames.at(-1);
if (!planned || !running || completed.turn.dispatchStatus !== 'completed') {
  throw new Error('expected a recorded timeline with plan approval, running and completed frames');
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const tasks = completed.turn.plan.tasks;
const recordFor = (taskId) => completed.turn.dispatch.find((record) => record.taskId === taskId);

// Transcript steps per task, taken from its recorded dispatch events.
function transcriptSteps(taskId) {
  const entries = [];
  for (const event of recordFor(taskId)?.events || []) {
    if (event.type === 'thinking_delta') entries.push({ kind: 'thinking', content: event.delta });
    else if (event.type === 'tool_use') entries.push({ kind: 'status', content: `Using ${event.name || 'tool'}` });
    else if (event.type === 'text_delta') entries.push({ kind: 'response', content: event.delta });
  }
  return entries;
}

// Waves: tasks whose dependencies are all done start together.
const done = new Set();
const waves = [];
while (done.size < tasks.length) {
  const wave = tasks.filter((task) => !done.has(task.id) && (task.deps || []).every((dep) => done.has(dep)));
  if (wave.length === 0) throw new Error('dependency cycle in plan');
  waves.push(wave);
  wave.forEach((task) => done.add(task.id));
}

const out = [clone(planned)];
let atMs = running.atMs;
const finished = new Set();
const activity = {};
const conversationId = (taskId) => `synthetic_${taskId}`;

for (const wave of waves) {
  const steps = Object.fromEntries(wave.map((task) => [task.id, transcriptSteps(task.id)]));
  const longest = Math.max(...wave.map((task) => steps[task.id].length), 1);
  // One frame for "starting up", then one per transcript entry, then completion.
  for (let step = 0; step <= longest + 1; step += 1) {
    for (const task of wave) {
      const entries = steps[task.id];
      const complete = step > entries.length;
      activity[task.id] = {
        conversationId: conversationId(task.id),
        agentId: task.owner,
        runtime: 'claude',
        status: complete ? 'completed' : 'running',
        error: null,
        transcript: entries.slice(0, Math.min(step, entries.length)),
      };
      if (complete) finished.add(task.id);
    }
    const turn = clone(running.turn);
    for (const t of tasks) {
      const status = finished.has(t.id) ? 'done' : activity[t.id]?.status === 'running' ? 'running' : 'pending';
      turn.workflowRun.stageStates[t.id] = { status };
    }
    // A stage is running while any of its tasks runs, done once they all finish.
    for (const stageId of new Set(tasks.map((t) => t.stageId))) {
      const stageTasks = tasks.filter((t) => t.stageId === stageId);
      const stage = turn.workflowRun.stageStates[stageId];
      if (!stage) continue;
      stage.status = stageTasks.every((t) => finished.has(t.id))
        ? 'done'
        : stageTasks.some((t) => activity[t.id]?.status === 'running') ? 'running' : stage.status;
    }
    turn.liveActivity = clone(activity);
    out.push({ atMs, turn });
    atMs += stepMs;
  }
}

const final = clone(completed);
final.atMs = atMs;
final.turn.liveActivity = clone(activity);
out.push(final);

const timeline = {
  format: 'roundtable.turn-timeline',
  version: 1,
  source: {
    ...recorded.source,
    synthetic: true,
    derivedFrom: basename(inputPath),
    capturedWith: 'scripts/synthesize-live-activity.mjs',
    note: 'liveActivity frames are synthesized from the recorded dispatch events; they are not a real agent-cli run.',
  },
  frames: out,
};
writeFileSync(outputPath, `${JSON.stringify(timeline, null, 2)}\n`);
process.stdout.write(`wrote ${out.length} frames (${waves.length} waves) to ${outputPath}\n`);
