import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskState, type StreamResponse } from '@a2a-js/sdk';
import { resetData } from '../src/server/store.js';
import type { HandoffCardV2, PlanTask } from '../src/server/types.js';
import { bindingsForTurn, upsertA2ATaskBinding } from '../src/server/actions/a2a/task-store.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-a2a-adapter-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

describe('A2A adapter', () => {
  it('streams a remote result into the existing agent run contract', async () => {
    const module = await import('../src/server/actions/adapters/a2a-adapter.js').catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;

    const events: StreamResponse[] = [
      {
        payload: {
          $case: 'artifactUpdate',
          value: {
            taskId: 'remote-1',
            contextId: 'context-1',
            append: false,
            lastChunk: true,
            metadata: undefined,
            artifact: {
              artifactId: 'artifact-1',
              name: 'result.md',
              description: '',
              metadata: undefined,
              extensions: [],
              parts: [{
                content: { $case: 'text', value: '# Remote result' },
                filename: 'result.md',
                mediaType: 'text/markdown',
                metadata: undefined,
              }],
            },
          },
        },
      },
      {
        payload: {
          $case: 'statusUpdate',
          value: {
            taskId: 'remote-1',
            contextId: 'context-1',
            metadata: undefined,
            status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
          },
        },
      },
    ];
    const client = {
      protocolVersion: '1.0',
      async *sendMessageStream() {
        for (const event of events) yield event;
      },
    };

    const result = await module.runOnA2A({
      workspace: tempDir,
      turnId: 'turn-1',
      missionId: 'mission-1',
      task,
      handoff,
      handoffText: '# Handoff',
      config: {
        agentId: 'atlas',
        enabled: true,
        baseUrl: 'https://atlas.example',
        cardPath: '/.well-known/agent-card.json',
        authToken: 'remote-secret',
        source: 'settings',
      },
    }, {
      createClient: async () => ({ client, protocolVersion: '1.0', tenant: '' }),
    });

    expect(result).toMatchObject({
      ok: true,
      text: '# Remote result',
      path: '.roundtable/runs/a2a/task-1/result.md',
      kind: 'markdown',
      remote: { protocol: 'a2a', taskId: 'remote-1', contextId: 'context-1' },
    });
    expect(await readFile(join(tempDir, result.path), 'utf8')).toBe('# Remote result');
    expect(result.events.at(-1)).toEqual({ type: 'done', finishReason: 'completed' });
  });

  it('cancels a persisted remote task', async () => {
    const module = await import('../src/server/actions/adapters/a2a-adapter.js');
    const binding = await upsertA2ATaskBinding({
      id: 'a2a_turn-1_task-1',
      missionId: 'mission-1',
      turnId: 'turn-1',
      planTaskId: 'task-1',
      agentId: 'atlas',
      agentBaseUrl: 'https://atlas.example',
      agentCardPath: '/.well-known/agent-card.json',
      remoteTaskId: 'remote-1',
      remoteContextId: 'context-1',
      remoteTenant: '',
      protocolVersion: '1.0',
      state: 'working',
      error: null,
    });
    const client = {
      async *sendMessageStream() {},
      async cancelTask() {
        return {
          id: 'remote-1',
          contextId: 'context-1',
          status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: undefined },
          artifacts: [],
          history: [],
          metadata: undefined,
        };
      },
    };

    await module.cancelA2ABinding(binding, {
      agentId: 'atlas',
      enabled: true,
      baseUrl: 'https://atlas.example',
      cardPath: '/.well-known/agent-card.json',
      authToken: 'remote-secret',
      source: 'settings',
    }, {
      createClient: async () => ({ client, protocolVersion: '1.0', tenant: '' }),
    });

    expect(await bindingsForTurn('turn-1')).toMatchObject([{ state: 'canceled', error: null }]);
  });
});

const task: PlanTask = {
  id: 'task-1',
  title: 'Build',
  assignee: '@atlas',
  owner: 'atlas',
  role: 'implementer',
  brief: 'Build the requested result',
  deps: [],
  parallel: false,
};

const handoff: HandoffCardV2 = {
  protocolVersion: 'roundtable.handoff.v2',
  cardId: 'card-1',
  missionId: 'mission-1',
  sourceTaskId: null,
  referenceTaskIds: [],
  fromAgent: 'orchestrator',
  toAgent: 'atlas',
  task: { id: 'task-1', title: 'Build', brief: 'Build', state: 'pending' },
  contextPackage: { summary: 'Build', includedArtifactIds: [], omittedHistoryRef: null },
  artifacts: [],
  nextAction: 'Build',
  risks: [],
  provenance: {
    generatedBy: 'orchestrator',
    generatedAt: '2026-08-14T00:00:00.000Z',
    agentCardSnapshot: null,
    selectionReason: 'test',
  },
};
