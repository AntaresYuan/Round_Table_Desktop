const CONTAINER_NAME = 'roundtable-postgres';

const command = process.argv[2];

if (command === 'up') {
  if (await containerExists()) {
    await run('docker', ['start', CONTAINER_NAME]);
    process.stdout.write(`${CONTAINER_NAME} running.\n`);
  } else {
    await run('docker', ['compose', 'up', '-d', 'postgres']);
  }
  process.exit(0);
}

if (command === 'down') {
  if (await containerExists()) {
    await run('docker', ['stop', CONTAINER_NAME]);
    process.stdout.write(`${CONTAINER_NAME} stopped.\n`);
  } else {
    await run('docker', ['compose', 'down']);
  }
  process.exit(0);
}

throw new Error(`unknown_local_postgres_command:${command ?? ''}`);

async function containerExists(): Promise<boolean> {
  const result = await spawn('docker', ['inspect', CONTAINER_NAME]);
  return result.code === 0;
}

async function run(cmd: string, args: string[]): Promise<void> {
  const result = await spawn(cmd, args, { inherit: true });
  if (result.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.code}`);
}

async function spawn(
  cmd: string,
  args: string[],
  opts: { inherit?: boolean } = {},
): Promise<{ code: number }> {
  const { spawn: nodeSpawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, {
      stdio: opts.inherit ? 'inherit' : 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });
}

export {};
