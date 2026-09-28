# Cross-UID isolation canary

`isolation-canary.c` is a test-only, low-privilege probe for the Phase 4
service-UID boundary. It is not a broker operation and it must never run as
root or as the login user. It contains no shell and exposes no general command,
path, signal, UID, or launchd proxy.

The launchd-owned canary process is only a trusted trampoline. It starts the
actual worker with `TASK_BOOTSTRAP_PORT` set to `MACH_PORT_NULL` through
`posix_spawnattr_setspecialport_np`; the worker refuses to probe unless it can
independently observe that null port. This prevents the worker and its fixed
`launchctl` child from inheriting the system LaunchDaemon bootstrap capability.
Directly supplying the internal worker flag while retaining a bootstrap port
fails with `invalid_bootstrap_context`.

The executable accepts one exact, ordered argument schema:

```text
--host-pid PID
--host-uid UID
--launchd-label com.roundtable.runtime.isolation-canary.host.RUN_ID
--unix-socket ABSOLUTE_PATH
--host-canary ABSOLUTE_PATH
--staging-directory CANONICAL_ABSOLUTE_PATH
--run-id 32_LOWERCASE_HEX_BYTES
```

Unknown, missing, duplicate, reordered, relative, traversing, noncanonical
numeric, oversized, or control-character-bearing values are rejected. The
launchd label is derived from the run ID, so the probe cannot target an
arbitrary job. Its only subprocess is the fixed invocation
`/bin/launchctl kickstart -k gui/UID/LABEL`, with a fixed minimal environment
and a two-second timeout.

The privileged integration harness must establish and independently observe
all fixtures before invoking the canary:

- `PID` is a live, dedicated host-UID process with a harmless `SIGUSR1`
  handler. The harness checks that it remains alive and received no signal.
- The GUI-domain job exists under the derived dedicated label. The harness
  records its PID/generation and proves the attempted kickstart did not occur.
- The Unix socket is live beneath a host-only directory and its listener
  records whether a connection was accepted.
- The host canary is a regular host-only file that exists before the test.
- The staging directory is canonical, owned by the service UID, and mode
  `0700`. A successful probe leaves exactly
  `.roundtable-service-uid-canary-RUN_ID`, mode `0600`, with fixed content for
  host-side inspection and cleanup.

The bounded one-line JSON result uses schema version 1. Exit `0` and result
`passed` require explicit permission denial for procargs, signal, launchd
control, socket connection, and host-file read, plus a successful staging
write. Any permitted boundary action exits `10` with `boundary_violation`.
Missing, raced, ambiguous, or incorrectly permissioned fixtures exit `11`
with `inconclusive`. Invalid invocation and execution context use exits `64`
and `65`; an inherited bootstrap capability uses exit `66`. On the validated
macOS host, null-bootstrap `launchctl` rejects the fixed kickstart with exit
`141` and `Reentrancy avoided`; the canary accepts that pair as denial only
after the worker has proved its bootstrap port is null.

`isolation-canary-selftest.c` validates the parser without root or a service
account. A parser self-test or successful compilation is not evidence that the
cross-UID Phase 4 gate has passed; only the privileged harness and its
host-side observations can make that claim.
