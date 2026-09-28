import { id, mutateData, nowIso, readData } from '../store.js';
import type { Actor, UserProfile, WorkbenchPin } from '../types.js';
import { getWorkbench } from './workbench-actions.js';

export async function getUserProfile(actor: Actor): Promise<UserProfile> {
  return mutateData((data) => {
    const existing = data.profiles.find((profile) => profile.userId === actor.id);
    if (existing) return existing;
    const profile: UserProfile = {
      userId: actor.id,
      defaultBrief: '',
      defaultSkills: [],
      notes: '',
      updatedAt: nowIso(),
    };
    data.profiles.push(profile);
    return profile;
  });
}

export async function updateUserProfile(
  actor: Actor,
  patch: { defaultBrief?: string | undefined; defaultSkills?: string[] | undefined; notes?: string | undefined },
): Promise<UserProfile> {
  return mutateData((data) => {
    let profile = data.profiles.find((item) => item.userId === actor.id);
    if (!profile) {
      profile = {
        userId: actor.id,
        defaultBrief: '',
        defaultSkills: [],
        notes: '',
        updatedAt: nowIso(),
      };
      data.profiles.push(profile);
    }
    if (patch.defaultBrief !== undefined) profile.defaultBrief = patch.defaultBrief;
    if (patch.defaultSkills !== undefined) profile.defaultSkills = patch.defaultSkills;
    if (patch.notes !== undefined) profile.notes = patch.notes;
    profile.updatedAt = nowIso();
    return profile;
  });
}

export async function listWorkbenchPins(actor: Actor, workbenchId: string): Promise<WorkbenchPin[]> {
  await ensureWorkbench(actor, workbenchId);
  const data = await readData();
  return data.workbenchPins
    .filter((pin) => pin.userId === actor.id && pin.workbenchId === workbenchId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function pinWorkbench(actor: Actor, input: { workbenchId: string; content: string }): Promise<WorkbenchPin> {
  await ensureWorkbench(actor, input.workbenchId);
  const content = input.content.trim();
  if (!content) throw new Error('missing_pin_content');
  return mutateData((data) => {
    const pin: WorkbenchPin = {
      id: id('pin'),
      userId: actor.id,
      workbenchId: input.workbenchId,
      content,
      createdAt: nowIso(),
    };
    data.workbenchPins.push(pin);
    return pin;
  });
}

export async function unpinWorkbench(actor: Actor, input: { workbenchId: string; id: string }): Promise<{ id: string }> {
  await ensureWorkbench(actor, input.workbenchId);
  return mutateData((data) => {
    data.workbenchPins = data.workbenchPins.filter(
      (pin) => !(pin.userId === actor.id && pin.workbenchId === input.workbenchId && pin.id === input.id),
    );
    return { id: input.id };
  });
}

async function ensureWorkbench(actor: Actor, workbenchId: string): Promise<void> {
  const workbench = await getWorkbench(actor, workbenchId);
  if (!workbench) throw new Error('workbench_not_found');
}
