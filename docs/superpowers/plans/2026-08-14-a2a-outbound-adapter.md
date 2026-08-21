# A2A Outbound Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Roundtable dispatch an internal `PlanTask` to a configured remote A2A v1.0 agent, stream its task state and artifacts back into the existing mission UI, and cancel the remote task when a turn is interrupted.

**Architecture:** Keep Mission planning, approval, DAG scheduling, review/fix gates, and `HandoffCardV2` as Roundtable's internal orchestration model. Add an outbound `a2a` adapter at the existing `runAgentTask` boundary: discover a remote Agent Card, map the handoff to an A2A `Message`, consume task/artifact events, persist the remote task binding, and materialize safe text artifacts into Roundtable's existing artifact pipeline. This plan deliberately treats Roundtable as the A2A client; exposing Roundtable as an inbound A2A server is a separate follow-up project.

**Tech Stack:** Next.js 15, TypeScript 5.5, Vitest 3, existing JSON/Postgres store abstraction, A2A Protocol v1.0, `@a2a-js/sdk@1.0.1`, JSON-RPC/HTTP with SSE streaming.

**Execution update (2026-08-14):** Per user direction, automated coverage is intentionally limited to core functional behavior: configuration redaction/resolution, task-binding persistence, handoff/event mapping, streamed artifact materialization, remote cancellation, and dispatch fallback. Hash/signature tests and exhaustive protocol edge-case matrices are excluded.

## Global Constraints

- Use the sibling clone at `../A2A` as the local protocol reference; it is pinned at commit `1eb4aa0` when this plan was written and must not be vendored or added as a Git submodule.
- Implement A2A Protocol v1.0 only. Reject Agent Cards that expose no v1.0 `JSONRPC` or `HTTP+JSON` interface.
- Use the official `@a2a-js/sdk@1.0.1`; do not hand-roll JSON-RPC or SSE parsing.
- Roundtable remains the owner of task IDs, DAG dependencies, `blocked` state, review gates, and fixer rounds. Remote A2A task/context IDs are stored as mappings and never replace `PlanTask.id` or `Mission.id`.
- Do not send local dependency IDs in A2A `referenceTaskIds`; those IDs are not meaningful to another A2A server. Put Roundtable IDs in message metadata instead.
- Never expose `workspace://`, `turn://`, or `chat://` URIs to a remote agent as downloadable URLs. The first release sends text/structured handoff context only.
- Remote output may create files only below `.roundtable/runs/a2a/<plan-task-id>/`. It must not overwrite source files or arbitrary workspace paths.
- Accept `text/plain`, `text/markdown`, `text/html`, and `application/json` output parts. Represent other URL/binary parts as links/metadata without downloading them.
- Bearer tokens may be stored through the existing protected settings path, but no API response, event, log, task binding, handoff, or test snapshot may contain a token.
- Production A2A endpoints must use HTTPS. Plain HTTP is allowed only for `localhost`, `127.0.0.1`, and `::1` in non-production environments.
- Existing adapters and the zero-key `local-dispatch` flow must remain behaviorally unchanged.
- No inbound A2A server, push notifications, gRPC transport, Agent Card signing, or remote patch application is included in this plan.

---

## File Structure

- `src/server/actions/a2a/config.ts`: validates and resolves per-seat A2A endpoint/auth configuration from saved settings and environment variables.
- `src/server/actions/a2a/message-mapper.ts`: converts `HandoffCardV2` into A2A requests and reduces A2A stream events into Roundtable output/events.
- `src/server/actions/a2a/task-store.ts`: persists local-plan-task to remote-A2A-task bindings through the existing store abstraction.
- `src/server/actions/adapters/a2a-adapter.ts`: owns Agent Card discovery, SDK client creation, streaming, timeout handling, cancellation, and safe output materialization.
- `src/server/types.ts`: adds A2A configuration/binding contracts and extends settings/dispatch metadata.
- `src/server/store.ts`: persists A2A bindings and normalizes new settings fields for JSON and normalized Postgres drivers.
- `src/server/actions/settings-actions.ts`: exposes redacted A2A configuration and resolves `a2a` as a workflow adapter.
- `src/app/api/settings/route.ts`: validates A2A configuration patches.
- `src/ui/components/settings-console.jsx`: lets the user configure one remote A2A endpoint per Roundtable seat without exposing saved tokens.
- `src/server/actions/agent-runner.ts`: recognizes `a2a` and delegates to the new adapter.
- `src/server/actions/turns/dispatch.ts`: passes the structured handoff, handles visible A2A fallback errors, and cancels active remote tasks on interruption.
- `tests/a2a-config.test.ts`: configuration validation, precedence, and secret-redaction coverage.
- `tests/a2a-message-mapper.test.ts`: protocol mapping, state mapping, streamed artifact assembly, and safe filename coverage.
- `tests/a2a-task-store.test.ts`: JSON-store persistence and task-binding lifecycle coverage.
- `tests/a2a-adapter.test.ts`: SDK-client boundary tests with a typed fake client.
- `tests/a2a-dispatch.test.ts`: Roundtable dispatch/fallback/cancel integration coverage.

