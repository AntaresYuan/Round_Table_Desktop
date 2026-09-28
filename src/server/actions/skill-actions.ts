import { readData } from '../store.js';
import type { Actor, WorkingStyleSnapshot } from '../types.js';

// The skills panel and its per-user skill table are gone; what remains is the
// working-style pipe that injects user-level guidance into every agent prompt:
// profile default skills (edited in the memory panel) and workbench pins
// (rendered as project rules).

const SKILL_CATALOG: Record<string, { label: string; description: string }> = {
  plan_before_implementation: {
    label: 'Plan before implementation',
    description: 'Create and review a short plan before agents edit files.',
  },
  visual_approval_required: {
    label: 'Visual approval required',
    description: 'For UI changes, show screenshots or previews before calling the work done.',
  },
  verify_before_push: {
    label: 'Verify before push',
    description: 'Run relevant checks such as typecheck, lint, build, or tests before pushing.',
  },
  concise_prd_style: {
    label: 'Concise PRD style',
    description: 'Keep PRDs short, flow-focused, and implementation-useful.',
  },
  accessibility_qa: {
    label: 'Accessibility QA',
    description: 'Check interaction states, labels, focus behavior, and readable contrast on UI work.',
  },
  github_visibility_preferred: {
    label: 'GitHub visibility preferred',
    description: 'Surface reviewable issues and changes through GitHub PRs or comments when useful.',
  },
};

export async function getWorkingStyleSnapshot(
  actor: Actor | null | undefined,
  chatId?: string | null | undefined,
): Promise<WorkingStyleSnapshot> {
  if (!actor) return emptyWorkingStyle();
  const data = await readData();
  const profile = data.profiles.find((item) => item.userId === actor.id);
  const skills: WorkingStyleSnapshot['skills'] = [];
  for (const raw of profile?.defaultSkills ?? []) {
    const keyValue = normalizeKey(raw);
    if (!keyValue || skills.some((skill) => skill.key === keyValue)) continue;
    const catalog = catalogEntry(keyValue);
    skills.push({
      key: keyValue,
      label: catalog.label,
      description: catalog.description,
      source: 'user',
      scope: 'personal',
    });
  }
  const chat = chatId ? data.chats.find((item) => item.id === chatId && item.ownerId === actor.id) : null;
  const projectRules = chat
    ? data.workbenchPins
        .filter((pin) => pin.userId === actor.id && pin.workbenchId === chat.workbenchId)
        .map((pin) => pin.content)
    : [];
  return { skills, projectRules };
}

export function emptyWorkingStyle(): WorkingStyleSnapshot {
  return { skills: [], projectRules: [] };
}

function catalogEntry(key: string): { label: string; description: string } {
  const keyValue = normalizeKey(key);
  return SKILL_CATALOG[keyValue] ?? {
    label: keyValue.split('_').map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part).join(' '),
    description: 'Custom working style skill.',
  };
}

function normalizeKey(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
