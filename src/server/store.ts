import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg';
import type {
  A2ATaskBinding,
  Artifact,
  AgentRuntimeConfig,
  AgentRuntimeConversation,
  AgentRuntimeDefaultConfig,
  BreakoutMessage,
  BreakoutRoom,
  Chat,
  Handoff,
  LocalTurn,
  Message,
  Mission,
  RoundtableSettings,
  UserProfile,
  Workbench,
  WorkbenchPin,
} from './types.js';

export type RoundtableData = {
  version: 1;
  users: Array<{ id: string; email: string; name: string | null; createdAt: string }>;
  workbenches: Workbench[];
  chats: Chat[];
  messages: Message[];
  breakoutRooms: BreakoutRoom[];
  breakoutMessages: BreakoutMessage[];
  artifacts: Artifact[];
  handoffs: Handoff[];
  profiles: UserProfile[];
  workbenchPins: WorkbenchPin[];
  turns: LocalTurn[];
  missions: Mission[];
  agentRuntimeConfigs: AgentRuntimeConfig[];
  agentRuntimeDefaults: AgentRuntimeDefaultConfig[];
  agentRuntimeConversations: AgentRuntimeConversation[];
  a2aTaskBindings: A2ATaskBinding[];
  settings: RoundtableSettings;
};

const { Pool } = pg;
const POSTGRES_TABLE = 'roundtable_store';
const DEFAULT_STORE_KEY = 'default';

let pool: PgPool | null = null;
let postgresReady: Promise<void> | null = null;
let normalizedPostgresReady: Promise<void> | null = null;

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function dataPath(): string {
  return resolve(process.env.ROUNDTABLE_DATA_PATH || '.roundtable/data.json');
}

export async function readData(): Promise<RoundtableData> {
  if (useNormalizedPostgresStore()) return readNormalizedPostgresData();
  if (usePostgresStore()) return readPostgresData();
  return readJsonData();
}

export async function writeData(data: RoundtableData): Promise<void> {
  if (useNormalizedPostgresStore()) {
    await writeNormalizedPostgresData(data);
    return;
  }
  if (usePostgresStore()) {
    await writePostgresData(data);
    return;
  }
  await withJsonLock(() => writeJsonData(data));
}

export async function mutateData<T>(fn: (data: RoundtableData) => T | Promise<T>): Promise<T> {
  if (useNormalizedPostgresStore()) return mutateNormalizedPostgresData(fn);
  if (usePostgresStore()) return mutatePostgresData(fn);
  return withJsonLock(async () => {
    const data = await readJsonData();
    const result = await fn(data);
    await writeJsonData(data);
    return result;
  });
}

// The JSON store is one shared file mutated by read-modify-write: concurrent
// callers (parallel scheduler waves, runtime-conversation updates from several
// agents) would silently drop each other's changes — and interleaved writes to
// the shared temp file tear it into invalid JSON. Serialize every mutation
// through an in-process promise chain.
let jsonLock: Promise<unknown> = Promise.resolve();

function withJsonLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = jsonLock.then(fn);
  // A failed mutation must not wedge the chain for every later caller.
  jsonLock = run.catch(() => undefined);
  return run;
}

export async function resetData(): Promise<void> {
  await writeData(emptyData());
}

async function readJsonData(): Promise<RoundtableData> {
  try {
    const raw = await readFile(dataPath(), 'utf8');
    return normalizeData(JSON.parse(raw) as Partial<RoundtableData>);
  } catch (error) {
    if (isNotFound(error)) return emptyData();
    throw error;
  }
}

let writeSeq = 0;

async function writeJsonData(data: RoundtableData): Promise<void> {
  const target = dataPath();
  await mkdir(dirname(target), { recursive: true });
  // Unique per write: a pid-only name collides when two writers in the same
  // process interleave (or two dev processes share the file), tearing the temp
  // file before the atomic rename.
  const temp = `${target}.${process.pid}.${++writeSeq}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

async function readPostgresData(): Promise<RoundtableData> {
  await ensurePostgresStore();
  const result = await getPool().query<{ data: Partial<RoundtableData> }>(
    `SELECT data FROM ${POSTGRES_TABLE} WHERE id = $1`,
    [storeKey()],
  );
  return normalizeData(result.rows[0]?.data ?? {});
}

async function writePostgresData(data: RoundtableData): Promise<void> {
  await ensurePostgresStore();
  await getPool().query(
    `INSERT INTO ${POSTGRES_TABLE} (id, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [storeKey(), normalizeData(data)],
  );
}

