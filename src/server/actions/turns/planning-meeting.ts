import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  AgentRole,
  ModelProviderKind,
  Plan,
  PlanTask,
  PlanningMeeting,
  PlanningMeetingDecision,
  PlanningMeetingMessage,
} from '../../types.js';
import { AGENT_ROSTER, agentForTask, type AgentProfile } from '../agent-roster.js';
import { runOnMiniMax } from '../adapters/minimax-adapter.js';
import { runOnOpenAICompat } from '../adapters/openai-compat-adapter.js';
import { defaultConfiguredModelProvider, resolveModelProvider } from '../settings-actions.js';

const POSITION_WORD_LIMIT = 120;
const CHALLENGE_WORD_LIMIT = 100;
const DECISION_WORD_LIMIT = 220;
const SYNTHESIS_WORD_LIMIT = 420;
const MAX_PARTICIPANTS = 5;
const MAX_REPOSITORY_FILES = 120;
const MAX_REPOSITORY_DEPTH = 4;
const MAX_CONTEXT_CHARS = 8_000;
const MODEL_TIMEOUT_MS = 12_000;
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.next', '.roundtable', 'node_modules', 'dist', 'build', 'coverage', 'out', 'tmp',
]);

type MeetingTaskNote = {
  taskId: string;
  objective: string;
  acceptanceCriteria: string[];
};

type MeetingSynthesis = {
  summary: string;
  decisions: Array<{ summary: string; rationale: string; taskIds: string[] }>;
  risks: string[];
  unresolved: string[];
  taskNotes: MeetingTaskNote[];
};

type RepositoryBrief = {
  prompt: string;
  summary: string;
};

type MeetingModel = {
  provider: ModelProviderKind;
  model: string;
};

const SynthesisSchema = z.object({
  summary: z.string().min(1).max(600),
  decisions: z.array(z.object({
    summary: z.string().min(1).max(280),
    rationale: z.string().max(500).default(''),
    taskIds: z.array(z.string()).max(12).default([]),
  })).max(8).default([]),
  risks: z.array(z.string().min(1).max(280)).max(6).default([]),
  unresolved: z.array(z.string().min(1).max(280)).max(4).default([]),
  taskNotes: z.array(z.object({
    taskId: z.string(),
    objective: z.string().min(1).max(400),
    acceptanceCriteria: z.array(z.string().min(1).max(240)).max(5).default([]),
  })).max(20).default([]),
});

const ROLE_MANDATES: Record<AgentRole, string> = {
  planner: 'Own scope, sequencing, dependency clarity, and the smallest complete execution plan.',
  pm: 'Own user value, missing requirements, explicit trade-offs, and observable acceptance criteria.',
  architect: 'Own module boundaries, reuse, contracts, failure modes, and integration risk. Prefer proven simple architecture.',
  implementer: 'Own implementation feasibility, codebase fit, testability, and concrete delivery effort.',
  reviewer: 'Act as an independent quality gate. Look for hidden assumptions, regressions, security gaps, and missing evidence.',
  fixer: 'Own narrowly scoped repair feasibility and regression containment.',
};

/**
 * Runs a bounded planning meeting before any coding runtime starts.
 *
 * The interaction is a facilitated relay rather than an all-to-all debate:
 * product and architecture form independent views in parallel, implementation
 * responds to those views, review challenges the proposed execution, and the
 * planner closes with a validated contract. This keeps the call graph O(n),
 * preserves professional independence, and avoids five repetitive mini-plans.
 */
