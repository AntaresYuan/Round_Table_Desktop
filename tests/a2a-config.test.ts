import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSettingsState, saveSettings } from '../src/server/actions/settings-actions.js';
import { readData, resetData } from '../src/server/store.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-a2a-config-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

describe('A2A settings', () => {
  it('saves an A2A remote without returning its bearer token', async () => {
    const state = await saveSettings({
      defaultAgentAdapter: 'a2a',
      a2aAgents: [{
        agentId: 'atlas',
        enabled: true,
        baseUrl: 'https://atlas.example',
        authToken: 'remote-secret',
      }],
    } as Parameters<typeof saveSettings>[0]);

    expect(state.effectiveAgentAdapter).toBe('a2a');
    expect(state.a2aAgents.find((item) => item.agentId === 'atlas')).toMatchObject({
      enabled: true,
      baseUrl: 'https://atlas.example',
      tokenSet: true,
    });
    expect(JSON.stringify(state)).not.toContain('remote-secret');
    expect(JSON.stringify(await listSettingsState())).not.toContain('remote-secret');
    expect(JSON.stringify((await readData()).settings)).toContain('remote-secret');
  });

  it('resolves the configured remote for a Roundtable seat', async () => {
    await saveSettings({
      a2aAgents: [{
        agentId: 'atlas',
        enabled: true,
        baseUrl: 'https://atlas.example',
        authToken: 'remote-secret',
      }],
    } as Parameters<typeof saveSettings>[0]);
    const module = await import('../src/server/actions/a2a/config.js').catch(() => null);

    expect(module).not.toBeNull();
    if (!module) return;
    await expect(module.resolveA2ARemoteAgentConfig('atlas')).resolves.toMatchObject({
      agentId: 'atlas',
      baseUrl: 'https://atlas.example',
      authToken: 'remote-secret',
      source: 'settings',
    });
  });
});