async function mutatePostgresData<T>(fn: (data: RoundtableData) => T | Promise<T>): Promise<T> {
  await ensurePostgresStore();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await ensurePostgresRow(client);
    const result = await client.query<{ data: Partial<RoundtableData> }>(
      `SELECT data FROM ${POSTGRES_TABLE} WHERE id = $1 FOR UPDATE`,
      [storeKey()],
    );
    const data = normalizeData(result.rows[0]?.data ?? {});
    const output = await fn(data);
    await client.query(
      `UPDATE ${POSTGRES_TABLE} SET data = $2::jsonb, updated_at = now() WHERE id = $1`,
      [storeKey(), data],
    );
    await client.query('COMMIT');
    return output;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function readNormalizedPostgresData(): Promise<RoundtableData> {
  await ensureNormalizedPostgresStore();
  return readNormalizedDataFrom(getPool());
}

async function writeNormalizedPostgresData(data: RoundtableData): Promise<void> {
  await ensureNormalizedPostgresStore();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await lockNormalizedStore(client);
    await writeNormalizedDataTo(client, data);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function mutateNormalizedPostgresData<T>(fn: (data: RoundtableData) => T | Promise<T>): Promise<T> {
  await ensureNormalizedPostgresStore();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await lockNormalizedStore(client);
    const data = await readNormalizedDataFrom(client);
    const output = await fn(data);
    await writeNormalizedDataTo(client, data);
    await client.query('COMMIT');
    return output;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensurePostgresStore(): Promise<void> {
  postgresReady ??= (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS ${POSTGRES_TABLE} (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await getPool().query(
      `INSERT INTO ${POSTGRES_TABLE} (id, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [storeKey(), emptyData()],
    );
  })().catch((error: unknown) => {
    postgresReady = null;
    throw error;
  });
  await postgresReady;
}

async function ensureNormalizedPostgresStore(): Promise<void> {
  normalizedPostgresReady ??= (async () => {
    for (const statement of NORMALIZED_TABLE_STATEMENTS) {
      await getPool().query(statement);
    }
    for (const statement of NORMALIZED_INDEX_STATEMENTS) {
      await getPool().query(statement);
    }
    for (const statement of NORMALIZED_CONSTRAINT_STATEMENTS) {
      await getPool().query(statement);
    }
  })().catch((error: unknown) => {
    normalizedPostgresReady = null;
    throw error;
  });
  await normalizedPostgresReady;
}

async function ensurePostgresRow(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO ${POSTGRES_TABLE} (id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [storeKey(), emptyData()],
  );
}

type StoreUser = RoundtableData['users'][number];
type PgQueryable = {
  query<T = Record<string, unknown>>(
    statement: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

type NormalizedTableColumn<T> = {
  name: string;
  value: (row: T) => unknown;
};

type NormalizedTableSpec<T> = {
  table: string;
  idColumn: string;
  rows: (data: RoundtableData) => T[];
  assign: (data: RoundtableData, rows: T[]) => void;
  id: (row: T) => string;
  orderBy: string;
  columns: Array<NormalizedTableColumn<T>>;
};

function makeTableSpec<T>(spec: NormalizedTableSpec<T>): NormalizedTableSpec<T> {
  return spec;
}

const NORMALIZED_TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS roundtable_users (
    store_key text NOT NULL,
    id text NOT NULL,
    email text NOT NULL,
    name text,
    created_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_workbenches (
    store_key text NOT NULL,
    id text NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    workspace_path text NOT NULL,
    created_at timestamptz NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_chats (
    store_key text NOT NULL,
    id text NOT NULL,
    owner_id text NOT NULL,
    workbench_id text NOT NULL,
    title text NOT NULL,
    created_at timestamptz NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_messages (
    store_key text NOT NULL,
    id text NOT NULL,
    owner_id text NOT NULL,
    chat_id text NOT NULL,
    author_type text NOT NULL,
    author_id text NOT NULL,
    created_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_breakout_rooms (
    store_key text NOT NULL,
    id text NOT NULL,
    owner_id text NOT NULL,
    chat_id text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_breakout_messages (
    store_key text NOT NULL,
    id text NOT NULL,
    owner_id text NOT NULL,
    room_id text NOT NULL,
    author_type text NOT NULL,
    author_id text NOT NULL,
    created_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_artifacts (
    store_key text NOT NULL,
    id text NOT NULL,
    chat_id text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    owner_agent_id text NOT NULL,
    created_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_handoffs (
    store_key text NOT NULL,
    id text NOT NULL,
    owner_id text NOT NULL,
    chat_id text NOT NULL,
    created_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_profiles (
    store_key text NOT NULL,
    user_id text NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_user_skills (
    store_key text NOT NULL,
    id text NOT NULL,
    user_id text NOT NULL,
    key text NOT NULL,
    scope text NOT NULL,
    target_chat_id text,
    enabled boolean NOT NULL,
    source text NOT NULL,
    created_at timestamptz NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_workbench_pins (
    store_key text NOT NULL,
    id text NOT NULL,
    user_id text NOT NULL,
    workbench_id text NOT NULL,
    created_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_turns (
    store_key text NOT NULL,
    id text NOT NULL,
    owner_id text,
    local_chat_id text,
    mission_id text NOT NULL,
    workflow_template_id text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_missions (
    store_key text NOT NULL,
    id text NOT NULL,
    owner_id text,
    chat_id text,
    source_turn_id text NOT NULL,
    status text NOT NULL,
    workflow_template_id text NOT NULL,
    created_at timestamptz NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_agent_runtime_configs (
    store_key text NOT NULL,
    agent_id text NOT NULL,
    runtime text NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_agent_runtime_defaults (
    store_key text NOT NULL,
    runtime text NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, runtime)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_agent_runtime_conversations (
    store_key text NOT NULL,
    id text NOT NULL,
    agent_id text NOT NULL,
    turn_id text,
    task_id text,
    status text NOT NULL,
    started_at timestamptz NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_a2a_task_bindings (
    store_key text NOT NULL,
    id text NOT NULL,
    mission_id text NOT NULL,
    turn_id text NOT NULL,
    plan_task_id text NOT NULL,
    agent_id text NOT NULL,
    remote_task_id text NOT NULL,
    state text NOT NULL,
    created_at timestamptz NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roundtable_settings (
    store_key text NOT NULL,
    id text NOT NULL,
    record_updated_at timestamptz NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_key, id)
  )`,
];

const NORMALIZED_INDEX_STATEMENTS = [
  'CREATE UNIQUE INDEX IF NOT EXISTS roundtable_users_email_unique_idx ON roundtable_users (store_key, lower(email))',
  'CREATE INDEX IF NOT EXISTS roundtable_workbenches_owner_idx ON roundtable_workbenches (store_key, owner_id)',
  'CREATE INDEX IF NOT EXISTS roundtable_chats_owner_workbench_idx ON roundtable_chats (store_key, owner_id, workbench_id)',
  'CREATE INDEX IF NOT EXISTS roundtable_messages_chat_created_idx ON roundtable_messages (store_key, chat_id, created_at)',
  'CREATE INDEX IF NOT EXISTS roundtable_breakout_rooms_chat_updated_idx ON roundtable_breakout_rooms (store_key, chat_id, record_updated_at)',
  'CREATE INDEX IF NOT EXISTS roundtable_breakout_messages_room_created_idx ON roundtable_breakout_messages (store_key, room_id, created_at)',
  'CREATE INDEX IF NOT EXISTS roundtable_artifacts_chat_created_idx ON roundtable_artifacts (store_key, chat_id, created_at)',
  'CREATE INDEX IF NOT EXISTS roundtable_handoffs_chat_created_idx ON roundtable_handoffs (store_key, chat_id, created_at)',
  'CREATE INDEX IF NOT EXISTS roundtable_user_skills_user_idx ON roundtable_user_skills (store_key, user_id, enabled)',
  'CREATE INDEX IF NOT EXISTS roundtable_user_skills_target_chat_idx ON roundtable_user_skills (store_key, target_chat_id)',
  'CREATE INDEX IF NOT EXISTS roundtable_workbench_pins_user_workbench_idx ON roundtable_workbench_pins (store_key, user_id, workbench_id)',
  'CREATE INDEX IF NOT EXISTS roundtable_turns_chat_created_idx ON roundtable_turns (store_key, local_chat_id, created_at)',
  'CREATE INDEX IF NOT EXISTS roundtable_missions_chat_created_idx ON roundtable_missions (store_key, chat_id, created_at)',
  'CREATE INDEX IF NOT EXISTS roundtable_missions_status_idx ON roundtable_missions (store_key, status)',
  'CREATE INDEX IF NOT EXISTS roundtable_agent_runtime_conversations_turn_idx ON roundtable_agent_runtime_conversations (store_key, turn_id)',
  'CREATE INDEX IF NOT EXISTS roundtable_a2a_task_bindings_turn_idx ON roundtable_a2a_task_bindings (store_key, turn_id)',
];

const NORMALIZED_CONSTRAINT_STATEMENTS = [
  'ALTER TABLE "roundtable_artifacts" DROP CONSTRAINT IF EXISTS "roundtable_artifacts_chat_fk"',
  normalizedConstraint('roundtable_workbenches_owner_fk', 'roundtable_workbenches', '(store_key, owner_id)', 'roundtable_users', '(store_key, id)'),
  normalizedConstraint('roundtable_chats_owner_fk', 'roundtable_chats', '(store_key, owner_id)', 'roundtable_users', '(store_key, id)'),
  normalizedConstraint('roundtable_chats_workbench_fk', 'roundtable_chats', '(store_key, workbench_id)', 'roundtable_workbenches', '(store_key, id)'),
  normalizedConstraint('roundtable_messages_chat_fk', 'roundtable_messages', '(store_key, chat_id)', 'roundtable_chats', '(store_key, id)'),
  normalizedConstraint('roundtable_breakout_rooms_chat_fk', 'roundtable_breakout_rooms', '(store_key, chat_id)', 'roundtable_chats', '(store_key, id)'),
  normalizedConstraint('roundtable_breakout_messages_room_fk', 'roundtable_breakout_messages', '(store_key, room_id)', 'roundtable_breakout_rooms', '(store_key, id)'),
  normalizedConstraint('roundtable_handoffs_chat_fk', 'roundtable_handoffs', '(store_key, chat_id)', 'roundtable_chats', '(store_key, id)'),
  normalizedConstraint('roundtable_profiles_user_fk', 'roundtable_profiles', '(store_key, user_id)', 'roundtable_users', '(store_key, id)'),
  normalizedConstraint('roundtable_user_skills_user_fk', 'roundtable_user_skills', '(store_key, user_id)', 'roundtable_users', '(store_key, id)'),
  normalizedConstraint('roundtable_workbench_pins_user_fk', 'roundtable_workbench_pins', '(store_key, user_id)', 'roundtable_users', '(store_key, id)'),
  normalizedConstraint('roundtable_workbench_pins_workbench_fk', 'roundtable_workbench_pins', '(store_key, workbench_id)', 'roundtable_workbenches', '(store_key, id)'),
  normalizedConstraint('roundtable_missions_chat_fk', 'roundtable_missions', '(store_key, chat_id)', 'roundtable_chats', '(store_key, id)'),
];

const NORMALIZED_TABLE_SPECS = [
  makeTableSpec<StoreUser>({
    table: 'roundtable_users',
    idColumn: 'id',
    rows: (data) => data.users,
    assign: (data, rows) => {
      data.users = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'email', value: (row) => row.email },
      { name: 'name', value: (row) => row.name },
      { name: 'created_at', value: (row) => row.createdAt },
    ],
  }),
  makeTableSpec<Workbench>({
    table: 'roundtable_workbenches',
    idColumn: 'id',
    rows: (data) => data.workbenches,
    assign: (data, rows) => {
      data.workbenches = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'owner_id', value: (row) => row.ownerId },
      { name: 'name', value: (row) => row.name },
      { name: 'workspace_path', value: (row) => row.workspacePath },
      { name: 'created_at', value: (row) => row.createdAt },
      { name: 'record_updated_at', value: (row) => row.updatedAt },
    ],
  }),
  makeTableSpec<Chat>({
    table: 'roundtable_chats',
    idColumn: 'id',
    rows: (data) => data.chats,
    assign: (data, rows) => {
      data.chats = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'owner_id', value: (row) => row.ownerId },
      { name: 'workbench_id', value: (row) => row.workbenchId },
      { name: 'title', value: (row) => row.title },
      { name: 'created_at', value: (row) => row.createdAt },
      { name: 'record_updated_at', value: (row) => row.updatedAt },
    ],
  }),
  makeTableSpec<Message>({
    table: 'roundtable_messages',
    idColumn: 'id',
    rows: (data) => data.messages,
    assign: (data, rows) => {
      data.messages = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'owner_id', value: (row) => row.ownerId },
      { name: 'chat_id', value: (row) => row.chatId },
      { name: 'author_type', value: (row) => row.authorType },
      { name: 'author_id', value: (row) => row.authorId },
      { name: 'created_at', value: (row) => row.createdAt },
    ],
  }),
  makeTableSpec<BreakoutRoom>({
    table: 'roundtable_breakout_rooms',
    idColumn: 'id',
    rows: (data) => data.breakoutRooms,
    assign: (data, rows) => {
      data.breakoutRooms = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'owner_id', value: (row) => row.ownerId },
      { name: 'chat_id', value: (row) => row.chatId },
      { name: 'status', value: (row) => row.status },
      { name: 'created_at', value: (row) => row.createdAt },
      { name: 'record_updated_at', value: (row) => row.updatedAt },
    ],
  }),
  makeTableSpec<BreakoutMessage>({
    table: 'roundtable_breakout_messages',
    idColumn: 'id',
    rows: (data) => data.breakoutMessages,
    assign: (data, rows) => {
      data.breakoutMessages = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'owner_id', value: (row) => row.ownerId },
      { name: 'room_id', value: (row) => row.roomId },
      { name: 'author_type', value: (row) => row.authorType },
      { name: 'author_id', value: (row) => row.authorId },
      { name: 'created_at', value: (row) => row.createdAt },
    ],
  }),
  makeTableSpec<Artifact>({
    table: 'roundtable_artifacts',
    idColumn: 'id',
    rows: (data) => data.artifacts,
    assign: (data, rows) => {
      data.artifacts = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'chat_id', value: (row) => row.chatId },
      { name: 'kind', value: (row) => row.kind },
      { name: 'title', value: (row) => row.title },
      { name: 'owner_agent_id', value: (row) => row.ownerAgentId },
      { name: 'created_at', value: (row) => row.createdAt },
    ],
  }),
  makeTableSpec<Handoff>({
    table: 'roundtable_handoffs',
    idColumn: 'id',
    rows: (data) => data.handoffs,
    assign: (data, rows) => {
      data.handoffs = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'owner_id', value: (row) => row.ownerId },
      { name: 'chat_id', value: (row) => row.chatId },
      { name: 'created_at', value: (row) => row.createdAt },
    ],
  }),
  makeTableSpec<UserProfile>({
    table: 'roundtable_profiles',
    idColumn: 'user_id',
    rows: (data) => data.profiles,
    assign: (data, rows) => {
      data.profiles = rows;
    },
    id: (row) => row.userId,
    orderBy: 'user_id ASC',
    columns: [{ name: 'record_updated_at', value: (row) => row.updatedAt }],
  }),
  makeTableSpec<WorkbenchPin>({
    table: 'roundtable_workbench_pins',
    idColumn: 'id',
    rows: (data) => data.workbenchPins,
    assign: (data, rows) => {
      data.workbenchPins = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'user_id', value: (row) => row.userId },
      { name: 'workbench_id', value: (row) => row.workbenchId },
      { name: 'created_at', value: (row) => row.createdAt },
    ],
  }),
  makeTableSpec<LocalTurn>({
    table: 'roundtable_turns',
    idColumn: 'id',
    rows: (data) => data.turns,
    assign: (data, rows) => {
      data.turns = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'owner_id', value: (row) => row.ownerId },
      { name: 'local_chat_id', value: (row) => row.localChatId },
      { name: 'mission_id', value: (row) => row.missionId },
      { name: 'workflow_template_id', value: (row) => row.workflowTemplateId },
      { name: 'status', value: (row) => row.status },
      { name: 'created_at', value: (row) => row.createdAt },
    ],
  }),
  makeTableSpec<Mission>({
    table: 'roundtable_missions',
    idColumn: 'id',
    rows: (data) => data.missions,
    assign: (data, rows) => {
      data.missions = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'owner_id', value: (row) => row.ownerId },
      { name: 'chat_id', value: (row) => row.chatId },
      { name: 'source_turn_id', value: (row) => row.sourceTurnId },
      { name: 'status', value: (row) => row.status },
      { name: 'workflow_template_id', value: (row) => row.workflowTemplateId },
      { name: 'created_at', value: (row) => row.createdAt },
      { name: 'record_updated_at', value: (row) => row.updatedAt },
    ],
  }),
  makeTableSpec<AgentRuntimeConfig>({
    table: 'roundtable_agent_runtime_configs',
    idColumn: 'agent_id',
    rows: (data) => data.agentRuntimeConfigs,
    assign: (data, rows) => {
      data.agentRuntimeConfigs = rows;
    },
    id: (row) => row.agentId,
    orderBy: 'agent_id ASC',
    columns: [
      { name: 'runtime', value: (row) => row.runtime },
      { name: 'record_updated_at', value: (row) => row.updatedAt },
    ],
  }),
  makeTableSpec<AgentRuntimeDefaultConfig>({
    table: 'roundtable_agent_runtime_defaults',
    idColumn: 'runtime',
    rows: (data) => data.agentRuntimeDefaults,
    assign: (data, rows) => {
      data.agentRuntimeDefaults = rows;
    },
    id: (row) => row.runtime,
    orderBy: 'runtime ASC',
    columns: [
      { name: 'record_updated_at', value: (row) => row.updatedAt },
    ],
  }),
  makeTableSpec<AgentRuntimeConversation>({
    table: 'roundtable_agent_runtime_conversations',
    idColumn: 'id',
    rows: (data) => data.agentRuntimeConversations,
    assign: (data, rows) => {
      data.agentRuntimeConversations = rows;
    },
    id: (row) => row.id,
    // The in-memory list is kept newest-first (runtime-actions prepends);
    // reads must preserve that so newest-per-task lookups stay correct.
    orderBy: 'started_at DESC, id DESC',
    columns: [
      { name: 'agent_id', value: (row) => row.agentId },
      { name: 'turn_id', value: (row) => row.turnId },
      { name: 'task_id', value: (row) => row.taskId },
      { name: 'status', value: (row) => row.status },
      { name: 'started_at', value: (row) => row.startedAt },
      { name: 'record_updated_at', value: (row) => row.updatedAt },
    ],
  }),
  makeTableSpec<A2ATaskBinding>({
    table: 'roundtable_a2a_task_bindings',
    idColumn: 'id',
    rows: (data) => data.a2aTaskBindings,
    assign: (data, rows) => {
      data.a2aTaskBindings = rows;
    },
    id: (row) => row.id,
    orderBy: 'created_at ASC, id ASC',
    columns: [
      { name: 'mission_id', value: (row) => row.missionId },
      { name: 'turn_id', value: (row) => row.turnId },
      { name: 'plan_task_id', value: (row) => row.planTaskId },
      { name: 'agent_id', value: (row) => row.agentId },
      { name: 'remote_task_id', value: (row) => row.remoteTaskId },
      { name: 'state', value: (row) => row.state },
      { name: 'created_at', value: (row) => row.createdAt },
      { name: 'record_updated_at', value: (row) => row.updatedAt },
    ],
  }),
  makeTableSpec<RoundtableSettings>({
    table: 'roundtable_settings',
    idColumn: 'id',
    rows: (data) => [data.settings],
    assign: (data, rows) => {
      data.settings = rows[0] ?? data.settings;
    },
    id: () => 'settings',
    orderBy: 'id ASC',
    columns: [
      { name: 'record_updated_at', value: (row) => row.updatedAt },
    ],
  }),
];

