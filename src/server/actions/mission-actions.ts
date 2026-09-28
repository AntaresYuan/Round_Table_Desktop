import { id, mutateData, nowIso, readData } from '../store.js';
import type {
  Actor,
  Artifact,
  HandoffCardV2,
  LocalTurn,
  Mission,
  MissionCheckpoint,
  MissionFinalDelivery,
  MissionStage,
  MissionStatus,
  MissionTask,
  Plan,
  PlanTask,
  QualityGate,
  QualityGateKind,
  WorkingStyleSnapshot,
  WorkflowRun,
  WorkflowStage,
  WorkflowStageRunStatus,
  WorkflowTemplate,
  AgentRole,
} from '../types.js';
import { AGENT_ROSTER, agentCardFor, agentForTask } from './agent-roster.js';

const seat = (role: AgentRole, agentId?: string) => ({
  ref: { kind: 'role' as const, role, ...(agentId ? { agentId } : {}) },
});
const userSeat = { ref: { kind: 'user' as const } };

const gate = (
  kind: QualityGateKind,
  label: string,
  description: string,
  actions: string[] = [],
  required = kind !== 'none',
): QualityGate => ({ kind, required, label, description, actions });

export const BUILTIN_WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'wf-feature-builder',
    name: 'Feature Builder',
    tag: 'Flagship',
    desc: 'Turn a vague request into a planned, implemented, reviewed, and reportable feature.',
    builtin: true,
    version: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    planning: { cut: 'by_capability', clarifyThreshold: 0.6, maxClarifyQuestions: 3 },
    stages: [
      {
        id: 'intake',
        name: 'Intake',
        icon: 'clip',
        kind: 'intake',
        desc: 'Capture the user goal, repo context, constraints, and desired output.',
        seats: [userSeat],
        fixed: true,
        gate: gate('none', 'Goal captured', 'The Mission has an initial goal.'),
        requiredInputs: ['goal'],
        expectedOutputs: ['intake artifact'],
        requiredCapabilities: [],
      },
      {
        id: 'clarify',
        name: 'Clarify',
        icon: 'search',
        kind: 'clarify',
        desc: 'Ask only for missing decisions that would change the plan.',
        seats: [seat('planner', 'orchestrator'), seat('pm', 'mira')],
        gate: gate('requirement_clarification', 'Clarification', 'The planner pauses when the request is too vague.', ['answer_questions']),
        requiredInputs: ['goal'],
        expectedOutputs: ['clarified requirements'],
        requiredCapabilities: ['mission.planning', 'product.briefing'],
      },
      {
        id: 'plan',
        name: 'Plan',
        icon: 'layers',
        kind: 'plan',
        desc: 'Produce a technical plan and split the work into agent-owned tasks.',
        seats: [seat('planner', 'orchestrator'), seat('architect', 'nova')],
        gate: gate('plan_approval', 'Plan approval', 'The user approves the plan before agents execute.', ['approve_plan', 'reject_plan']),
        requiredInputs: ['clarified requirements'],
        expectedOutputs: ['plan artifact', 'task graph'],
        requiredCapabilities: ['workflow.decomposition', 'technical.plan'],
      },
      {
        id: 'build',
        name: 'Build',
        icon: 'code',
        kind: 'work',
        desc: 'Implementers produce code and preview artifacts from structured handoffs.',
        seats: [seat('implementer', 'atlas'), seat('implementer', 'beam')],
        parallelGroup: 'build',
        gate: gate('handoff_acceptance', 'Handoff accepted', 'Each implementer receives a compact context package.', ['inspect_handoff'], false),
        requiredInputs: ['approved plan', 'handoff card'],
        expectedOutputs: ['generated artifacts', 'edited artifacts'],
        requiredCapabilities: ['frontend.implementation', 'backend.implementation'],
      },
      {
        id: 'review',
        name: 'Review',
        icon: 'eye',
        kind: 'review',
        desc: 'Reviewer checks requirement coverage; the architect audits modularity, hardcoding, and reuse.',
        seats: [seat('reviewer', 'vera'), seat('architect', 'nova')],
        parallelGroup: 'review',
        gate: gate('reviewer_signoff', 'Reviewer confidence', 'Final delivery is blocked until the reviewer reports pass/warn/block.', ['request_repair', 'accept_review']),
        requiredInputs: ['build artifacts'],
        expectedOutputs: ['review artifact', 'architecture check', 'risk list', 'confidence recommendation'],
        requiredCapabilities: ['review.quality_gate', 'risk.assessment', 'architecture.review'],
      },
      {
        id: 'repair',
        name: 'Repair',
        icon: 'wrench',
        kind: 'repair',
        desc: 'Apply focused fixes when safety or review blocks the run.',
        seats: [seat('fixer', 'fixer')],
        gate: gate('test_failure_repair', 'Repair required', 'Failures create follow-up repair work instead of mutating completed tasks.', ['run_repair'], false),
        requiredInputs: ['failed task or blocking review'],
        expectedOutputs: ['repair artifact', 'change summary'],
        requiredCapabilities: ['repair.implementation'],
      },
      {
        id: 'ship',
        name: 'Delivery',
        icon: 'rocket',
        kind: 'ship',
        desc: 'Package the working deliverable with acceptance evidence and next action.',
        seats: [seat('planner', 'orchestrator'), seat('reviewer', 'vera')],
        gate: gate('final_delivery_acceptance', 'Delivery acceptance', 'The user accepts the delivered artifact or requests repair.', ['accept_delivery', 'request_repair']),
        requiredInputs: ['working artifact', 'review artifact'],
        expectedOutputs: ['working delivery', 'acceptance summary'],
        requiredCapabilities: ['confidence_report', 'mission.planning'],
      },
    ],
  },
  {
    id: 'wf-bug-fixer',
    name: 'Bug Fixer',
    tag: 'Diagnosis',
    desc: 'Diagnose a bug, patch it, verify the fix, and summarize residual risk.',
    builtin: true,
    version: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    planning: { cut: 'by_capability', clarifyThreshold: 0.55, maxClarifyQuestions: 3 },
    stages: [
      {
        id: 'intake',
        name: 'Intake',
        icon: 'clip',
        kind: 'intake',
        desc: 'Capture symptoms, expected behavior, logs, and repro hints.',
        seats: [userSeat],
        fixed: true,
        gate: gate('none', 'Bug captured', 'The Mission has a bug report.'),
        requiredInputs: ['bug report'],
        expectedOutputs: ['bug intake'],
        requiredCapabilities: [],
      },
      {
        id: 'plan',
        name: 'Diagnose',
        icon: 'search',
        kind: 'plan',
        desc: 'Map likely causes and pick the smallest safe fix path.',
        seats: [seat('planner', 'orchestrator'), seat('architect', 'nova')],
        gate: gate('plan_approval', 'Fix plan approval', 'The user approves the diagnosis before patching.', ['approve_plan', 'reject_plan']),
        requiredInputs: ['bug intake'],
        expectedOutputs: ['diagnosis plan'],
        requiredCapabilities: ['technical.plan', 'risk_modeling'],
      },
      {
        id: 'build',
        name: 'Patch',
        icon: 'wrench',
        kind: 'work',
        desc: 'Apply the focused patch and preserve surrounding behavior.',
        seats: [seat('implementer', 'beam'), seat('implementer', 'atlas')],
        gate: gate('none', 'Patch ready', 'The patch can proceed after plan approval.'),
        requiredInputs: ['approved diagnosis'],
        expectedOutputs: ['patch artifact'],
        requiredCapabilities: ['backend.implementation', 'frontend.implementation'],
      },
      {
        id: 'review',
        name: 'Verify',
        icon: 'eye',
        kind: 'review',
        desc: 'Reviewer checks the repro path and regression risk; the architect confirms the patch stays modular.',
        seats: [seat('reviewer', 'vera'), seat('architect', 'nova')],
        parallelGroup: 'review',
        gate: gate('reviewer_signoff', 'Verification sign-off', 'A reviewer must confirm the fix before delivery.', ['request_repair', 'accept_review']),
        requiredInputs: ['patch artifact'],
        expectedOutputs: ['verification report', 'architecture check'],
        requiredCapabilities: ['review.quality_gate', 'test_evidence', 'architecture.review'],
      },
      {
        id: 'ship',
        name: 'Delivery',
        icon: 'rocket',
        kind: 'ship',
        desc: 'Package the patch, verification, and remaining risk.',
        seats: [seat('planner', 'orchestrator')],
        gate: gate('final_delivery_acceptance', 'Delivery acceptance', 'The user accepts the bug-fix delivery.', ['accept_delivery', 'request_repair']),
        requiredInputs: ['verification report'],
        expectedOutputs: ['patch delivery summary'],
        requiredCapabilities: ['mission.planning'],
      },
    ],
  },
  {
    id: 'wf-codebase-onboarding',
    name: 'Codebase Onboarding',
    tag: 'Discovery',
    desc: 'Understand an unfamiliar repo, map architecture, and propose starter tasks.',
    builtin: true,
    version: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    planning: { cut: 'by_capability', clarifyThreshold: 0.5, maxClarifyQuestions: 2 },
    stages: [
      {
        id: 'intake',
        name: 'Intake',
        icon: 'clip',
        kind: 'intake',
        desc: 'Capture what the user wants to learn or change.',
        seats: [userSeat],
        fixed: true,
        gate: gate('none', 'Scope captured', 'The onboarding scope is recorded.'),
        requiredInputs: ['repo path', 'learning goal'],
        expectedOutputs: ['onboarding intake'],
        requiredCapabilities: [],
      },
      {
        id: 'plan',
        name: 'Map',
        icon: 'layers',
        kind: 'plan',
        desc: 'Create a codebase map with major modules, flows, and ownership hints.',
        seats: [seat('architect', 'nova'), seat('planner', 'orchestrator')],
        gate: gate('none', 'Map ready', 'The architecture map can proceed directly.'),
        requiredInputs: ['repo context'],
        expectedOutputs: ['architecture map'],
        requiredCapabilities: ['system.design', 'dependency.mapping'],
      },
      {
        id: 'review',
        name: 'Check',
        icon: 'eye',
        kind: 'review',
        desc: 'Review the map for unsupported guesses and missing context.',
        seats: [seat('reviewer', 'vera')],
        gate: gate('reviewer_signoff', 'Confidence check', 'The reviewer marks the onboarding map pass/warn/block.', ['accept_review', 'request_more_context']),
        requiredInputs: ['architecture map'],
        expectedOutputs: ['confidence report'],
        requiredCapabilities: ['review.quality_gate'],
      },
      {
        id: 'ship',
        name: 'Starter Tasks',
        icon: 'rocket',
        kind: 'ship',
        desc: 'Deliver starter tasks and recommended next actions.',
        seats: [seat('pm', 'mira'), seat('planner', 'orchestrator')],
        gate: gate('final_delivery_acceptance', 'Accept onboarding', 'The user accepts or refines the onboarding output.', ['accept_delivery', 'request_refinement']),
        requiredInputs: ['confidence report'],
        expectedOutputs: ['starter task list'],
        requiredCapabilities: ['product.briefing', 'mission.planning'],
      },
    ],
  },
];

