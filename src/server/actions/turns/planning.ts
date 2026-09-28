import type { Intake, Plan, PlanTask, WorkflowStage, WorkflowTemplate, WorkingStyleSnapshot } from '../../types.js';
import { AGENT_ROSTER, mentionedAgents, mentionTokens, messageWithoutMentions, type AgentProfile } from '../agent-roster.js';
import { emptyWorkingStyle } from '../skill-actions.js';
import { updateTurn } from './turn-store.js';

export function intakeFromMessage(message: string): Intake {
  const lower = message.toLowerCase();
  const intentType = isQuestionMessage(message)
    ? 'question'
    : lower.includes('review')
      ? 'review'
      : lower.includes('fix') || lower.includes('bug')
        ? 'fix'
        : lower.includes('research')
          ? 'research'
          : 'build';
  return {
    intentType,
    summary: message.slice(0, 220),
    clarity: message.length > 24 ? 'high' : 'medium',
    risk: lower.includes('payment') || lower.includes('auth') ? 'high' : 'medium',
  };
}

// A question gets an ANSWER, not a build pipeline: no clarify gate, no
// implementer/reviewer chain, no previewable page. Conservative on purpose —
// any build verb keeps the message on the build path, because "帮我做个网站吗?"
// is a request, not a question.
export function isQuestionMessage(message: string): boolean {
  const trimmed = messageWithoutMentions(message).trim() || message.trim();
  const interrogative = /[?？]\s*$/.test(trimmed)
    || /[吗呢]\s*[?？]?\s*$/.test(trimmed)
    || /^(why|how|what|when|where|which|who|whose|is|are|was|were|does|do|did|can|could|should|would|explain|tell me)\b/i.test(trimmed)
    || /\b(why|how|what)\b/i.test(trimmed)
    || /(为什么|为啥|怎么|怎样|如何|什么|哪个|哪些|是不是|能不能|可不可以|有没有|解释一下|讲讲|说说)/.test(trimmed);
  const buildVerb = /\b(build|create|make|implement|add|write|code|develop|generate|refactor|fix|repair|deploy|update|remove|delete|rename|install|set\s?up)\b/i.test(trimmed)
    || /(做|建|写|开发|生成|搭|实现|修复|修改|修好|改成|改进|添加|加上|部署|创建|删除|重构|安装|帮我把)/.test(trimmed);
  return interrogative && !buildVerb;
}

export function planFromMessage(
  message: string,
  workingStyle: WorkingStyleSnapshot = emptyWorkingStyle(),
  intentType?: Intake['intentType'],
  template?: WorkflowTemplate,
): Plan {
  const goal = messageWithoutMentions(message) || message;
  const base = compactTitle(goal);
  const hasExplicitMention = mentionTokens(message).length > 0;
  const targets = mentionedAgents(message);
  const explicitPlanningOnly = targets.length === 1 && targets[0]?.role === 'planner';
  const startsWithPlanning = targets.some((agent) => agent.role === 'planner') || targets.length === AGENT_ROSTER.length;
  const tasks: PlanTask[] = [];

  // A question needs exactly one agent reading the workspace and answering —
  // not a plan→build→review pipeline. Explicit @mentions still win.
  if (intentType === 'question' && !hasExplicitMention) {
    return {
      summary: `Answer: ${base}`,
      tasks: [taskForAgent('task_answer', `Answer: ${base}`, planner(), goal, [], false, 'answer', workingStyle)],
    };
  }

  if (!hasExplicitMention) {
    // The workflow template is the source of truth for the default chain:
    // stage order, seats, and parallelism come from the (possibly user-edited)
    // template, so reordering stages in the Workflow editor changes what runs.
    const templateTasks = template ? tasksFromTemplate(template, message, base, workingStyle) : [];
    if (templateTasks.length > 0) {
      return { summary: `Plan for: ${base}`, tasks: templateTasks };
    }
    // No template (or a template with no runnable stages): fall back to the
    // canonical architect-bracketed chain.
    const implementer = implementerForMessage(message);
    const reviewerAgent = reviewer();
    const architectAgent = architect();
    return {
      summary: `Plan for: ${base}`,
      tasks: [
        taskForAgent('task_planning', `Plan ${base}`, planner(), goal, [], false, 'plan', workingStyle),
        taskForAgent(`task_${architectAgent.id}`, titleForAgent(architectAgent, base), architectAgent, goal, ['task_planning'], false, 'plan', workingStyle),
        taskForAgent(`task_${implementer.id}`, titleForAgent(implementer, base), implementer, goal, ['task_planning', `task_${architectAgent.id}`], false, 'build', workingStyle),
        taskForAgent(`task_${reviewerAgent.id}`, titleForAgent(reviewerAgent, base), reviewerAgent, goal, [`task_${implementer.id}`], false, 'review', workingStyle),
        taskForAgent(`task_${architectAgent.id}_check`, 'Architecture check · awaits the build', architectAgent, goal, [`task_${implementer.id}`], false, 'review', workingStyle),
      ],
    };
  }

  if (startsWithPlanning || explicitPlanningOnly) {
    tasks.push(taskForAgent('task_planning', `Plan ${base}`, planner(), goal, [], false, 'plan', workingStyle));
  }

  if (!explicitPlanningOnly) {
    let previousTaskId = startsWithPlanning ? 'task_planning' : null;
    for (const agent of targets.filter((target) => target.role !== 'planner')) {
      const idValue = `task_${agent.id}`;
      tasks.push(taskForAgent(
        idValue,
        titleForAgent(agent, base),
        agent,
        goal,
        previousTaskId ? [previousTaskId] : [],
        false,
        stageIdForAgent(agent),
        workingStyle,
      ));
      previousTaskId = idValue;
    }
  }

  return {
    summary: `Plan for: ${base}`,
    tasks: tasks.length > 0 ? tasks : [taskForAgent('task_planning', `Plan ${base}`, planner(), goal, [], false, 'plan', workingStyle)],
  };
}