async function readNormalizedDataFrom(queryable: PgQueryable): Promise<RoundtableData> {
  const data = emptyData();
  for (const tableSpec of NORMALIZED_TABLE_SPECS) {
    const spec = tableSpec as NormalizedTableSpec<unknown>;
    const rows = await readNormalizedRows(queryable, spec);
    spec.assign(data, rows);
  }
  return normalizeData(data);
}

async function writeNormalizedDataTo(queryable: PgQueryable, data: RoundtableData): Promise<void> {
  const normalized = normalizeData(data);
  for (const tableSpec of NORMALIZED_TABLE_SPECS) {
    const spec = tableSpec as NormalizedTableSpec<unknown>;
    await upsertNormalizedRows(queryable, spec, spec.rows(normalized));
  }
  for (const tableSpec of [...NORMALIZED_TABLE_SPECS].reverse()) {
    const spec = tableSpec as NormalizedTableSpec<unknown>;
    await deleteMissingNormalizedRows(queryable, spec, spec.rows(normalized));
  }
}

async function readNormalizedRows<T>(queryable: PgQueryable, spec: NormalizedTableSpec<T>): Promise<T[]> {
  const result = await queryable.query<{ data: T }>(
    `SELECT data FROM ${identifier(spec.table)} WHERE store_key = $1 ORDER BY ${spec.orderBy}`,
    [storeKey()],
  );
  return result.rows.map((row) => row.data);
}