---

### Task 1: Add A2A contracts and durable task bindings

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/server/types.ts`
- Modify: `src/server/store.ts`
- Create: `src/server/actions/a2a/task-store.ts`
- Create: `tests/a2a-task-store.test.ts`

**Interfaces:**
- Consumes: existing `RoundtableData`, `mutateData`, `readData`, `nowIso`, and normalized table specifications.
- Produces: `A2ARemoteAgentConfig`, `A2ATaskBinding`, `A2ATaskBindingState`, `upsertA2ATaskBinding()`, `bindingsForTurn()`, and `finishA2ATaskBinding()` for later adapter and cancellation tasks.

- [ ] **Step 1: Write the failing persistence test**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetData } from '../src/server/store.js';
import {
  bindingsForTurn,
  finishA2ATaskBinding,
  upsertA2ATaskBinding,
} from '../src/server/actions/a2a/task-store.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-a2a-binding-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

describe('A2A task bindings', () => {
  it('persists the remote identity without credentials and reaches a terminal state', async () => {
    await upsertA2ATaskBinding({
      id: 'a2a_turn-1_task-1',
      missionId: 'mission-1',
      turnId: 'turn-1',
      planTaskId: 'task-1',
      agentId: 'atlas',
      agentBaseUrl: 'https://agent.example',
      agentCardPath: '/.well-known/agent-card.json',
      remoteTaskId: 'remote-task-9',
      remoteContextId: 'remote-context-4',
      remoteTenant: '',
      protocolVersion: '1.0',
      state: 'working',
      error: null,
    });

    await finishA2ATaskBinding('turn-1', 'task-1', 'completed', null);

    expect(await bindingsForTurn('turn-1')).toMatchObject([{
      remoteTaskId: 'remote-task-9',
      state: 'completed',
      error: null,
    }]);
    expect(JSON.stringify(await bindingsForTurn('turn-1'))).not.toContain('Bearer');
  });
});
```

- [ ] **Step 2: Run the new test and confirm that the missing module fails**

Run: `corepack pnpm vitest run tests/a2a-task-store.test.ts`

Expected: FAIL because `src/server/actions/a2a/task-store.ts` does not exist.

- [ ] **Step 3: Install the official v1.0 JavaScript SDK**

Run: `corepack pnpm add @a2a-js/sdk@1.0.1`

Expected: `package.json` contains `"@a2a-js/sdk": "1.0.1"` and `pnpm-lock.yaml` records the resolved package.

- [ ] **Step 4: Add the persistent contracts**

Add these types to `src/server/types.ts` and add `a2aRemoteAgents` to `RoundtableSettings`:

```ts
export type A2ARemoteAgentConfig = {
  agentId: string;
  enabled: boolean;
  baseUrl: string;
  cardPath: string | null;
  authToken: string | null;
  updatedAt: string;
};

export type A2ATaskBindingState =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'input_required'
  | 'auth_required'
  | 'rejected';

export type A2ATaskBinding = {
  id: string;
  missionId: string;
  turnId: string;
  planTaskId: string;
  agentId: string;
  agentBaseUrl: string;
  agentCardPath: string | null;
  remoteTaskId: string;
  remoteContextId: string | null;
  remoteTenant: string;
  protocolVersion: string;
  state: A2ATaskBindingState;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RoundtableSettings = {
  defaultAgentAdapter: string | null;
  modelProviders: ModelProviderConfig[];
  a2aRemoteAgents: A2ARemoteAgentConfig[];
  workflowTemplates: WorkflowTemplate[];
  updatedAt: string;
};
```

- [ ] **Step 5: Register bindings in every store driver**

Add `a2aTaskBindings: A2ATaskBinding[]` to `RoundtableData`, initialize it in `emptyData()`, normalize missing legacy data to `[]`, and add this normalized table specification in `src/server/store.ts`:

```ts
makeTableSpec<A2ATaskBinding>({
  table: 'roundtable_a2a_task_bindings',
  idColumn: 'id',
  rows: (data) => data.a2aTaskBindings,
  assign: (data, rows) => { data.a2aTaskBindings = rows; },
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
```

Also make `emptySettings()` and `normalizeSettings()` supply `a2aRemoteAgents: []` for existing data files.

- [ ] **Step 6: Implement the binding store functions**

Create `src/server/actions/a2a/task-store.ts` with these exact signatures:

