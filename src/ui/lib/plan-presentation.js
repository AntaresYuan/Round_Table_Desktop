const GENERIC_SUMMARY = /^(?:Executable plan after|Meeting closed with)\b/i;
const PLACEHOLDER_OBJECTIVE = /(?:awaiting plan|awaits the build|^Architecture\s*[·:]|^Build\s*[·:]|^Review\s*[·:])/i;

function extractBriefSection(brief, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\n\\n)${escaped}:\\s*([\\s\\S]*?)(?=\\n\\n(?:Clarified requirements|Planning meeting objective|Acceptance criteria|Locked prerequisites):|$)`,
    'i',
  );
  return String(brief || '').match(pattern)?.[1]?.trim() || '';
}

function compactGoal(value, max = 76) {
  const clean = String(value || '')
    .replace(/\s*Clarified requirements:[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max).trim()}…` : clean;
}

function extractUserRequest(brief) {
  return String(brief || '').match(
    /User request:\s*([\s\S]*?)(?=\n\n(?:Clarified requirements|Planning meeting objective|Acceptance criteria|Locked prerequisites):|$)/i,
  )?.[1]?.trim() || '';
}

function planTaskObjective(task) {
  const explicit = String(task?.objective || '').trim();
  const fromBrief = extractBriefSection(task?.brief, 'Planning meeting objective');
  const agreed = explicit || fromBrief;
  if (agreed && !PLACEHOLDER_OBJECTIVE.test(agreed)) return agreed;

  const goal = compactGoal(extractUserRequest(task?.brief) || task?.title);
  const zh = /[\u3400-\u9fff]/.test(`${goal} ${task?.brief || ''}`);
  const stage = task?.stageKind || task?.stageId;
  if (zh) {
    if (task?.role === 'architect' && stage === 'review') {
      return '复核实现是否遵守已经确定的模块边界、复用方式和依赖关系，并指出集成风险。';
    }
    if (task?.role === 'architect') {
      return '检查真实代码入口和可复用部分，确定页面结构、数据流、模块边界与实现约束。';
    }
    if (task?.role === 'implementer') {
      return `在现有项目中完成核心页面与交互：${goal || '用户确认的功能'}，并提供可运行结果和移动端验证。`;
    }
    if (task?.role === 'reviewer') {
      return '独立检查构建结果是否覆盖需求、关键交互和移动端，列出带证据的阻塞或回归问题。';
    }
    if (task?.role === 'fixer') return '只修复审查确认的问题，并补充对应的回归验证。';
    return goal || '完成分配的工作，并附上验证证据。';
  }
  if (task?.role === 'architect' && stage === 'review') {
    return 'Check that the implementation follows the agreed module boundaries, reuse strategy, and dependencies, and flag integration risk.';
  }
  if (task?.role === 'architect') {
    return 'Inspect the real entrypoint and reusable code, then define page structure, data flow, module boundaries, and implementation constraints.';
  }
  if (task?.role === 'implementer') {
    return `Build the core pages and interactions in the existing project for: ${goal || 'the approved scope'}, with a runnable result and mobile verification.`;
  }
  if (task?.role === 'reviewer') {
    return 'Independently check requirement coverage, critical interactions, mobile behavior, and regressions, with evidence for every blocker.';
  }
  if (task?.role === 'fixer') return 'Repair only the confirmed review findings and add matching regression evidence.';
  return goal || 'Complete the assigned work and attach verification evidence.';
}

function planSummaryForDisplay(plan) {
  const summary = String(plan?.summary || '').trim();
  if (summary && !GENERIC_SUMMARY.test(summary)) return summary;
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const zh = tasks.some((task) => /[\u3400-\u9fff]/.test(`${task?.brief || ''} ${task?.title || ''}`));
  return zh
    ? `主要执行计划共 ${tasks.length} 个 CLI 任务；确认后按下面的前置依赖顺序执行。`
    : `${tasks.length} CLI tasks make up the main execution plan; after approval they run in the dependency order below.`;
}

export { extractBriefSection, extractUserRequest, planTaskObjective, planSummaryForDisplay };