export type CreateMissionInput = {
  actor?: Actor | null | undefined;
  ownerId?: string | null | undefined;
  chatId?: string | null | undefined;
  turnId: string;
  missionId?: string | undefined;
  goal: string;
  workingStyle?: WorkingStyleSnapshot | undefined;
  plan: Plan;
  needsClarification: boolean;
  workflowTemplateId?: string | undefined;
  // The already-resolved template (custom-aware). When present it wins over
  // id-based resolution, so custom templates flow through without a re-read.
  template?: WorkflowTemplate | undefined;
  // Standalone missions (question turns) are never continued by follow-up
  // turns and never picked up as the chat's ongoing mission.
  standalone?: boolean | undefined;
};

export async function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  const custom = await customWorkflowTemplates();
  // A custom template overrides the builtin with the same id; novel ids are
  // appended as additional selectable workflows.
  const overridden = BUILTIN_WORKFLOW_TEMPLATES.map((builtin) =>
    custom.find((template) => template.id === builtin.id) ?? builtin,
  );
  const extra = custom.filter((template) => !BUILTIN_WORKFLOW_TEMPLATES.some((builtin) => builtin.id === template.id));
  return [...overridden, ...extra].map(cloneTemplate);
}

export function workflowTemplateById(
  idValue: string | null | undefined,
  custom: WorkflowTemplate[] = [],
): WorkflowTemplate {
  return cloneTemplate(
    custom.find((template) => template.id === idValue)
      ?? BUILTIN_WORKFLOW_TEMPLATES.find((template) => template.id === idValue)
      ?? custom.find((template) => template.id === BUILTIN_WORKFLOW_TEMPLATES[0]!.id)
      ?? BUILTIN_WORKFLOW_TEMPLATES[0]!,
  );
}

