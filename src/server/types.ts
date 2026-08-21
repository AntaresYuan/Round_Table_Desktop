export type Actor = {
  id: string;
  email: string;
  name: string | null;
};

export type ArtifactKind = 'markdown' | 'code' | 'preview' | 'file' | 'diff' | 'html' | 'spec';

export type Workbench = {
  id: string;
  ownerId: string;
  name: string;
  workspacePath: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Chat = {
  id: string;
  ownerId: string;
  workbenchId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  ownerId: string;
  chatId: string;
  authorType: 'user' | 'agent' | 'system';
  authorId: string;
  content: string;
  createdAt: string;
};

export type BreakoutRoomStatus = 'open' | 'closed';

export type BreakoutRoom = {
  id: string;
  ownerId: string;
  chatId: string;
  createdBy: string;
  participantAgentIds: string[];
  status: BreakoutRoomStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type BreakoutMessage = {
  id: string;
  ownerId: string;
  roomId: string;
  authorType: 'user' | 'agent' | 'system';
  authorId: string;
  content: string;
  createdAt: string;
};

export type Artifact = {
  id: string;
  chatId: string;
  kind: ArtifactKind;
  title: string;
  // The agent that produced the CURRENT version — on a version bump this is
  // updated to the last editor, which is what makes per-file blame possible.
  ownerAgentId: string;
  version: number;
  uri: string;
  preview: string | null;
  code: string | null;
  createdAt: string;
  // Line-level stats for the latest version: all-added on creation, computed
  // against the previous version on each bump. Absent on legacy artifacts.
  change?: { added: number; removed: number } | null;
};

export type WorkflowSeat =
  | { ref: { kind: 'user' } }
  | { ref: { kind: 'role'; role: AgentRole; agentId?: string | undefined } };

export type QualityGateKind =
  | 'none'
  | 'requirement_clarification'
  | 'plan_approval'
  | 'handoff_acceptance'
  | 'test_failure_repair'
  | 'reviewer_signoff'
  | 'final_delivery_acceptance';

export type QualityGate = {
  kind: QualityGateKind;
  required: boolean;
  label: string;
  description: string;
  actions: string[];
};

export type WorkflowStage = {
  id: string;
  name: string;
  icon: string;
  kind: 'intake' | 'clarify' | 'plan' | 'work' | 'review' | 'repair' | 'ship';
  desc: string;
  seats: WorkflowSeat[];
  fixed?: boolean | undefined;
  parallelGroup?: string | undefined;
  gate: QualityGate;
  requiredInputs: string[];
  expectedOutputs: string[];
  requiredCapabilities: string[];
};

export type WorkflowTemplate = {
  id: string;
  name: string;
  tag: string | null;
  desc: string;
  builtin: boolean;
  version: number;
  updatedAt: string;
  planning: {
    cut: 'by_role' | 'by_capability' | 'by_artifact';
    clarifyThreshold: number;
    maxClarifyQuestions: number;
  };
  stages: WorkflowStage[];
};

export type AgentRole = 'planner' | 'pm' | 'architect' | 'implementer' | 'reviewer' | 'fixer';

export type AgentRuntimeKind =
  | 'local-dispatch'
  | 'claude-code'
  | 'claude-code-router'
  | 'codex'
  | 'opencode';

export type AgentRuntimeInteractionMode = 'auto' | 'manual';
export type AgentRuntimeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgentRuntimeConfig = {
  agentId: string;
  runtime: AgentRuntimeKind;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  model: string | null;
  modelProvider: ModelProviderKind | null;
  interactionMode: AgentRuntimeInteractionMode | null;
  effort: AgentRuntimeEffort | null;
  updatedAt: string;
};

export type AgentRuntimeDefaultConfig = {
  runtime: AgentRuntimeKind;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  model: string | null;
  modelProvider: ModelProviderKind | null;
  interactionMode: AgentRuntimeInteractionMode | null;
  effort: AgentRuntimeEffort | null;
  updatedAt: string;
};

export type AgentRuntimeConversationStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type AgentRuntimeTranscriptEntry = {
  at: string;
  kind: 'status' | 'thinking' | 'response' | 'error';
  content: string;
};

// Response-only view of a task's live runtime conversation, attached to turns
// by listTurns so the polling UI can stream agent activity while a run is hot.
// Never persisted on the turn itself — conversations remain the source of truth.
export type TurnTaskActivity = {
  conversationId: string;
  agentId: string;
  runtime: AgentRuntimeKind;
  status: AgentRuntimeConversationStatus;
  error: string | null;
  updatedAt: string;
  transcript: AgentRuntimeTranscriptEntry[];
};

export type TurnLiveActivity = Record<string, TurnTaskActivity>;

export type AgentRuntimeConversation = {
  id: string;
  agentId: string;
  role: AgentRole;
  runtime: AgentRuntimeKind;
  title: string;
  turnId: string | null;
  taskId: string | null;
  workspacePath: string;
  cwd: string;
  command: string;
  pid: number | null;
  status: AgentRuntimeConversationStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  events: AgentEvent[];
  transcript: AgentRuntimeTranscriptEntry[];
  error: string | null;
  // CLI-native session id (claude session_id / codex thread_id / opencode
  // sessionID) captured from the run, when the runtime reported one. Optional:
  // records predate this field.
  sessionId?: string | null;
};

export type ModelProviderKind = 'minimax' | 'openai-compatible';

export type ModelProviderConfig = {
  provider: ModelProviderKind;
  enabled: boolean;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  updatedAt: string;
};

export type RoundtableSettings = {
  defaultAgentAdapter: string | null;
  modelProviders: ModelProviderConfig[];
  a2aRemoteAgents: A2ARemoteAgentConfig[];
  // User-edited workflow templates. A custom template with a builtin id
  // OVERRIDES that builtin everywhere (resolution, auto-select, plan
  // generation); novel ids are additional selectable workflows.
  workflowTemplates: WorkflowTemplate[];
  updatedAt: string;
};

export type A2ARemoteAgentConfig = {
  agentId: string;
  enabled: boolean;
  baseUrl: string;
  cardPath: string | null;
  authToken: string | null;
  updatedAt: string;
};

export type A2ATaskBindingState =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'input_required'
  | 'auth_required'
  | 'rejected';

export type A2ATaskBinding = {
  id: string;
  missionId: string;
  turnId: string;
  planTaskId: string;
  agentId: string;
  agentBaseUrl: string;
  agentCardPath: string | null;
  remoteTaskId: string;
  remoteContextId: string | null;
  remoteTenant: string;
  protocolVersion: string;
  state: A2ATaskBindingState;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentCard = {
  id: string;
  name: string;
  role: AgentRole;
  capabilities: string[];
  skills: string[];
  preferredTaskTypes: string[];
  supportedArtifactTypes: ArtifactKind[];
  adapterMetadata: Record<string, string>;
  safetyConstraints: string[];
};

export type Handoff = {
  id: string;
  ownerId: string;
  chatId: string;
  card: Record<string, unknown>;
  createdAt: string;
};

export type HandoffCardV2 = {
  protocolVersion: 'roundtable.handoff.v2';
  cardId: string;
  missionId: string;
  sourceTaskId: string | null;
  referenceTaskIds: string[];
  fromAgent: string;
  toAgent: string;
  task: {
    id: string;
    title: string;
    brief: string;
    state: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  };
  contextPackage: {
    summary: string;
    includedArtifactIds: string[];
    omittedHistoryRef: string | null;
  };
  artifacts: Array<{ id: string; kind: ArtifactKind; title: string }>;
  nextAction: string;
  risks: string[];
  provenance: {
    generatedBy: string;
    generatedAt: string;
    agentCardSnapshot: AgentCard | null;
    selectionReason: string;
  };
};

export type UserProfile = {
  userId: string;
  defaultBrief: string;
  defaultSkills: string[];
  notes: string;
  updatedAt: string;
};

// Retained for WorkingStyleSnapshot: profile default skills and stored turn
// snapshots still carry a source/scope even though the skills panel is gone.
export type UserSkillSource = 'user' | 'observed' | 'workspace' | 'recommended';
export type UserSkillScope = 'personal' | 'workspace' | 'mission';

export type WorkingStyleSnapshot = {
  skills: Array<{
    key: string;
    label: string;
    description: string;
    source: UserSkillSource;
    scope: UserSkillScope;
  }>;
  projectRules: string[];
};

export type WorkbenchPin = {
  id: string;
  userId: string;
  workbenchId: string;
  content: string;
  createdAt: string;
};

export type Intake = {
  intentType: 'build' | 'review' | 'research' | 'fix' | 'question';
  summary: string;
  clarity: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
};

// A clarifying question the planner asks when the request is too vague to plan.
// The user only picks an option (nocode-friendly); answers feed back into the plan.
export type ClarifyOption = {
  id: string;
  label: string;
  description?: string | undefined;
};

export type ClarifyQuestion = {
  id: string;
  question: string;
  options: ClarifyOption[];
};

export type ClarifyAnswer = {
  questionId: string;
  optionId: string;
  // The free-text label chosen, so the planner can read it directly.
  label: string;
};

export type PlanTask = {
  id: string;
  title: string;
  assignee: string;
  owner?: string | undefined;
  role?: string | undefined;
  stageId?: string | undefined;
  // The template stage KIND this task was generated from ('plan' | 'work' |
  // 'review' …). stageId is the stage's (possibly renamed) id; kind is stable,
  // so gating logic (e.g. the architect's review check) survives custom
  // templates that rename their stages.
  stageKind?: string | undefined;
  requiredCapabilities?: string[] | undefined;
  brief: string;
  // One user-facing sentence describing the concrete work this CLI owns.
  // Unlike `brief`, this is safe to display directly in the approval plan.
  objective?: string | undefined;
  deps: string[];
  parallel: boolean;
  // Optional scheduler hints. `priority` orders tasks inside a single wave
  // (lower first). `producedFor`/`fixRound` are only set on fixer tasks the
  // scheduler derives when an upstream task fails — they record which task is
  // being repaired and how many fix attempts have run for that branch.
  priority?: number | undefined;
  producedFor?: string | undefined;
  fixRound?: number | undefined;
  // Set on fixer tasks that repair a concrete deliverable (e.g. an HTML page):
  // the workspace path the corrected output should be written to, and the task
  // whose artifact gets updated in place so the preview shows the fixed version.
  repairTargetPath?: string | undefined;
  repairTargetTaskId?: string | undefined;
  // Set on fixer tasks derived from a failed PLANNING task (and inherited by
  // chained fix rounds): the fixer must only re-produce the plan — it is not
  // allowed to touch source/product files. Implementation stays with the
  // build stage that runs once the repaired plan is in place.
  replanOnly?: boolean | undefined;
  // Concrete checks agreed during the planning meeting. They travel with the
  // task handoff so an implementer knows what "done" means before execution.
  acceptanceCriteria?: string[] | undefined;
  // Meeting decisions that shaped this task. These are stable ids into
  // LocalTurn.planningMeeting.decisions, not free-form duplicated prose.
  meetingDecisionIds?: string[] | undefined;
};

export type Plan = {
  summary: string;
  tasks: PlanTask[];
};

export type AgentEvent =
  | { type: 'thinking_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; output: Record<string, unknown>; isError?: boolean }
  | { type: 'file_change'; path: string; kind: 'create' | 'edit' | 'delete'; diff: string }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string; recoverable: boolean };

export type DispatchRecord = {
  taskId: string;
  agentId: string;
  // 'blocked' is added for the DAG scheduler: a task whose (transitive) deps
  // failed is never executed and is recorded as blocked. Existing values are
  // kept unchanged so the UI status mapping (completed/failed/...) still works.
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  events: AgentEvent[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  // Set on fixer records derived by the scheduler: which task produced this
  // fix attempt, and how many fix rounds had run for that branch.
  producedFor?: string | undefined;
  fixRound?: number | undefined;
  // Every artifact this task's run produced or edited (transcript + workspace
  // files) — the per-agent attribution link the conversation UI renders.
  // Absent on records persisted before this field existed.
  artifactIds?: string[] | undefined;
  remote?: {
    protocol: 'a2a';
    taskId: string;
    contextId: string | null;
    protocolVersion: string;
    agentBaseUrl: string;
  } | undefined;
};

export type WorkflowStageRunStatus = 'pending' | 'active' | 'running' | 'done' | 'blocked' | 'failed';

export type WorkflowRun = {
  activeStageId: string | null;
  // Kept keyed by both task id and stage id for compatibility with the old
  // task-only UI and the newer Mission stage cards.
  stageStates: Record<string, {
    status: WorkflowStageRunStatus;
    taskIds?: string[] | undefined;
    artifactIds?: string[] | undefined;
    gate?: QualityGate | undefined;
    seatRuns?: Array<{
      agentId: string;
      status: WorkflowStageRunStatus;
      artifactIds: string[];
    }> | undefined;
  }>;
  taskStates: Record<string, { status: WorkflowStageRunStatus; stageId: string | null }>;
};

export type MissionStatus =
  | 'awaiting_clarification'
  | 'awaiting_approval'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed';

export type MissionStage = {
  id: string;
  name: string;
  status: WorkflowStageRunStatus;
  taskIds: string[];
  artifactIds: string[];
  gate: QualityGate;
};

export type MissionTask = {
  id: string;
  stageId: string | null;
  title: string;
  assignee: string;
  owner: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  deps: string[];
  artifactIds: string[];
};

export type MissionCheckpoint = {
  id: string;
  kind: QualityGateKind;
  label: string;
  status: 'pending' | 'satisfied' | 'blocked' | 'skipped';
  requiredAction: string | null;
  stageId: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type MissionDecision = {
  id: string;
  stageId: string;
  actor: 'user' | 'reviewer' | 'orchestrator';
  summary: string;
  createdAt: string;
};

export type MissionFinalDelivery = {
  status: 'not_ready' | 'ready' | 'accepted' | 'rejected';
  reportArtifactId: string | null;
  recommendation: 'accept' | 'repair' | 'review';
  confidence: 'pass' | 'warning' | 'blocked' | 'unknown';
  testsObserved: boolean;
  risks: string[];
};

export type Mission = {
  id: string;
  ownerId: string | null;
  chatId: string | null;
  // The turn that most recently (re)defined this mission's plan.
  sourceTurnId: string;
  // Every turn that has contributed to the mission, oldest first. A chat's
  // follow-up turns continue one mission instead of spawning siblings.
  // Optional: records created before cross-turn continuity carry only
  // sourceTurnId.
  turnIds?: string[];
  // Standalone missions (question turns) never become — or continue — the
  // chat's ongoing mission.
  standalone?: boolean;
  goal: string;
  workingStyle: WorkingStyleSnapshot;
  status: MissionStatus;
  workflowTemplateId: string;
  workflowTemplateName: string;
  currentStageId: string | null;
  stages: MissionStage[];
  tasks: MissionTask[];
  checkpoints: MissionCheckpoint[];
  decisions: MissionDecision[];
  artifactIds: string[];
  finalDelivery: MissionFinalDelivery;
  createdAt: string;
  updatedAt: string;
};

export type PlanningMeetingPhase = 'opening' | 'position' | 'facilitation' | 'commitment' | 'challenge' | 'decision';

export type PlanningMeetingMessage = {
  id: string;
  phase: PlanningMeetingPhase;
  agentId: string;
  role: AgentRole;
  content: string;
  createdAt: string;
  wordLimit: number;
  // Position messages are independent. Challenge/decision messages list the
  // earlier statements they were allowed to inspect.
  references: string[];
};

export type PlanningMeetingDecision = {
  id: string;
  summary: string;
  rationale: string;
  taskIds: string[];
};

export type PlanningMeeting = {
  status: 'completed' | 'fallback' | 'skipped';
  algorithm: 'independent-positions-linear-challenge-v1' | 'facilitated-role-relay-v2';
  provider: ModelProviderKind | 'local-deterministic';
  model: string;
  participants: string[];
  messages: PlanningMeetingMessage[];
  decisions: PlanningMeetingDecision[];
  risks: string[];
  unresolved: string[];
  repositorySummary: string;
  startedAt: string;
  completedAt: string;
};

export type LocalTurn = {
  id: string;
  localChatId: string | null;
  ownerId: string | null;
  missionId: string;
  workflowTemplateId: string;
  message: string;
  workingStyle: WorkingStyleSnapshot;
  status: 'pending' | 'done' | 'error';
  createdAt: string;
  provider: string;
  model: string;
  pmMessage: string;
  // Clarify gate: when the planner finds the request too vague it returns
  // questions and the turn pauses here (before dispatch) until the user answers.
  needsClarification: boolean;
  clarifyQuestions: ClarifyQuestion[];
  clarifyAnswers: ClarifyAnswer[];
  needsApproval: boolean;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  approvedAt: string | null;
  dispatchStatus: 'not_started' | 'running' | 'completed' | 'failed';
  dispatchAdapter: string | null;
  dispatchedAt: string | null;
  dispatchStage: string | null;
  dispatchError: string | null;
  dispatchWorkspacePath: string | null;
  dispatch: DispatchRecord[];
  artifacts: Artifact[];
  intake: Intake;
  plan: Plan;
  // Optional for backward compatibility with turns persisted before planning
  // meetings were introduced. New non-question turns always populate it.
  planningMeeting?: PlanningMeeting | null | undefined;
  workflow: Record<string, unknown> | null;
  workflowRun: WorkflowRun | null;
  mission: Mission | null;
  error: string | null;
};
