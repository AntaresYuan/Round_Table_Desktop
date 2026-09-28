import { describe, expect, it } from 'vitest';
import {
  buildLocalScene,
  meetingSpeechText,
  planningMessageDuration,
} from '../src/ui/lib/live-scene.js';

const agents = {
  orchestrator: { agentId: 'orchestrator', role: 'planner', pm: true },
  mira: { agentId: 'mira', role: 'pm', pm: false },
  nova: { agentId: 'nova', role: 'architect', pm: false },
  atlas: { agentId: 'atlas', role: 'implementer', pm: false },
  vera: { agentId: 'vera', role: 'reviewer', pm: false },
};

const baseScene = {
  status: Object.fromEntries(Object.keys(agents).map((id) => [id, 'idle'])),
  speech: null,
  started: false,
  planPosted: false,
  tasks: [],
  placed: [],
};

const turn = {
  id: 'turn_1',
  message: 'Build the feature',
  createdAt: '2026-07-12T00:00:00.000Z',
  status: 'done',
  result: {
    provider: 'roundtable-local',
    model: 'agent-chain-v1',
    approvalStatus: 'pending',
    dispatchStatus: 'not_started',
    artifacts: [],
    planningMeeting: {
      participants: ['orchestrator', 'mira', 'nova', 'atlas', 'vera'],
      messages: [
        { id: 'm1', phase: 'opening', agentId: 'orchestrator', content: 'Here is the task.' },
        { id: 'm2', phase: 'position', agentId: 'nova', content: 'Architecture view.' },
      ],
    },
    plan: {
      tasks: [{
        id: 'task_atlas', title: 'Build feature', owner: 'atlas', assignee: '@atlas', role: 'implementer', deps: [], parallel: false,
      }],
    },
    workflowRun: { stageStates: {} },
  },
};

describe('live roundtable planning projection', () => {
  it('shows the current meeting speaker and hides the compiled plan during discussion', () => {
    const scene = buildLocalScene(baseScene, [turn], agents, {
      meetingMessageIndex: 1,
      meetingComplete: false,
    });

    expect(scene.speech).toMatchObject({
      agentId: 'nova', mode: 'speaking', text: 'Architecture view.', step: 2, steps: 2,
    });
    expect(scene.status.nova).toBe('speaking');
    expect(scene.planPosted).toBe(false);
    expect(scene.tasks).toEqual([]);
    expect(scene.run.phase).toBe('planning_meeting');
  });

  it('reveals assignments only after the meeting is complete', () => {
    const scene = buildLocalScene(baseScene, [turn], agents, {
      meetingMessageIndex: 1,
      meetingComplete: true,
    });

    expect(scene.speech).toBeNull();
    expect(scene.planPosted).toBe(true);
    expect(scene.tasks).toHaveLength(1);
    expect(scene.run.phase).toBe('awaiting_approval');
  });

  it('keeps more spoken content visible and gives it a readable pause', () => {
    const longSpeech = `${'先把用户要的结果说清楚。'.repeat(20)}\n${'再确认怎么接进现有项目。'.repeat(20)}`;
    const shown = meetingSpeechText(longSpeech);

    expect(shown).toContain('\n');
    expect(shown.length).toBeGreaterThan(260);
    expect(shown.length).toBeLessThanOrEqual(521);
    expect(planningMessageDuration('短句')).toBe(6_000);
    expect(planningMessageDuration(shown)).toBeGreaterThan(6_000);
    expect(planningMessageDuration('x'.repeat(1_000))).toBe(11_000);
  });
});