export async function conductPlanningMeeting(input: {
  message: string;
  plan: Plan;
  workspace: string | null;
  now: string;
}): Promise<{ meeting: PlanningMeeting; plan: Plan }> {
  const startedAt = input.now;
  const participants = meetingParticipants(input.plan);
  const repository = await buildRepositoryBrief(input.workspace);
  const model = await resolveMeetingModel();
  let usedFallback = model === null;

  const opening = meetingMessage({
    id: 'meeting_opening',
    phase: 'opening',
    agent: plannerAgent(),
    content: localOpening(input.message, participants),
    now: startedAt,
    wordLimit: POSITION_WORD_LIMIT,
  });

  const perspectiveAgents = meetingPerspectiveAgents(participants);
  const positions = await Promise.all(perspectiveAgents.map(async (agent) => {
    if (!model) return localPosition(agent, input.message, input.plan, repository.summary, startedAt);
    try {
      const content = await callMeetingModel(model, [
        independentSystemPrompt(agent, input.message),
        `Repository context:\n${repository.prompt}`,
        `Draft execution graph (treat as a proposal, not authority):\n${compactPlan(input.plan)}`,
        perspectiveInstruction(agent),
      ].join('\n\n'), POSITION_WORD_LIMIT);
      return meetingMessage({
        id: `meeting_position_${agent.id}`,
        phase: 'position',
        agent,
        content,
        now: startedAt,
        wordLimit: POSITION_WORD_LIMIT,
      });
    } catch {
      usedFallback = true;
      return localPosition(agent, input.message, input.plan, repository.summary, startedAt);
    }
  }));

  const positionTranscript = transcriptForPrompt(positions);
  const implementer = participants.find((agent) => agent.role === 'implementer') ?? plannerAgent();
  const executionHandoff = localFacilitation(implementer, input.message, positions, startedAt);
  let commitment: PlanningMeetingMessage;
  if (!model) {
    commitment = localCommitment(implementer, input.message, positions, input.plan, startedAt);
  } else {
    try {
      const content = await callMeetingModel(model, [
        independentSystemPrompt(implementer, input.message),
        'The product and architecture seats have spoken. Respond to them as the execution owner. Say what sounds workable, what needs a small adjustment, and where you would start. Do not repeat their proposals.',
        positionTranscript,
        `Speak in 2–4 natural sentences, within ${CHALLENGE_WORD_LIMIT} words (or 260 Chinese characters). Avoid a component-by-component or file-by-file list unless one name is essential to the decision.`,
      ].join('\n\n'), CHALLENGE_WORD_LIMIT);
      commitment = meetingMessage({
        id: `meeting_commitment_${implementer.id}`,
        phase: 'commitment',
        agent: implementer,
        content,
        now: startedAt,
        wordLimit: CHALLENGE_WORD_LIMIT,
        references: positions.map((message) => message.id),
      });
    } catch {
      usedFallback = true;
      commitment = localCommitment(implementer, input.message, positions, input.plan, startedAt);
    }
  }

  const reviewer = participants.find((agent) => agent.role === 'reviewer') ?? plannerAgent();
  const reviewContext = [...positions, commitment];
  let challenge: PlanningMeetingMessage;
  if (!model) {
    challenge = localReviewChallenge(reviewer, input.message, reviewContext, input.plan, startedAt);
  } else {
    try {
      const content = await callMeetingModel(model, [
        independentSystemPrompt(reviewer, input.message),
        'Act as the final independent gate. Respond like a teammate doing the last check before work starts. Say plainly whether anything blocks the team, name the one or two risks that matter most, and say what proof you expect at delivery.',
        transcriptForPrompt(reviewContext),
        `Speak in 2–4 natural sentences, within ${CHALLENGE_WORD_LIMIT} words (or 260 Chinese characters). Do not use BLOCKER/RISK/EVIDENCE headings. If there is no blocker, just say that naturally.`,
      ].join('\n\n'), CHALLENGE_WORD_LIMIT);
      challenge = meetingMessage({
        id: `meeting_challenge_${reviewer.id}`,
        phase: 'challenge',
        agent: reviewer,
        content,
        now: startedAt,
        wordLimit: CHALLENGE_WORD_LIMIT,
        references: reviewContext.map((message) => message.id),
      });
    } catch {
      usedFallback = true;
      challenge = localReviewChallenge(reviewer, input.message, reviewContext, input.plan, startedAt);
    }
  }

  const synthesis = model
    ? await synthesizeWithModel(model, input, repository, positions, [commitment, challenge]).catch(() => {
        usedFallback = true;
        return localSynthesis(input.plan, repository.summary, input.message);
      })
    : localSynthesis(input.plan, repository.summary, input.message);
  const decisions = validatedDecisions(synthesis.decisions, input.plan);
  const decisionMessage = meetingMessage({
    id: 'meeting_decision_planner',
    phase: 'decision',
    agent: plannerAgent(),
    content: limitText(synthesis.summary, DECISION_WORD_LIMIT),
    now: startedAt,
    wordLimit: DECISION_WORD_LIMIT,
    references: [...positions, executionHandoff, commitment, challenge].map((message) => message.id),
  });
  const meeting: PlanningMeeting = {
    status: usedFallback ? 'fallback' : 'completed',
    algorithm: 'facilitated-role-relay-v2',
    provider: model?.provider ?? 'local-deterministic',
    model: model?.model ?? 'bounded-rules-v1',
    participants: participants.map((agent) => agent.id),
    messages: [opening, ...positions, executionHandoff, commitment, challenge, decisionMessage],
    decisions,
    risks: uniqueLimited(synthesis.risks, 6),
    unresolved: uniqueLimited(synthesis.unresolved, 4),
    repositorySummary: repository.summary,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  return { meeting, plan: applyMeetingToPlan(input.plan, synthesis, decisions) };
}

export function applyMeetingToPlan(
  plan: Plan,
  synthesis: MeetingSynthesis,
  decisions: PlanningMeetingDecision[],
): Plan {
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  const notes = new Map(
    synthesis.taskNotes
      .filter((note) => taskIds.has(note.taskId))
      .map((note) => [note.taskId, note]),
  );
  return {
    ...plan,
    summary: synthesis.summary.trim() || plan.summary,
    tasks: plan.tasks.map((task) => {
      const note = notes.get(task.id);
      const taskDecisionIds = decisions
        .filter((decision) => decision.taskIds.includes(task.id))
        .map((decision) => decision.id);
      if (!note && taskDecisionIds.length === 0) return task;
      const agreement = note?.objective.trim();
      const criteria = uniqueLimited(note?.acceptanceCriteria ?? [], 5);
      return {
        ...task,
        ...(agreement ? { objective: agreement } : {}),
        brief: [
          task.brief,
          agreement ? `Planning meeting objective: ${agreement}` : '',
          criteria.length > 0 ? `Acceptance criteria:\n${criteria.map((item) => `- ${item}`).join('\n')}` : '',
          task.deps.length > 0
            ? `Locked prerequisites: ${task.deps.join(', ')}. Do not start until all are completed.`
            : 'Locked prerequisites: none; this task may start immediately after approval.',
        ].filter(Boolean).join('\n\n'),
        ...(criteria.length > 0 ? { acceptanceCriteria: criteria } : {}),
        ...(taskDecisionIds.length > 0 ? { meetingDecisionIds: taskDecisionIds } : {}),
      };
    }),
  };
}

function meetingParticipants(plan: Plan): AgentProfile[] {
  const planned = plan.tasks.map((task) => agentForTask(task));
  const preferred = [
    plannerAgent(),
    AGENT_ROSTER.find((agent) => agent.role === 'pm'),
    AGENT_ROSTER.find((agent) => agent.role === 'architect'),
    planned.find((agent) => agent.role === 'implementer'),
    AGENT_ROSTER.find((agent) => agent.role === 'reviewer'),
    ...planned,
  ].filter((agent): agent is AgentProfile => agent !== undefined);
  return preferred.filter((agent, index) =>
    preferred.findIndex((candidate) => candidate.id === agent.id) === index,
  ).slice(0, MAX_PARTICIPANTS);
}

function meetingPerspectiveAgents(participants: AgentProfile[]): AgentProfile[] {
  const selected = participants.filter((agent) => agent.role === 'pm' || agent.role === 'architect');
  return selected.length > 0 ? selected : participants.filter((agent) => agent.role !== 'planner').slice(0, 2);
}

function perspectiveInstruction(agent: AgentProfile): string {
  if (agent.role === 'pm') {
    return `Speak only from the planning/product angle in 2–4 natural sentences, within ${POSITION_WORD_LIMIT} words (or 300 Chinese characters). Tell the team what the user should get, what belongs in this round, and how everyone will know it is done. Do not prescribe architecture or implementation, and do not use report headings.`;
  }
  return `Speak only from the architecture angle in 2–4 natural sentences, within ${POSITION_WORD_LIMIT} words (or 300 Chinese characters). Give one clear structural recommendation, say what should be reused, and surface the most important concern. Do not repeat the product plan, volunteer to implement it, or dump a list of files and component names.`;
}

async function resolveMeetingModel(): Promise<MeetingModel | null> {
  if (process.env.ROUNDTABLE_PLANNING_MEETING_MODEL === 'local') return null;
  const provider = await defaultConfiguredModelProvider();
  if (!provider) return null;
  const config = await resolveModelProvider(provider);
  if (!config.configured) return null;
  const override = process.env.ROUNDTABLE_PLANNING_MEETING_MODEL?.trim();
  return { provider, model: override || config.model };
}

async function callMeetingModel(
  model: MeetingModel,
  prompt: string,
  wordLimit: number,
  format: 'spoken' | 'json' = 'spoken',
): Promise<string> {
  const messages = [
    {
      role: 'system' as const,
      content: format === 'json'
        ? 'Return only the requested valid JSON. Never reveal hidden chain-of-thought.'
        : 'You are taking one turn in a real software team meeting. Speak naturally in the same language as the user, using short sentences a teammate would actually say aloud. Do not use report-style headings, field labels, bullet lists, or boilerplate. Technical terms are welcome only when they change a decision; explain the rest in everyday language. Return only your concise meeting statement and never reveal hidden chain-of-thought.',
    },
    { role: 'user' as const, content: prompt },
  ];
  const result = model.provider === 'minimax'
    ? await runOnMiniMax({ messages, model: model.model, maxTokens: Math.max(180, wordLimit * 3), temperature: 0.2, timeoutMs: MODEL_TIMEOUT_MS, thinking: false })
    : await runOnOpenAICompat({ messages, model: model.model, maxTokens: Math.max(180, wordLimit * 3), temperature: 0.2, timeoutMs: MODEL_TIMEOUT_MS });
  if (!result.text.trim()) throw new Error('empty_meeting_response');
  return limitText(result.text, wordLimit);
}

async function synthesizeWithModel(
  model: MeetingModel,
  input: { message: string; plan: Plan },
  repository: RepositoryBrief,
  positions: PlanningMeetingMessage[],
  challenges: PlanningMeetingMessage[],
): Promise<MeetingSynthesis> {
  const prompt = [
    'You are the Planner chair. Resolve the meeting into an execution contract. Preserve genuine objections as risks; do not invent consensus.',
    `User goal: ${input.message}`,
    `Repository: ${repository.prompt}`,
    `Draft graph:\n${compactPlan(input.plan)}`,
    `Meeting transcript:\n${transcriptForPrompt([...positions, ...challenges])}`,
    'The planning meeting itself completes task_planning. Describe the executable CLI work that follows; do not schedule another CLI planning pass.',
    'The summary field will be spoken aloud by the Planner. Write it as 2–3 natural sentences to the team, without labels, bullets, or management jargon.',
    'Each taskNotes objective must be one concrete sentence saying what that CLI will do. Do not copy the task title or use placeholders such as awaiting plan/build.',
    'Return ONLY valid JSON with this exact shape:',
    '{"summary":"...","decisions":[{"summary":"...","rationale":"...","taskIds":["task_id"]}],"risks":["..."],"unresolved":["..."],"taskNotes":[{"taskId":"task_id","objective":"...","acceptanceCriteria":["..."]}]}',
    'Use only task ids from the draft graph. Keep at most 8 decisions, 6 risks, 4 unresolved items, and 5 acceptance criteria per task.',
  ].join('\n\n');
  const raw = await callMeetingModel(model, prompt, SYNTHESIS_WORD_LIMIT, 'json');
  const parsed = parseJsonObject(raw);
  return SynthesisSchema.parse(parsed);
}

function localOpening(goal: string, participants: AgentProfile[]): string {
  const zh = containsCjk(goal);
  const names = participants.map((agent) => agent.displayName).join(', ');
  return zh
    ? `大家先对齐一下，我们要解决的是：${limitText(goal, 55)}。${names}，Mira 先把用户真正要的结果说清楚，Nova 再看看怎么接进现有项目，执行和审查随后接上。有做不了、说不准或容易翻车的地方，现在就直接提。`
    : `Quick alignment: we need to solve this — ${limitText(goal, 55)}. ${names}, Mira will pin down the user outcome, Nova will look at how it fits the existing project, then implementation and review will respond. If anything is unclear, risky, or genuinely blocked, say it now.`;
}

function localPosition(
  agent: AgentProfile,
  goal: string,
  plan: Plan,
  repositorySummary: string,
  now: string,
): PlanningMeetingMessage {
  const zh = containsCjk(goal);
  const content = agent.role === 'pm'
    ? (zh
        ? `我先把范围收一下：这一轮先把用户明确要的体验做完整，别顺手加上后端、账号或运营系统。最后我会按三个东西验收——主流程能走通、关键入口看得懂、手机上也能正常用；素材或品牌上有猜测的地方要标出来。`
        : `I would keep this round focused on the experience the user explicitly asked for, without quietly adding a backend, accounts, or an operations system. I will call it done when the main journey works, the important actions are clear, mobile holds up, and any content or brand assumptions are visible.`)
    : (zh
        ? `从结构上看，我建议先认准一个现有目录作为基线，再沿着它已有的页面和样式方式往下做，不要复制出第三套差不多的项目。页面、视觉、内容和交互可以分开整理，但开工前得先核实真实入口和资源路径，因为我现在看到的还只是一次快速扫描（${repositorySummary}）。`
        : `Structurally, I would choose one existing directory as the baseline and extend its page and styling conventions instead of creating a third near-duplicate project. We can keep page structure, visuals, content, and interaction separate, but the real entrypoint and asset paths still need checking because this is only a compact scan (${repositorySummary}).`);
  return meetingMessage({
    id: `meeting_position_${agent.id}`,
    phase: 'position',
    agent,
    content,
    now,
    wordLimit: POSITION_WORD_LIMIT,
  });
}

function localFacilitation(
  implementer: AgentProfile,
  goal: string,
  positions: PlanningMeetingMessage[],
  now: string,
): PlanningMeetingMessage {
  const content = containsCjk(goal)
    ? `好，目标和技术方向先放在这里。${implementer.displayName}，你听完这两边以后说说：哪些可以直接做，哪些需要调整，准备先从哪里下手；真有做不了的，现在就提。`
    : `Good, we have the outcome and a technical direction. ${implementer.displayName}, tell us what is immediately workable, what needs adjusting, and where you would start. If something is not feasible, raise it now.`;
  return meetingMessage({
    id: 'meeting_facilitation_execution',
    phase: 'facilitation',
    agent: plannerAgent(),
    content,
    now,
    wordLimit: POSITION_WORD_LIMIT,
    references: positions.map((message) => message.id),
  });
}

function localCommitment(
  agent: AgentProfile,
  goal: string,
  positions: PlanningMeetingMessage[],
  plan: Plan,
  now: string,
): PlanningMeetingMessage {
  const zh = containsCjk(goal);
  const owned = plan.tasks.filter((task) => task.owner === agent.id || task.role === 'implementer');
  const execution = owned.map((task) => task.title).join('；') || '已分配的实现任务';
  const content = zh
    ? `这个方向我能接。我会先确认真正的入口、能复用的部分和素材路径，再开始做 ${execution}；如果前面的结构判断和代码对不上，我会马上回来说明，不会硬着头皮往下改。做完后我会把手机端和关键操作的验证结果一起交出来。`
    : `I can take this direction. I will confirm the real entrypoint, reusable pieces, and asset paths before starting ${execution}; if the code contradicts our structural assumptions, I will bring that back instead of forcing it. I will include mobile and critical-interaction checks with the handoff.`;
  return meetingMessage({
    id: `meeting_commitment_${agent.id}`,
    phase: 'commitment',
    agent,
    content,
    now,
    wordLimit: CHALLENGE_WORD_LIMIT,
    references: positions.map((message) => message.id),
  });
}

function localReviewChallenge(
  agent: AgentProfile,
  goal: string,
  context: PlanningMeetingMessage[],
  plan: Plan,
  now: string,
): PlanningMeetingMessage {
  const zh = containsCjk(goal);
  const hasUnowned = plan.tasks.some((task) => !task.owner);
  const content = zh
    ? `${hasUnowned ? '我这里有个硬阻塞：还有任务没有明确负责人，现在不能批准。' : '我这里暂时没有硬阻塞，可以开工。'}不过要盯住两件事：别在重复目录里改错版本，动效和素材也别把手机端拖慢。交付时我要看到真实文件改动、主流程测试和手机端检查，剩下没解决的风险也要说清楚。`
    : `${hasUnowned ? 'I do have a hard blocker: at least one task still has no owner, so this cannot be approved yet.' : 'I do not see a hard blocker, so the team can start.'} Keep an eye on two things: editing the wrong duplicate baseline, and motion or assets hurting mobile. At delivery I want real file changes, a critical-path test, a mobile check, and any remaining risk stated plainly.`;
  return meetingMessage({
    id: `meeting_challenge_${agent.id}`,
    phase: 'challenge',
    agent,
    content,
    now,
    wordLimit: CHALLENGE_WORD_LIMIT,
    references: context.map((message) => message.id),
  });
}

function localSynthesis(plan: Plan, repositorySummary: string, goal: string): MeetingSynthesis {
  const zh = containsCjk(goal);
  const executableTasks = plan.tasks.some((task) => task.role !== 'planner')
    ? plan.tasks.filter((task) => task.role !== 'planner')
    : plan.tasks;
  return {
    summary: zh
      ? `好，方向就这么定。接下来有 ${executableTasks.length} 个执行任务，我已经把负责人、先后顺序和验收要求排好了；等用户确认后再开工，谁的前置没完成谁就先别动。`
      : `All right, that is the direction. I have arranged ${executableTasks.length} execution task${executableTasks.length === 1 ? '' : 's'} with clear owners, order, and acceptance checks. Work starts after user approval, and nobody jumps an unfinished prerequisite.`,
    decisions: [
      {
        summary: zh ? '以确定性工作流的分工与依赖顺序作为执行合同。' : 'Use deterministic workflow ownership and dependency ordering as the execution contract.',
        rationale: zh ? '讨论负责澄清目标和风险，不能绕过已经校验的调度图。' : 'Discussion clarifies goals and risks but cannot bypass the validated scheduler graph.',
        taskIds: executableTasks.map((task) => task.id),
      },
      {
        summary: zh ? '每次交接都必须附带明确的验收证据。' : 'Require explicit acceptance evidence in every handoff.',
        rationale: zh ? '让执行者与审查者使用同一套完成标准。' : 'This gives implementers and reviewers the same definition of done.',
        taskIds: executableTasks.map((task) => task.id),
      },
    ],
    risks: zh
      ? [`代码库扫描范围：${repositorySummary}`, '开工前必须用真实文件验证基线目录、入口与资源假设。']
      : [`Compact repository scan: ${repositorySummary}`, 'Implementation assumptions must be verified against real files before edits.'],
    unresolved: [],
    taskNotes: executableTasks.map((task) => ({
      taskId: task.id,
      objective: localTaskObjective(task, goal, zh),
      acceptanceCriteria: acceptanceCriteriaFor(task, zh),
    })),
  };
}

function localTaskObjective(task: PlanTask, goal: string, zh: boolean): string {
  const scopedGoal = limitText(goal.replace(/\s*Clarified requirements:[\s\S]*$/i, '').trim(), 48);
  const stage = task.stageKind ?? task.stageId;
  const codeGoal = wantsCodeArtifact(goal);
  const pythonGoal = wantsPythonArtifact(goal);
  if (zh) {
    if (task.role === 'architect' && stage === 'review') {
      return '复核实现是否遵守已经确定的模块边界、复用方式和依赖关系，并指出集成风险。';
    }
    if (task.role === 'architect') {
      return codeGoal
        ? '检查真实代码入口、依赖和可复用部分，确定脚本结构、数据流、模块边界与实现约束。'
        : '检查真实代码入口和可复用部分，确定页面结构、数据流、模块边界与实现约束。';
    }
    if (task.role === 'implementer') {
      if (pythonGoal) {
        return `在现有项目中调研需求背景并编写可运行的 Python 代码：${scopedGoal}，同时附上运行方式和验证证据。`;
      }
      if (codeGoal) {
        return `在现有项目中完成可运行的代码实现：${scopedGoal}，同时附上运行方式和验证证据。`;
      }
      return `在现有项目中完成核心页面与交互：${scopedGoal}，并提供可运行结果和移动端验证。`;
    }
    if (task.role === 'reviewer') {
      return '独立检查构建结果是否覆盖需求、关键交互和移动端，列出带证据的阻塞或回归问题。';
    }
    if (task.role === 'fixer') return '只修复审查确认的问题，并补充对应的回归验证。';
    return `完成分配的工作：${scopedGoal}，并附上验证证据。`;
  }
  if (task.role === 'architect' && stage === 'review') {
    return 'Check that the implementation follows the agreed module boundaries, reuse strategy, and dependencies, and flag integration risk.';
  }
  if (task.role === 'architect') {
    return codeGoal
      ? 'Inspect the real entrypoint, dependencies, and reusable code, then define script structure, data flow, module boundaries, and implementation constraints.'
      : 'Inspect the real entrypoint and reusable code, then define page structure, data flow, module boundaries, and implementation constraints.';
  }
  if (task.role === 'implementer') {
    if (pythonGoal) {
      return `Research the requirement context and write runnable Python code for: ${scopedGoal}, with usage notes and verification evidence.`;
    }
    if (codeGoal) {
      return `Build runnable code in the existing project for: ${scopedGoal}, with usage notes and verification evidence.`;
    }
    return `Build the core pages and interactions in the existing project for: ${scopedGoal}, with a runnable result and mobile verification.`;
  }
  if (task.role === 'reviewer') {
    return 'Independently check requirement coverage, critical interactions, mobile behavior, and regressions, with evidence for every blocker.';
  }
  if (task.role === 'fixer') return 'Repair only the confirmed review findings and add matching regression evidence.';
  return `Complete the assigned work for: ${scopedGoal}, with verification evidence.`;
}

function acceptanceCriteriaFor(task: PlanTask, zh = false): string[] {
  const text = `${task.title} ${task.brief} ${task.objective ?? ''}`;
  const codeTask = wantsCodeArtifact(text);
  const pythonTask = wantsPythonArtifact(text);
  if (zh) {
    if (task.role === 'planner') return ['范围、负责人、依赖和风险已经明确。', '用户确认前不启动任何下游任务。'];
    if (task.role === 'architect') return codeTask
      ? ['脚本边界、依赖、输入输出和复用接口已经明确。', '硬编码与集成风险已经指出。']
      : ['模块边界、复用接口和基线目录已经明确。', '硬编码与集成风险已经指出。'];
    if (task.role === 'implementer') {
      if (pythonTask) return ['Python 代码可以在本地运行。', '附有运行命令、输入输出说明和验证证据。'];
      if (codeTask) return ['代码实现可以在本地运行。', '附有运行命令和验证证据。'];
      return ['分配的功能在现有项目中真实可用。', '附有相关测试或验证证据。'];
    }
    if (task.role === 'reviewer') return ['需求覆盖与回归风险已经检查。', '阻塞问题带有严重级别和证据。'];
    return ['任务目标已完成并附带验证证据。'];
  }
  if (task.role === 'planner') return ['Scope, owner, dependencies, and risks are explicit.', 'No downstream task starts before plan approval.'];
  if (task.role === 'architect') return codeTask
    ? ['Script boundaries, dependencies, inputs, outputs, and reused interfaces are named.', 'Hardcoded values and integration risks are called out.']
    : ['Module boundaries and reused interfaces are named.', 'Hardcoded values and integration risks are called out.'];
  if (task.role === 'implementer') {
    if (pythonTask) return ['The Python code runs locally.', 'Usage command, inputs/outputs, and verification evidence are recorded.'];
    if (codeTask) return ['The code runs locally.', 'Usage command and verification evidence are recorded.'];
    return ['The assigned slice works in the existing project.', 'Relevant tests or verification evidence are recorded.'];
  }
  if (task.role === 'reviewer') return ['Requirements and regression risks are checked.', 'Blocking findings use explicit severity and evidence.'];
  return ['The assigned objective is complete and verification evidence is attached.'];
}

function wantsPythonArtifact(text: string): boolean {
  return /\bpython\b|\.py\b|py脚本|python脚本|python代码/i.test(text);
}

function wantsCodeArtifact(text: string): boolean {
  return wantsPythonArtifact(text)
    || /\b(script|code|cli|library|package|module|function|notebook|jupyter|api)\b|代码|脚本|函数|模块|库|命令行|接口|笔记本/i.test(text);
}

function validatedDecisions(
  candidates: MeetingSynthesis['decisions'],
  plan: Plan,
): PlanningMeetingDecision[] {
  const validTaskIds = new Set(plan.tasks.map((task) => task.id));
  return candidates.slice(0, 8).map((decision, index) => ({
    id: `meeting_decision_${index + 1}`,
    summary: decision.summary.trim(),
    rationale: decision.rationale.trim(),
    taskIds: [...new Set(decision.taskIds.filter((taskId) => validTaskIds.has(taskId)))],
  })).filter((decision) => decision.summary.length > 0);
}

function independentSystemPrompt(agent: AgentProfile, goal: string): string {
  return [
    `You are ${agent.displayName}, acting strictly as the professional ${agent.role}.`,
    ROLE_MANDATES[agent.role],
    'Independence rule: form your own judgment before seeing any other agent opinion. Do not imitate consensus, defer to authority, or hide a problem to be agreeable.',
    'If the task is unsafe, underspecified, architecturally unsound, or blocked, you must say so plainly from your discipline.',
    'Speak like a colleague in a live meeting: respond in 2–4 short sentences, not a memo. Avoid headings, colon labels, bullet lists, and long inventories of technical names.',
    'Use a technical term only when it changes the decision. Prefer explaining the consequence in plain language.',
    `Reply in the same language as the user goal: ${goal}`,
  ].join('\n');
}

function meetingMessage(input: {
  id: string;
  phase: PlanningMeetingMessage['phase'];
  agent: AgentProfile;
  content: string;
  now: string;
  wordLimit: number;
  references?: string[];
}): PlanningMeetingMessage {
  return {
    id: input.id,
    phase: input.phase,
    agentId: input.agent.id,
    role: input.agent.role,
    content: limitText(input.content, input.wordLimit),
    createdAt: input.now,
    wordLimit: input.wordLimit,
    references: input.references ?? [],
  };
}

async function buildRepositoryBrief(workspace: string | null): Promise<RepositoryBrief> {
  if (!workspace) return { prompt: 'No repository is linked to this turn.', summary: 'No linked repository' };
  const files: string[] = [];
  await walkRepository(workspace, '', 0, files);
  files.sort();
  const contextFiles = ['AGENTS.md', 'CONTEXT.md', 'README.md', 'README.zh-CN.md', 'package.json', 'tsconfig.json']
    .filter((name) => files.includes(name));
  const excerpts: string[] = [];
  for (const name of contextFiles) {
    const content = await readFile(join(workspace, name), 'utf8').catch(() => '');
    if (content) excerpts.push(`## ${name}\n${content.slice(0, 1_600)}`);
  }
  const tree = files.slice(0, MAX_REPOSITORY_FILES).join('\n');
  const prompt = [`Repository file map (${files.length} files sampled):`, tree, ...excerpts]
    .join('\n\n')
    .slice(0, MAX_CONTEXT_CHARS);
  const roots = [...new Set(files.map((file) => file.split('/')[0]).filter(Boolean))].slice(0, 8);
  return {
    prompt: prompt || 'The linked repository is currently empty.',
    summary: files.length === 0
      ? 'Linked repository is empty'
      : `${files.length} files; roots: ${roots.join(', ')}`,
  };
}

async function walkRepository(
  workspace: string,
  relative: string,
  depth: number,
  files: string[],
): Promise<void> {
  if (depth > MAX_REPOSITORY_DEPTH || files.length >= MAX_REPOSITORY_FILES * 2) return;
  const entries = await readdir(relative ? join(workspace, relative) : workspace, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (files.length >= MAX_REPOSITORY_FILES * 2) return;
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walkRepository(workspace, path, depth + 1, files);
    else if (entry.isFile()) files.push(path);
  }
}

function compactPlan(plan: Plan): string {
  return JSON.stringify(plan.tasks.map((task) => ({
    id: task.id,
    owner: task.owner,
    role: task.role,
    title: task.title,
    dependsOn: task.deps,
  })), null, 2);
}

function transcriptForPrompt(messages: PlanningMeetingMessage[]): string {
  return messages.map((message) => `[${message.id}] ${message.agentId}/${message.role}:\n${message.content}`).join('\n\n');
}

function parseJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!candidate.trim()) throw new Error('meeting_synthesis_missing_json');
  return JSON.parse(candidate);
}

function uniqueLimited(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function limitText(value: string, maxWords: number): string {
  const compact = value.trim().replace(/\n{3,}/g, '\n\n');
  const maxChars = containsCjk(compact) ? maxWords * 3 : maxWords * 9;
  if (compact.length <= maxChars && compact.split(/\s+/).length <= maxWords) return compact;
  const words = compact.split(/\s+/).slice(0, maxWords).join(' ');
  const limited = words.slice(0, maxChars).trim();
  return `${limited.replace(/[.,;:!?，。；：！？]$/, '')}…`;
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function plannerAgent(): AgentProfile {
  return AGENT_ROSTER.find((agent) => agent.role === 'planner') ?? AGENT_ROSTER[0]!;
}
