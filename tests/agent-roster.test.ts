import { describe, expect, it } from 'vitest';
import { agentForTask } from '../src/server/actions/agent-roster.js';

describe('agent capability routing', () => {
  it('falls back to required capabilities when no owner, assignee, or role resolves', () => {
    const agent = agentForTask({
      assignee: '@unknown',
      requiredCapabilities: ['backend.implementation', 'api.integration'],
    });

    expect(agent.id).toBe('beam');
  });

  it('keeps explicit owner routing ahead of capability fallback', () => {
    const agent = agentForTask({
      owner: 'atlas',
      assignee: '@unknown',
      requiredCapabilities: ['backend.implementation'],
    });

    expect(agent.id).toBe('atlas');
  });
});
