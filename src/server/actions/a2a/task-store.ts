import { mutateData, nowIso, readData } from '../../store.js';
import type { A2ATaskBinding, A2ATaskBindingState } from '../../types.js';

export async function upsertA2ATaskBinding(
  input: Omit<A2ATaskBinding, 'createdAt' | 'updatedAt'>,
): Promise<A2ATaskBinding> {
  const now = nowIso();
  let saved: A2ATaskBinding | null = null;
  await mutateData((data) => {
    const existing = data.a2aTaskBindings.find((item) => item.id === input.id) ?? null;
    saved = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    data.a2aTaskBindings = [
      saved,
      ...data.a2aTaskBindings.filter((item) => item.id !== input.id),
    ];
  });
  return saved!;
}

export async function bindingsForTurn(turnId: string): Promise<A2ATaskBinding[]> {
  return (await readData()).a2aTaskBindings.filter((item) => item.turnId === turnId);
}

export async function finishA2ATaskBinding(
  turnId: string,
  planTaskId: string,
  state: A2ATaskBindingState,
  error: string | null,
): Promise<A2ATaskBinding | null> {
  let saved: A2ATaskBinding | null = null;
  await mutateData((data) => {
    data.a2aTaskBindings = data.a2aTaskBindings.map((item) => {
      if (item.turnId !== turnId || item.planTaskId !== planTaskId) return item;
      saved = { ...item, state, error, updatedAt: nowIso() };
      return saved;
    });
  });
  return saved;
}
