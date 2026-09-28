import { describe, expect, it } from 'vitest';
import { planSummaryForDisplay, planTaskObjective } from '../src/ui/lib/plan-presentation.js';

describe('plan presentation', () => {
  it('shows an explicit meeting objective when one exists', () => {
    expect(planTaskObjective({
      role: 'implementer',
      objective: '实现镜头筛选、排序和评论功能，并验证移动端。',
      brief: 'User request: 生成镜头排行网站',
    })).toBe('实现镜头筛选、排序和评论功能，并验证移动端。');
  });

  it('turns legacy placeholder briefs into concrete CLI work', () => {
    const brief = [
      'Build lens ranking site. Agent: Atlas. Role: implementer. User request: 生成一个镜头排行网站，支持按评分、价格和焦距排序筛选，并提供评论。',
      'Planning meeting objective: Build · awaiting plan (Atlas)',
      'Acceptance criteria:\n- 功能可用。',
    ].join('\n\n');

    expect(planTaskObjective({ role: 'implementer', brief, title: 'Build · Atlas' }))
      .toContain('评分、价格和焦距排序筛选');
  });

  it('replaces scheduler-only summaries with a readable execution summary', () => {
    expect(planSummaryForDisplay({
      summary: 'Executable plan after the planning meeting: 4 CLI tasks.',
      tasks: [{ title: '构建页面', brief: '构建页面' }, {}, {}, {}],
    })).toBe('主要执行计划共 4 个 CLI 任务；确认后按下面的前置依赖顺序执行。');
  });
});