```ts
export async function upsertA2ATaskBinding(
  input: Omit<A2ATaskBinding, 'createdAt' | 'updatedAt'>,
): Promise<A2ATaskBinding>;

export async function bindingsForTurn(turnId: string): Promise<A2ATaskBinding[]>;

export async function finishA2ATaskBinding(
  turnId: string,
  planTaskId: string,
  state: A2ATaskBindingState,
  error: string | null,
): Promise<A2ATaskBinding | null>;
```

`upsertA2ATaskBinding()` must preserve the original `createdAt`, update mutable remote/state fields, and derive `updatedAt` with `nowIso()`. It must never accept or persist an auth token.

- [ ] **Step 7: Run the binding and compatibility tests**

Run: `corepack pnpm vitest run tests/a2a-task-store.test.ts tests/settings-actions.test.ts tests/runtime-actions.test.ts`

Expected: PASS, including normalization of stores created before A2A fields existed.

- [ ] **Step 8: Commit the contracts and store changes**

```bash
git add package.json pnpm-lock.yaml src/server/types.ts src/server/store.ts src/server/actions/a2a/task-store.ts tests/a2a-task-store.test.ts
git commit -m "feat: add A2A task binding contracts"
```

---

### Task 2: Add redacted per-agent A2A configuration

**Files:**
- Create: `src/server/actions/a2a/config.ts`
- Modify: `src/server/actions/settings-actions.ts`
- Modify: `src/app/api/settings/route.ts`
- Modify: `src/ui/components/settings-console.jsx`
- Create: `tests/a2a-config.test.ts`
- Modify: `tests/settings-actions.test.ts`

**Interfaces:**
- Consumes: `A2ARemoteAgentConfig`, `AGENT_ROSTER`, saved `RoundtableSettings`, and existing settings auth/API flow.
- Produces: `resolveA2ARemoteAgentConfig(agentId, data?, env?)`, `A2ARemoteAgentState`, `a2aAgents` in `SettingsState`, and an `a2a` adapter option.

- [ ] **Step 1: Write failing tests for validation, precedence, and redaction**

```ts
it('resolves a saved remote agent without exposing its bearer token', async () => {
  const state = await saveSettings({
    defaultAgentAdapter: 'a2a',
    a2aAgents: [{
      agentId: 'atlas',
      enabled: true,
      baseUrl: 'https://atlas.example',
      cardPath: '/.well-known/agent-card.json',
      authToken: 'remote-secret',
    }],
  });

  const resolved = await resolveA2ARemoteAgentConfig('atlas');
  expect(resolved).toMatchObject({
    agentId: 'atlas',
    baseUrl: 'https://atlas.example',
    authToken: 'remote-secret',
    source: 'settings',
  });
  expect(state.a2aAgents.find((item) => item.agentId === 'atlas')).toMatchObject({
    enabled: true,
    tokenSet: true,
    tokenSource: 'settings',
  });
  expect(JSON.stringify(state)).not.toContain('remote-secret');
});

it('rejects an insecure production endpoint', async () => {
  process.env.NODE_ENV = 'production';
  await expect(saveSettings({
    a2aAgents: [{ agentId: 'atlas', enabled: true, baseUrl: 'http://agent.example' }],
  })).rejects.toMatchObject({ message: 'a2a_https_required' });
});
```

Restore `NODE_ENV` in the test cleanup so this test cannot leak state into the rest of the suite.

- [ ] **Step 2: Run the configuration tests and confirm the missing API fails**

Run: `corepack pnpm vitest run tests/a2a-config.test.ts tests/settings-actions.test.ts`

Expected: FAIL because A2A settings and resolver functions are not implemented.

- [ ] **Step 3: Implement configuration resolution**

Create `src/server/actions/a2a/config.ts` with:

```ts
export type ResolvedA2ARemoteAgentConfig = {
  agentId: string;
  enabled: boolean;
  baseUrl: string;
  cardPath: string | null;
  authToken: string | null;
  source: 'settings' | 'env';
};

export async function resolveA2ARemoteAgentConfig(
  agentId: string,
  data?: RoundtableData,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedA2ARemoteAgentConfig | null>;

export function assertAllowedA2AUrl(raw: string, nodeEnv: string | undefined): string;
```

Resolution order is saved per-agent configuration first, then these environment variables:

```text
ROUNDTABLE_A2A_URL_ATLAS
ROUNDTABLE_A2A_TOKEN_ATLAS
ROUNDTABLE_A2A_CARD_PATH_ATLAS
```

Use the same normalized uppercase key rule as `envKey()` in the CLI runtime registry. `assertAllowedA2AUrl()` must accept HTTPS everywhere and HTTP only for loopback hosts outside production.

- [ ] **Step 4: Extend settings actions without leaking credentials**

Add this response-only shape to `SettingsState`:

```ts
export type A2ARemoteAgentState = {
  agentId: string;
  name: string;
  role: string;
  enabled: boolean;
  baseUrl: string;
  cardPath: string;
  tokenSet: boolean;
  tokenSource: 'settings' | 'env' | null;
};
```