export function selectWorkflowTemplate(message: string, custom: WorkflowTemplate[] = []): WorkflowTemplate {
  const lower = message.toLowerCase();
  if (/\b(bug|fix|error|crash|broken|regression)\b/i.test(lower) || /(修复|报错|故障)/.test(lower)) {
    return workflowTemplateById('wf-bug-fixer', custom);
  }
  if (/\b(onboard|understand|architecture|map|learn)\b/i.test(lower) || /(熟悉|理解|架构|代码库|导览)/.test(lower)) {
    return workflowTemplateById('wf-codebase-onboarding', custom);
  }
  return workflowTemplateById('wf-feature-builder', custom);
}

// The custom-aware async resolver used by turn creation: an explicit id wins,
// else keyword auto-select — in both cases a stored custom template with the
// matching id replaces the builtin, so editing the default workflow changes
// what actually runs.
export async function resolveWorkflowTemplate(
  idValue: string | null | undefined,
  message: string,
): Promise<WorkflowTemplate> {
  const custom = await customWorkflowTemplates();
  return idValue ? workflowTemplateById(idValue, custom) : selectWorkflowTemplate(message, custom);
}

async function customWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  const data = await readData();
  return data.settings.workflowTemplates ?? [];
}

const TASK_STAGE_KINDS = new Set(['plan', 'work', 'review']);

export class WorkflowTemplateError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Persist a user-edited workflow template. Same-id-as-builtin = override; new
// id = additional workflow. Validation is structural: the editor UI owns
// cosmetics, but a template that cannot produce a runnable task DAG (no
// plan/work/review stage, or a seat pointing at an unknown agent) is rejected
// here so the orchestrator never trips over it at mission time.
export async function saveWorkflowTemplate(template: WorkflowTemplate): Promise<WorkflowTemplate> {
  const idValue = (template.id ?? '').trim();
  if (!idValue) throw new WorkflowTemplateError('missing_template_id');
  if (!(template.name ?? '').trim()) throw new WorkflowTemplateError('missing_template_name');
  if (!Array.isArray(template.stages) || template.stages.length === 0) {
    throw new WorkflowTemplateError('missing_stages');
  }
  const stageIds = new Set<string>();
  for (const stage of template.stages) {
    if (!(stage.id ?? '').trim()) throw new WorkflowTemplateError('missing_stage_id');
    if (stageIds.has(stage.id)) throw new WorkflowTemplateError(`duplicate_stage_id: ${stage.id}`);
    stageIds.add(stage.id);
    for (const seatItem of stage.seats ?? []) {
      if (seatItem.ref.kind !== 'role') continue;
      const agentId = seatItem.ref.agentId;
      if (agentId && !AGENT_ROSTER.some((agent) => agent.id === agentId)) {
        throw new WorkflowTemplateError(`unknown_seat_agent: ${agentId}`);
      }
    }
  }
  if (!template.stages.some((stage) => TASK_STAGE_KINDS.has(stage.kind))) {
    throw new WorkflowTemplateError('no_runnable_stage');
  }
  if (!template.stages.some(stageCanCreateTask)) {
    throw new WorkflowTemplateError('no_runnable_agent_seat');
  }
  const stored: WorkflowTemplate = {
    ...cloneTemplate(template),
    id: idValue,
    builtin: false,
    version: (template.version ?? 0) + 1,
    updatedAt: nowIso(),
  };
  await mutateData((data) => {
    const templates = data.settings.workflowTemplates ?? [];
    data.settings = {
      ...data.settings,
      workflowTemplates: [
        ...templates.filter((item) => item.id !== stored.id),
        stored,
      ],
      updatedAt: nowIso(),
    };
  });
  return stored;
}

function stageCanCreateTask(stage: WorkflowStage): boolean {
  if (!TASK_STAGE_KINDS.has(stage.kind)) return false;
  return (stage.seats ?? []).some((seatItem) => {
    const ref = seatItem.ref;
    if (ref.kind !== 'role') return false;
    if (ref.agentId) {
      return AGENT_ROSTER.some((agent) => agent.id === ref.agentId);
    }
    return AGENT_ROSTER.some((agent) => agent.role === ref.role);
  });
}

// Deleting a custom template removes the override/custom entry; a builtin id
// falls back to the builtin definition (builtins themselves are immutable).
export async function deleteWorkflowTemplate(idValue: string): Promise<void> {
  await mutateData((data) => {
    const templates = data.settings.workflowTemplates ?? [];
    data.settings = {
      ...data.settings,
      workflowTemplates: templates.filter((item) => item.id !== idValue),
      updatedAt: nowIso(),
    };
  });
}

export async function createMission(input: CreateMissionInput): Promise<Mission> {
  const fresh = buildMissionSnapshot(input);
  const saved = await mutateData((data) => {
    const existing = data.missions.find((item) => item.id === fresh.id);
    const mission = existing ? continueMission(existing, fresh, input) : fresh;
    data.missions = [mission, ...data.missions.filter((item) => item.id !== mission.id)];
    return mission;
  });
  return saved ?? fresh;
}

