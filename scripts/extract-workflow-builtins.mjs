#!/usr/bin/env node
// Extracts BUILTIN_WORKFLOW_TEMPLATES from the server source into a JSON
// resource the macOS app bundles, so the desktop's built-in workflows are the
// same templates the orchestrator runs rather than a hand-copied second truth.
//
//   node scripts/extract-workflow-builtins.mjs [--check]
//
// The server module cannot be imported directly (it pulls in the store), so the
// literal is sliced out and its three helpers are re-declared without types.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'src/server/actions/mission-actions.ts');
const OUTPUT = path.join(root, 'apps/macos/Resources/workflow-builtins.json');

const HELPERS = `
const seat = (role, agentId) => ({ ref: { kind: 'role', role, ...(agentId ? { agentId } : {}) } });
const userSeat = { ref: { kind: 'user' } };
const gate = (kind, label, description, actions = [], required = kind !== 'none') =>
  ({ kind, required, label, description, actions });
`;

const source = await readFile(SOURCE, 'utf8');
const start = source.indexOf('export const BUILTIN_WORKFLOW_TEMPLATES');
if (start < 0) throw new Error('BUILTIN_WORKFLOW_TEMPLATES not found in ' + SOURCE);
const end = source.indexOf('\n];', start);
if (end < 0) throw new Error('could not find the end of BUILTIN_WORKFLOW_TEMPLATES');

const literal = source
  .slice(start, end + 3)
  .replace('export const BUILTIN_WORKFLOW_TEMPLATES: WorkflowTemplate[] =', 'const BUILTIN_WORKFLOW_TEMPLATES =');

const module = `${HELPERS}\n${literal}\nexport default BUILTIN_WORKFLOW_TEMPLATES;\n`;
const templates = (await import('data:text/javascript;base64,' + Buffer.from(module).toString('base64'))).default;

if (!Array.isArray(templates) || templates.length === 0) throw new Error('no templates extracted');
for (const template of templates) {
  if (!template.id || !Array.isArray(template.stages) || template.stages.length === 0) {
    throw new Error(`template ${template.id ?? '(no id)'} looks malformed`);
  }
}

const json = JSON.stringify({ format: 'roundtable.workflow-builtins', version: 1, templates }, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = await readFile(OUTPUT, 'utf8').catch(() => '');
  if (current !== json) {
    console.error(`${path.relative(root, OUTPUT)} is stale — run: node scripts/extract-workflow-builtins.mjs`);
    process.exit(1);
  }
  console.log(`${path.relative(root, OUTPUT)} is up to date (${templates.length} templates)`);
} else {
  await writeFile(OUTPUT, json);
  console.log(`wrote ${path.relative(root, OUTPUT)} (${templates.map((t) => t.id).join(', ')})`);
}