Add `a2a` to `ADAPTER_OPTIONS`, accept `a2aAgents` patches in `saveSettings()`, preserve an existing token when the submitted token field is empty, and clear it only when `clearAuthToken: true` is explicitly sent. `listSettingsState()` must return one redacted row per `AGENT_ROSTER` entry.

- [ ] **Step 5: Extend the authenticated settings route schema**

Add this Zod schema in `src/app/api/settings/route.ts`:

```ts
const A2AAgentSchema = z.object({
  agentId: z.string().min(1),
  enabled: z.boolean().optional(),
  baseUrl: z.string().nullable().optional(),
  cardPath: z.string().nullable().optional(),
  authToken: z.string().nullable().optional(),
  clearAuthToken: z.boolean().optional(),
});
```

Add `a2aAgents: z.array(A2AAgentSchema).optional()` to `BodySchema`. Keep the existing `requireProductionActor()` checks for reads and writes.

- [ ] **Step 6: Add A2A remote cards to Settings**

Extend `toDraft()` with an `a2aAgents` collection whose token field starts blank. Add an “A2A Agents” section with, per seat:

- enable checkbox;
- Agent base URL;
- Agent Card path, defaulting to `/.well-known/agent-card.json`;
- password input whose blank value preserves the existing token;
- explicit clear-token button;
- visible `configured via settings/env` state.

The save request must send only a newly typed token or `clearAuthToken: true`; it must never echo the saved token into React state.

- [ ] **Step 7: Run configuration and settings tests**

Run: `corepack pnpm vitest run tests/a2a-config.test.ts tests/settings-actions.test.ts tests/production-api-auth.test.ts`

Expected: PASS, including existing settings authorization tests and secret-redaction assertions.

- [ ] **Step 8: Commit the configuration surface**

```bash
git add src/server/actions/a2a/config.ts src/server/actions/settings-actions.ts src/app/api/settings/route.ts src/ui/components/settings-console.jsx tests/a2a-config.test.ts tests/settings-actions.test.ts
git commit -m "feat: configure remote A2A agents"
```

---

### Task 3: Map Roundtable handoffs and A2A stream events

**Files:**
- Create: `src/server/actions/a2a/message-mapper.ts`
- Create: `tests/a2a-message-mapper.test.ts`

**Interfaces:**
- Consumes: `HandoffCardV2`, the formatted handoff text, A2A SDK `Message`, `SendMessageRequest`, `StreamResponse`, `TaskState`, and remote artifacts.
- Produces: `buildA2ASendRequest()`, `createA2AOutputAccumulator()`, `applyA2AStreamResponse()`, `a2aStateName()`, and `materializableA2AParts()`.

- [ ] **Step 1: Write a failing request-mapping test**

```ts
it('sends human-readable and structured handoff parts without foreign task references', () => {
  const request = buildA2ASendRequest({
    handoff: handoffFixture,
    handoffText: '# Roundtable handoff\n\nBuild the checkout.',
    acceptedOutputModes: ['text/plain', 'text/markdown', 'text/html', 'application/json'],
    messageId: 'message-1',
  });

  expect(request.message.messageId).toBe('message-1');
  expect(request.message.taskId).toBe('');
  expect(request.message.contextId).toBe('');
  expect(request.message.referenceTaskIds).toEqual([]);
  expect(request.message.metadata).toMatchObject({
    roundtableMissionId: handoffFixture.missionId,
    roundtablePlanTaskId: handoffFixture.task.id,
    roundtableHandoffVersion: 'roundtable.handoff.v2',
  });
  expect(request.message.parts.map((part) => part.content?.$case)).toEqual(['text', 'data']);
});
```

- [ ] **Step 2: Write failing stream-reducer tests**

Cover these cases with explicit SDK-shaped fixtures:

1. a `task` event records the server-generated task/context IDs;
2. two `artifactUpdate` events with the same `artifactId` and `append: true` concatenate text in order;
3. `TASK_STATE_COMPLETED` maps to `completed` and emits a Roundtable `done` event;
4. `TASK_STATE_INPUT_REQUIRED` maps to `input_required` and emits a recoverable Roundtable error;
5. a direct `message` response with no Task is accepted as a completed text result;
6. message/status text becomes `text_delta`, never `thinking_delta`;
7. local dependency IDs remain only inside Roundtable metadata/data and not A2A `referenceTaskIds`.

- [ ] **Step 3: Run the mapper test and confirm the missing module fails**

Run: `corepack pnpm vitest run tests/a2a-message-mapper.test.ts`

Expected: FAIL because the mapper does not exist.

- [ ] **Step 4: Implement the outgoing request**

Implement this exact entry point:

```ts
export function buildA2ASendRequest(input: {
  handoff: HandoffCardV2;
  handoffText: string;
  acceptedOutputModes: string[];
  messageId?: string;
}): SendMessageRequest;
```