// A follow-up turn CONTINUES the chat's mission instead of spawning a sibling:
// the new plan replaces the old one (stages, tasks, checkpoints reset for the
// new work) while the mission keeps its identity and history — createdAt, the
// accumulated artifacts, the decision log, and the list of contributing turns.
function continueMission(existing: Mission, fresh: Mission, input: CreateMissionInput): Mission {
  const turnIds = existing.turnIds?.length ? existing.turnIds : [existing.sourceTurnId];
  const followUpId = `decision_followup_${input.turnId}`;
  const isNewTurn = !turnIds.includes(input.turnId);
  return {
    ...fresh,
    id: existing.id,
    createdAt: existing.createdAt,
    turnIds: isNewTurn ? [...turnIds, input.turnId] : turnIds,
    artifactIds: existing.artifactIds,
    decisions: isNewTurn && !existing.decisions.some((decision) => decision.id === followUpId)
      ? [
          ...existing.decisions,
          {
            id: followUpId,
            stageId: 'intake',
            actor: 'user' as const,
            summary: `Follow-up request: ${input.goal.slice(0, 160)}`,
            createdAt: nowIso(),
          },
        ]
      : existing.decisions,
  };
}

// The chat's continuing mission: the most recently updated non-standalone
// mission in the chat. Question turns are standalone, so they neither hijack
// nor become the chat's ongoing mission.
export async function latestMissionForChat(
  ownerId: string | null,
  chatId: string | null | undefined,
): Promise<Mission | null> {
  if (!chatId) return null;
  const data = await readData();
  return data.missions
    .filter((mission) => mission.chatId === chatId && mission.ownerId === ownerId && !mission.standalone)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export function buildMissionSnapshot(input: CreateMissionInput): Mission {
  const template = input.template
    ?? (input.workflowTemplateId
      ? workflowTemplateById(input.workflowTemplateId)
      : selectWorkflowTemplate(input.goal));
  const now = nowIso();
  return {
    id: input.missionId ?? id('mission'),
    ownerId: input.actor?.id ?? input.ownerId ?? null,
    chatId: input.chatId ?? null,
    sourceTurnId: input.turnId,
    turnIds: [input.turnId],
    ...(input.standalone ? { standalone: true } : {}),
    goal: input.goal,
    workingStyle: input.workingStyle ?? { skills: [], projectRules: [] },
    status: input.needsClarification ? 'awaiting_clarification' : 'awaiting_approval',
    workflowTemplateId: template.id,
    workflowTemplateName: template.name,
    currentStageId: input.needsClarification ? 'clarify' : 'plan',
    stages: template.stages.map((stage): MissionStage => ({
      id: stage.id,
      name: stage.name,
      status: stage.id === 'intake' ? 'done' : stage.id === (input.needsClarification ? 'clarify' : 'plan') ? 'active' : 'pending',
      taskIds: taskIdsForStage(stage.id, input.plan.tasks),
      artifactIds: [],
      gate: stage.gate,
    })),
    tasks: input.plan.tasks.map((task) => missionTaskFromPlanTask(task, 'pending', [])),
    checkpoints: checkpointsForTemplate(template, input.needsClarification, now),
    decisions: [],
    artifactIds: [],
    finalDelivery: initialFinalDelivery(),
    createdAt: now,
    updatedAt: now,
  };
}

export async function getMission(actor: Actor, missionId: string): Promise<Mission | null> {
  const data = await readData();
  return data.missions.find((mission) => mission.ownerId === actor.id && mission.id === missionId) ?? null;
}

export async function getMissionByTurn(actor: Actor, turnId: string): Promise<Mission | null> {
  const data = await readData();
  // A mission can span several turns, so resolve through the turn's own
  // missionId first; the sourceTurnId/turnIds fallbacks cover older records.
  const missionId = data.turns.find((turn) => turn.id === turnId && turn.ownerId === actor.id)?.missionId;
  const byId = missionId
    ? data.missions.find((mission) => mission.ownerId === actor.id && mission.id === missionId)
    : null;
  return byId
    ?? data.missions.find((mission) =>
      mission.ownerId === actor.id
      && (mission.sourceTurnId === turnId || (mission.turnIds ?? []).includes(turnId)),
    )
    ?? null;
}

export async function listMissions(actor: Actor, chatId?: string | undefined): Promise<Mission[]> {
  const data = await readData();
  return data.missions
    .filter((mission) => mission.ownerId === actor.id && (!chatId || mission.chatId === chatId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function rejectHandoff(actor: Actor, handoffId: string): Promise<Mission> {
  const data = await readData();
  const handoff = data.handoffs.find((item) => item.ownerId === actor.id && item.id === handoffId);
  if (!handoff) throw new Error('handoff_not_found');
  const card = handoff.card?.['handoffV2'] as HandoffCardV2 | undefined;
  if (!card?.missionId || !card.task?.id) throw new Error('handoff_not_rejectable');

  const mission = data.missions.find((item) => item.ownerId === actor.id && item.id === card.missionId);
  if (!mission) throw new Error('mission_not_found');
  const repairTaskId = `repair_handoff_${card.task.id}`;
  const next = await updateMission(mission.id, (current) => {
    const needsRepairTask = !current.tasks.some((task) => task.id === repairTaskId);
    return {
      ...current,
      currentStageId: 'repair',
      tasks: needsRepairTask
        ? [
            ...current.tasks,
            {
              id: repairTaskId,
              stageId: 'repair',
              title: `Repair handoff for ${card.task.title}`,
              assignee: '@fixer',
              owner: 'fixer',
              status: 'pending' as const,
              deps: [card.task.id],
              artifactIds: [],
            },
          ]
        : current.tasks,
      stages: current.stages.map((stage) =>
        stage.id === 'repair' && needsRepairTask
          ? { ...stage, status: 'active', taskIds: [...stage.taskIds, repairTaskId] }
          : stage,
      ),
      decisions: [
        ...current.decisions,
        {
          id: `decision_handoff_${handoff.id}_reject`,
          stageId: 'repair',
          actor: 'user',
          summary: `Handoff rejected; repair follow-up created for ${card.task.title}.`,
          createdAt: nowIso(),
        },
      ],
      updatedAt: nowIso(),
    };
  });
  if (!next) throw new Error('mission_not_found');
  return next;
}

export async function updateMissionForPlannedTurn(turn: LocalTurn): Promise<Mission | null> {
  return updateMission(turn.missionId, (mission) => syncMissionWithTurn(mission, turn, { artifactIds: [] }));
}

export async function updateMissionForDispatch(turn: LocalTurn): Promise<Mission | null> {
  return updateMission(turn.missionId, (mission) => syncMissionWithTurn(mission, turn, {
    artifactIds: turn.artifacts.map((artifact) => artifact.id),
  }));
}

export async function setMissionRejected(turn: LocalTurn): Promise<Mission | null> {
  return updateMission(turn.missionId, (mission) => ({
    ...mission,
    status: 'blocked',
    currentStageId: 'plan',
    checkpoints: mission.checkpoints.map((checkpoint) =>
      checkpoint.kind === 'plan_approval'
        ? { ...checkpoint, status: 'blocked', requiredAction: 'Revise or restart the plan.', resolvedAt: null }
        : checkpoint,
    ),
    updatedAt: nowIso(),
  }));
}

export async function decideFinalDelivery(
  turn: LocalTurn,
  decision: 'accept' | 'repair' | 'tests',
): Promise<Mission | null> {
  const wantsTests = decision === 'tests';
  return updateMission(turn.missionId, (mission) => {
    const repairTaskId = `repair_final_${turn.id}`;
    const testTaskId = `test_final_${turn.id}`;
    const needsRepairTask = decision === 'repair' && !mission.tasks.some((task) => task.id === repairTaskId);
    const needsTestTask = wantsTests && !mission.tasks.some((task) => task.id === testTaskId);
    const tasks = [
      ...mission.tasks,
      ...(needsRepairTask ? [{
        id: repairTaskId,
        stageId: 'repair',
        title: 'Repair final delivery issues',
        assignee: '@fixer',
        owner: 'fixer',
        status: 'pending' as const,
        deps: mission.tasks.filter((task) => task.stageId === 'review').map((task) => task.id),
        artifactIds: [],
      }] : []),
      ...(needsTestTask ? [{
        id: testTaskId,
        stageId: 'review',
        title: 'Collect final test evidence',
        assignee: '@vera',
        owner: 'vera',
        status: 'pending' as const,
        deps: mission.tasks.filter((task) => task.stageId !== 'review').map((task) => task.id),
        artifactIds: [],
      }] : []),
    ];
    return {
      ...mission,
      currentStageId: decision === 'repair' ? 'repair' : mission.currentStageId,
      tasks,
      stages: mission.stages.map((stage) =>
        stage.id === 'repair' && needsRepairTask
          ? { ...stage, status: 'active', taskIds: [...stage.taskIds, repairTaskId] }
          : stage.id === 'review' && needsTestTask
            ? { ...stage, status: 'active', taskIds: [...stage.taskIds, testTaskId] }
          : stage,
      ),
      finalDelivery: {
        ...mission.finalDelivery,
        status: decision === 'accept' ? 'accepted' : decision === 'repair' ? 'rejected' : 'ready',
        recommendation: decision === 'accept' ? 'accept' : decision === 'repair' ? 'repair' : 'review',
      },
      checkpoints: mission.checkpoints.map((checkpoint) =>
        checkpoint.kind === 'final_delivery_acceptance'
          ? {
              ...checkpoint,
              status: decision === 'accept' ? 'satisfied' : decision === 'repair' ? 'blocked' : 'pending',
              requiredAction: decision === 'accept'
                ? null
                : wantsTests
                  ? 'Reviewer test evidence requested before final acceptance.'
                  : 'Repair follow-up task created from final delivery state.',
              resolvedAt: wantsTests ? null : nowIso(),
            }
          : checkpoint,
      ),
      decisions: [
        ...mission.decisions,
        {
          id: `decision_final_${turn.id}_${decision}`,
          stageId: 'ship',
          actor: 'user',
          summary: decision === 'accept'
            ? 'Final delivery accepted.'
            : wantsTests
              ? 'Additional test evidence requested before final acceptance.'
              : 'Final delivery rejected; repair follow-up task created.',
          createdAt: nowIso(),
        },
      ],
      updatedAt: nowIso(),
    };
  });
}

export function workflowRunForTurn(turn: LocalTurn): WorkflowRun {
  const template = templateFromTurn(turn);
  const mission = turn.mission ?? missionFromTurnSnapshot(turn, template);
  return workflowRunFromMission(mission, template);
}

// The turn stores the resolved template snapshot at creation time (turn.workflow),
// which is the ONLY sync-safe way to honor custom templates here — id-based
// resolution alone would silently fall back to the builtin.
function templateFromTurn(turn: LocalTurn): WorkflowTemplate {
  const snapshot = turn.workflow as WorkflowTemplate | null;
  if (snapshot && Array.isArray(snapshot.stages) && snapshot.stages.length > 0) {
    return cloneTemplate(snapshot);
  }
  return workflowTemplateById(turn.workflowTemplateId);
}

export function workflowRunFromMission(mission: Mission, template: WorkflowTemplate): WorkflowRun {
  const taskStates: WorkflowRun['taskStates'] = {};
  for (const task of mission.tasks) {
    taskStates[task.id] = { status: taskStatusToStageStatus(task.status), stageId: task.stageId };
  }

  const stageStates: WorkflowRun['stageStates'] = {};
  for (const stage of template.stages) {
    const missionStage = mission.stages.find((item) => item.id === stage.id);
    const taskIds = missionStage?.taskIds ?? [];
    stageStates[stage.id] = {
      status: missionStage?.status ?? 'pending',
      taskIds,
      artifactIds: missionStage?.artifactIds ?? [],
      gate: stage.gate,
      seatRuns: stage.seats.map((seatItem) => {
        const agentId = seatItem.ref.kind === 'user'
          ? 'user'
          : seatItem.ref.agentId ?? seatItem.ref.role;
        const ownedTasks = mission.tasks.filter((task) =>
          taskIds.includes(task.id)
          && (task.owner === agentId || task.assignee.replace(/^@/, '') === agentId || task.assignee.replace(/^@/, '') === (seatItem.ref.kind === 'role' ? seatItem.ref.role : 'user')),
        );
        if (ownedTasks.length === 0) return null;
        return {
          agentId,
          status: aggregateTaskStatus(ownedTasks),
          artifactIds: ownedTasks.flatMap((task) => task.artifactIds),
        };
      }).filter((seatRun): seatRun is NonNullable<typeof seatRun> => seatRun !== null),
    };
  }

  for (const task of mission.tasks) {
    stageStates[task.id] = { status: taskStatusToStageStatus(task.status) };
  }

  return {
    activeStageId: mission.currentStageId,
    stageStates,
    taskStates,
  };
}

export function buildHandoffCardV2(input: {
  mission: Mission;
  turn: LocalTurn;
  task: PlanTask;
  artifacts: Artifact[];
  generatedAt?: string | undefined;
}): HandoffCardV2 {
  const agent = agentForTask(input.task);
  const generatedAt = input.generatedAt ?? nowIso();
  return {
    protocolVersion: 'roundtable.handoff.v2',
    cardId: `handoff-v2-${input.mission.id}-${input.task.id}`,
    missionId: input.mission.id,
    sourceTaskId: input.task.deps[0] ?? null,
    referenceTaskIds: [...input.task.deps],
    fromAgent: 'orchestrator',
    toAgent: agent.id,
    task: {
      id: input.task.id,
      title: input.task.title,
      brief: input.task.brief,
      state: 'pending',
    },
    contextPackage: {
      summary: input.turn.plan.summary,
      includedArtifactIds: input.artifacts.map((artifact) => artifact.id),
      omittedHistoryRef: input.turn.localChatId ? `chat://${input.turn.localChatId}` : `turn://${input.turn.id}`,
    },
    artifacts: input.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
    })),
    nextAction: `Run ${input.task.title}`,
    risks: riskHints(input.turn.message),
    provenance: {
      generatedBy: 'orchestrator',
      generatedAt,
      agentCardSnapshot: agentCardFor(agent),
      selectionReason: selectionReasonForTask(input.task, agent.id),
    },
  };
}

function selectionReasonForTask(task: PlanTask, agentId: string): string {
  if (task.owner) return `Selected ${agentId} from explicit task owner ${task.owner}.`;
  if (task.assignee) return `Selected ${agentId} from task assignee ${task.assignee}.`;
  if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
    return `Selected ${agentId} because it matches required capabilities: ${task.requiredCapabilities.join(', ')}.`;
  }
  return `Selected ${agentId} by default orchestrator fallback.`;
}

