import { readFile } from 'node:fs/promises';
import './load-env.js';
import { dataPath, writeData } from '../server/store.js';

const source = process.argv[2] || dataPath();
const targetDriver = process.env.ROUNDTABLE_TARGET_STORE_DRIVER || process.env.ROUNDTABLE_STORE_DRIVER || 'postgres_normalized';

if (!['postgres', 'postgres_normalized', 'normalized'].includes(targetDriver)) {
  throw new Error('Set ROUNDTABLE_TARGET_STORE_DRIVER to postgres or postgres_normalized.');
}

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL before running this migration.');
}

process.env.ROUNDTABLE_STORE_DRIVER = targetDriver;

const raw = await readFile(source, 'utf8');
await writeData(JSON.parse(raw));

process.stdout.write(
  `Migrated ${source} to ${targetDriver} store key ${process.env.ROUNDTABLE_STORE_KEY || 'default'}.\n`,
);
