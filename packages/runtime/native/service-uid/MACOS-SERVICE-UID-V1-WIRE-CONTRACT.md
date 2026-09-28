# macOS service-UID v1 wire contract and self-test plan

> **Implementation status — transport and validation skeleton only.**
> `protocol-v1.[ch]`, `transport-v1.[ch]`, response codecs, operation client,
> lifecycle FSM, broker core, and the status listener exist. The listener has no
> production workload callbacks or live service-UID attestation yet; its
> uninstalled self-tests are development evidence and do not prove a Phase 4
> gate. `protocol.c`, `broker.c`, and `client.c` remain the incompatible
> `bootstrap-probe-v0` and are not part of v1.

## One contract, two implementations

The sole executable definition of the logical v1 protocol is
[`../../src/macos-service-uid-protocol.ts`](../../src/macos-service-uid-protocol.ts).
It fixes these identities:

- backend/contract: `macos-service-uid-v1`;
- protocol version: unsigned integer `1`;
- reserved Mach service: `com.roundtable.runtime.service-uid-v1`;
- operations: `status`, `prepare`, `start`, `stop`, and `cleanup`;
- maximum active executions: `1`;
- secret transport: `inherited-fd-once`.

A native v1 implementation MUST implement those exact logical objects. It MUST
NOT introduce a second C-only spelling, version, or operation set. In
particular, the bootstrap probe's snake_case keys, `ping`, security-mode string,
and peer-audit-session response fields are not aliases and must be rejected.

Before a `prepare` callback can consume the inherited secret FD, the broker
implementation must authorize the opaque workspace grant against its
execution/staging registry. A denied grant is a `workspace_grant_invalid`
failure and the descriptor is closed; syntactic parsing alone is insufficient.
The broker must also authorize the requested workload/provider against its
capability policy before invoking the workload callback. A denied workload is a
`workload_invalid` failure with the descriptor closed.

Until the machine-readable corpus described below lands, the TypeScript parser's
exact-key checks and value validators are normative. Contract changes require a
new backend/version; they must not silently widen v1.

## XPC mapping

The transport adapter maps each TypeScript property name to an identically named
XPC dictionary key. Strings use `XPC_TYPE_STRING`, booleans use
`XPC_TYPE_BOOL`, non-negative integer fields use `XPC_TYPE_UINT64`, nested
records use `XPC_TYPE_DICTIONARY`, and the two `null` values in an idle seat use
`XPC_TYPE_NULL`. Unknown keys, missing keys, signed/unsigned type confusion,
lossy numeric conversion, embedded NULs, and out-of-range values fail closed.

The exact logical request key sets are:

| Type | Exact keys |
|---|---|
| `status` | `backend`, `protocolVersion`, `requestId`, `type` |
| `prepare` | base + `leaseId`, `executionId`, `workload`, `workspaceGrant`, `secretChannel` |
| `start` | base + `leaseId`, `executionId`, `preparationId` |
| `stop` | base + `leaseId`, `executionId`, `reason` |
| `cleanup` | base + `leaseId`, `executionId`, `disposition` |

Nested request records are also exact:

- `workload` is either `{ kind: "provider", provider: "codex" |
  "claude-code" }` or `{ kind: "fixture", fixture: "lifecycle-v1" }`;
- `workspaceGrant` is `{ grantId, revision }`, where revision is `1` through
  `2147483647`;
- `secretChannel` is `{ channelId, transport: "inherited-fd", fdIndex: 0,
  consumption: "once" }`;
- stop reason is `requested`, `shutdown`, or `timeout`; cleanup disposition is
  exactly `terminate-and-scrub`.

Every response has `backend`, `protocolVersion`, `requestId`,
`serviceInstanceId`, `brokerUid`, `executionUid`, `type`, and `ok`. A failure
adds exactly `error` and `seat`. Successes add the exact fields enforced by
`parseMacOsServiceUidBrokerResponse`: status reports `maxConcurrency`,
`secretTransport`, and `seat`; the four lifecycle responses report their
operation-specific lease, process, termination, and cleanup facts. A seat is
exactly `{ state, leaseId, executionId }`; idle uses two null IDs, and every
other state uses two valid IDs.

