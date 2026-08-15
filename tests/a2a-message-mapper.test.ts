import { describe, expect, it } from 'vitest';
import { TaskState, type StreamResponse } from '@a2a-js/sdk';
import type { HandoffCardV2 } from '../src/server/types.js';

const handoff: HandoffCardV2 = {
  protocolVersion: 'roundtable.handoff.v2',
  cardId: 'card-1',
  missionId: 'mission-1',
  sourceTaskId: null,
  referenceTaskIds: ['local-dependency'],
  fromAgent: 'orchestrator',
  toAgent: 'atlas',
  task: { id: 'task-1', title: 'Build', brief: 'Build the page', state: 'pending' },
  contextPackage: { summary: 'Build a checkout', includedArtifactIds: [], omittedHistoryRef: null },
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

describe('A2A message mapping', () => {
  it('maps a handoff into text and structured parts without foreign task references', async () => {
    const module = await import('../src/server/actions/a2a/message-mapper.js').catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;

    const request = module.buildA2ASendRequest({
      handoff,
      handoffText: '# Handoff\n\nBuild the checkout.',
      messageId: 'message-1',
    });

    expect(request.message).toMatchObject({
      messageId: 'message-1',
      taskId: '',
      contextId: '',
      referenceTaskIds: [],
      metadata: {
        roundtableMissionId: 'mission-1',
        roundtablePlanTaskId: 'task-1',
      },
    });
    expect(request.message?.parts.map((part) => part.content?.$case)).toEqual(['text', 'data']);
  });

  it('collects a streamed artifact and terminal completion event', async () => {
    const module = await import('../src/server/actions/a2a/message-mapper.js').catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;

    const artifact: StreamResponse = {
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
              content: { $case: 'text', value: '# Result' },
              filename: 'result.md',
              mediaType: 'text/markdown',
              metadata: undefined,
            }],
          },
        },
      },
    };
    const completed: StreamResponse = {
      payload: {
        $case: 'statusUpdate',
        value: {
          taskId: 'remote-1',
          contextId: 'context-1',
          metadata: undefined,
          status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
        },
      },
    };

    let output = module.createA2AOutputAccumulator();
    output = module.applyA2AStreamResponse(output, artifact);
    output = module.applyA2AStreamResponse(output, completed);

    expect(output).toMatchObject({
      remoteTaskId: 'remote-1',
      remoteContextId: 'context-1',
      state: 'completed',
      parts: [{ filename: 'result.md', mediaType: 'text/markdown', value: '# Result' }],
    });
    expect(output.events.at(-1)).toEqual({ type: 'done', finishReason: 'completed' });
  });
});
