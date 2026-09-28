import { resetData } from '../server/store.js';
import { createChat, createMessage } from '../server/actions/chat-actions.js';
import { answerClarification, approveTurn, createTurn, dispatchTurn, listTurns } from '../server/actions/turn-actions.js';
import type { ClarifyAnswer } from '../server/types.js';
import { createWorkbench } from '../server/actions/workbench-actions.js';
import type { Actor } from '../server/types.js';

export type CliJson = null | boolean | number | string | CliJson[] | { [key: string]: CliJson };

export async function runCliAction(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const actor = cliActor();

  if (action === 'roundtable.data.reset') {
    await resetData();
    return result({ reset: true });
  }

  if (action === 'roundtable.workbench.create') {
    const workbench = await createWorkbench(actor, {
      name: readString(input, 'name', 'Devrt Workbench'),
      workspacePath: optionalString(input, 'workspacePath'),
      description: optionalString(input, 'description'),
    });
    return result({ workbench }, [`created:${workbench.id}`]);
  }

  if (action === 'roundtable.chat.create') {
    const chat = await createChat(actor, {
      workbenchId: readString(input, 'workbenchId'),
      title: readString(input, 'title', 'Devrt task'),
    });
    return result({ chat }, [`created:${chat.id}`]);
  }

  if (action === 'roundtable.turn.create') {
    const turn = await createTurn({
      actor,
      chatId: optionalString(input, 'chatId'),
      turnId: optionalString(input, 'turnId'),
      message: readString(input, 'message'),
    });
    return result({ turn }, [`created:${turn.id}`]);
  }

  if (action === 'roundtable.turn.approve') {
    const approval = await approveTurn({
      actor,
      turnId: readString(input, 'turnId'),
      decision: readDecision(input),
      autoDispatch: readBoolean(input, 'autoDispatch', false),
      agentAdapter: optionalString(input, 'agentAdapter'),
    });
    return result({ approval }, [`approved:${approval.id}`]);
  }

  if (action === 'roundtable.turn.clarify') {
    const turn = await answerClarification({
      actor,
      turnId: readString(input, 'turnId'),
      answers: readAnswers(input),
    });
    return result({ turn }, [`clarified:${turn.id}`]);
  }

  if (action === 'roundtable.turn.dispatch') {
    const dispatch = await dispatchTurn({
      actor,
      turnId: readString(input, 'turnId'),
      agentAdapter: optionalString(input, 'agentAdapter'),
    });
    return result({ dispatch }, [`dispatched:${dispatch.id}`]);
  }

  if (action === 'roundtable.history.list') {
    const turns = await listTurns(optionalString(input, 'chatId'), { actor });
    return result({ turns, count: turns.length });
  }

  if (action === 'roundtable.workflow.smoke') {
    const message = readString(input, 'message', 'Build a small waitlist workflow');
    const workbench = await createWorkbench(actor, {
      name: readString(input, 'workbenchName', 'Devrt Roundtable'),
      workspacePath: `workspaces/devrt-${Date.now()}`,
      description: 'Created by the devrt workflow smoke.',
    });
    const chat = await createChat(actor, {
      workbenchId: workbench.id,
      title: message.slice(0, 120),
    });
    await createMessage(actor, { chatId: chat.id, content: message });
    const turn = await createTurn({ actor, chatId: chat.id, message });
    const approval = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: optionalString(input, 'agentAdapter') || 'local-dispatch',
    });
    const turns = await listTurns(chat.id, { actor });
    return result({
      workbench,
      chat,
      turn,
      approval,
      history: { turns, count: turns.length },
      artifactCount: approval.artifacts.length,
    }, [`workflow:${turn.id}`]);
  }

  throw new CliError(`unknown_action:${action}`);
}

export class CliError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function result(payload: Record<string, unknown>, stateChanges: string[] = []): Record<string, unknown> {
  return {
    ok: true,
    result: payload,
    stateChanges,
    nextSuggestedChecks: ['devrt verify scenario roundtable-local-workflow --task <taskId>'],
  };
}

function readString(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = input[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new CliError(`missing_${key}`);
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readDecision(input: Record<string, unknown>): 'approve' | 'reject' {
  const value = input.decision;
  if (value === 'reject') return 'reject';
  return 'approve';
}

// --answers '[{"questionId":"stack","optionId":"fullstack","label":"Full-stack app"}]'
function readAnswers(input: Record<string, unknown>): ClarifyAnswer[] {
  const raw = input.answers;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
      .map((a) => ({
        questionId: String(a.questionId ?? ''),
        optionId: String(a.optionId ?? ''),
        label: String(a.label ?? ''),
      }))
      .filter((a) => a.questionId && a.label);
  } catch {
    return [];
  }
}

function cliActor(): Actor {
  return {
    id: process.env.ROUNDTABLE_CLI_USER_ID || 'cli-user',
    email: process.env.ROUNDTABLE_CLI_USER_EMAIL || 'cli@roundtable.local',
    name: 'CLI User',
  };
}