// Task-generating stage kinds. intake (user), clarify (clarify gate), repair
// (derived at runtime by the fix loop), and ship (final-delivery acceptance)
// are runtime-managed and never planned as agent tasks up front.
const RUNNABLE_STAGE_KINDS = new Set(['plan', 'work', 'review']);

/**
 * Generate the task DAG from a workflow template's stages, in stage order.
 *
 * Semantics — kept deliberately simple so the Workflow editor's mental model
 * matches execution exactly:
 * - Each runnable stage contributes one task per agent seat (user seats skip).
 * - A seat pinned to an agent uses that agent; a role-only seat resolves at
 *   plan time (implementer → by message keywords, others → roster default).
 * - Within a 'plan' stage seats chain sequentially (planner → architect needs
 *   the plan); within 'work'/'review' stages seats run in parallel.
 * - Every task in stage N depends on all tasks of the previous runnable stage,
 *   so reordering stages in the editor reorders execution.
 */
export function tasksFromTemplate(
  template: WorkflowTemplate,
  message: string,
  base: string,
  workingStyle: WorkingStyleSnapshot,
): PlanTask[] {
  const goal = messageWithoutMentions(message) || message;
  const tasks: PlanTask[] = [];
  const usedIds = new Set<string>();
  let previousStageTaskIds: string[] = [];

  for (const stage of template.stages) {
    if (!RUNNABLE_STAGE_KINDS.has(stage.kind)) continue;
    const agents = agentsForStage(stage, message);
    if (agents.length === 0) continue;

    const stageTaskIds: string[] = [];
    const sequential = stage.kind === 'plan';
    for (const agent of agents) {
      const idValue = taskIdFor(agent, stage, usedIds);
      usedIds.add(idValue);
      const deps = sequential && stageTaskIds.length > 0
        ? [stageTaskIds[stageTaskIds.length - 1]!]
        : [...previousStageTaskIds];
      const task = taskForAgent(
        idValue,
        stageTitleForAgent(agent, stage, base),
        agent,
        goal,
        deps,
        !sequential && agents.length > 1,
        stage.id,
        workingStyle,
      );
      tasks.push({ ...task, stageKind: stage.kind });
      stageTaskIds.push(idValue);
    }
    previousStageTaskIds = stageTaskIds;
  }
  return tasks;
}

// Resolve a stage's seats to concrete agents. Role-only implementer seats
// resolve by message keywords (backend-ish → beam, else atlas). Seats that
// resolve to the same agent within one stage are deduped — a template listing
// atlas AND beam as implementer candidates still yields one implementer per
// stage unless the seats pin different agents explicitly... they DO pin here,
// so a multi-pinned work stage keeps only the message-preferred implementer
// when all its seats share the implementer role (candidate pool), and keeps
// every agent otherwise (deliberate multi-agent stage).
function agentsForStage(stage: WorkflowStage, message: string): AgentProfile[] {
  const roleSeats = stage.seats.filter(
    (seatItem): seatItem is typeof seatItem & { ref: { kind: 'role'; role: string; agentId?: string } } =>
      seatItem.ref.kind === 'role',
  );
  if (roleSeats.length === 0) return [];

  // Candidate-pool case: a work stage whose seats are all implementers is
  // "whoever fits the job", not "everyone at once" — resolve by message.
  const allImplementers = roleSeats.every((seatItem) => seatItem.ref.role === 'implementer');
  if (stage.kind === 'work' && allImplementers && roleSeats.length > 1) {
    return [implementerForMessage(message)];
  }

  const resolved: AgentProfile[] = [];
  for (const seatItem of roleSeats) {
    const agent = seatItem.ref.agentId
      ? AGENT_ROSTER.find((item) => item.id === seatItem.ref.agentId)
      : seatItem.ref.role === 'implementer'
        ? implementerForMessage(message)
        : AGENT_ROSTER.find((item) => item.role === seatItem.ref.role);
    if (agent && !resolved.some((item) => item.id === agent.id)) resolved.push(agent);
  }
  return resolved;
}

