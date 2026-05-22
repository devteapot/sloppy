# Launch-scope resume Session replaces global active Session

## Status

Accepted.

## Context

The TUI should behave like a normal CLI when packaged: running `sloppy` in a
directory opens the TUI for that directory. During development, `bun run tui`
keeps the same behavior through the source entrypoint.

The runtime also needs to support multiple concurrent TUIs connected to the
same supervisor. A single supervisor-wide `active_session_id` would make one
client's switch unexpectedly move every other client. It would also make
`sloppy --continue` ambiguous: "continue" should mean the launch scope's
remembered resume target, not whichever session another client most recently
selected.

## Decision

The Session supervisor no longer presents one global `active_session_id` as if
every UI must follow it. Multiple clients can select different Sessions
concurrently, so the supervisor records a Launch-scope resume Session
(`resume_session_id`) for `sloppy --continue` while each client keeps its own
selected Session through its Supervisor client lease.

The packaged `sloppy` launcher resolves the launch scope from
`realpath(process.cwd())`, starts or reuses that scope's managed supervisor,
creates a fresh Session by default, and selects the launch-scope resume Session
only when called with `--continue`.

Supervisor sockets, discovery, and logs are runtime process files. Durable
Session snapshots and the launch-scope registry live in the configured Session
persistence directory. Stop Session ends a live Session process but keeps its
snapshot and registry record restorable. Archive and Delete are separate future
operations.

## Consequences

- Plain `sloppy` starts fresh work in the current launch scope while keeping old
  Sessions switchable.
- `sloppy --continue` has deterministic behavior and fails clearly in a clean
  launch scope with no previous Session.
- Switching inside one TUI does not disturb another TUI connected to the same
  supervisor.
- Stop Session can be guarded by connection-bound leases so a client cannot
  stop a Session another connected client has selected.
- The supervisor remains an agnostic SLOP provider for Session lifecycle
  bookkeeping; managed launch, auto-close, and cwd scope choice stay in the
  launcher layer.