The prepare transport carries one additional XPC object named
`secretChannelFd` with type `XPC_TYPE_FD`. The adapter removes it before passing
the logical request to `parseMacOsServiceUidBrokerRequest`, duplicates it into
the `MacOsServiceUidBrokerTransfer` shape, verifies its channel against
`secretChannel.channelId`, and closes every duplicate on all paths. No FD is
accepted for another operation, and no secret bytes, descriptor number, argv,
environment, path, command, UID, signal target, or launchd label may appear in
the logical payload.

Identifiers use the parser's ASCII allowlist and length bounds. UIDs must be
integers from `0` through `2147483647`. `serviceInstanceId` is minted when the
service process starts and is stable for that process lifetime; every response
must match the instance and fixed UIDs obtained during connection attestation.

## Attestation is not broker-supplied data

`MacOsServiceUidBroker.attestPeer()` is a trusted adapter API, not an XPC method
and not a dictionary returned by the broker. In production the adapter derives
the connected peer's effective UID and audit token from XPC, evaluates the
configured designated code requirement with Security.framework, and supplies
the configured fixed execution UID. Only then may it construct peer evidence
with:

- `deployment: "production"`;
- `authentication: { kind: "xpc-audit-token" }`;
- `codeIdentity: { status: "verified", teamIdentifier,
  designatedRequirement }`.

The adapter must compare status identity fields with that evidence. It must
never trust `authentication`, Team ID, requirement text, broker UID, or
execution UID merely because an XPC payload states them. Development
`development-test-double` evidence remains fixture-only and can never enable a
real provider.

## Executable cross-language self-test plan

Implement the following in order; each item is a blocking acceptance criterion
for the next one.

1. Add one reviewed machine-readable corpus at
   `packages/runtime/contracts/macos-service-uid-v1/contract.json`. It records
   every exact key set, XPC primitive type, bound, enum, positive vector, and
   negative vector. Its SHA-256 is embedded in generated artifacts.
2. Add a deterministic generator that emits both a TypeScript fixture module and
   `native/service-uid/generated/macos-service-uid-v1-contract.h`. CI regenerates
   into a temporary directory and byte-compares both outputs; hand-maintained
   copies or drift fail the job.
3. Run the same corpus through the current TypeScript parsers and a new native
   v1 codec self-test. Each side must accept every positive vector and reject
   every negative vector, including extra/missing fields, integer type
   confusion, malformed IDs, every bootstrap-probe-v0 shape, and an FD on the
   wrong operation. Both print the same corpus hash.
4. Add a test-signed macOS integration harness that uses the production adapter
   code path and the reserved v1 Mach service. It sends `status`, performs peer
   attestation from the live connection, and proves that payload identity cannot
   replace audit-token/code-signing evidence. This milestone is **status and
   attestation only** and must keep real-provider capability disabled.
5. Extend that same harness, without changing v1, to execute
   `prepare -> start -> stop -> cleanup`. It transfers a real one-shot FD,
   checks close-on-success and close-on-error, validates replay/idempotency and
   lease binding, proves tree termination plus UID-wide zero-process state, and
   verifies secret residue is absent. Only after this passes may the adapter
   advertise lifecycle support.
6. Run the privileged cross-UID attack canaries and one credentialed real
   provider vertical slice. These are separate runtime gates; a contract test,
   native build, signature check, or successful status response cannot replace
   them.

The current regression checks are intentionally only the naming boundary and
can be run with:

```text
corepack pnpm --filter @roundtable/runtime exec vitest run \
  tests/build-service-uid-xpc.test.ts \
  tests/macos-service-uid-control-plane.test.ts

corepack pnpm --filter @roundtable/runtime \
  build:native:service-uid-bootstrap-probe:dev
```

The first command proves the two contract families reject each other. On macOS,
the second compiles and runs the probe parser self-test, signature checks, and
isolation-canary parser self-test. Neither command claims Phase 4 completion.

| Evidence | What it proves | Phase 4 gate? |
|---|---|---|
| bootstrap-probe-v0 parser/build/ping | build, XPC reachability, narrow peer setup | No |
| v1 shared-corpus self-tests | TS/native schema parity | No |
| v1 live status + transport attestation | live identity and status interop | No |
| full v1 lifecycle + one-shot FD integration | lifecycle wire behavior | Not alone |
| privileged canaries + credentialed vertical slice | required runtime isolation outcome | Yes, with all prior evidence |
