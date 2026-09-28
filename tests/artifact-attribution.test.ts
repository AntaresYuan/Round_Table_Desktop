import { describe, expect, it } from 'vitest';
import { lineChangeStats } from '../src/server/actions/turns/diff-stats.js';
import { artifactsFromRun, upsertArtifacts } from '../src/server/actions/turns/artifacts.js';
import type { Artifact, LocalTurn, PlanTask } from '../src/server/types.js';

describe('lineChangeStats — which lines changed between versions', () => {
  it('reports zero for identical text', () => {
    expect(lineChangeStats('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
  });

  it('counts pure additions', () => {
    expect(lineChangeStats('a\nb', 'a\nb\nc\nd')).toEqual({ added: 2, removed: 0 });
  });

  it('counts pure removals', () => {
    expect(lineChangeStats('a\nb\nc\nd', 'a\nd')).toEqual({ added: 0, removed: 2 });
  });

  it('counts a replaced middle block as added + removed', () => {
    expect(lineChangeStats('a\nOLD\nz', 'a\nNEW1\nNEW2\nz')).toEqual({ added: 2, removed: 1 });
  });

  it('treats a brand-new file as all lines added', () => {
    expect(lineChangeStats('', 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
  });
});

function makeTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 'T1',
    title: 'Build the page',
    assignee: '@implementer',
    owner: 'atlas',
    role: 'implementer',
    stageId: 'build',
    requiredCapabilities: [],
    brief: 'build',
    deps: [],
    parallel: false,
    ...overrides,
  };
}

function makeTurn(): LocalTurn {
  return {
    id: 'turn-1',
    localChatId: 'chat-1',
    ownerId: null,
    missionId: 'mission-1',
    workflowTemplateId: 'wf-default',
    message: 'build a page',
  } as LocalTurn;
}

describe('artifactsFromRun — attribution on produced files', () => {
  it('stamps every workspace file with the owning agent and an all-added change', () => {
    const { all } = artifactsFromRun(makeTurn(), makeTask(), {
      text: 'done',
      path: '.roundtable/runs/logs/t1.md',
      kind: 'markdown',
      files: [{ path: 'app/page.tsx', text: 'line1\nline2\nline3', kind: 'code' }],
    });
    const file = all.find((artifact) => artifact.title === 'app/page.tsx');
    expect(file?.ownerAgentId).toBe('atlas');
    expect(file?.change).toEqual({ added: 3, removed: 0 });
  });
});

describe('upsertArtifacts — version bumps carry change stats and last editor', () => {
  const base: Artifact = {
    id: 'file_app-page_chat-1',
    chatId: 'chat-1',
    kind: 'code',
    title: 'app/page.tsx',
    ownerAgentId: 'atlas',
    version: 1,
    uri: 'workspace://app/page.tsx',
    preview: 'a\nb\nc',
    code: 'a\nb\nc',
    createdAt: '2026-07-04T00:00:00.000Z',
    change: { added: 3, removed: 0 },
  };

  it('computes change stats against the previous version and bumps the version', () => {
    const target: Artifact[] = [{ ...base }];
    upsertArtifacts(target, [{
      ...base,
      ownerAgentId: 'vera',
      preview: 'a\nb\nc\nd\ne',
      code: 'a\nb\nc\nd\ne',
    }]);
    expect(target).toHaveLength(1);
    expect(target[0]!.version).toBe(2);
    expect(target[0]!.ownerAgentId).toBe('vera');
    expect(target[0]!.change).toEqual({ added: 2, removed: 0 });
  });

  it('keeps version and existing change when content is unchanged', () => {
    const target: Artifact[] = [{ ...base }];
    upsertArtifacts(target, [{ ...base, ownerAgentId: 'vera' }]);
    expect(target[0]!.version).toBe(1);
    expect(target[0]!.change).toEqual({ added: 3, removed: 0 });
  });
});
