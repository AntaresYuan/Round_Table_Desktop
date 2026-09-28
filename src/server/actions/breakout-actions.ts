/*
  Breakout rooms: real side rooms a user can sit in next to the main chat.

  What this module owns:
  - persistence of rooms and their messages (two participants per room),
  - a contextual reply from one of the room's agents when the user posts,
  - context injection: the room agent answers WITH the current main-chat
    context (mission goal, active tasks, recent messages, artifacts) so it can
    reason about "this / now / the current work" without the user re-explaining.

  Deliberately NOT here: handoff proposals / "send to main chat". That flow was
  removed because it never actually dispatched the handed-off task. Reply
  generation reuses the SAME model-availability path as ai-actions.ts
  (isOpenAICompatConfigured/isMiniMaxConfigured), so a key saved through the
  settings UI drives real replies — env vars are not required.
*/

import { id, mutateData, nowIso, readData } from '../store.js';
import type { RoundtableData } from '../store.js';
import type {
  Actor,
  BreakoutMessage,
  BreakoutRoom,
  Chat,
} from '../types.js';
import { AGENT_ROSTER, resolveAgentMention } from './agent-roster.js';
import type { AgentProfile } from './agent-roster.js';
import { isMiniMaxConfigured, runOnMiniMax } from './adapters/minimax-adapter.js';
import { isOpenAICompatConfigured, runOnOpenAICompat } from './adapters/openai-compat-adapter.js';
import { getChat } from './chat-actions.js';
import { tokenizeForOverlap } from './text-overlap.js';

export type BreakoutRoomBundle = BreakoutRoom & {
  messages: BreakoutMessage[];
};

export type BreakoutContextPackage = {
  chatTitle?: string | undefined;
  recentMainMessages?: string[] | undefined;
  missionGoal?: string | undefined;
  currentStage?: string | undefined;
  activeTasks?: string[] | undefined;
  detailSnippets?: Array<{
    source: 'main_message' | 'artifact' | 'task' | 'mission';
    id?: string | undefined;
    label: string;
    text: string;
  }> | undefined;
  artifacts?: Array<{
    id: string;
    title: string;
    kind: string;
    ownerAgentId: string;
    version?: number | undefined;
    summary?: string | undefined;
  }> | undefined;
};

export type BreakoutRequestRelation = 'current_work' | 'general_sidebar' | 'boundary_action';

export type BreakoutResponderDecision = {
  replyAuthorId: string;
  reason: string;
  scores: Array<{ agentId: string; score: number; matched: string[] }>;
};

