import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readData } from '../../store.js';
import type { LocalTurn } from '../../types.js';
import { managedWorkspaceRoot, storedWorkspacePath } from '../workbench-actions.js';

export async function prepareWorkspace(turn: LocalTurn): Promise<string> {
  const projectWorkspace = await workspaceFromChat(turn.localChatId);
  if (projectWorkspace) {
    await mkdir(projectWorkspace, { recursive: true });
    await clearRunOutput(projectWorkspace);
    return projectWorkspace;
  }
  const root = managedWorkspaceRoot();
  const workspace = resolve(root, turn.localChatId ?? turn.id);
  await mkdir(workspace, { recursive: true });
  await clearRunOutput(workspace);
  return workspace;
}

export async function writeWorkspaceFile(workspace: string, relativePath: string, text: string): Promise<void> {
  const target = join(workspace, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

// Wipe this system's own output tree (.roundtable/runs) before a run so a
// re-dispatch — or a different request in the same chat — doesn't leave stale
// artifacts from the previous run mixed in with the new ones. Only the runs/
// subtree is removed; any real project files in the workspace are untouched.
async function clearRunOutput(workspace: string): Promise<void> {
  try {
    await rm(join(workspace, '.roundtable', 'runs'), { recursive: true, force: true });
  } catch {
    // Best-effort: a missing dir or transient FS error must not block the run.
  }
}

// The workspace path a chat's runs use, WITHOUT creating or clearing anything —
// for read paths (memory panel, exports) that must never touch run state.
export async function workspacePathForChat(chatId: string | null): Promise<string | null> {
  if (!chatId) return null;
  const projectWorkspace = await workspaceFromChat(chatId);
  if (projectWorkspace) return projectWorkspace;
  const root = managedWorkspaceRoot();
  return resolve(root, chatId);
}

async function workspaceFromChat(chatId: string | null): Promise<string | null> {
  if (!chatId) return null;
  const data = await readData();
  const chat = data.chats.find((item) => item.id === chatId);
  if (!chat) return null;
  const workbench = data.workbenches.find((item) => item.id === chat.workbenchId);
  if (!workbench?.workspacePath) return null;
  return storedWorkspacePath(workbench);
}
