import './load-env.js';
import { runCliAction, CliError } from './action-runner.js';

async function main(): Promise<void> {
  const action = process.env.DEVRT_ACTION;
  if (!action) throw new CliError('missing_devrt_action');
  const input = parseJson(process.env.DEVRT_ACTION_INPUT || await readStdin());
  const output = await runCliAction(action, input);
  printJson(output);
}

main().catch((error) => {
  const message = error instanceof CliError ? error.code : error instanceof Error ? error.message : String(error);
  printJson({ ok: false, error: { type: 'CliActionError', message } });
  process.exitCode = 1;
});

function parseJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  throw new CliError('input_must_be_object');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