function syncMissionWithTurn(
  mission: Mission,
  turn: LocalTurn,
  opts: { artifactIds: string[] },
): Mission {
  const now = nowIso();
  const template = templateFromTurn(turn);
  const recordByTask = new Map(turn.dispatch.map((record) => [record.taskId, record]));
  const artifactByTask = new Map<string, string[]>();
  for (const artifact of turn.artifacts) {
    const taskId = turn.plan.tasks.find((task) => artifact.id.startsWith(`${task.id}_`))?.id;
    if (!taskId) continue;
    artifactByTask.set(taskId, [...(artifactByTask.get(taskId) ?? []), artifact.id]);
  }

  const tasks = turn.plan.tasks.map((task) => {
    const record = recordByTask.get(task.id);
    return missionTaskFromPlanTask(task, record?.status ?? taskStatusFromTurn(turn, task.id), artifactByTask.get(task.id) ?? []);
  });

  const stages = template.stages.map((stage) => {
    const taskIds = taskIdsForStage(stage.id, turn.plan.tasks);
    const stageTasks = tasks.filter((task) => task.stageId === stage.id);
    const artifactIds = unique(stageTasks.flatMap((task) => task.artifactIds));
    return {
      id: stage.id,
      name: stage.name,
      status: stageStatusFromTasks(stage, stageTasks, turn),
      taskIds,
      artifactIds,
      gate: stage.gate,
    };
  });

  const status = missionStatusFromTurn(turn, stages);
  const currentStageId = currentStageFromStages(stages, status);
  return {
    ...mission,
    goal: turn.message,
    status,
    currentStageId,
    stages,
    tasks,
    checkpoints: updateCheckpoints(mission.checkpoints, turn, status, now),
    decisions: updateDecisions(mission.decisions, turn, now),
    artifactIds: unique([...mission.artifactIds, ...opts.artifactIds]),
    finalDelivery: finalDeliveryForTurn(turn),
    updatedAt: now,
  };
}