The returned message must use `Role.ROLE_USER`, an empty `taskId` and `contextId`, and these two parts:

```ts
parts: [
  {
    content: { $case: 'text', value: input.handoffText },
    filename: '',
    mediaType: 'text/plain',
    metadata: undefined,
  },
  {
    content: { $case: 'data', value: input.handoff },
    filename: 'roundtable-handoff.json',
    mediaType: 'application/json',
    metadata: { schema: 'roundtable.handoff.v2' },
  },
],
```

Set `configuration.acceptedOutputModes` from the caller and keep `returnImmediately: false` so streaming drives the existing live-activity UI.

- [ ] **Step 5: Implement a deterministic stream accumulator**

Use a plain serializable accumulator rather than exposing SDK objects outside the mapper:

```ts
export type A2ACollectedPart = {
  artifactId: string | null;
  filename: string | null;
  mediaType: string;
  kind: 'text' | 'data' | 'url' | 'raw';
  value: string | Record<string, unknown> | unknown[] | null;
};

export type A2AOutputAccumulator = {
  remoteTaskId: string | null;
  remoteContextId: string | null;
  state: A2ATaskBindingState | null;
  parts: A2ACollectedPart[];
  events: AgentEvent[];
  error: string | null;
};

export function createA2AOutputAccumulator(): A2AOutputAccumulator;

export function applyA2AStreamResponse(
  current: A2AOutputAccumulator,
  response: StreamResponse,
): A2AOutputAccumulator;
```

For `append: true`, append only to a previous part with the same `artifactId`, filename, media type, and kind. Deduplicate terminal events so a final Task followed by a final status update produces one `done` or `error` event.

- [ ] **Step 6: Add output filtering helpers**

Implement `materializableA2AParts()` so only text/data parts with an accepted MIME type are returned for local file creation. URL/raw parts stay in the accumulator for the transcript but cannot trigger a fetch or write.

Sanitize filenames by taking the basename, replacing characters outside `[a-zA-Z0-9._-]` with `-`, and falling back by MIME type:

```text
text/html        -> result.html
application/json -> result.json
text/markdown    -> result.md
text/plain       -> result.txt
```

- [ ] **Step 7: Run mapper tests and typechecking**

Run: `corepack pnpm vitest run tests/a2a-message-mapper.test.ts`

Expected: PASS.

Run: `corepack pnpm typecheck`

Expected: PASS with the SDK protobuf discriminated unions handled without `any`.

- [ ] **Step 8: Commit the protocol mapping**

```bash
git add src/server/actions/a2a/message-mapper.ts tests/a2a-message-mapper.test.ts
git commit -m "feat: map Roundtable handoffs to A2A"
```

---

### Task 4: Implement Agent Card discovery, streaming, and safe artifact materialization

**Files:**
- Create: `src/server/actions/adapters/a2a-adapter.ts`
- Create: `tests/a2a-adapter.test.ts`

**Interfaces:**
- Consumes: `ResolvedA2ARemoteAgentConfig`, `buildA2ASendRequest()`, mapper accumulator helpers, task-binding store functions, existing `AgentRunResult` shape, and `artifactKindForFile()`.
- Produces: `runOnA2A()`, `cancelA2ABinding()`, `A2AUnavailableError`, `A2ARequestError`, and an injectable `A2AClientLike` boundary used by tests and turn cancellation.

- [ ] **Step 1: Write a failing successful-stream test with a typed fake client**

```ts
it('discovers an agent, streams a task, persists its binding, and materializes output', async () => {
  const client = fakeA2AClient([
    taskEvent('remote-1', 'context-1', TaskState.TASK_STATE_WORKING),
    artifactTextEvent('remote-1', 'context-1', 'artifact-1', 'result.md', '# Result'),
    statusEvent('remote-1', 'context-1', TaskState.TASK_STATE_COMPLETED),
  ]);

  const result = await runOnA2A(runFixture, {
    createClient: async () => ({ client, protocolVersion: '1.0', tenant: '' }),
  });

  expect(result).toMatchObject({ ok: true, kind: 'markdown' });
  expect(result.path).toBe('.roundtable/runs/a2a/task-1/result.md');
  expect(result.text).toBe('# Result');
  expect(result.events.at(-1)).toMatchObject({ type: 'done' });
  expect(await bindingsForTurn('turn-1')).toMatchObject([{
    remoteTaskId: 'remote-1',
    remoteContextId: 'context-1',
    state: 'completed',
  }]);
});
```

- [ ] **Step 2: Write failing error and safety tests**

Add explicit cases for:

