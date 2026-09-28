import { mutateData, nowIso, readData } from '../../store.js';
import type { A2ATaskBinding, A2ATaskBindingState } from '../../types.js';

// Bindings are an operational index, not history: they exist so an interrupt
// can cancel a live remote task. Without a bound they accumulate forever in a
// store that is read and rewritten in full on every mutation.
const MAX_RETAINED_BINDINGS = 500;
const TERMINAL_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL_BINDING_STATES: ReadonlySet<A2ATaskBindingState> = new Set<A2ATaskBindingState>([
  'completed', 'failed', 'canceled', 'rejected',
]);

export function isTerminalBindingState(state: A2ATaskBindingState): boolean {
  return TERMINAL_BINDING_STATES.has(state);
}

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
    data.a2aTaskBindings = pruneBindings([
      saved,
      ...data.a2aTaskBindings.filter((item) => item.id !== input.id),
    ], now);
  });
  return saved!;
}

// Drops settled bindings past their TTL, then caps the list. Non-terminal
// bindings are never dropped by TTL: those are the ones an interrupt needs.
function pruneBindings(bindings: A2ATaskBinding[], now: string): A2ATaskBinding[] {
  const cutoff = Date.parse(now) - TERMINAL_BINDING_TTL_MS;
  const live = bindings.filter((item) => {
    if (!isTerminalBindingState(item.state)) return true;
    const updated = Date.parse(item.updatedAt);
    return Number.isNaN(updated) || updated >= cutoff;
  });
  if (live.length <= MAX_RETAINED_BINDINGS) return live;
  const keep = live.filter((item) => !isTerminalBindingState(item.state));
  const settled = live.filter((item) => isTerminalBindingState(item.state));
  return [...keep, ...settled].slice(0, Math.max(MAX_RETAINED_BINDINGS, keep.length));
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
