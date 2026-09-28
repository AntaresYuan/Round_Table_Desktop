import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RELAY_STDOUT_BYTES = 128 * 1024;
const RELAY_STDERR_BYTES = 96 * 1024;
const mode = process.argv[2];

process.on('SIGTERM', () => undefined);

if (mode === 'daemon') {
  setInterval(() => undefined, 1_000);
} else {
  let stdinBytes = 0;
  process.stdin.on('data', (chunk) => {
    stdinBytes += chunk.length;
  });
  process.stdin.once('end', () => {
    if (mode === 'relay') {
      process.stdout.write(`STDIN=${stdinBytes}\n`);
      process.stdout.write('O'.repeat(RELAY_STDOUT_BYTES));
      process.stderr.write('E'.repeat(RELAY_STDERR_BYTES));
      return;
    }
    if (mode === 'owner-loss') {
      const pidFile = process.argv[3];
      if (!pidFile) process.exit(64);
      const daemon = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), 'daemon'],
        {
          detached: true,
          env: process.env,
          stdio: 'ignore',
        },
      );
      daemon.unref();
      writeFileSync(
        pidFile,
        JSON.stringify({ provider: process.pid, daemon: daemon.pid }),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
    }
  });
  process.stdin.resume();
  setInterval(() => undefined, 1_000);
}