- missing/disabled configuration throws `A2AUnavailableError`;
- Agent Card discovery sees no compatible v1.0 interface and throws `A2AUnavailableError('a2a_v1_interface_required')`;
- 401/403 becomes `A2ARequestError` without including the bearer token;
- timeout aborts the SDK call and returns a recoverable failure;
- `INPUT_REQUIRED`, `AUTH_REQUIRED`, `FAILED`, `CANCELED`, and `REJECTED` are non-success results with the correct stored binding state;
- `../../src/server/store.ts` from a remote filename is materialized as `.roundtable/runs/a2a/task-1/store.ts`, not outside the A2A run directory;
- URL and raw parts are described in the transcript but are not downloaded or written;
- a response larger than 512 KiB is rejected as `a2a_artifact_too_large`.

- [ ] **Step 3: Run the adapter tests and confirm failure**

Run: `corepack pnpm vitest run tests/a2a-adapter.test.ts`

Expected: FAIL because `a2a-adapter.ts` is missing.

- [ ] **Step 4: Create an authenticated SDK client factory**

Define this testable boundary:

```ts
export interface A2AClientLike {
  getAgentCard(options?: RequestOptions): Promise<AgentCard>;
  sendMessageStream(
    request: SendMessageRequest,
    options?: RequestOptions,
  ): AsyncGenerator<StreamResponse, void, undefined>;
  cancelTask(request: CancelTaskRequest, options?: RequestOptions): Promise<Task>;
  getTask(request: GetTaskRequest, options?: RequestOptions): Promise<Task>;
}

export type CreatedA2AClient = {
  client: A2AClientLike;
  protocolVersion: string;
  tenant: string;
};
```

The production factory must use:

```ts
const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
  cardResolver: new DefaultAgentCardResolver({ fetchImpl: authenticatedFetch }),
  preferredTransports: ['JSONRPC', 'HTTP+JSON'],
});
const client = await new ClientFactory(options).createFromUrl(config.baseUrl, config.cardPath ?? undefined);
```

Attach `Authorization: Bearer <token>` both to Agent Card discovery and SDK `serviceParameters`. Verify the selected client reports protocol version `1.0` before sending the message.

- [ ] **Step 5: Implement `runOnA2A()`**

Use this signature:

```ts
export async function runOnA2A(
  input: {
    workspace: string;
    turnId: string;
    missionId: string;
    task: PlanTask;
    handoff: HandoffCardV2;
    handoffText: string;
    config: ResolvedA2ARemoteAgentConfig;
    timeoutMs?: number;
  },
  dependencies?: {
    createClient?: (config: ResolvedA2ARemoteAgentConfig) => Promise<CreatedA2AClient>;
  },
): Promise<AgentRunResult>;
```

For every stream response, reduce the output and persist the binding as soon as a remote task ID appears. After a terminal event, call `finishA2ATaskBinding()`. If the stream ends without a terminal event, call `client.getTask()` only if a task ID was observed; otherwise return `a2a_stream_ended_without_result`.

- [ ] **Step 6: Materialize accepted output under the A2A run directory**

Write accepted parts below:

```text
.roundtable/runs/a2a/<sanitized-plan-task-id>/<sanitized-filename>
```

Choose the primary result in this order: HTML, Markdown, JSON, plain text. Return remaining accepted parts through `AgentRunResult.files` so `artifactsFromRun()` preserves normal Roundtable artifact attribution. Serialize `application/json` with two-space indentation.

- [ ] **Step 7: Implement remote cancellation for a persisted binding**

```ts
export async function cancelA2ABinding(
  binding: A2ATaskBinding,
  config: ResolvedA2ARemoteAgentConfig,
  dependencies?: {
    createClient?: (config: ResolvedA2ARemoteAgentConfig) => Promise<CreatedA2AClient>;
  },
): Promise<void>;
```

Recreate the client with the binding's persisted `agentBaseUrl` and `agentCardPath`, while resolving the current token separately so endpoint edits cannot redirect cancellation for an already-running task. Call `client.cancelTask({ tenant: binding.remoteTenant, id: binding.remoteTaskId, metadata: { roundtableTurnId: binding.turnId } }, options)`, then persist the returned state. Never treat cancellation failure as permission to omit local interruption state.

- [ ] **Step 8: Run adapter tests and commit**

Run: `corepack pnpm vitest run tests/a2a-adapter.test.ts tests/a2a-task-store.test.ts tests/a2a-message-mapper.test.ts`

Expected: PASS.

```bash
git add src/server/actions/adapters/a2a-adapter.ts tests/a2a-adapter.test.ts
git commit -m "feat: execute remote A2A tasks"
```

---

### Task 5: Connect A2A to Roundtable dispatch and interruption

**Files:**
- Modify: `src/server/actions/agent-runner.ts`
- Modify: `src/server/actions/turns/dispatch.ts`
- Modify: `src/server/types.ts`
- Create: `tests/a2a-dispatch.test.ts`
- Modify: `tests/turn-actions.test.ts`
- Modify: `tests/settings-actions.test.ts`

