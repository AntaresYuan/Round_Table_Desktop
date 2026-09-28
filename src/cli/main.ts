import './load-env.js';
import { runCliAction, CliError } from './action-runner.js';

async function main(): Promise<void> {
  const [resource, action, ...args] = process.argv.slice(2);
  const flags = parseFlags(args);

  if (resource === 'workflow' && action === 'smoke') {
    printJson(await runCliAction('roundtable.workflow.smoke', flags));
    return;
  }

  if (resource === 'workbench' && action === 'create') {
    printJson(await runCliAction('roundtable.workbench.create', flags));
    return;
  }

  if (resource === 'chat' && action === 'create') {
    printJson(await runCliAction('roundtable.chat.create', flags));
    return;
  }

  if (resource === 'turn' && action === 'create') {
    printJson(await runCliAction('roundtable.turn.create', flags));
    return;
  }

  if (resource === 'turn' && action === 'approve') {
    printJson(await runCliAction('roundtable.turn.approve', { ...flags, decision: 'approve' }));
    return;
  }

  if (resource === 'turn' && action === 'clarify') {
    printJson(await runCliAction('roundtable.turn.clarify', flags));
    return;
  }

  if (resource === 'turn' && action === 'dispatch') {
    printJson(await runCliAction('roundtable.turn.dispatch', flags));
    return;
  }

  if (resource === 'history' && action === 'list') {
    printJson(await runCliAction('roundtable.history.list', flags));
    return;
  }

  throw new CliError(`unknown_command:${resource ?? ''}:${action ?? ''}`);
}

main().catch((error) => {
  const message = error instanceof CliError ? error.code : error instanceof Error ? error.message : String(error);
  printJson({ ok: false, error: { type: 'CliError', message } });
  process.exitCode = 1;
});

function parseFlags(args: string[]): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item?.startsWith('--')) continue;
    const key = toCamel(item.slice(2));
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return flags;
}

function toCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
