import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILES = ['.env.local', '.env'];

export function loadCliEnv(cwd = process.cwd()): void {
  for (const file of ENV_FILES) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    loadEnvFile(path);
  }
}

function loadEnvFile(path: string): void {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const assignment = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
  const index = assignment.indexOf('=');
  if (index <= 0) return null;

  const key = assignment.slice(0, index).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  const raw = assignment.slice(index + 1).trim();
  return [key, unquote(raw)];
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

loadCliEnv();