**Interfaces:**
- Consumes: `runOnA2A()`, `cancelA2ABinding()`, `resolveA2ARemoteAgentConfig()`, `bindingsForTurn()`, `HandoffCardV2`, existing dispatch fallback semantics, and `interruptTurn()`.
- Produces: `normalizeAdapter('a2a')`, an A2A execution path in `runAgentTask()`, visible A2A remote metadata on `DispatchRecord`, and best-effort remote cancellation from the existing interrupt route.

- [ ] **Step 1: Write a failing adapter-selection test**

```ts
it('normalizes A2A without changing existing aliases', () => {
  expect(normalizeAdapter('a2a')).toBe('a2a');
  expect(normalizeAdapter('agent-to-agent')).toBe('a2a');
  expect(normalizeAdapter('openai')).toBe('openai-compat');
  expect(normalizeAdapter(undefined)).toBe('local-dispatch');
});
```

- [ ] **Step 2: Write failing dispatch tests**

Use an injectable A2A client factory or module mock to prove:

1. approving a turn with `agentAdapter: 'a2a'` passes the exact `HandoffCardV2` created by dispatch into the adapter;
2. successful remote HTML becomes a normal preview artifact and keeps the remote task/context IDs on the task's `DispatchRecord`;
3. an unavailable endpoint falls back to `local-dispatch` with a visible `thinking_delta`, matching existing MiniMax/OpenAI behavior;
4. an A2A terminal failure enters the existing scheduler failure/fixer path instead of being reported as success;
5. local adapters still receive the unchanged Markdown `handoffContext`.

- [ ] **Step 3: Run dispatch tests and confirm failure**

Run: `corepack pnpm vitest run tests/a2a-dispatch.test.ts tests/turn-actions.test.ts`

Expected: FAIL because `a2a` is not a recognized adapter.

- [ ] **Step 4: Extend the runner input without flattening A2A context**

Add these optional fields to `runAgentTask()` input:

```ts
handoffCard?: HandoffCardV2;
missionId?: string;
```

Extend `normalizeAdapter()`'s return type with `'a2a'`, recognize `a2a` and `agent-to-agent`, resolve the target remote by `agentForTask(input.task).id`, and call `runOnA2A()`. Throw `A2AUnavailableError('a2a_remote_not_configured:<agent-id>')` when no enabled remote exists.

- [ ] **Step 5: Pass structured handoffs from dispatch**

Change every workflow `runAgentTask()` call in `src/server/actions/turns/dispatch.ts` to pass:

```ts
handoffCard,
missionId: handoffCard.missionId,
```

Keep passing `handoffContext` for all adapters. The A2A adapter uses both parts; existing adapters ignore the structured card.

- [ ] **Step 6: Add explicit A2A fallback and remote metadata**

Catch `A2AUnavailableError` and `A2ARequestError` alongside existing opt-in adapter errors. Keep the visible fallback event and do not include base auth headers or tokens in its message.

Extend `AgentRunResult` and `DispatchRecord` with optional redacted metadata:

```ts
remote?: {
  protocol: 'a2a';
  taskId: string;
  contextId: string | null;
  protocolVersion: string;
  agentBaseUrl: string;
};
```

Copy this metadata into the scheduler record only after it has been returned by the adapter. Do not alter existing records that lack it.

- [ ] **Step 7: Cancel active A2A tasks before marking a turn interrupted**

Add:

```ts
export async function cancelA2ATasksForTurn(turnId: string): Promise<Array<{
  planTaskId: string;
  canceled: boolean;
  error: string | null;
}>>;
```

Load non-terminal bindings, resolve each binding's agent configuration, call `cancelA2ABinding()` in parallel with `Promise.allSettled()`, and redact errors. `interruptTurn()` must await this best-effort cancellation before it sets `dispatchStage: 'interrupted'`. Cancellation failures must not prevent the local turn and Mission from reaching the existing interrupted/failed state.

- [ ] **Step 8: Run dispatch, cancellation, and regression tests**

Run: `corepack pnpm vitest run tests/a2a-dispatch.test.ts tests/turn-actions.test.ts tests/dispatch-repair.test.ts tests/scheduler.test.ts tests/workflow.test.ts`

Expected: PASS, including review-to-fixer behavior and non-A2A adapters.

- [ ] **Step 9: Commit dispatch integration**

```bash
git add src/server/actions/agent-runner.ts src/server/actions/turns/dispatch.ts src/server/types.ts tests/a2a-dispatch.test.ts tests/turn-actions.test.ts tests/settings-actions.test.ts
git commit -m "feat: dispatch Roundtable tasks over A2A"
```

---

### Task 6: Document, verify, and smoke-test the complete adapter

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `tests/a2a-adapter.test.ts`
- Modify: `tests/a2a-dispatch.test.ts`

