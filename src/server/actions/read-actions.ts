import { readData } from '../store.js';
import type { Actor, Artifact, Handoff } from '../types.js';
import { getChat } from './chat-actions.js';

export async function listArtifactsByChat(actor: Actor, chatId: string): Promise<Artifact[]> {
  const chat = await getChat(actor, chatId);
  if (!chat) throw new Error('chat_not_found');
  const data = await readData();
  return data.artifacts
    .filter((artifact) => artifact.chatId === chatId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listHandoffsByChat(actor: Actor, chatId: string): Promise<Handoff[]> {
  const chat = await getChat(actor, chatId);
  if (!chat) throw new Error('chat_not_found');
  const data = await readData();
  return data.handoffs
    .filter((handoff) => handoff.ownerId === actor.id && handoff.chatId === chatId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
