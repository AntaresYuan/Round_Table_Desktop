import './load-env.js';
import { id, mutateData, readData } from '../server/store.js';
import type {
  AgentRuntimeConfig,
  AgentRuntimeConversation,
  Artifact,
  Chat,
  Handoff,
  LocalTurn,
  Message,
  Mission,
  UserProfile,
  Workbench,
  WorkbenchPin,
} from '../server/types.js';

const targetDriver = process.env.ROUNDTABLE_STORE_DRIVER || 'postgres_normalized';

if (!['postgres', 'postgres_normalized', 'normalized'].includes(targetDriver)) {
  throw new Error('Set ROUNDTABLE_STORE_DRIVER to postgres or postgres_normalized before running the smoke check.');
}

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL before running the Postgres smoke check.');
}

process.env.ROUNDTABLE_STORE_DRIVER = targetDriver;

const now = new Date().toISOString();
const marker = {
  id: id('user'),
  email: `smoke-${Date.now()}@roundtable.local`,
  name: 'Postgres Smoke',
  createdAt: now,
};
const workbench: Workbench = {
  id: id('wb'),
  ownerId: marker.id,
  name: 'Smoke Workbench',
  workspacePath: `.roundtable/workspaces/${marker.id}/smoke`,
  description: null,
  createdAt: now,
  updatedAt: now,
};
const chat: Chat = {
  id: id('chat'),
  ownerId: marker.id,
  workbenchId: workbench.id,
  title: 'Smoke Chat',
  createdAt: now,
  updatedAt: now,
};
const message: Message = {
  id: id('msg'),
  ownerId: marker.id,
  chatId: chat.id,
  authorType: 'user',
  authorId: marker.id,
  content: 'Smoke message',
  createdAt: now,
};
const artifact: Artifact = {
  id: id('art'),
  chatId: `local-${id('turn')}`,
  kind: 'markdown',
  title: 'Smoke artifact',
  ownerAgentId: 'planner',
  version: 1,
  uri: 'memory://smoke-artifact',
  preview: 'Artifact created before a durable chat exists.',
  code: null,
  createdAt: now,
};
const handoff: Handoff = {
  id: id('handoff'),
  ownerId: marker.id,
  chatId: chat.id,
  card: { summary: 'Smoke handoff', artifactIds: [artifact.id] },
  createdAt: now,
};
const profile: UserProfile = {
  userId: marker.id,
  defaultBrief: 'Smoke profile',
  defaultSkills: [],
  notes: 'Smoke profile notes',
  updatedAt: now,
};
const pin: WorkbenchPin = {
  id: id('pin'),
  userId: marker.id,
  workbenchId: workbench.id,
  content: 'Smoke pin',
  createdAt: now,
};
const turn: LocalTurn = {
  id: id('turn'),
  localChatId: null,
  ownerId: marker.id,
  missionId: id('mission'),
  workflowTemplateId: 'standard',
  message: 'Smoke turn',
  workingStyle: { skills: [], projectRules: [] },
  status: 'done',
  createdAt: now,
  provider: 'roundtable-local',
  model: 'smoke',
  pmMessage: 'Smoke plan ready.',
  needsClarification: false,
  clarifyQuestions: [],
  clarifyAnswers: [],
  needsApproval: false,
  approvalStatus: 'approved',
  approvedAt: now,
  dispatchStatus: 'not_started',
  dispatchAdapter: null,
  dispatchedAt: null,
  dispatchStage: 'approved',
  dispatchError: null,
  dispatchWorkspacePath: null,
  dispatch: [],
  artifacts: [artifact],
  intake: { intentType: 'build', summary: 'Smoke turn', clarity: 'high', risk: 'low' },
  plan: { summary: 'Smoke plan', tasks: [] },
  workflow: { id: 'standard', name: 'Standard', stages: [] },
  workflowRun: null,
  mission: null,
  error: null,
};
const mission: Mission = {
  id: turn.missionId,
  ownerId: marker.id,
  chatId: chat.id,
  sourceTurnId: turn.id,
  goal: 'Smoke mission',
  status: 'awaiting_approval',
  workflowTemplateName: 'Standard',
  workflowTemplateId: 'standard',
  currentStageId: null,
  stages: [],
  tasks: [],
  checkpoints: [],
  decisions: [],
  artifactIds: [artifact.id],
  workingStyle: { skills: [], projectRules: [] },
  finalDelivery: {
    status: 'not_ready',
    reportArtifactId: null,
    recommendation: 'review',
    confidence: 'unknown',
    testsObserved: false,
    risks: [],
  },
  createdAt: now,
  updatedAt: now,
};

const runtimeConfig: AgentRuntimeConfig = {
  agentId: 'atlas',
  runtime: 'claude-code',
  command: 'echo',
  args: ['smoke'],
  env: {},
  model: null,
  modelProvider: null,
  interactionMode: null,
  effort: null,
  updatedAt: now,
};
const runtimeConversation: AgentRuntimeConversation = {
  id: id('conv'),
  agentId: 'atlas',
  role: 'implementer',
  runtime: 'claude-code',
  title: 'Smoke conversation',
  turnId: turn.id,
  taskId: id('task'),
  workspacePath: workbench.workspacePath,
  cwd: workbench.workspacePath,
  command: 'echo smoke',
  pid: null,
  status: 'completed',
  startedAt: now,
  updatedAt: now,
  finishedAt: now,
  error: null,
  events: [],
  transcript: [{ at: now, kind: 'response', content: 'smoke' }],
};

await mutateData((data) => {
  data.users.push(marker);
  data.workbenches.push(workbench);
  data.chats.push(chat);
  data.messages.push(message);
  data.artifacts.push(artifact);
  data.handoffs.push(handoff);
  data.profiles.push(profile);
  data.workbenchPins.push(pin);
  data.turns.push(turn);
  data.missions.push(mission);
  data.agentRuntimeConfigs.push(runtimeConfig);
  data.agentRuntimeConversations = [runtimeConversation, ...data.agentRuntimeConversations];
  data.settings = { ...data.settings, defaultAgentAdapter: 'local-dispatch', updatedAt: now };
});

const data = await readData();
const found = data.users.some((user) => user.id === marker.id && user.email === marker.email);
if (!found) throw new Error('Postgres smoke marker was not persisted.');
if (!data.workbenches.some((item) => item.id === workbench.id)) throw new Error('Workbench marker was not persisted.');
if (!data.chats.some((item) => item.id === chat.id)) throw new Error('Chat marker was not persisted.');
if (!data.artifacts.some((item) => item.id === artifact.id && item.chatId.startsWith('local-'))) {
  throw new Error('Local artifact marker was not persisted.');
}
if (!data.agentRuntimeConfigs.some((item) => item.agentId === runtimeConfig.agentId && item.runtime === 'claude-code')) {
  throw new Error('Agent runtime config marker was not persisted.');
}
if (!data.agentRuntimeConversations.some((item) => item.id === runtimeConversation.id && item.transcript.length === 1)) {
  throw new Error('Agent runtime conversation marker was not persisted.');
}
if (data.settings.defaultAgentAdapter !== 'local-dispatch') {
  throw new Error('Settings marker was not persisted.');
}

process.stdout.write(
  `Postgres smoke check passed with ${targetDriver} store key ${process.env.ROUNDTABLE_STORE_KEY || 'default'}.\n`,
);