async function updateMission(
  missionId: string,
  update: (mission: Mission) => Mission,
): Promise<Mission | null> {
  return mutateData((data) => {
    const index = data.missions.findIndex((mission) => mission.id === missionId);
    if (index === -1) return null;
    const current = data.missions[index];
    if (!current) return null;
    const next = update(current);
    data.missions[index] = next;
    return next;
  });
}

function missionFromTurnSnapshot(turn: LocalTurn, template: WorkflowTemplate): Mission {
  const now = nowIso();
  return {
    id: turn.missionId,
    ownerId: turn.ownerId,
    chatId: turn.localChatId,
    sourceTurnId: turn.id,
    turnIds: [turn.id],
    goal: turn.message,
    workingStyle: turn.workingStyle ?? { skills: [], projectRules: [] },
    status: missionStatusFromTurn(turn, []),
    workflowTemplateId: template.id,
    workflowTemplateName: template.name,
    currentStageId: turn.dispatchStatus === 'completed' ? 'ship' : turn.needsClarification ? 'clarify' : 'plan',
    stages: template.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      status: 'pending',
      taskIds: taskIdsForStage(stage.id, turn.plan.tasks),
      artifactIds: [],
      gate: stage.gate,
    })),
    tasks: turn.plan.tasks.map((task) => missionTaskFromPlanTask(task, 'pending', [])),
    checkpoints: checkpointsForTemplate(template, turn.needsClarification, now),
    decisions: [],
    artifactIds: turn.artifacts.map((artifact) => artifact.id),
    finalDelivery: initialFinalDelivery(),
    createdAt: turn.createdAt,
    updatedAt: now,
  };
}

