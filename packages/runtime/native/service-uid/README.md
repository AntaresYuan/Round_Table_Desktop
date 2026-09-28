# macOS service-UID bootstrap probe v0

> **Not a Phase 4 gate:** the native broker/client in this directory implement
> only `bootstrap-probe-v0`. They do not implement `macos-service-uid-v1`, the
> service-UID lifecycle, descriptor transfer, or production peer attestation.

The probe exists to exercise a narrow XPC connection and code-signing setup
before the real lifecycle transport is implemented. Its identity is deliberately
disjoint from the TypeScript contract:

- contract: `bootstrap-probe-v0`;
- Mach service: `com.roundtable.runtime.service-uid-bootstrap-probe-v0`;
- exact snake_case XPC dictionaries with `probe_contract`, `probe_version`,
  `request_id`, and only the `ping`/`status` operations;
- output artifacts and success lines contain `bootstrap-probe-v0` and state that
  they are not a Phase 4 gate.

Both peers install a code-signing requirement before resuming their XPC
connection. The broker binds a development-harness connection to its configured
login-user EUID and audit session, then validates the audit-token-backed dynamic
code identity on every request. Unknown fields fail closed. The root probe does
not launch a shell, execute a provider, parse repository data, or apply a diff.

`--allowed-client-euid` is accepted only by a development harness. A production
build never accepts identity configuration through argv and currently exits
fail-closed when run as root because an installer-owned production identity
source is not implemented. The probe does not install or register a
LaunchDaemon.

## Build modes

Use `packages/runtime/scripts/build-service-uid-xpc.mjs` with an explicit mode:

```text
node packages/runtime/scripts/build-service-uid-xpc.mjs \
  --mode development-adhoc \
  --output-dir /tmp/roundtable-service-uid-bootstrap-probe-v0
```

Development mode compiles identifier-only peer requirements and creates ad-hoc
signatures. Those artifacts are test-only and must never be shipped.

`development-signed` requires an explicit local test identity and explicit
requirements for both peers. Each requirement must bind the exact probe peer
identifier and the SHA-1 hash of the signing leaf certificate; binding only a
shared root CA is rejected. It can exercise a controlled, privileged bootstrap
harness, but neither its build nor a successful ping/status exchange is a Phase
4 gate.

Production mode requires all of the following explicit inputs and fails before
compilation if any is missing or weak:

- `--signing-identity`
- `--team-identifier`
- `--broker-accepts-client-requirement`
- `--client-accepts-broker-requirement`

Each production requirement must exactly match the fixed probe peer identifier,
`anchor apple generic`, and the configured Team ID certificate clause. The build
also verifies Hardened Runtime and the signed artifact's Team ID. These checks
protect the probe artifacts; they do not make the production probe launchable or
implement the v1 service. Production installation, LaunchDaemon approval,
notarization, and upgrade/uninstall behavior remain a separate Phase 7 gate.

The separately built isolation canary remains a test-only component documented
in [ISOLATION-CANARY.md](./ISOLATION-CANARY.md). Compiling it or passing its
parser self-test is not cross-UID evidence; only the privileged harness and
host-side observations can satisfy that canary.

`protocol-selftest.c` exercises the probe's exact parser without root access or
a registered Mach service, including rejection of a TypeScript v1-shaped
request. The only planned v1 wire contract and its executable cross-language
self-test milestones are documented in
[MACOS-SERVICE-UID-V1-WIRE-CONTRACT.md](./MACOS-SERVICE-UID-V1-WIRE-CONTRACT.md).