async function upsertNormalizedRows<T>(
  queryable: PgQueryable,
  spec: NormalizedTableSpec<T>,
  rows: T[],
): Promise<void> {
  const table = identifier(spec.table);
  const idColumn = identifier(spec.idColumn);
  const columnNames = spec.columns.map((column) => identifier(column.name));
  const insertColumns = ['store_key', spec.idColumn, ...spec.columns.map((column) => column.name), 'data', 'updated_at']
    .map(identifier)
    .join(', ');
  const assignments = [...columnNames.map((name) => `${name} = EXCLUDED.${name}`), 'data = EXCLUDED.data', 'updated_at = now()']
    .join(', ');

  for (const row of rows) {
    const values = [storeKey(), spec.id(row), ...spec.columns.map((column) => column.value(row)), row];
    const placeholders = values.map((_, index) => (index === values.length - 1 ? `$${index + 1}::jsonb` : `$${index + 1}`));
    await queryable.query(
      `INSERT INTO ${table} (${insertColumns})
       VALUES (${[...placeholders, 'now()'].join(', ')})
       ON CONFLICT (store_key, ${idColumn})
       DO UPDATE SET ${assignments}`,
      values,
    );
  }
}

async function deleteMissingNormalizedRows<T>(
  queryable: PgQueryable,
  spec: NormalizedTableSpec<T>,
  rows: T[],
): Promise<void> {
  const rowIds = rows.map((row) => spec.id(row));
  const table = identifier(spec.table);
  const idColumn = identifier(spec.idColumn);
  if (rowIds.length === 0) {
    await queryable.query(`DELETE FROM ${table} WHERE store_key = $1`, [storeKey()]);
    return;
  }

  await queryable.query(`DELETE FROM ${table} WHERE store_key = $1 AND NOT (${idColumn} = ANY($2::text[]))`, [
    storeKey(),
    rowIds,
  ]);
}

