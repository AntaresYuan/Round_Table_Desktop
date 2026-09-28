import { describe, expect, it } from 'vitest';
import {
  hostRuntimeTurnStreamRequestSchema,
  hostRuntimeTurnStreamResponseSchema,
  MACOS_HOST_RUNTIME_V1_CORPUS,
} from '../src/index.js';

const base = {
  protocolVersion: 1 as const,
  requestId: 'request_0123456789abcdef0123456789abcdef',
  sessionNonce: 'session_0123456789abcdef0123456789abcdef',
};

describe('Host Runtime Turn stream contract', () => {
  it('accepts every action with exact keys', () => {
    expect(hostRuntimeTurnStreamRequestSchema.parse({ ...base, action: 'start', goal: 'Build it',
      workflowTemplateId: 'wf-feature-builder' }).action).toBe('start');
    expect(hostRuntimeTurnStreamRequestSchema.parse({ ...base, action: 'poll',
      streamId: 'turnstream_0123456789abcdef0123456789abcdef', afterSequence: 1 }).action).toBe('poll');
    for (const action of ['approve', 'accept', 'stop'] as const) {
      expect(hostRuntimeTurnStreamRequestSchema.parse({ ...base, action,
        streamId: 'turnstream_0123456789abcdef0123456789abcdef' }).action).toBe(action);
    }
  });

  it('rejects unknown keys and validates bounded snapshots', () => {
    expect(() => hostRuntimeTurnStreamRequestSchema.parse({ ...base, action: 'poll',
      streamId: 'turnstream_0123456789abcdef0123456789abcdef', afterSequence: 1,
      credential: 'forbidden' })).toThrow();
    expect(hostRuntimeTurnStreamResponseSchema.parse({
      protocolVersion: 1, requestId: base.requestId, ok: true,
      streamId: 'turnstream_0123456789abcdef0123456789abcdef',
      awaiting: 'plan_approval', terminal: false,
      frames: [{ sequence: 1, gate: 'plan_approval',
        turn: { id: 'turn_1', message: 'Build it', status: 'done' } }],
    }).ok).toBe(true);
    expect(MACOS_HOST_RUNTIME_V1_CORPUS.turnStream.replay)
      .toBe('connection-session-owner-bound');
  });

  it('accepts the same local-dispatch oracle frames consumed by Swift', () => {
    const timeline = JSON.parse(readFileSync(resolve(import.meta.dirname,
      '../../../apps/macos/Tests/Fixtures/TurnTimelines/feature-builder-local-dispatch.timeline.json'),
    'utf8')) as { frames: Array<{ gate?: string; turn: Record<string, unknown> }> };
    const response = hostRuntimeTurnStreamResponseSchema.parse({
      protocolVersion: 1, requestId: base.requestId, ok: true,
      streamId: 'turnstream_0123456789abcdef0123456789abcdef',
      awaiting: 'delivery_decision', terminal: false,
      frames: timeline.frames.map((frame, index) => ({
        sequence: index + 1, gate: frame.gate ?? null, turn: frame.turn,
      })),
    });
    expect(response.ok && response.frames).toHaveLength(timeline.frames.length);
  });
});
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
