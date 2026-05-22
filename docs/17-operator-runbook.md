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

Expected production posture:

- doctor output combines core runtime checks with first-party plugin
  contributions. Provider-specific readiness checks should live with their
  plugin, while the doctor core handles generic profile, socket, audit, and
  persistence checks plus aggregation of plugin-provided subprocess probes.
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
  files use current schema envelopes. `error` means startup should stop before
  loading malformed or unsupported state.

## Smoke

Use smoke runs to verify real runtime wiring after the doctor passes:

```sh
bun run runtime:smoke
bun run runtime:smoke -- --mode native
bun run runtime:smoke -- --mode acp --acp-adapter <adapter-id>
```

Provider smoke verifies meta-runtime routing through SLOP providers without a
live model. Native and ACP modes verify the selected model path.

## Managed TUI Supervisor

The packaged interactive entrypoint is:

```sh
sloppy
```

In a source checkout, use:

```sh
bun run tui
```

The launcher resolves `realpath(process.cwd())` into a launch scope, starts or
reuses that scope's managed supervisor, creates a fresh session by default, and
attaches the TUI to that session's ordinary provider socket. Use `sloppy
--continue` to select the launch-scope resume session instead. In a clean launch
scope with no previous session, `--continue` fails at the CLI level.

Supervisor sockets, discovery files, and logs live under the process runtime
directory: `SLOPPY_RUNTIME_DIR/supervisors`,
`$XDG_RUNTIME_DIR/sloppy/supervisors`, `$TMPDIR/sloppy/supervisors`, or
`/tmp/slop/supervisors`. Durable session snapshots and the launch-scope
registry live in the configured `session.persistenceDir` when
`session.persistSnapshots=true`; by default that is `.sloppy/sessions` under the
configured filesystem root.

Multiple TUIs can connect to the same supervisor and select different sessions.
Each TUI registers a supervisor client lease, so Stop Session is rejected when
another connected TUI has selected the target session. After all leases
disconnect, a managed supervisor auto-closes only when no live session has a
core or plugin-provided auto-close blocker. Core blockers are active turns,
approval waits, queued messages, pending approvals, and running tasks; plugin
blockers must be declared by the session plugin.

## Live Headless E2E

Run the opt-in live headless CLI e2e when you want the real `-p` path, the
configured LLM, and provider tools in one check:

```sh
SLOPPY_RUN_LIVE_E2E=1 bun test tests/cli-headless-e2e.test.ts
```

The test creates an ignored `test-artifacts/` marker file, runs
`bun run src/cli.ts -p "<prompt>"`, asks the configured model to read that file
through the filesystem provider, and verifies both the marker in stdout and the
filesystem tool events in the audit log. It is not part of default preflight
because it can use network and model quota.

Run the live source-view edit benchmark when you need to compare model behavior
between exact legacy edits and source-version line-range edits:

```sh
bun run benchmark:headless-view-edits -- --dry-run
SLOPPY_RUN_LIVE_BENCHMARK=1 bun run benchmark:headless-view-edits
SLOPPY_RUN_LIVE_BENCHMARK=1 bun run benchmark:headless-view-edits -- --cases all
```

The benchmark uses the same headless CLI path, creates isolated temp
workspaces, instructs the model to use either `edit` or `edit_range`, and
records stdout/stderr, CLI metrics, runtime event logs, validation, and final
files under `test-artifacts/headless-view-edits/<timestamp>/`.

## Audit Log

Set an event log path for any run that needs an operator trail:

```sh
SLOPPY_EVENT_LOG=/var/tmp/sloppy-events.jsonl bun run session:serve
```

`bun run src/cli.ts -p "<prompt>"` also honors `SLOPPY_EVENT_LOG`. The CLI uses
an ephemeral in-process session provider, so its audit entries come from the
same session-runtime lifecycle as `/composer`, `/turn`, `/usage`, `/activity`,
`/tasks`, and `/approvals`.

For a one-file summary of a single CLI run, set `SLOPPY_CLI_METRICS_PATH`.
Metrics are best-effort diagnostics; write failures are warnings and never
change the CLI exit code.

The runtime writes JSONL lifecycle events such as turn start/completion/failure,
queued messages, goal status changes, approval waits, tool calls, provider task
transitions, topology proposals, and route dispatch. Treat the log as an audit
trail, not as the source of truth for live UI state; current state remains in
the public session provider.

Thinking output is public transcript state, but audit logs should not retain
the Thinking-output text by default. Log that Thinking output occurred, plus
provider, block id, token count, and text length when useful; redact or omit the
text itself unless an explicit operator debug mode is added.

## Restart Recovery

Session snapshots are persisted as versioned envelopes when
`session.persistSnapshots=true`. On startup, a stale in-flight turn is recovered
as explicit public state:

- `/session.recovered_after_restart=true`
- `/turn.state="error"` with a message that the turn could not be resumed
- pending approvals become `expired` and lose approve/reject affordances
- running tasks become `superseded`, lose cancel affordances, and keep an error
  explaining the restart
- an active extension-backed goal becomes `paused` with
  `update_source="runtime"` in both `/goal` and `/extensions/goal`
- queued messages remain visible under `/queue` and can be cancelled or drained
  normally after a fresh turn

Do not infer hidden continuation after restart. Resume or recreate work through
the public `/goal`, `/queue`, and `/composer` affordances.

Stopped supervised sessions remain in the session registry as dormant records.
Selecting a dormant record restores a new live session process from its snapshot
and then applies the same stale-turn recovery rules above. Archive and Delete
are intentionally separate future operations: Archive should remove a session
from normal resume/switch lists while retaining history, and Delete should
permanently remove both registry entry and snapshot.

## Live Session Checks

For a running session, inspect public state instead of runtime internals:

- `/session`: status, restart-required flags, persistence path, recovery flags
- `/llm`: active profile, credential source, secure-store status
- `/turn`: current turn phase and cancel affordance, when active
- `/goal`: persistent objective status and usage accounting
- `/extensions`: generic session extension metadata and cleanup state
- `/queue`: FIFO user and goal messages waiting for the active turn
- `/approvals`: pending and resolved approval state
- `/tasks`: downstream async task state
- `/apps`: external and first-party plugin provider attachment visibility, including
  explicit `load_provider`, `reload_provider`, `query_provider`, and `invoke_provider`

The TUI and third-party consumers should use the same public session provider
boundary.

For a running supervisor, inspect public supervisor state instead of process
internals:

- `/session`: launch-scope key/root, resume session id/socket, registry path,
  live/session counts, client lease count, and auto-close status
- `/sessions`: session records with runtime status, resume marker, scope
  metadata, live socket when available, and compact turn/goal/queue/task summary
- `/scopes`: configured workspace/project scopes that can launch new sessions

The supervisor owns lifecycle bookkeeping only. It should not be used as a
hidden scheduler or provider-rewiring layer.

## External Providers

Disconnected external providers should stay visible in `/apps` with status and
last error. Use `/apps.load_provider` to retry deliberately, or `/apps.reload_provider`
to refresh a connected app. Avoid adding
background reconnect loops to core unless a provider can expose that behavior as
ordinary SLOP state.

MCP and A2A are interoperability providers. Keep their behavior behind opt-in
provider config, public SLOP state, and the same approval policy used for other
affordances.
