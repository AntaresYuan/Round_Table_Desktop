import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MiniMaxUnavailableError,
  isMiniMaxAvailable,
  miniMaxModel,
  runOnMiniMax,
  stripThink,
} from '../src/server/actions/adapters/minimax-adapter.js';
import { normalizeAdapter } from '../src/server/actions/agent-runner.js';
import { resetData } from '../src/server/store.js';

const originalKey = process.env.MINIMAX_API_KEY;
const originalModel = process.env.MINIMAX_MODEL;
const originalAdapter = process.env.ROUNDTABLE_AGENT_ADAPTER;
let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-minimax-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_MODEL;
  delete process.env.ROUNDTABLE_AGENT_ADAPTER;
  await resetData();
});

afterEach(async () => {
  restore('MINIMAX_API_KEY', originalKey);
  restore('MINIMAX_MODEL', originalModel);
  restore('ROUNDTABLE_AGENT_ADAPTER', originalAdapter);
  delete process.env.ROUNDTABLE_DATA_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('minimax-adapter — availability + selection', () => {
  it('isMiniMaxAvailable reflects the key', () => {
    expect(isMiniMaxAvailable()).toBe(false);
    process.env.MINIMAX_API_KEY = 'sk-cp-test';
    expect(isMiniMaxAvailable()).toBe(true);
  });

  it('normalizeAdapter selects minimax when requested', () => {
    expect(normalizeAdapter('minimax')).toBe('minimax');
    process.env.ROUNDTABLE_AGENT_ADAPTER = 'minimax';
    expect(normalizeAdapter(undefined)).toBe('minimax');
  });

  it('miniMaxModel defaults to MiniMax-M3', () => {
    expect(miniMaxModel()).toBe('MiniMax-M3');
    process.env.MINIMAX_MODEL = 'MiniMax-M2.7';
    expect(miniMaxModel()).toBe('MiniMax-M2.7');
  });

  it('runOnMiniMax throws when no key is set', async () => {
    await expect(runOnMiniMax({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(MiniMaxUnavailableError);
  });
});

describe('minimax-adapter — stripThink', () => {
  it('removes a closed <think> block and returns the reasoning separately', () => {
    const [clean, reasoning] = stripThink('<think>let me reason</think>The answer is 42.');
    expect(clean).toBe('The answer is 42.');
    expect(reasoning).toBe('let me reason');
  });

  it('drops an unterminated <think> (truncated output)', () => {
    const [clean, reasoning] = stripThink('Intro.\n<think>reasoning that never closed because tokens ran out');
    expect(clean).toBe('Intro.');
    expect(reasoning).toBeUndefined();
  });

  it('passes through content with no think block', () => {
    const [clean, reasoning] = stripThink('Just the answer.');
    expect(clean).toBe('Just the answer.');
    expect(reasoning).toBeUndefined();
  });
});
