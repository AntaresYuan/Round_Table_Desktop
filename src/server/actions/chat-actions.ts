import { id, mutateData, nowIso, readData } from '../store.js';
import type { Actor, Chat, Message } from '../types.js';
import { getWorkbench } from './workbench-actions.js';
import { removeWorkspace } from './workspace-cleanup.js';

export type CreateChatInput = {
  workbenchId: string;
  title: string;
};

export async function listChats(actor: Actor): Promise<Chat[]> {
  const data = await readData();
  return data.chats
    .filter((chat) => chat.ownerId === actor.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getChat(actor: Actor, chatId: string): Promise<Chat | null> {
  const data = await readData();
  return data.chats.find((chat) => chat.ownerId === actor.id && chat.id === chatId) ?? null;
}

export async function createChat(actor: Actor, input: CreateChatInput): Promise<Chat> {
  const workbench = await getWorkbench(actor, input.workbenchId);
  if (!workbench) throw new Error('workbench_not_found');
  const title = input.title.trim();
  if (!title) throw new Error('missing_chat_title');
  return mutateData((data) => {
    const now = nowIso();
    const chat: Chat = {
      id: id('chat'),
      ownerId: actor.id,
      workbenchId: input.workbenchId,
      title,
      createdAt: now,
      updatedAt: now,
    };
    data.chats.push(chat);
    const target = data.workbenches.find((item) => item.id === input.workbenchId && item.ownerId === actor.id);
    if (target) target.updatedAt = now;
    return chat;
  });
}

export async function deleteChat(actor: Actor, chatId: string): Promise<{ id: string }> {
  const workspaces = await mutateData((data) => {
    const chat = data.chats.find((item) => item.ownerId === actor.id && item.id === chatId);
    if (!chat) throw new Error('chat_not_found');
    // Capture the workspaces of the turns being removed so the session's code
    // on disk goes with it (managed dirs entirely; project dirs runs-only).
    const paths = data.turns
      .filter((turn) => turn.localChatId === chatId)
      .map((turn) => turn.dispatchWorkspacePath)
      .filter((path): path is string => Boolean(path));
    data.chats = data.chats.filter((item) => item.id !== chatId);
    data.messages = data.messages.filter((message) => message.chatId !== chatId);
    data.artifacts = data.artifacts.filter((artifact) => artifact.chatId !== chatId);
    data.handoffs = data.handoffs.filter((handoff) => handoff.chatId !== chatId);
    data.turns = data.turns.filter((turn) => turn.localChatId !== chatId);
    data.missions = data.missions.filter((mission) => !(mission.ownerId === actor.id && mission.chatId === chatId));
    return paths;
  });
  for (const workspace of new Set(workspaces)) {
    await removeWorkspace(workspace);
  }
  return { id: chatId };
}

export async function listMessages(actor: Actor, chatId: string): Promise<Message[]> {
  await requireChat(actor, chatId);
  const data = await readData();
  return data.messages
    .filter((message) => message.ownerId === actor.id && message.chatId === chatId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createMessage(actor: Actor, input: { chatId: string; content: string }): Promise<Message> {
  const chat = await requireChat(actor, input.chatId);
  const content = input.content.trim();
  if (!content) throw new Error('missing_message_content');
  return mutateData((data) => {
    const now = nowIso();
    const message: Message = {
      id: id('msg'),
      ownerId: actor.id,
      chatId: input.chatId,
      authorType: 'user',
      authorId: actor.id,
      content,
      createdAt: now,
    };
    data.messages.push(message);
    const target = data.chats.find((item) => item.id === chat.id);
    if (target) target.updatedAt = now;
    return message;
  });
}

async function requireChat(actor: Actor, chatId: string): Promise<Chat> {
  const chat = await getChat(actor, chatId);
  if (!chat) throw new Error('chat_not_found');
  return chat;
}
