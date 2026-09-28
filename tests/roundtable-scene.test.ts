import { describe, expect, it } from 'vitest';
import { speechPlacementForSeat } from '../src/ui/components/roundtable.jsx';

describe('roundtable speech placement', () => {
  it('shows the Planning speaker below the head seat', () => {
    expect(speechPlacementForSeat(
      { agentId: 'orchestrator', head: true },
      { agentId: 'orchestrator', mode: 'speaking', text: 'Let us align.' },
    )).toEqual({ show: true, drop: true });
  });

  it('keeps other speakers above their seats', () => {
    expect(speechPlacementForSeat(
      { agentId: 'atlas', head: false },
      { agentId: 'atlas', mode: 'speaking', text: 'I can take this.' },
    )).toEqual({ show: true, drop: false });
  });

  it('does not show another agent speech on the wrong seat', () => {
    expect(speechPlacementForSeat(
      { agentId: 'nova', head: false },
      { agentId: 'atlas', mode: 'speaking', text: 'I can take this.' },
    )).toEqual({ show: false, drop: false });
  });
});
