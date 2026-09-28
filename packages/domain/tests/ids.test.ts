import { describe, expect, expectTypeOf, it } from 'vitest';

import type { MissionId, WorkspaceId } from '../src/index.js';

describe('opaque IDs', () => {
  it('remain serializable but type-distinct', () => {
    const id = 'workspace_01' as WorkspaceId;

    expect(String(id)).toBe('workspace_01');
    expectTypeOf(id).toMatchTypeOf<string>();
    expectTypeOf(id).not.toEqualTypeOf<MissionId>();
  });
});