async function lockNormalizedStore(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`roundtable:${storeKey()}`]);
}

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function normalizedConstraint(
  constraint: string,
  table: string,
  columns: string,
  targetTable: string,
  targetColumns: string,
): string {
  return `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '${constraint}'
      ) THEN
        ALTER TABLE ${identifier(table)}
        ADD CONSTRAINT ${identifier(constraint)}
        FOREIGN KEY ${columns}
        REFERENCES ${identifier(targetTable)} ${targetColumns}
        ON DELETE CASCADE
        NOT VALID;
      END IF;
    END
    $$`;
}

function getPool(): PgPool {
  if (!pool) {
    const max = Number(process.env.ROUNDTABLE_POSTGRES_POOL_SIZE || 10);
    const config: PoolConfig = { max: Number.isFinite(max) && max > 0 ? max : 10 };
    if (process.env.DATABASE_URL) config.connectionString = process.env.DATABASE_URL;
    pool = new Pool(config);
  }
  return pool;
}

type StoreDriver = 'json' | 'postgres' | 'postgres_normalized';

function storeDriver(): StoreDriver {
  const driver = process.env.ROUNDTABLE_STORE_DRIVER?.trim().toLowerCase();
  if (driver === 'postgres_normalized' || driver === 'normalized') return 'postgres_normalized';
  if (driver === 'postgres') return 'postgres';
  if (driver === 'json') return 'json';
  return process.env.NODE_ENV !== 'test' && Boolean(process.env.DATABASE_URL) ? 'postgres_normalized' : 'json';
}

