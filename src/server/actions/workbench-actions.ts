import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { id, mutateData, nowIso, readData } from '../store.js';
import type { Actor, Workbench } from '../types.js';

export type CreateWorkbenchInput = {
  name: string;
  workspacePath?: string | undefined;
  description?: string | null | undefined;
};

export async function listWorkbenches(actor: Actor): Promise<Workbench[]> {
  const data = await readData();
  return data.workbenches
    .filter((workbench) => workbench.ownerId === actor.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createWorkbench(actor: Actor, input: CreateWorkbenchInput): Promise<Workbench> {
  const name = input.name.trim();
  if (!name) throw new Error('missing_workbench_name');
  return mutateData((data) => {
    const now = nowIso();
    const workbenchId = id('wb');
    const workbench: Workbench = {
      id: workbenchId,
      ownerId: actor.id,
      name,
      workspacePath: workspacePathForWorkbench(actor.id, workbenchId, input.workspacePath),
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    data.workbenches.push(workbench);
    return workbench;
  });
}

export function workspacePathForWorkbench(ownerId: string, workbenchId: string, requestedPath?: string | undefined): string {
  const candidate = requestedPath?.trim();
  if (candidate && customWorkspacePathsAllowed()) {
    const resolved = resolve(candidate);
    if (!isForbiddenWorkspace(resolved)) return resolved;
  }
  return defaultWorkspacePath(ownerId, workbenchId);
}

export function storedWorkspacePath(workbench: Workbench): string {
  const resolved = resolve(workbench.workspacePath);
  if (isForbiddenWorkspace(resolved)) return defaultWorkspacePath(workbench.ownerId, workbench.id);
  if (customWorkspacePathsAllowed() || isPathInside(managedWorkspaceRoot(), resolved)) return resolved;
  return defaultWorkspacePath(workbench.ownerId, workbench.id);
}

// Agents run inside the workspace with file-write access. If the workspace is
// this app's own source tree (or a directory containing it), an agent asked to
// "build a website" will happily write its pages INTO the product's src/ — that
// actually happened. No configuration may point a workspace at the app root or
// any ancestor of it. Dedicated subdirectories (e.g. .roundtable/workspaces/*)
// remain fine.
export function isForbiddenWorkspace(target: string): boolean {
  const appRoot = process.cwd();
  const rel = relative(resolve(target), appRoot);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function defaultWorkspacePath(ownerId: string, workbenchId: string): string {
  return resolve(managedWorkspaceRoot(), ownerId, workbenchId);
}

export function managedWorkspaceRoot(): string {
  const configured = process.env.ROUNDTABLE_WORKSPACE_ROOT?.trim();
  if (configured) return resolve(configured);
  if (process.env.VERCEL === '1') return resolve(tmpdir(), 'roundtable', 'workspaces');
  return resolve('.roundtable/workspaces');
}

function customWorkspacePathsAllowed(): boolean {
  return process.env.ROUNDTABLE_ALLOW_CUSTOM_WORKSPACE_PATH === '1' || process.env.NODE_ENV !== 'production';
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function getWorkbench(actor: Actor, workbenchId: string): Promise<Workbench | null> {
  const data = await readData();
  return data.workbenches.find((workbench) => workbench.ownerId === actor.id && workbench.id === workbenchId) ?? null;
}
