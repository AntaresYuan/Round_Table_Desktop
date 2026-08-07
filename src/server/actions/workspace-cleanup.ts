import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { managedWorkspaceRoot } from './workbench-actions.js';

/* ============================================================================
   workspace-cleanup.ts — delete a run's workspace when its session is deleted.

   Two kinds of workspace exist:
   - Managed: created by us under ROUNDTABLE_WORKSPACE_ROOT — safe to remove
     entirely.
   - Workbench-linked: the user's REAL project directory. Deleting a session
     must never destroy their project, so outside the managed root we only
     remove our own output subtree (.roundtable/runs).

   Removal is best-effort: a missing directory or FS error must not block the
   session deletion itself.
   ============================================================================ */

export async function removeWorkspace(workspacePath: string | null | undefined): Promise<void> {
  if (!workspacePath) return;
  const root = managedWorkspaceRoot();
  const target = resolve(workspacePath);
  const managed = target !== root && target.startsWith(root + sep);
  try {
    if (managed) {
      await rm(target, { recursive: true, force: true });
    } else {
      await rm(join(target, '.roundtable', 'runs'), { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup — never block the deletion on an FS error.
  }
}
