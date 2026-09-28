import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  artifactKindForFile,
  collectChangedWorkspaceFiles,
} from '../src/server/actions/turns/workspace-scan.js';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'roundtable-scan-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writeAged(path: string, content: string, ageMs: number): Promise<void> {
  await writeFile(join(workspace, path), content, 'utf8');
  const aged = new Date(Date.now() - ageMs);
  await utimes(join(workspace, path), aged, aged);
}

describe('collectChangedWorkspaceFiles — real deliverables, not narration', () => {
  it('collects files modified after the run started and skips untouched ones', async () => {
    await writeAged('old-readme.md', '# old', 60_000);
    await mkdir(join(workspace, 'site'), { recursive: true });
    await writeFile(join(workspace, 'site/index.html'), '<!doctype html><html><body>hi</body></html>', 'utf8');
    await writeFile(join(workspace, 'site/app.js'), 'console.log(1)', 'utf8');

    const { files } = await collectChangedWorkspaceFiles(workspace, Date.now() - 5_000);
    const paths = files.map((file) => file.path).sort();
    expect(paths).toEqual(['site/app.js', 'site/index.html']);
    const html = files.find((file) => file.path === 'site/index.html');
    expect(html?.kind).toBe('preview');
    expect(html?.text).toContain('<!doctype html>');
  });

  it('never collects from dot-directories: .roundtable logs and .git are not deliverables', async () => {
    await mkdir(join(workspace, '.roundtable/runs/logs'), { recursive: true });
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeFile(join(workspace, '.roundtable/runs/logs/build.md'), 'transcript', 'utf8');
    await writeFile(join(workspace, '.git/config'), '[core]', 'utf8');
    await writeFile(join(workspace, 'kept.md'), 'real doc', 'utf8');

    const { files } = await collectChangedWorkspaceFiles(workspace, Date.now() - 5_000);
    expect(files.map((file) => file.path)).toEqual(['kept.md']);
  });

  it('skips node_modules, binary files, and oversized files, reporting them as skipped', async () => {
    await mkdir(join(workspace, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(workspace, 'node_modules/pkg/index.js'), 'x', 'utf8');
    await writeFile(join(workspace, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await writeFile(join(workspace, 'huge.txt'), 'a'.repeat(600 * 1024), 'utf8');
    await writeFile(join(workspace, 'fine.ts'), 'export const x = 1;', 'utf8');

    const { files, skipped } = await collectChangedWorkspaceFiles(workspace, Date.now() - 5_000);
    expect(files.map((file) => file.path)).toEqual(['fine.ts']);
    expect(skipped).toContain('image.png');
    expect(skipped).toContain('huge.txt');
    expect(skipped.some((path) => path.includes('node_modules'))).toBe(false);
  });
});

describe('artifactKindForFile', () => {
  it('maps extensions to artifact kinds', () => {
    expect(artifactKindForFile('site/index.html')).toBe('preview');
    expect(artifactKindForFile('README.md')).toBe('markdown');
    expect(artifactKindForFile('src/app.ts')).toBe('code');
    expect(artifactKindForFile('styles.css')).toBe('code');
    expect(artifactKindForFile('LICENSE')).toBe('file');
  });
});
