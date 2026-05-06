# Runtime Operator Runbook

This runbook is for local production-style operation of the Sloppy runtime. It
keeps operational checks outside the core runtime: use commands, public SLOP
state, persisted envelopes, and audit logs to verify behavior.

## Preflight

Run the checked-in preflight before a release, handoff, or production-style
runtime session:

```sh
bun run preflight
```

This runs lint, root TypeScript checks, TUI TypeScript checks, the full Bun test
suite, and the build/declaration emit. Use narrower commands only while
iterating on a focused change.

## Environment Doctor

Run the doctor before a live smoke or long-running session:

```sh
bun run runtime:doctor \
  --workspace <workspace-root> \
  --litellm-url <openai-compatible-base-url> \
  --acp-adapter <adapter-id> \
  --event-log <events-jsonl-path> \
  --socket <session-or-supervisor-socket-path>
```

To migrate accepted legacy state files after reviewing a warning, rerun with:

```sh
bun run runtime:doctor -- --workspace <workspace-root> --migrate-persistence
```

The migration path creates `.bak` copies next to each legacy file before
rewriting session snapshots or meta-runtime state with the current schema
envelope.

Expected production posture:

- `llm-profile`: `ok` means the active model profile is ready. `warning` means
  the active profile relies on a process environment variable. `error` means no
  model turn should start until credentials or external auth are fixed.
- `workspace-paths`: `ok` means the filesystem root is a readable directory and
  the terminal cwd, when the terminal provider is enabled, is readable and
  contained within that filesystem root.
- `subprocess-commands`: `ok` means the requested ACP adapter command and MCP
  stdio servers configured to connect on start resolve to executable commands.
  On-demand MCP servers are not treated as startup failures.
- `litellm`: `ok` means the OpenAI-compatible router answered `/models` with the
  configured API key environment variable, when present.
- `acp`: `ok` means the requested ACP adapter completed startup.
- `acp-boundary`: `ok` means the adapter uses Sloppy's minimal subprocess
  environment and declares capabilities. It is not an OS sandbox.
- `audit-log`: `ok` means the configured path, or `SLOPPY_EVENT_LOG`, can be
  opened for append after creating its parent directory.
- `session-socket`: `ok` means the socket parent directory can be created and
  written. `warning` means a socket already exists at that path, usually because
  another live session is using it or stale cleanup is needed. `error` means a
  non-socket file blocks the path or the directory is unusable.
- `session-persistence` and `meta-runtime-persistence`: `ok` means persisted
  files use current schema envelopes. `warning` means legacy raw files will be
  accepted but should be migrated with `--migrate-persistence` before handoff.
  `error` means startup should stop before loading malformed or unsupported
  state.

## Smoke

Use smoke runs to verify real runtime wiring after the doctor passes:

```sh
bun run runtime:smoke
bun run runtime:smoke -- --mode native
bun run runtime:smoke -- --mode acp --acp-adapter <adapter-id>
```

Provider smoke verifies meta-runtime routing through SLOP providers without a
live model. Native and ACP modes verify the selected model path.

## Audit Log

Set an event log path for any run that needs an operator trail:

```sh
SLOPPY_EVENT_LOG=/var/tmp/sloppy-events.jsonl bun run session:serve
```

The runtime writes JSONL lifecycle events such as turn start/completion/failure,
queued messages, goal status changes, approval waits, tool calls, provider task
transitions, topology proposals, and route dispatch. Treat the log as an audit
trail, not as the source of truth for live UI state; current state remains in
the public session provider.

## Restart Recovery

Session snapshots are persisted as versioned envelopes when
`session.persistSnapshots=true`. On startup, a stale in-flight turn is recovered
as explicit public state:

- `/session.recovered_after_restart=true`
- `/turn.state="error"` with a message that the turn could not be resumed
- pending approvals become `expired` and lose approve/reject affordances
- running tasks become `superseded`, lose cancel affordances, and keep an error
  explaining the restart
- an active goal becomes `paused` with `update_source="runtime"`
- queued messages remain visible under `/queue` and can be cancelled or drained
  normally after a fresh turn

Do not infer hidden continuation after restart. Resume or recreate work through
the public `/goal`, `/queue`, and `/composer` affordances.

## Live Session Checks

For a running session, inspect public state instead of runtime internals:

- `/session`: status, restart-required flags, persistence path, recovery flags
- `/llm`: active profile, credential source, secure-store status
- `/turn`: current turn phase and cancel affordance, when active
- `/goal`: persistent objective status and usage accounting
- `/queue`: FIFO user and goal messages waiting for the active turn
- `/approvals`: pending and resolved approval state
- `/tasks`: downstream async task state
- `/apps`: external and built-in provider attachment visibility, including
  explicit `reconnect_provider`, `query_provider`, and `invoke_provider`

The TUI and third-party consumers should use the same public session provider
boundary.

## External Providers

Disconnected external providers should stay visible in `/apps` with status and
last error. Use `/apps.reconnect_provider` to retry deliberately. Avoid adding
background reconnect loops to core unless a provider can expose that behavior as
ordinary SLOP state.

MCP and A2A are interoperability providers. Keep their behavior behind opt-in
provider config, public SLOP state, and the same approval policy used for other
affordances.