function useNormalizedPostgresStore(): boolean {
  return storeDriver() === 'postgres_normalized';
}

function usePostgresStore(): boolean {
  return storeDriver() === 'postgres';
}

function storeKey(): string {
  return process.env.ROUNDTABLE_STORE_KEY?.trim() || DEFAULT_STORE_KEY;
}

function emptyData(): RoundtableData {
  return {
    version: 1,
    users: [],
    workbenches: [],
    chats: [],
    messages: [],
    breakoutRooms: [],
    breakoutMessages: [],
    artifacts: [],
    handoffs: [],
    profiles: [],
    workbenchPins: [],
    turns: [],
    missions: [],
    agentRuntimeConfigs: [],
    agentRuntimeDefaults: [],
    agentRuntimeConversations: [],
    a2aTaskBindings: [],
    settings: emptySettings(),
  };
}

function normalizeData(raw: Partial<RoundtableData>): RoundtableData {
  return {
    version: 1,
    users: Array.isArray(raw.users) ? raw.users : [],
    workbenches: Array.isArray(raw.workbenches) ? raw.workbenches : [],
    chats: Array.isArray(raw.chats) ? raw.chats : [],
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    breakoutRooms: Array.isArray(raw.breakoutRooms) ? raw.breakoutRooms : [],
    breakoutMessages: Array.isArray(raw.breakoutMessages) ? raw.breakoutMessages : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    handoffs: Array.isArray(raw.handoffs) ? raw.handoffs : [],
    profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    workbenchPins: Array.isArray(raw.workbenchPins) ? raw.workbenchPins : [],
    turns: Array.isArray(raw.turns) ? raw.turns : [],
    missions: Array.isArray(raw.missions) ? raw.missions : [],
    agentRuntimeConfigs: Array.isArray(raw.agentRuntimeConfigs)
      ? raw.agentRuntimeConfigs.map(normalizeRuntimeConfig)
      : [],
    agentRuntimeDefaults: Array.isArray(raw.agentRuntimeDefaults)
      ? raw.agentRuntimeDefaults.map(normalizeRuntimeDefault)
      : [],
    agentRuntimeConversations: Array.isArray(raw.agentRuntimeConversations) ? raw.agentRuntimeConversations : [],
    a2aTaskBindings: Array.isArray(raw.a2aTaskBindings) ? raw.a2aTaskBindings : [],
    settings: normalizeSettings(raw.settings),
  };
}