**Interfaces:**
- Consumes: the completed A2A settings, adapter, mapper, store, dispatch, and cancellation behavior.
- Produces: reproducible local setup instructions, a documented protocol boundary, and final repository-wide verification evidence.

- [ ] **Step 1: Add an SDK-boundary smoke test**

In `tests/a2a-adapter.test.ts`, stub `fetch` with an Agent Card response and a JSON-RPC/SSE response captured in the official v1.0 shape. Use the real `ClientFactory`, `DefaultAgentCardResolver`, and transport implementation rather than the fake client for this one test. Assert:

- discovery requests `/.well-known/agent-card.json`;
- both discovery and message calls receive the configured Authorization header;
- the SDK sends `A2A-Version: 1.0`;
- the stream produces one remote binding and one Roundtable artifact;
- serialized requests do not use the legacy v0.3 `message/send` method name.

- [ ] **Step 2: Run the SDK smoke test alone**

Run: `corepack pnpm vitest run tests/a2a-adapter.test.ts -t "uses the official SDK transport"`

Expected: PASS without access to an external network service.

- [ ] **Step 3: Document configuration and behavior**

Add an `a2a` row to the README adapter table and a dedicated section showing:

```bash
ROUNDTABLE_AGENT_ADAPTER=a2a
ROUNDTABLE_A2A_URL_ATLAS=https://atlas-agent.example
ROUNDTABLE_A2A_TOKEN_ATLAS=replace-with-remote-agent-token
ROUNDTABLE_A2A_CARD_PATH_ATLAS=/.well-known/agent-card.json
```

State explicitly that:

- Settings UI configuration overrides environment values for the same seat;
- remote task IDs are mapped to Roundtable task IDs rather than reused;
- only structured/text context is sent in the first release;
- remote output is sandboxed below `.roundtable/runs/a2a/`;
- inbound A2A server support and remote source-patch application are outside this release.

Mirror the commented variables in `.env.example` without putting a real token in the file.

- [ ] **Step 4: Run focused A2A verification**

Run: `corepack pnpm vitest run tests/a2a-config.test.ts tests/a2a-message-mapper.test.ts tests/a2a-task-store.test.ts tests/a2a-adapter.test.ts tests/a2a-dispatch.test.ts`

Expected: PASS.

- [ ] **Step 5: Run full repository verification**

Run: `corepack pnpm test`

Expected: PASS.

Run: `corepack pnpm typecheck`

Expected: PASS.

Run: `corepack pnpm lint`

Expected: PASS with no new warnings.

Run: `corepack pnpm build`

Expected: Next.js production build completes successfully.

- [ ] **Step 6: Check that secrets and unsafe URIs are absent from tracked output**

Run: `rg -n "remote-secret|replace-with-remote-agent-token|workspace://|chat://|turn://" src/server/actions/a2a tests/a2a-* README.md .env.example`

Expected: no real secret appears; URI occurrences are limited to tests/documentation that assert those schemes are not transmitted.

- [ ] **Step 7: Review the final diff against the protocol reference**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git diff --stat main...HEAD`

Expected: changes are limited to the files named in this plan.

Compare the request fields, task states, Agent Card interface selection, and cancellation request against:

- `../A2A/specification/a2a.proto`
- `../A2A/docs/specification.md`
- `../A2A/docs/topics/streaming-and-async.md`

- [ ] **Step 8: Commit documentation and verification coverage**

```bash
git add .env.example README.md tests/a2a-adapter.test.ts tests/a2a-dispatch.test.ts
git commit -m "docs: explain Roundtable A2A integration"
```

---

## Definition of Done

- Selecting `a2a` dispatches each task to the configured remote endpoint for that Roundtable seat.
- Agent Card discovery and JSON-RPC/SSE communication use the official v1.0 SDK.
- Remote task/context IDs are persisted and visible as redacted dispatch metadata.
- Remote status and artifact updates appear through existing Roundtable events and artifacts.
- Remote text artifacts are materialized only below `.roundtable/runs/a2a/<task-id>/`.
- Interrupting a turn attempts remote cancellation and always completes the local interruption flow.
- Missing/unavailable remote configuration produces a visible fallback to `local-dispatch`.
- Settings/API responses, events, bindings, logs, and tests never expose the bearer token.
- Existing local, CLI, E2B, MiniMax, and OpenAI-compatible paths still pass their regression tests.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` all pass.

## Explicit Follow-up Projects

These are intentionally excluded so this implementation stays independently testable:

1. Expose Roundtable itself as an inbound A2A server with a public Agent Card and high-level skills such as `feature-builder`, `research`, and `review`.
2. Add signed artifact upload/download URLs for files that cannot fit safely in message parts.
3. Accept remote unified diffs or Git branches, validate them in an isolated worktree, and apply them to the user workspace after review.
4. Add durable background workers and push notifications for remote tasks that outlive the Next.js process.
5. Verify signed Agent Cards and support tenant-specific OAuth flows.