function missionTaskFromPlanTask(
  task: PlanTask,
  status: MissionTask['status'],
  artifactIds: string[],
): MissionTask {
  return {
    id: task.id,
    stageId: task.stageId ?? stageForTask(task),
    title: task.title,
    assignee: task.assignee,
    owner: task.owner ?? null,
    status,
    deps: [...task.deps],
    artifactIds,
  };
}

function stageForTask(task: PlanTask): string {
  if (task.role === 'planner' || task.id === 'task_planning') return 'plan';
  if (task.role === 'reviewer') return 'review';
  if (task.role === 'fixer' || task.producedFor) return 'repair';
  return 'build';
}

function taskIdsForStage(stageId: string, tasks: PlanTask[]): string[] {
  return tasks.filter((task) => (task.stageId ?? stageForTask(task)) === stageId).map((task) => task.id);
}

function checkpointsForTemplate(template: WorkflowTemplate, needsClarification: boolean, now: string): MissionCheckpoint[] {
  return template.stages
    .filter((stage) => stage.gate.kind !== 'none' && stage.gate.required)
    .map((stage) => {
      const planGate = stage.gate.kind === 'plan_approval';
      const clarifyGate = stage.gate.kind === 'requirement_clarification';
      const satisfied = clarifyGate && !needsClarification;
      return {
        id: `checkpoint_${stage.id}`,
        kind: stage.gate.kind,
        label: stage.gate.label,
        status: satisfied ? 'satisfied' : 'pending',
        requiredAction: planGate
          ? 'Approve the plan to start agent execution.'
          : clarifyGate && needsClarification
            ? 'Answer the planner questions.'
            : null,
        stageId: stage.id,
        createdAt: now,
        resolvedAt: satisfied ? now : null,
      };
    });
}

function updateCheckpoints(
  checkpoints: MissionCheckpoint[],
  turn: LocalTurn,
  status: MissionStatus,
  now: string,
): MissionCheckpoint[] {
  return checkpoints.map((checkpoint) => {
    if (checkpoint.kind === 'requirement_clarification') {
      const satisfied = !turn.needsClarification;
      return {
        ...checkpoint,
        status: satisfied ? 'satisfied' : 'pending',
        requiredAction: satisfied ? null : 'Answer the planner questions.',
        resolvedAt: satisfied ? checkpoint.resolvedAt ?? now : null,
      };
    }
    if (checkpoint.kind === 'plan_approval') {
      const satisfied = turn.approvalStatus === 'approved';
      return {
        ...checkpoint,
        status: satisfied ? 'satisfied' : turn.approvalStatus === 'rejected' ? 'blocked' : 'pending',
        requiredAction: satisfied ? null : 'Approve the plan to start agent execution.',
        resolvedAt: satisfied ? checkpoint.resolvedAt ?? now : null,
      };
    }
    if (checkpoint.kind === 'reviewer_signoff') {
      const reviewerDone = turn.dispatch.some((record) => record.status === 'completed'
        && turn.plan.tasks.find((task) => task.id === record.taskId)?.role === 'reviewer');
      const failed = status === 'failed';
      return {
        ...checkpoint,
        status: reviewerDone ? 'satisfied' : failed ? 'blocked' : 'pending',
        requiredAction: reviewerDone
          ? null
          : failed
            ? 'Review failed before confidence output. Check the failed task and retry the run.'
            : 'Wait for reviewer confidence output.',
        resolvedAt: reviewerDone ? checkpoint.resolvedAt ?? now : null,
      };
    }
    if (checkpoint.kind === 'final_delivery_acceptance') {
      const ready = turn.dispatchStatus === 'completed';
      return {
        ...checkpoint,
        status: ready ? 'pending' : checkpoint.status,
        requiredAction: ready ? 'Accept final delivery or request repair.' : checkpoint.requiredAction,
      };
    }
    return checkpoint;
  });
}

function updateDecisions(
  decisions: Mission['decisions'],
  turn: LocalTurn,
  now: string,
): Mission['decisions'] {
  const next = [...decisions];
  if (turn.approvalStatus === 'approved' && !next.some((item) => item.id === `decision_plan_${turn.id}`)) {
    next.push({
      id: `decision_plan_${turn.id}`,
      stageId: 'plan',
      actor: 'user',
      summary: 'Plan approved; agent execution may start.',
      createdAt: turn.approvedAt ?? now,
    });
  }
  if (turn.dispatchStatus === 'completed' && !next.some((item) => item.id === `decision_review_${turn.id}`)) {
    next.push({
      id: `decision_review_${turn.id}`,
      stageId: 'review',
      actor: 'reviewer',
      summary: 'Reviewer output completed; final delivery report can be prepared.',
      createdAt: turn.dispatchedAt ?? now,
    });
  }
  return next;
}

