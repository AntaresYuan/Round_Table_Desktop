import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactKind } from '../../types.js';

export type ChangedWorkspaceFile = {
  // Workspace-relative path with forward slashes.
  path: string;
  text: string;
  kind: ArtifactKind;
};

export type WorkspaceScanResult = {
  files: ChangedWorkspaceFile[];
  // Files that changed but were dropped (too large, binary, or over the cap).
  skipped: string[];
};

// Directories that are never user deliverables. `.roundtable` also covers this
// system's own transcript/log tree and per-run CLI homes.
const SKIPPED_ENTRIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', 'tmp']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 60;
const MAX_DEPTH = 8;

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'json', 'svg',
  'py', 'go', 'rs', 'java', 'rb', 'sh', 'sql', 'yml', 'yaml', 'toml', 'vue', 'svelte',
]);

/**
 * Collect the files a CLI agent actually produced or edited during a run: walk
 * the workspace and keep readable text files whose mtime is at or after
 * `sinceMs`. This is what turns "the agent wrote a real website into the
 * workspace" into artifacts the product can show — the CLI's stdout narration
 * is NOT the deliverable and is stored separately as a log.
 */
export async function collectChangedWorkspaceFiles(
  workspace: string,
  sinceMs: number,
): Promise<WorkspaceScanResult> {
  const files: ChangedWorkspaceFile[] = [];
  const skipped: string[] = [];
  await walk(workspace, '', 0, files, skipped, sinceMs);
  return { files, skipped };
}

export function artifactKindForFile(path: string): ArtifactKind {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'preview';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return 'file';
}

async function walk(
  workspace: string,
  relative: string,
  depth: number,
  files: ChangedWorkspaceFile[],
  skipped: string[],
  sinceMs: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const absolute = relative ? join(workspace, relative) : workspace;
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    // Dotfiles and dot-directories (.git, .roundtable, .next, CLI homes…) are
    // never deliverables.
    if (entry.name.startsWith('.') || SKIPPED_ENTRIES.has(entry.name)) continue;
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(workspace, entryRelative, depth + 1, files, skipped, sinceMs);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(join(workspace, entryRelative)).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    if (files.length >= MAX_FILES) {
      skipped.push(entryRelative);
      continue;
    }
    if (info.size > MAX_FILE_BYTES) {
      skipped.push(entryRelative);
      continue;
    }
    const raw = await readFile(join(workspace, entryRelative)).catch(() => null);
    if (raw === null || looksBinary(raw)) {
      if (raw !== null) skipped.push(entryRelative);
      continue;
    }
    files.push({
      path: entryRelative,
      text: raw.toString('utf8'),
      kind: artifactKindForFile(entryRelative),
    });
  }
}

function looksBinary(raw: Buffer): boolean {
  const sample = raw.subarray(0, 8192);
  return sample.includes(0);
}