// Stable ids: the planner keeps its historic 'task_planning' id (the fix loop
// and retitle logic key off it); everyone else gets task_<agent>; an agent
// seated in two stages (architect: design + check) gets task_<agent>_<stage>.
function taskIdFor(agent: AgentProfile, stage: WorkflowStage, used: Set<string>): string {
  const preferred = agent.role === 'planner' ? 'task_planning' : `task_${agent.id}`;
  if (!used.has(preferred)) return preferred;
  const staged = `task_${agent.id}_${stage.id}`;
  if (!used.has(staged)) return staged;
  let index = 2;
  while (used.has(`${staged}_${index}`)) index += 1;
  return `${staged}_${index}`;
}

function stageTitleForAgent(agent: AgentProfile, stage: WorkflowStage, base: string): string {
  if (agent.role === 'planner') return `Plan ${base}`;
  if (agent.role === 'architect' && stage.kind === 'review') return 'Architecture check · awaits the build';
  return titleForAgent(agent, base);
}

function taskForAgent(
  idValue: string,
  title: string,
  agent: AgentProfile,
  message: string,
  deps: string[],
  parallel: boolean,
  stageId: string,
  workingStyle: WorkingStyleSnapshot = emptyWorkingStyle(),
): PlanTask {
  const styleContext = formatWorkingStyleForPrompt(workingStyle);
  return {
    id: idValue,
    title,
    assignee: agent.assignee,
    owner: agent.id,
    role: agent.role,
    stageId,
    requiredCapabilities: agent.capabilities,
    brief: [
      `${title}. Agent: ${agent.displayName}. Role: ${agent.role}. User request: ${message}`,
      styleContext ? `Working style:\n${styleContext}` : '',
    ].filter(Boolean).join('\n\n'),
    deps,
    parallel,
  };
}

function stageIdForAgent(agent: AgentProfile): string {
  if (agent.role === 'planner' || agent.role === 'architect' || agent.role === 'pm') return 'plan';
  if (agent.role === 'reviewer') return 'review';
  if (agent.role === 'fixer') return 'repair';
  return 'build';
}

// Concrete title for a downstream task AFTER the planner has run. At this point
// the plan defines the work, so naming the goal is accurate (not a guess). Used
// by retitleDownstreamTasks() to replace the "awaiting plan" placeholders.
function plannedTitleForRole(role: string | undefined, stageRef: string | undefined, displayName: string, goal: string): string {
  if (role === 'pm') return `Product brief for ${goal}`;
  // The architect appears twice in the default chain: design (plan stage)
  // before the build, and the architecture check (review stage) after it.
  if (role === 'architect') {
    return stageRef === 'review' ? `Architecture check for ${goal}` : `Architecture for ${goal}`;
  }
  if (role === 'implementer') return `Build ${goal} (${displayName})`;
  if (role === 'reviewer') return `Review ${goal}`;
  if (role === 'fixer') return `Fix issues for ${goal}`;
  return `Plan ${goal}`;
}

