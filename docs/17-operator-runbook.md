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

For a Grok Build ACP check, configure the `grok agent stdio` adapter, then run
the doctor with `--acp-adapter grok`. Ensure either `XAI_API_KEY` is explicitly
allowed into the adapter environment or `grok login` has created a usable
cached token. ACP startup reports unmatched advertised authentication methods
as configuration errors. A subsequent session or routed smoke with an explicit
model also reports unavailable requested models rather than silently choosing a
different route.

## Smoke

Use smoke runs to verify real runtime wiring after the doctor passes:

```sh
bun run runtime:smoke
bun run runtime:smoke -- --mode native
bun run runtime:smoke -- --mode acp --acp-adapter <adapter-id>
```

Provider smoke verifies meta-runtime routing through SLOP providers without a
live model. Native and ACP modes verify the selected model path.

## WS Gateway

Local Session and Supervisor APIs use Unix sockets. The standalone WS gateway
relays the same typed protocol over one WebSocket port:

```sh
SLOPPY_WS_TOKEN=<random-token> \
  sloppy gateway --host 0.0.0.0 --port 8787 --token-env SLOPPY_WS_TOKEN
```

By default the gateway relays the managed supervisor of the current launch
scope (the same socket `sloppy` uses when started in that directory). Pass
`--supervisor-socket <path>` to relay a different supervisor. If the supervisor
socket does not exist yet the gateway warns and keeps retrying, so start order
does not matter.

Application clients use `/api/supervisor` and `/api/sessions/<session-id>`.
There are no legacy `/supervisor` or `/sessions/<session-id>` routes. Dialing a
dormant session closes the connection with code `4503` — select it through the
Supervisor API, then redial. The relay
is protocol-blind (one WebSocket frame per NDJSON line). Each remote client
holds its own upstream unix connection, so client-lease semantics are
preserved and remote client count maps one-to-one onto unix connections.

The listener defaults to `127.0.0.1`. Non-loopback upgrades are rejected
unless a token is configured, and browser upgrades also require at least one
`--allow-origin <origin>` entry. Prefer `--token-env` over `--token` for
shared systems so the token is not exposed in process arguments. If a proxy
terminates TLS or rewrites host/path, set `--public-url` to the externally
reachable `wss://...` URL.

A configured token is matched three ways: the `Authorization: Bearer <token>`
header, or the `token` / `access_token` query parameters. The query-parameter
forms exist for browser WebSocket clients, which cannot set headers, but URLs
end up in proxy and server logs — prefer the Bearer header wherever the client
allows it. The gateway logs a one-time warning when a query-parameter token is
used.

All remote-exposure policy lives in the gateway, not the session core.
Embedders can replace the token/origin/loopback policy entirely with
`startWsGateway({ authorize })`, which receives the raw upgrade `Request` and
returns a rejection `Response` or `null` to allow.

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
attaches the TUI to that session's typed API endpoint. Use `sloppy
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

A stopped Session may briefly appear as `stopping` while an active model or ACP
operation unwinds. It cannot be selected during this phase. Keep the supervisor
alive until the record becomes `dormant` (or disappears during full supervisor
shutdown); that transition confirms deferred cleanup and profile-lease release
completed.

## Headless Single-Shot

`sloppy -p "<prompt>"` runs one prompt through an in-process session and
exits. `--yolo` sets the session approval mode to `auto`, so auto-eligible
pending approvals (dangerous terminal commands, persistent writes, and the
like) resolve automatically instead of cancelling the turn. Explicit-only
items such as remote microphone egress remain manual. Use it only for workloads
where every auto-eligible affordance the model may invoke is acceptable
unattended.

## Config Layers

Session config merges `global` (`~/.sloppy/config.yaml`), `workspace`, and
`project` layers in that order; later layers override ordinary settings. The
first unique layer is the trusted LLM routing boundary: only it may define
`llm.endpoints` or legacy LLM `baseUrl`/`apiKeyEnv` fields. Workspace and
project layers may select profiles/models but cannot redirect trusted
credentials. Credential-bearing endpoints and `headerEnv` require HTTPS;
plain HTTP is limited to explicit no-auth endpoints. Nested
records merge key-by-key, but **arrays replace wholesale** — a project-level
list (for example a `command` array or `envAllowlist`) replaces the workspace
list rather than appending to it. Keyed records such as `plugins.mcp.servers`
merge per server id, so adding a server in a project layer keeps the workspace
servers.

Profile saves rewrite only managed profile selection in the `llm` section of
the trusted home config; comments, endpoint routing, and unrelated sections are
preserved.

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

For a running session, inspect the typed Session snapshot instead of runtime
internals. It contains session/recovery metadata, LLM readiness, turn and goal
state, extensions, queue, approvals, tasks, connected apps, controls, and plugin
contributions. Use the corresponding typed commands for config reload, turn and
queue cancellation, approval resolution, task cancellation, provider
load/reload/inspection, and plugin actions.

The SLOP projection is reserved for agent context and connected dynamic
providers. It is not exposed as an alternate Session transport.

For a running supervisor, inspect the typed Supervisor snapshot. It contains
launch-scope and resume metadata, client lease and auto-close state, live and
dormant session records, compact turn/goal/queue/task summaries, and configured
workspace/project scopes.

Use the Session API `reloadConfig` command after editing LLM profile defaults or other
session-scoped config. It applies LLM-profile changes to the live session and
sets `session.configRequiresRestart=true` when the edit affects runtime
wiring that only a restart can rebuild. It does not change approval mode. Use
the Supervisor API `reloadConfig` command after editing workspace/project scope
definitions so the `scopes` snapshot and future session creation use the new config.

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