// Pure read: never take the store write lock for a list query. Filtering and
// sorting happen in memory over a readData() snapshot, matching listTurns /
// listArtifactsByChat.
export async function listBreakoutRooms(actor: Actor, chatId: string): Promise<BreakoutRoomBundle[]> {
  await requireChat(actor, chatId);
  const data = await readData();
  return data.breakoutRooms
    .filter((room) => room.ownerId === actor.id && room.chatId === chatId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((room) => ({
      ...room,
      messages: data.breakoutMessages
        .filter((message) => message.ownerId === actor.id && message.roomId === room.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
}

export async function createBreakoutRoom(
  actor: Actor,
  input: { chatId: string; participantAgentIds: string[] },
): Promise<BreakoutRoomBundle> {
  await requireChat(actor, input.chatId);
  const participants = Array.from(new Set(input.participantAgentIds.map((item) => item.trim()).filter(Boolean)));
  if (participants.length !== 2) throw new Error('breakout_requires_two_participants');
  if (participants.some((agentId) => !AGENT_ROSTER.some((agent) => agent.id === agentId))) {
    throw new Error('breakout_unknown_participant');
  }

  return mutateData((data) => {
    const now = nowIso();
    const room: BreakoutRoom = {
      id: id('br'),
      ownerId: actor.id,
      chatId: input.chatId,
      createdBy: actor.id,
      participantAgentIds: participants,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    data.breakoutRooms.push(room);
    touchChat(data.chats, input.chatId, now);
    return { ...room, messages: [] };
  });
}

export async function postBreakoutMessage(
  actor: Actor,
  input: {
    roomId: string;
    content: string;
    authorType?: BreakoutMessage['authorType'] | undefined;
    authorId?: string | undefined;
  },
): Promise<BreakoutMessage> {
  const content = input.content.trim();
  if (!content) throw new Error('missing_message_content');

  // First write: persist the user message and take a context snapshot while we
  // hold the lock. The model call happens AFTER the lock is released.
  const saved = await mutateData((data) => {
    const room = requireRoomInData(data.breakoutRooms, actor, input.roomId);
    if (room.status === 'closed') throw new Error('breakout_room_closed');
    const now = nowIso();
    const message: BreakoutMessage = {
      id: id('brmsg'),
      ownerId: actor.id,
      roomId: input.roomId,
      authorType: input.authorType ?? 'user',
      authorId: input.authorId ?? actor.id,
      content,
      createdAt: now,
    };
    data.breakoutMessages.push(message);
    room.updatedAt = now;
    touchChat(data.chats, room.chatId, now);
    const transcript = data.breakoutMessages
      .filter((item) => item.ownerId === actor.id && item.roomId === room.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      message,
      room: { ...room },
      transcript,
      context: buildBreakoutContext(data, actor, room.chatId),
    };
  });

  if (saved.message.authorType !== 'user') return saved.message;

  const responder = selectBreakoutResponder({
    participantAgentIds: saved.room.participantAgentIds,
    content: saved.message.content,
    context: saved.context,
  });
  const replyText = await generateBreakoutAgentReply({
    participantAgentIds: saved.room.participantAgentIds,
    replyAuthorId: responder.replyAuthorId,
    responderReason: responder.reason,
    transcript: saved.transcript,
    context: saved.context,
  });
  await appendBreakoutAgentMessage(actor, {
    roomId: saved.room.id,
    authorId: responder.replyAuthorId,
    content: replyText,
  });
  return saved.message;
}

async function requireChat(actor: Actor, chatId: string): Promise<Chat> {
  const chat = await getChat(actor, chatId);
  if (!chat) throw new Error('chat_not_found');
  return chat;
}

function requireRoomInData(rooms: BreakoutRoom[], actor: Actor, roomId: string): BreakoutRoom {
  const room = rooms.find((item) => item.ownerId === actor.id && item.id === roomId);
  if (!room) throw new Error('breakout_room_not_found');
  return room;
}

function touchChat(chats: Chat[], chatId: string, updatedAt: string): void {
  const chat = chats.find((item) => item.id === chatId);
  if (chat) chat.updatedAt = updatedAt;
}

async function appendBreakoutAgentMessage(
  actor: Actor,
  input: { roomId: string; authorId: string; content: string },
): Promise<BreakoutMessage | null> {
  return mutateData((data) => {
    // The user message already committed and the model call has run; if the room
    // vanished or closed in the meantime, drop the reply rather than reject a
    // post that already succeeded.
    const room = data.breakoutRooms.find((item) => item.ownerId === actor.id && item.id === input.roomId);
    if (!room || room.status === 'closed') return null;
    const now = nowIso();
    const message: BreakoutMessage = {
      id: id('brmsg'),
      ownerId: actor.id,
      roomId: input.roomId,
      authorType: 'agent',
      authorId: input.authorId,
      content: input.content,
      createdAt: now,
    };
    data.breakoutMessages.push(message);
    room.updatedAt = now;
    return message;
  });
}

export async function generateBreakoutAgentReply(input: {
  participantAgentIds: string[];
  replyAuthorId: string;
  responderReason?: string | undefined;
  transcript: Array<Pick<BreakoutMessage, 'authorType' | 'authorId' | 'content'>>;
  context?: BreakoutContextPackage | undefined;
}): Promise<string> {
  const speaker = agentLabel(input.replyAuthorId);
  const participants = input.participantAgentIds.map(agentLabel).join(', ');
  const latestUserMessage = [...input.transcript].reverse().find((message) => message.authorType === 'user')?.content || '';
  const relation = classifyBreakoutRequest(latestUserMessage, input.context);
  const detailSnippets = relation === 'current_work'
    ? selectBreakoutDetailSnippets(latestUserMessage, input.context)
    : [];
  const transcript = input.transcript
    .slice(-12)
    .map((message) => {
      const name = message.authorType === 'user' ? 'User' : agentLabel(message.authorId);
      return `${name}: ${message.content}`;
    })
    .join('\n');
  const messages = [
    {
      role: 'system' as const,
      content: [
        'You are replying inside a Roundtable breakout room.',
        `You are ${speaker}. Other participants: ${participants}.`,
        input.responderReason ? `You were selected to answer because: ${input.responderReason}.` : null,
        'This room is for brainstorming, clarification, tradeoff thinking, and forming an action-ready plan.',
        'Reply as the agent, not as the system. Do not execute work, do not claim files changed, and do not send anything to the main chat.',
        'Classify the user request before answering:',
        '- CURRENT_WORK: it refers to the current mission, main chat, artifacts, UI, code, or uses pronouns like this/now/current that resolve to the current work. Use the provided main-chat context and current-chat detail snippets without asking permission.',
        '- GENERAL_SIDEBAR: it is an unrelated question or brainstorm. Answer normally in your agent voice and do not force the current mission context.',
        '- BOUNDARY_ACTION: it asks to write back to main chat, execute work, modify files, access another project/chat/workspace, call external services, or store durable memory. Do not do the action; explain that it needs an explicit handoff or confirmation.',
        'If CURRENT_WORK still lacks a specific detail after the supplied current-chat context, say exactly what is missing and offer a reasonable assumption or next question. Do not fabricate unseen details.',
        'Be genuinely useful: reason about the user question, ask a clarifying question if needed, and name tradeoffs or next steps.',
        'Keep it concise: 2-5 sentences. Match the user language.',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user' as const,
      content: [
        `Inferred request class: ${relation.toUpperCase()}`,
        '',
        'Current main-chat context:',
        formatBreakoutContext(input.context),
        '',
        'Current-chat detail snippets available to this breakout:',
        formatBreakoutDetailSnippets(detailSnippets),
        '',
        `Breakout transcript:\n${transcript}`,
        '',
        `Reply with the next message from ${speaker}.`,
      ].join('\n'),
    },
  ];
  try {
    if (await isOpenAICompatConfigured()) {
      const run = await runOnOpenAICompat({ messages, maxTokens: 420, temperature: 0.75, timeoutMs: 45_000 });
      if (run.text.trim()) return run.text.trim();
    } else if (await isMiniMaxConfigured()) {
      const run = await runOnMiniMax({ messages, maxTokens: 420, temperature: 0.75, timeoutMs: 45_000 });
      if (run.text.trim()) return run.text.trim();
    }
  } catch {
    // Keep the side room responsive if the configured model is temporarily unavailable.
  }
  return localBreakoutReply(input.transcript.at(-1)?.content || '');
}

export function classifyBreakoutRequest(
  content: string,
  context: BreakoutContextPackage | undefined,
): BreakoutRequestRelation {
  if (/(写回|发到|发送到|同步到|带回|提交到|存到|记到|保存到|改文件|修改文件|执行|开始做|去做|跑命令|部署|调用外部|另一个项目|别的项目|其他项目|另一个 chat|别的 chat|main chat|主\s*chat|主线|memory|remember|save.*memory|execute|run command|deploy|modify files|write back)/i.test(content)) {
    return 'boundary_action';
  }

  const contextText = [
    context?.chatTitle,
    context?.missionGoal,
    context?.currentStage,
    ...(context?.activeTasks || []),
    ...(context?.recentMainMessages || []),
    ...(context?.artifacts || []).flatMap((artifact) => [artifact.title, artifact.kind, artifact.summary]),
  ].filter(Boolean).join(' ').toLowerCase();
  const hasCurrentContext = contextText.trim().length > 0;
  const currentWorkCue = /(这个|这块|现在|当前|刚才|上面|这里|那个|主线|主\s*chat|当前\s*chat|mission|plan|task|breakout|room|agent|artifact|按钮|页面|代码|实现|设计|上下文|context|ui|auth|oauth|sign in|sign up)/i.test(content);
  if (currentWorkCue && hasCurrentContext) return 'current_work';

  const queryTokens = tokenizeForOverlap(content.toLowerCase());
  const contextTokens = new Set(tokenizeForOverlap(contextText));
  const overlap = queryTokens.filter((token) => contextTokens.has(token)).length;
  return overlap >= 2 ? 'current_work' : 'general_sidebar';
}

export function selectBreakoutResponder(input: {
  participantAgentIds: string[];
  content: string;
  context?: BreakoutContextPackage | undefined;
}): BreakoutResponderDecision {
  const participants = input.participantAgentIds
    .map((agentId) => AGENT_ROSTER.find((agent) => agent.id === agentId))
    .filter((agent): agent is AgentProfile => Boolean(agent));
  const fallback = participants[0] ?? AGENT_ROSTER[0]!;
  const mentioned = extractMentionedAgents(input.content)
    .find((agent) => participants.some((participant) => participant.id === agent.id));
  if (mentioned) {
    return {
      replyAuthorId: mentioned.id,
      reason: `the user explicitly mentioned ${mentioned.displayName}`,
      scores: participants.map((agent) => ({ agentId: agent.id, score: agent.id === mentioned.id ? 100 : 0, matched: agent.id === mentioned.id ? ['explicit_mention'] : [] })),
    };
  }

  const text = [
    input.content,
    input.context?.currentStage,
  ].filter(Boolean).join(' ').toLowerCase();
  const scored = participants.map((agent, index) => {
    const result = scoreAgentForBreakout(agent, text);
    return { agent, score: result.score - index * 0.01, matched: result.matched };
  });
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  if (!winner || winner.score <= 0) {
    return {
      replyAuthorId: fallback.id,
      reason: `${fallback.displayName} is the first participant and no stronger responsibility match was found`,
      scores: scored.map((item) => ({ agentId: item.agent.id, score: item.score, matched: item.matched })),
    };
  }
  return {
    replyAuthorId: winner.agent.id,
    reason: `${winner.agent.displayName}'s ${winner.agent.role} responsibility matched ${winner.matched.join(', ')}`,
    scores: scored.map((item) => ({ agentId: item.agent.id, score: item.score, matched: item.matched })),
  };
}

function extractMentionedAgents(content: string): AgentProfile[] {
  const explicit = [...content.matchAll(/@([a-zA-Z][\w-]*)/g)]
    .map((match) => resolveAgentMention(match[1] || ''))
    .filter((agent): agent is AgentProfile => Boolean(agent));
  if (explicit.length > 0) return explicit;
  return AGENT_ROSTER.filter((agent) => {
    const name = agent.displayName.toLowerCase();
    const text = content.toLowerCase();
    return agent.aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i').test(text))
      || new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(text);
  });
}

function scoreAgentForBreakout(agent: AgentProfile, text: string): { score: number; matched: string[] } {
  const matched: string[] = [];
  let score = 0;
  const add = (label: string, value: number, patterns: RegExp[]) => {
    if (!patterns.some((pattern) => pattern.test(text))) return;
    score += value;
    matched.push(label);
  };

  if (agent.role === 'planner') {
    add('planning', 8, [/workflow|breakout|room|agent|context|mission|plan|task|scope/i, /规划|计划|流程|拆解|任务|分工|边界|上下文|主线|房间|执行/i]);
  }
  if (agent.role === 'pm') {
    add('product/requirements', 8, [/product|requirement|user|ux|copy|value|acceptance|spec|persona|pricing/i, /产品|需求|用户|体验|文案|价值|验收|范围|受众|定价/i]);
  }
  if (agent.role === 'architect') {
    add('architecture/system', 8, [/architecture|system|data model|schema|contract|dependency|api design|integration/i, /架构|系统|数据模型|模型|表结构|接口设计|依赖|集成|技术方案/i]);
  }
  if (agent.role === 'implementer') {
    const backend = agent.id === 'beam';
    const frontend = agent.id === 'atlas';
    add('implementation', 7, [/implement|build|code|component|css|react|bug|error|debug|api|database|server|frontend|backend/i, /实现|代码|组件|页面|按钮|样式|报错|调试|接口|数据库|服务端|前端|后端/i]);
    if (frontend) add('frontend/ui', 3, [/ui|frontend|react|css|component|button|layout|visual|style/i, /界面|前端|组件|按钮|布局|视觉|样式/i]);
    if (backend) add('backend/api', 3, [/backend|api|database|server|postgres|auth|oauth|session/i, /后端|接口|数据库|服务端|登录|鉴权|认证/i]);
  }
  if (agent.role === 'reviewer') {
    add('review/risk', 8, [/review|risk|qa|test|quality|regression|accessibility|security|acceptance/i, /评审|风险|测试|质量|回归|可访问|安全|验收|检查/i]);
  }
  if (agent.role === 'fixer') {
    add('fix/debug', 8, [/fix|repair|debug|failure|failing|broken|regression/i, /修复|修一下|debug|失败|坏了|报错|回归/i]);
  }

  const searchable = [
    agent.id,
    agent.role,
    agent.assignee,
    agent.displayName,
    ...agent.aliases,
    ...agent.capabilities,
    ...agent.skills,
    ...agent.preferredTaskTypes,
  ].join(' ').toLowerCase();
  for (const token of tokenizeForOverlap(text)) {
    if (!searchable.includes(token)) continue;
    score += 1;
    matched.push(token);
  }
  return { score, matched: Array.from(new Set(matched)).slice(0, 5) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildBreakoutContext(data: RoundtableData, actor: Actor, chatId: string): BreakoutContextPackage {
  const chat = data.chats.find((item) => item.ownerId === actor.id && item.id === chatId);
  const mission = data.missions
    .filter((item) => item.ownerId === actor.id && item.chatId === chatId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const turn = data.turns
    .filter((item) => item.ownerId === actor.id && item.localChatId === chatId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const currentStage = mission?.stages.find((stage) => stage.id === mission.currentStageId)?.name
    || mission?.stages.find((stage) => ['active', 'running'].includes(stage.status))?.name;
  const activeTasks = mission
    ? mission.tasks
        .filter((task) => ['pending', 'running', 'blocked'].includes(task.status))
        .slice(0, 5)
        .map((task) => `${task.title} (${task.status})`)
    : turn?.plan?.tasks.slice(0, 5).map((task) => `${task.title}: ${task.brief}`);
  const recentMessages = data.messages
    .filter((message) => message.ownerId === actor.id && message.chatId === chatId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const artifacts = data.artifacts
    .filter((artifact) => artifact.chatId === chatId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const taskSnippets = mission?.tasks
    .filter((task) => ['pending', 'running', 'blocked'].includes(task.status))
    .slice(0, 8)
    .map((task) => ({
      source: 'task' as const,
      id: task.id,
      label: `${task.title} (${task.status})`,
      text: [
        task.title,
        `assignee:${task.assignee}`,
        task.deps.length ? `depends on ${task.deps.join(', ')}` : null,
        task.artifactIds.length ? `artifacts ${task.artifactIds.join(', ')}` : null,
      ].filter(Boolean).join(' '),
    })) || [];
  return {
    chatTitle: chat?.title,
    recentMainMessages: recentMessages
      .slice(0, 5)
      .reverse()
      .map((message) => `${message.authorType}:${message.content}`),
    missionGoal: mission?.goal || turn?.message,
    currentStage,
    activeTasks,
    detailSnippets: [
      ...(mission ? [{
        source: 'mission' as const,
        id: mission.id,
        label: mission.goal,
        text: [mission.goal, currentStage ? `Current stage: ${currentStage}` : null].filter(Boolean).join(' '),
      }] : []),
      ...taskSnippets,
      ...recentMessages.slice(0, 20).map((message) => ({
        source: 'main_message' as const,
        id: message.id,
        label: `${message.authorType}:${message.authorId}`,
        text: message.content,
      })),
      ...artifacts.slice(0, 10).map((artifact) => ({
        source: 'artifact' as const,
        id: artifact.id,
        label: `${artifact.kind}: ${artifact.title}`,
        text: summarizeArtifact(artifact.preview || artifact.code || '') || '',
      })),
    ].filter((snippet) => snippet.text.trim()),
    artifacts: artifacts
      .slice(0, 6)
      .map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        ownerAgentId: artifact.ownerAgentId,
        version: artifact.version,
        summary: summarizeArtifact(artifact.preview || artifact.code || ''),
      })),
  };
}

function formatBreakoutContext(context: BreakoutContextPackage | undefined): string {
  if (!context) return '- No main-chat context was supplied.';
  const lines = [
    context.chatTitle ? `- Chat: ${context.chatTitle}` : null,
    context.missionGoal ? `- Goal: ${context.missionGoal}` : null,
    context.currentStage ? `- Current stage: ${context.currentStage}` : null,
    context.activeTasks?.length ? `- Active tasks: ${context.activeTasks.join('; ')}` : null,
    context.recentMainMessages?.length ? `- Recent main messages: ${context.recentMainMessages.join(' | ')}` : null,
    context.artifacts?.length
      ? `- Artifacts: ${context.artifacts.map((artifact) =>
        `${artifact.id} (${artifact.kind}, ${artifact.title}, by ${artifact.ownerAgentId})${artifact.summary ? ` — ${artifact.summary}` : ''}`,
      ).join(' | ')}`
      : null,
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : '- No main-chat context was supplied.';
}

function selectBreakoutDetailSnippets(
  query: string,
  context: BreakoutContextPackage | undefined,
): NonNullable<BreakoutContextPackage['detailSnippets']> {
  const snippets = context?.detailSnippets || [];
  if (!snippets.length) return [];
  const queryTokens = new Set(tokenizeForOverlap(query));
  const scored = snippets.map((snippet, index) => {
    const text = `${snippet.label} ${snippet.text}`.toLowerCase();
    const score = tokenizeForOverlap(text).filter((token) => queryTokens.has(token)).length
      + (snippet.source === 'mission' ? 1 : 0)
      + (snippet.source === 'task' ? 0.5 : 0)
      - index * 0.001;
    return { snippet, score };
  });
  const selected = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.snippet);
  return selected.length ? selected : snippets.slice(0, 6);
}

function formatBreakoutDetailSnippets(snippets: NonNullable<BreakoutContextPackage['detailSnippets']>): string {
  if (!snippets.length) return '- No extra current-chat detail snippets were needed or available.';
  return snippets
    .map((snippet) => {
      const snippetId = snippet.id ? ` ${snippet.id}` : '';
      return `- [${snippet.source}${snippetId}] ${snippet.label}: ${summarizeArtifact(snippet.text) || ''}`;
    })
    .join('\n');
}

function summarizeArtifact(text: string): string | undefined {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, 700);
}

function agentLabel(agentId: string): string {
  const profile = AGENT_ROSTER.find((agent) => agent.id === agentId);
  return profile ? `${profile.displayName} (${profile.role})` : agentId;
}

function localBreakoutReply(content: string): string {
  const text = content.trim();
  if (/[?？]|吗\b|么\b/.test(text)) {
    return '我看到了。模型暂时不可用时，我先给一个本地判断：这个问题需要先明确评价标准，再决定下一步。你想让我重点看视觉、可用性，还是是否符合当前需求？';
  }
  return '我收到了。模型暂时不可用，所以我先把这条作为 breakout 上下文保留；你可以继续追问，或把结论整理清楚再回主 chat。';
}
