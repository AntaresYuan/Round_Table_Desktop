import { chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Provider help/version parsing remains useful independently of the production
// isolation backend.  Keep that coverage behind an explicit per-test-module
// Seatbelt-only substitution; production probe callers remain fail closed.
vi.mock('../src/containment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/containment.js')>();
  return {
    ...actual,
    prepareContainedProviderLaunch: actual.prepareSeatbeltDefenseInDepthLaunch,
  };
});

import { resolveProviderExecutable } from '../src/executable.js';
import { probeProviderCapability } from '../src/probe.js';
import type { RuntimeProvider } from '../src/types.js';

const fixture = fileURLToPath(new URL('./fixtures/runtime-fixture.mjs', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function probeRoot(provider: RuntimeProvider = 'codex'): Promise<{
  root: string;
  binary: string;
  home: string;
  temporary: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-probe-'));
  temporaryDirectories.push(root);
  const baseName = provider === 'claude-code' ? 'claude' : provider;
  const binary = join(root, process.platform === 'win32' ? `${baseName}.exe` : baseName);
  const home = join(root, 'home');
  const temporary = join(root, 'temporary');
  await copyFile(fixture, binary);
  await chmod(binary, 0o755);
  await mkdir(home, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  return { root, binary, home, temporary };
}

describe.skipIf(process.platform === 'win32')('bounded provider capability probe', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)(
    'accepts %s only when every fixed security capability is advertised',
    async (provider) => {
      const target = await probeRoot(provider);
      const executable = await resolveProviderExecutable(provider, [target.root]);

      const capability = await probeProviderCapability({
        provider,
        executable,
        environment: {
          hostHomeDirectory: homedir(),
          homeDirectory: target.home,
          temporaryDirectory: target.temporary,
        },
        timeoutMs: 10_000,
      });

      expect(capability).toMatchObject({
        provider,
        available: true,
        version: 'roundtable-fixture 1.2.3',
      });
      if (provider === 'opencode') {
        expect(capability.disclosures).toContain('prompt_visible_in_process_arguments');
      }
    },
  );

  it('returns a stable unavailable reason when a required security flag is missing', async () => {
    const target = await probeRoot();
    await writeFile(target.binary, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('insecure 1.0.0');
else console.log('--json --sandbox');
`, { mode: 0o755 });
    await chmod(target.binary, 0o755);
    const executable = await resolveProviderExecutable('codex', [target.root]);

    const capability = await probeProviderCapability({
      provider: 'codex',
      executable,
      environment: {
        hostHomeDirectory: homedir(),
        homeDirectory: target.home,
        temporaryDirectory: target.temporary,
      },
    });

    expect(capability).toEqual({
      provider: 'codex',
      available: false,
      version: 'insecure 1.0.0',
      reason: 'security_capability_missing',
      disclosures: [],
    });
  });

  it.skipIf(process.platform !== 'darwin')(
    'contains fixed capability probes so they cannot read a host-home canary',
    async () => {
      const target = await probeRoot();
      const hostProbeRoot = await mkdtemp(join(homedir(), '.roundtable-probe-host-'));
      temporaryDirectories.push(hostProbeRoot);
      const canary = join(hostProbeRoot, 'private.txt');
      await writeFile(canary, 'must-not-cross-probe-boundary', 'utf8');
      await writeFile(target.binary, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  let boundary = 'denied';
  try { readFileSync(${JSON.stringify(canary)}, 'utf8'); boundary = 'leaked'; } catch {}
  console.log(boundary + ' 1.0.0');
} else {
  console.log('--ignore-user-config --ignore-rules --strict-config --sandbox --ephemeral --json');
}
`, { mode: 0o755 });
      await chmod(target.binary, 0o755);
      const executable = await resolveProviderExecutable('codex', [target.root]);

      const capability = await probeProviderCapability({
        provider: 'codex',
        executable,
        environment: {
          hostHomeDirectory: homedir(),
          homeDirectory: target.home,
          temporaryDirectory: target.temporary,
        },
      });

      expect(capability).toMatchObject({ available: true, version: 'denied 1.0.0' });
    },
  );

  it('runs the fixed version and help probes concurrently', async () => {
    const target = await probeRoot('opencode');
    await writeFile(target.binary, `#!/usr/bin/env node
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.env.HOME;
if (!root) process.exit(4);
const kind = process.argv.includes('--version') ? 'version' : process.argv.includes('run') ? 'run-help' : 'global-help';
await writeFile(join(root, '.probe-' + kind), '');
const deadline = Date.now() + 1_200;
while ((await readdir(root)).filter((name) => name.startsWith('.probe-')).length < 3 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if ((await readdir(root)).filter((name) => name.startsWith('.probe-')).length < 3) process.exit(3);
if (process.argv.includes('--version')) console.log('concurrent-fixture 1.0.0');
else console.log('--pure --auto --format --dir --agent');
`, { mode: 0o755 });
    await chmod(target.binary, 0o755);
    const executable = await resolveProviderExecutable('opencode', [target.root]);

    const capability = await probeProviderCapability({
      provider: 'opencode',
      executable,
      environment: {
        hostHomeDirectory: homedir(),
        homeDirectory: target.home,
        temporaryDirectory: target.temporary,
      },
      timeoutMs: 5_000,
    });

    expect(capability.available).toBe(true);
  });
});