// Concrete title+brief for every task that (transitively) depends on the
// planner, computed once the plan exists. Pure so the dispatch loop can apply
// the same patches to its in-memory scheduler tasks (the scheduler snapshots
// the graph before the planner runs, so persisting alone is not enough — the
// model prompts and artifact paths read the in-memory objects).
export function plannedTaskPatches(
  tasks: PlanTask[],
  plannerTaskId: string,
  message: string,
): Map<string, { title: string; brief: string }> {
  const goal = compactTitle(messageWithoutMentions(message) || message);
  // Build the set of tasks reachable from the planner via deps.
  const downstream = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (downstream.has(task.id)) continue;
      if (task.deps.includes(plannerTaskId) || task.deps.some((dep) => downstream.has(dep))) {
        downstream.add(task.id);
        changed = true;
      }
    }
  }
  const ownerName = (task: PlanTask): string =>
    AGENT_ROSTER.find((agent) => agent.id === task.owner)?.displayName ?? task.owner ?? task.role ?? 'agent';
  const patches = new Map<string, { title: string; brief: string }>();
  for (const task of tasks) {
    if (!downstream.has(task.id)) continue;
    const title = plannedTitleForRole(task.role, task.stageKind ?? task.stageId, ownerName(task), goal);
    patches.set(task.id, {
      title,
      // Mirror taskForAgent()'s brief shape so the handoff card reads the same.
      brief: `${title}. Agent: ${ownerName(task)}. Role: ${task.role ?? 'agent'}. User request: ${message}`,
    });
  }
  return patches;
}

// Once the planner task completes, rewrite every task that (transitively)
// depends on it from its placeholder title to a concrete one. The plan now
// exists, so the downstream tasks have a real, named scope.
export async function retitleDownstreamTasks(turnId: string, plannerTaskId: string, message: string): Promise<void> {
  await updateTurn(turnId, (current) => {
    const patches = plannedTaskPatches(current.plan.tasks, plannerTaskId, message);
    if (patches.size === 0) return current;
    return {
      ...current,
      plan: {
        ...current.plan,
        tasks: current.plan.tasks.map((task) => {
          const patch = patches.get(task.id);
          return patch ? { ...task, ...patch } : task;
        }),
      },
    };
  });
}

function planner(): AgentProfile {
  return AGENT_ROSTER.find((agent) => agent.role === 'planner') ?? AGENT_ROSTER[0]!;
}

function reviewer(): AgentProfile {
  return AGENT_ROSTER.find((agent) => agent.role === 'reviewer') ?? planner();
}

function architect(): AgentProfile {
  return AGENT_ROSTER.find((agent) => agent.role === 'architect') ?? planner();
}

function implementerForMessage(message: string): AgentProfile {
  const lower = message.toLowerCase();
  const wantsBackend = /\b(api|backend|server|database|db|auth|login|endpoint|接口|后端|数据库|登录|鉴权)\b/i.test(lower);
  const preferredId = wantsBackend ? 'beam' : 'atlas';
  return AGENT_ROSTER.find((agent) => agent.id === preferredId)
    ?? AGENT_ROSTER.find((agent) => agent.role === 'implementer')
    ?? planner();
}

// Title for a task at PLAN TIME — before the planner has run. Only the planner
// itself knows the concrete goal up front; every downstream task is still
// undefined (its real scope is decided once the plan lands), so we show a
// responsibility placeholder, NOT the user's raw request. dispatchTurn() later
// rewrites these from the planner's actual output via retitleDownstreamTasks().
function titleForAgent(agent: AgentProfile, base: string): string {
  if (agent.role === 'planner') return `Plan ${base}`;
  if (agent.role === 'pm') return 'Product brief · awaiting plan';
  if (agent.role === 'architect') return 'Architecture · awaiting plan';
  if (agent.role === 'implementer') return `Build · awaiting plan (${agent.displayName})`;
  if (agent.role === 'reviewer') return 'Review · awaits the build';
  if (agent.role === 'fixer') return 'Fix issues · awaits review';
  return `Plan ${base}`;
}

export function formatWorkingStyleForPrompt(workingStyle: WorkingStyleSnapshot | null | undefined): string {
  const skills = workingStyle?.skills ?? [];
  const projectRules = workingStyle?.projectRules ?? [];
  const lines = [
    ...skills.map((skill) => `- ${skill.label}: ${skill.description}`),
    ...projectRules.map((rule) => `- Project rule: ${rule}`),
  ];
  return lines.join('\n');
}

export function compactTitle(message: string): string {
  // Titles should read as the core ask, not the whole enriched goal. Drop the
  // clarification block appended by applyAnswers() ("...\n\nClarified
  // requirements:\n- ...") so Plan/Build/Review titles don't all repeat the same
  // long string. The full enriched text still lives in each task's brief.
  const core = stripClarification(message);
  return core.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Roundtable task';
}

// Mirror of applyAnswers()'s appended block ("\n\nClarified requirements:\n…").
// Whitespace-tolerant: by the time a title is built the goal may have had its
// newlines collapsed to single spaces, so match either form. Keep the marker
// text in sync with clarify-actions.ts applyAnswers().
const CLARIFICATION_MARKER = /\s*Clarified requirements:[\s\S]*$/;

function stripClarification(message: string): string {
  return message.replace(CLARIFICATION_MARKER, '');
}