function normalizeRuntimeConfig(config: AgentRuntimeConfig): AgentRuntimeConfig {
  return {
    ...config,
    modelProvider: config.modelProvider ?? null,
    interactionMode: config.interactionMode ?? null,
    effort: config.effort ?? null,
  };
}

function normalizeRuntimeDefault(config: AgentRuntimeDefaultConfig): AgentRuntimeDefaultConfig {
  return {
    ...config,
    modelProvider: config.modelProvider ?? null,
    interactionMode: config.interactionMode ?? null,
    effort: config.effort ?? null,
  };
}

function emptySettings(): RoundtableSettings {
  return {
    defaultAgentAdapter: null,
    modelProviders: [],
    a2aRemoteAgents: [],
    workflowTemplates: [],
    updatedAt: nowIso(),
  };
}

function normalizeSettings(raw: Partial<RoundtableSettings> | undefined): RoundtableSettings {
  if (!raw || typeof raw !== 'object') return emptySettings();
  return {
    defaultAgentAdapter: typeof raw.defaultAgentAdapter === 'string' ? raw.defaultAgentAdapter : null,
    modelProviders: Array.isArray(raw.modelProviders) ? raw.modelProviders : [],
    a2aRemoteAgents: Array.isArray(raw.a2aRemoteAgents) ? raw.a2aRemoteAgents : [],
    workflowTemplates: Array.isArray(raw.workflowTemplates) ? raw.workflowTemplates : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