function finalDeliveryForTurn(turn: LocalTurn): MissionFinalDelivery {
  if (turn.dispatchStatus !== 'completed') return initialFinalDelivery();
  // Report artifacts are scoped to the chat when one exists (so follow-up turns
  // replace them) and to the turn otherwise — match by prefix, not exact id.
  const reportArtifact = turn.artifacts.find((artifact) => artifact.id.startsWith('final_report_'));
  const summaryArtifact = turn.artifacts.find((artifact) => artifact.id.startsWith('review_summary_'));
  const summary = parseReviewSummary(summaryArtifact?.preview);
  const reviewArtifact = turn.artifacts.find((artifact) => artifact.ownerAgentId === 'vera' || artifact.ownerAgentId === 'reviewer');
  const reportText = reportArtifact?.preview ?? '';
  const confidence = summary?.confidence ?? (/Reviewer confidence:\s*blocked/i.test(reportText)
    ? 'blocked'
    : /Reviewer confidence:\s*pass/i.test(reportText)
      ? 'pass'
      : /Reviewer confidence:\s*warning/i.test(reportText)
        ? 'warning'
        : reviewArtifact
          ? 'pass'
          : 'unknown');
  const testsObserved = summary?.testsObserved ?? /Test or verification evidence was mentioned/i.test(reportText);
  const risks = summary?.risks ?? (reportText.includes('No blocking task failures recorded.')
    ? []
    : reportText
        .split('\n')
        .filter((line) => line.startsWith('- ') && /failed|blocked|error/i.test(line))
        .map((line) => line.slice(2)));
  return {
    status: 'ready',
    reportArtifactId: reportArtifact?.id ?? reviewArtifact?.id ?? turn.artifacts.at(-1)?.id ?? null,
    recommendation: summary?.recommendation ?? 'accept',
    confidence,
    testsObserved,
    risks,
  };
}

function parseReviewSummary(text: string | null | undefined): Pick<MissionFinalDelivery, 'confidence' | 'recommendation' | 'testsObserved' | 'risks'> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<MissionFinalDelivery>;
    const confidence = ['pass', 'warning', 'blocked', 'unknown'].includes(String(parsed.confidence))
      ? parsed.confidence as MissionFinalDelivery['confidence']
      : 'unknown';
    const recommendation = ['accept', 'repair', 'review'].includes(String(parsed.recommendation))
      ? parsed.recommendation as MissionFinalDelivery['recommendation']
      : 'review';
    return {
      confidence,
      recommendation,
      testsObserved: parsed.testsObserved === true,
      risks: Array.isArray(parsed.risks) ? parsed.risks.filter((risk): risk is string => typeof risk === 'string') : [],
    };
  } catch {
    return null;
  }
}

function initialFinalDelivery(): MissionFinalDelivery {
  return { status: 'not_ready', reportArtifactId: null, recommendation: 'review', confidence: 'unknown', testsObserved: false, risks: [] };
}

function missionStatusFromTurn(turn: LocalTurn, stages: MissionStage[]): MissionStatus {
  if (turn.needsClarification) return 'awaiting_clarification';
  if (turn.approvalStatus === 'rejected') return 'blocked';
  if (turn.needsApproval || turn.approvalStatus === 'pending') return 'awaiting_approval';
  if (turn.dispatchStatus === 'running') return 'running';
  if (turn.dispatchStatus === 'completed') return 'completed';
  if (turn.dispatchStatus === 'failed') return 'failed';
  if (stages.some((stage) => stage.status === 'blocked')) return 'blocked';
  return 'awaiting_approval';
}

function currentStageFromStages(stages: MissionStage[], status: MissionStatus): string | null {
  if (status === 'completed') return 'ship';
  if (status === 'failed') {
    return stages.find((stage) => stage.status === 'failed')?.id
      ?? stages.find((stage) => stage.status === 'blocked')?.id
      ?? null;
  }
  return stages.find((stage) => stage.status === 'active' || stage.status === 'running' || stage.status === 'blocked')?.id
    ?? stages.find((stage) => stage.status === 'pending')?.id
    ?? null;
}

function taskStatusFromTurn(turn: LocalTurn, taskId: string): MissionTask['status'] {
  const live = turn.workflowRun?.taskStates?.[taskId]?.status ?? turn.workflowRun?.stageStates?.[taskId]?.status;
  if (live === 'done') return 'completed';
  if (live === 'running' || live === 'active') return 'running';
  if (live === 'failed') return 'failed';
  if (live === 'blocked') return 'blocked';
  return 'pending';
}

function stageStatusFromTasks(
  stage: WorkflowStage,
  tasks: MissionTask[],
  turn: LocalTurn,
): WorkflowStageRunStatus {
  if (stage.id === 'intake') return 'done';
  if (stage.id === 'clarify') return turn.needsClarification ? 'active' : 'done';
  if (stage.id === 'ship') {
    if (turn.dispatchStatus === 'completed') return 'done';
    if (turn.dispatchStatus === 'failed') return 'blocked';
    return 'pending';
  }
  if (tasks.length === 0) return stage.id === 'plan' && turn.approvalStatus === 'pending' ? 'active' : 'pending';
  return aggregateTaskStatus(tasks);
}

function aggregateTaskStatus(tasks: MissionTask[]): WorkflowStageRunStatus {
  if (tasks.length === 0) return 'pending';
  if (tasks.some((task) => task.status === 'running')) return 'active';
  if (tasks.some((task) => task.status === 'failed')) return 'failed';
  if (tasks.some((task) => task.status === 'blocked')) return 'blocked';
  if (tasks.every((task) => task.status === 'completed')) return 'done';
  return 'pending';
}

function taskStatusToStageStatus(status: MissionTask['status']): WorkflowStageRunStatus {
  if (status === 'completed') return 'done';
  if (status === 'running') return 'running';
  return status;
}

function riskHints(message: string): string[] {
  const risks = [];
  if (/\b(auth|login|payment|billing|权限|支付|登录|鉴权)\b/i.test(message)) {
    risks.push('High-risk domain; reviewer should verify security and failure paths.');
  }
  risks.push('Downstream agents receive compact handoff context, not full raw history.');
  return risks;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function cloneTemplate(template: WorkflowTemplate): WorkflowTemplate {
  return JSON.parse(JSON.stringify(template)) as WorkflowTemplate;
}
