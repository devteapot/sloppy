# Sloppy

Sloppy is a SLOP-native agent harness.

It is built around the idea that agents should observe application state and invoke contextual affordances, not reason over a flat global tool list.

## Why this exists

Most agent harnesses inherit MCP or function-calling assumptions:

- tools are global
- the model must infer when each tool applies
- state is reconstructed indirectly through read tools or screenshots

Sloppy moves the integration boundary to the SLOP protocol instead:

- providers expose semantic state trees
- affordances appear on the nodes where they are valid
- the consumer subscribes to state and receives patches over time
- the LLM sees state and actions together, in context

This project is explicitly inspired by OpenClaw and Hermes Agent, but it replaces their tool/plugin center of gravity with a SLOP-first runtime.

## Current status

Pre-alpha, but no longer docs-only.

Current checked-in implementation includes:

- Bun + TypeScript project scaffold
- provider-native LLM adapter layer with:
  - native Anthropic/Claude support
  - OpenAI-compatible support for OpenAI, OpenRouter, and Ollama
  - native OpenAI Codex subscription support through the Codex CLI auth store
  - native Gemini support
- consumer hub for first-party plugin and live-discovered SLOP providers
- first-party in-process plugin providers:
  - `apps`
  - `terminal`
  - `filesystem`
  - `memory`
  - `skills`
  - `meta-runtime`
  - `browser`
  - `web`
  - `cron`
  - `messaging`
  - `delegation`
  - `spec`
  - `vision`
  - `mcp`
  - `workspaces`
  - `a2a`
- fixed observation tools:
  - `query_state`
  - `focus_state`
  - `unfocus_state`
- dynamic affordance tools generated from visible SLOP state
- bounded same-turn parallel execution for `query_state` and explicitly
  idempotent, non-dangerous affordance tools, with tool results returned to the
  model in original call order
- CLI single-shot mode and interactive REPL
- initial `src/session/` scaffold for a headless agent-session provider
- idle session startup without an API key
- persisted LLM profile metadata plus secure API-key storage on macOS and Linux
- env-loaded provider keys exposed as selectable LLM profiles instead of silently overriding the active choice
- ACP adapter profiles as first-class session model profiles, so a main session can run through a configured external agent instead of only native API adapters
- ACP adapter subprocesses use bounded prompt timeouts and a minimal default environment; opt into extra environment variables with adapter `env`, `envAllowlist`, or `inheritEnv`
- session-provider LLM/profile onboarding and management state
- session-provider FIFO `/queue` for submitted messages while another turn is active
- session-provider `/plugins` registry for first-party session runtime plugins,
  including declarative TUI manifests for contributed subscriptions and slash
  command, palette action, and notification discovery
- session-provider `/usage` state for session-owned token accounting, showing
  provider-reported model usage when available and `N/A` semantics otherwise,
  alongside provider-counted SLOP state-tail size when supported and the known
  model context window
- session-provider `/goal` state for persistent long-running objectives, backed
  by the first-party `persistent-goal` session plugin and generic session
  extension metadata under `/extensions/goal`, including
  create/pause/resume/complete/clear controls, usage accounting, cleanup
  retention, and automatic continuation while the goal is active. Native goal
  turns load the `persistent-goal` skill and expose a model-owned
  `slop_goal_update` local tool for progress, blocker, and completion reports
  with evidence.
- session-provider restart-required state when provider or agent config changes after startup
- durable session snapshots that restore visible transcript/activity state and mark stale in-flight work explicitly after process restart
- first-party `apps` provider for agent-visible external app discovery plus explicit load/unload controls
- session-provider `/apps` attachment state for UI/API external provider visibility and debugging
- TypeScript/OpenTUI TUI under `apps/tui/` that consumes public session-provider sockets, with launch-scope managed supervisor startup, `sloppy --continue` resume selection, scoped session create/switch/stop controls, supervised session comparison in the inspector, meta-runtime proposal review/apply/revert controls, route/event/capability visibility, runtime bundle export, shared route tabs, function-key shortcuts, and a live command palette
- optional meta-runtime provider for agent profiles, nodes, channels, typed route envelopes, fanout/canary dispatch, enforced child capability masks, executor bindings, selected skill-version context for routed children, topology experiments/evaluations, proposals, topology pattern records, scoped storage, events, state import/export, and portable runtime bundles with active skill contents. Reusable self-evolution strategy lives in skills over this substrate.
- Hermes-style skill discovery with lightweight `skill_view` usage telemetry and a first-party `skill-curator` workflow for skill-managed procedural memory
- end-to-end tests for transport, consumer/runtime wiring, session state, and all first-party plugin providers

## Interface direction

The current CLI is the first development surface, not the long-term public interface boundary.

Near-term direction:

- keep the core runtime headless
- add richer interfaces under `apps/`, starting with `apps/tui/`
- expose the running agent session through a public bridge or provider surface
- have first-party and third-party UIs use that same public contract
- allow multiple UIs to attach to the same session concurrently

This means the agent process is expected to act both as:

- a **consumer** of workspace and application providers
- a **provider** of agent-session state to UIs and other clients

## Architecture at a glance

```text
Session agent profile (native LLM adapter or ACP adapter)
        |
        v
RuntimeToolSet
  - fixed observation tools
  - dynamic affordance tools
        |
        v
Agent Loop
  - history
  - ephemeral <slop-state> context tail
  - ordered tool execution with safe concurrent read/idempotent runs
        |
        v
ConsumerHub
  - first-party plugin providers
  - live-discovered SLOP providers
  - overview/detail subscriptions
        |
        v
SLOP providers
```

The important detail is that provider-native tool calling is only the LLM adapter layer.

The actual runtime model is still SLOP:

- `query`
- `subscribe`
- `patch`
- `invoke`

Implementation modules follow the same boundary discipline. Provider entrypoints own live state and
orchestration, while sibling modules own protocol parsing, descriptor construction, pure state
transitions, and reusable domain contracts. File length is treated as a signal to look for one of
those ownership seams, not as a reason to move unrelated code into generic utility modules.

The package-level `Agent` export is the default application composition: it
installs the session-backed child factory used by delegation. Embedders that
import the lower-level `src/core/agent.ts` boundary must supply a
`ChildSessionFactory` when delegated child sessions are enabled.

The main seams are concrete: model-turn orchestration is separate from tool
execution and scheduling; the Hub delegates provider connection mechanics and
dangerous-affordance indexing; session contracts and constructor assembly sit
outside `SessionRuntime`; first-party provider construction is separate from
session/policy/doctor facets; and config migration/environment stages plus
Codex auth, A2A transport, and skill discovery have domain-specific modules.

## What is implemented now

### Additional First-Party Plugin Providers

The runtime now ships with a broader first-party provider surface beyond terminal and filesystem.

These providers are currently implemented as in-process SLOP providers:

- `memory` for persistent recall-like state, search, compaction, and approval-gated destructive clears
- `skills` for skill-based progressive skill loading (`skill_view`), supporting files, nested `metadata.sloppy`, agent-managed skill edits (`skill_manage`), proposed skill activation, and approval-gated persistent workspace/global writes
- `meta-runtime` for evolving internal agent-to-agent topology through SLOP state, including typed route dispatch to delegated agents or messaging channels, route matchers over envelope body/topic/channel/metadata, topology proposals, experiment/evaluation records, per-profile/per-agent skill-version context for routed children, scoped persistence, and child capability-mask enforcement. Runtime architect prompts, repair/triage playbooks, automatic evidence scoring, and reusable topology pattern authoring should be expressed as skills over this state rather than long-term provider policy.
- `browser` for tab state, navigation history, and simulated screenshots
- `web` for search/read operations plus browsed-history state
- `cron` for scheduled jobs and job lifecycle state
- `messaging` for channel/message history and send affordances
- `delegation` for background child-session lifecycle state, explicit wait joins, follow-up messages, approval forwarding, result retrieval, close controls, and optional ACP-backed child execution
- `spec` for active specs, requirements, decisions, and proposed spec changes
- `vision` for simulated image-generation and image-analysis workflows
- `mcp` for opt-in Model Context Protocol compatibility, exposing configured MCP servers as SLOP state under `/servers`
- `workspaces` for opt-in workspace/project registry state, active scope selection, and scoped config layer visibility
- `a2a` for opt-in Agent2Agent interoperability, exposing remote Agent Cards, declared skills, and remote task lifecycle as SLOP state under `/agents` and `/tasks`

They follow the same architectural rule as terminal/filesystem: state first, affordances second.

### Filesystem provider

The filesystem provider is stateful, not just a bag of file actions.

It exposes:

- a focused workspace directory
- directory entries as state
- last search results as state
- recent filesystem operations as state

It supports affordances such as:

- `set_focus`
- `read`
- `write`
- `edit`
- `edit_range`
- `mkdir`
- `search`

Reads of text files return a `source_version` when the provider has cached the
observed line text. `edit_range` can then replace whole line ranges by
`start_line`/`end_line` without echoing old text or line hashes. Before writing,
the provider checks that the current file still matches the remembered source
view at those lines; stale ranges fail instead of editing the wrong location.

Text `read` creates provider-owned File views under `/views` and returns a
compact reference instead of putting file bodies into permanent Tool-result
history. Loaded File views are included in the filesystem Default projection
until the Agent explicitly closes them; changed backing files preserve the
observed content and mark the view stale.

### Terminal provider

The terminal provider exposes:

- current shell session state
- recent command history
- background tasks as status nodes

It supports affordances such as:

- `execute`
- `cd`
- `cancel`
- `show_output`

### First-Party Plugin Catalog

First-party plugin identity, defaults, and public metadata live in
`src/plugins/first-party/manifest.ts`. Provider construction lives in
`catalog.ts`; session, policy, and doctor contributions live in the neighboring
facet modules. The exported `FIRST_PARTY_PLUGINS` descriptors therefore cover
metadata and provider construction, not the separate runtime facets.
Provider-backed plugins are still registered through `src/providers/registry.ts`,
and all first-party plugins are enabled and configured from
`plugins.<plugin-id>`.

Provider-specific config now exists for:

- `terminal`
- `filesystem`
- `memory`
- `skills`
- `web`
- `browser`
- `cron`
- `messaging`
- `delegation`
- `vision`
- `mcp`
- `workspaces`
- `a2a`

The `spec` provider uses the configured filesystem workspace root and currently
does not require a provider-specific config block.

## Development

Install dependencies:

```sh
bun install
```

Run checks:

```sh
bun run preflight
```

For narrower local loops, run the individual gates:

```sh
bun run lint
bun run typecheck
bun run tui:typecheck
bun run test
bun run build
```

Run the source-view filesystem edit benchmark:

```sh
bun run benchmark:filesystem-view-edits
bun run benchmark:filesystem-view-edits -- --iterations 5 --json
```

Run the opt-in live headless source-view edit benchmark when an LLM is
configured. This invokes the real `bun run src/cli.ts -p "<prompt>"` path
against temp workspaces and compares model-driven legacy `edit` with
source-view `edit_range`:

```sh
bun run benchmark:headless-view-edits -- --dry-run
SLOPPY_RUN_LIVE_BENCHMARK=1 bun run benchmark:headless-view-edits
SLOPPY_RUN_LIVE_BENCHMARK=1 bun run benchmark:headless-view-edits -- --cases all
```

Run the CLI in headless single-shot mode with the configured LLM:

```sh
export ANTHROPIC_API_KEY=...
bun run src/cli.ts -p "list the files in the current workspace"
```

The packaged equivalent is:

```sh
sloppy -p "list the files in the current workspace"
```

Single-shot mode runs an ephemeral in-process session provider and drives it
through the public session surface. It does not open a Unix socket or persist a
session snapshot, but it uses the same turn, usage, activity, task, approval, and
audit plumbing as `session:serve`.

Bare prompt arguments are still accepted for compatibility:

```sh
bun run src/cli.ts "list the files in the current workspace"
```

Interactive mode with the default Anthropic config:

```sh
export ANTHROPIC_API_KEY=...
bun run src/cli.ts
```

Run the session provider surface:

```sh
bun run session:serve
```

If no ready model profile is configured, the session still starts and waits for a UI to attach.
When `workspaces.items` is configured, `session:serve` loads the active
workspace/project config layers by default. You can pin a scope explicitly:

```sh
bun run session:serve -- --workspace-id sloppy --project-id runtime
```

The session server always opens its local Unix socket. Add an opt-in WebSocket
listener for remote SLOP clients:

```sh
SLOPPY_WS_TOKEN="$(openssl rand -hex 24)" \
  bun run session:serve -- \
    --ws-host 0.0.0.0 \
    --ws-port 8787 \
    --ws-token-env SLOPPY_WS_TOKEN
```

WebSocket listeners bind to `127.0.0.1` by default. Non-loopback connections are
rejected unless `--ws-token-env <name>` or `--ws-token <token>` is configured;
clients can pass the token as `?token=...` or an `Authorization: Bearer ...`
header. Browser clients must also match an explicit `--ws-allow-origin
<origin>` allowlist. Use `--ws-path <path>` to change the default `/slop`, and
`--ws-public-url <ws-or-wss-url>` when publishing behind a proxy.

The TUI client can attach directly to either transport:

```sh
bun run tui -- --socket ws://runtime.example.test:8787/slop?token=...
```

Run a public session supervisor, which exposes session creation/switching while
each managed session still has its own ordinary session-provider socket:

```sh
bun run session:serve -- --supervisor --socket /tmp/slop/sloppy-supervisor.sock
```

For the packaged CLI, the equivalent operator command is:

```sh
sloppy session supervisor --socket /tmp/slop/sloppy-supervisor.sock
```

The same `--ws-*` flags expose the supervisor provider itself over WebSocket.
Ordinary supervised sessions still expose their own per-session endpoint; use a
standalone `session serve --ws-port ...` when a remote client needs to attach
directly to one running session.

Add `--managed --no-initial-session --auto-close-enabled` when you want the
same launch-scope supervisor shape used by the TUI launcher.

Run the TypeScript/OpenTUI TUI from the source checkout:

```sh
bun run tui
```

For the published package, the same behavior is the bare CLI:

```sh
sloppy
```

By default `sloppy` resolves the real current working directory into a launch
scope, starts or reuses that scope's managed supervisor, creates a fresh
session, and attaches to that session's public provider socket. Later `sloppy`
runs from the same directory reuse the same supervisor but still start a fresh
session.

Use `--continue` to attach to the launch-scope resume session instead of
creating a fresh session:

```sh
sloppy --continue
```

If there is no previous session for that launch scope, `sloppy --continue`
fails at the CLI level and tells you to run `sloppy` first.

Use `--yolo` to start or attach with session approval mode set to `auto`:

```sh
sloppy --yolo
sloppy --continue --yolo
bun run session:serve -- --yolo
bun run src/cli.ts -p "read README.md" --yolo
```

`--yolo` may appear before or after the prompt/session arguments. It sets the same public `/approvals.approval_mode` state controlled by
`/approval auto` in the TUI. When used with `--continue`, direct socket attach,
or any other existing-session path, it mutates that Session's shared approval
mode to `auto` until a client sets `/approval normal`. Plain `sloppy --continue`
restores the Session's persisted approval mode without resetting it.

To attach to an existing session provider socket directly, use:

```sh
bun run tui -- --socket /tmp/slop/sloppy-session-<id>.sock
```

`--socket` also accepts `ws://` and `wss://` session provider URLs.

To attach through an existing supervisor socket, use:

```sh
bun run tui -- --supervisor-socket /tmp/slop/sloppy-supervisor.sock
```

`--supervisor-socket` also accepts a WebSocket supervisor URL.

Managed TUI sessions accept the same workspace/project scope flags. The command
palette and slash commands can create, switch, and stop additional scoped
sessions through the supervisor. Switching selects a session for the current
TUI's supervisor client lease; it does not change a global active session for
other connected TUIs. Stop ends a live session process while keeping its
snapshot and registry entry restorable; it is blocked when another connected TUI
has selected that session. The supervisor `/sessions` state also exposes
per-session runtime status, resume-session marker, turn state, goal status,
queue pressure, pending approvals, and running task counts so the TUI can
compare sessions through `/inspector sessions` without reading runtime
internals:

```sh
bun run tui -- --workspace-id sloppy --project-id runtime --title "Runtime"
```

Run the runtime smoke harness:

```sh
bun run runtime:smoke
```

By default this creates a temporary workspace, wires `meta-runtime`, `messaging`,
`delegation`, `skills`, and `filesystem`, applies a session topology proposal,
dispatches a typed route envelope, and verifies that the message lands in a SLOP
channel. Native and ACP delegated-child paths can be checked explicitly:

```sh
bun run runtime:smoke -- --mode native
bun run runtime:smoke -- --mode acp --acp-adapter claude
```

Add `--event-log /path/to/events.jsonl` or set `SLOPPY_EVENT_LOG` to capture a
JSONL audit trail of runtime events such as topology proposals, route dispatch,
tool calls, provider task changes, and approvals.

For CLI single-shot diagnostics, set `SLOPPY_CLI_METRICS_PATH` to write a
best-effort JSON summary of the run from session state. Metrics write failures
emit a warning but do not change the CLI exit code.

Native mode uses the active LLM profile selected by the LLM profile manager
unless `--profile <id>` is provided. For a local OpenAI-compatible router, point
the run at a configured `llm.endpoints` entry with the one-shot LLM endpoint
overrides, for example:

```sh
SLOPPY_LLM_ENDPOINT=litellm \
SLOPPY_MODEL=<model> \
LITELLM_API_KEY=<router-key-or-dummy> \
bun run runtime:smoke -- --mode native
```

Run the opt-in live headless CLI e2e when an LLM is configured. This invokes the
actual `bun run src/cli.ts -p "<prompt>"` path, asks the model to use the
filesystem provider, and may use network/model quota:

```sh
SLOPPY_RUN_LIVE_E2E=1 bun test tests/cli-headless-e2e.test.ts
```

Check live runtime dependencies before a smoke run:

```sh
bun run runtime:doctor \
  --litellm-url http://sloppy-mba.local:8001/v1 \
  --acp-adapter claude \
  --event-log /tmp/sloppy-events.jsonl \
  --socket /tmp/slop/sloppy-session.sock
```

The doctor combines core runtime checks with first-party plugin doctor
contributions. It reports the active LLM profile readiness and credential
source, OpenAI-compatible router reachability, ACP adapter startup and boundary
posture, workspace path containment/readability, required ACP/MCP startup
subprocess commands, audit-log writability, session/supervisor socket path
usability, and persisted session/meta-runtime state schema health. A missing
ready LLM profile is an error; environment-backed credentials are reported as a
warning so operators can decide whether process-scoped secrets are acceptable
for that run.

Use `.sloppy/config.example.yaml` as the local workspace config shape for the
Claude and Codex ACP adapters. Copy those adapter blocks into
`.sloppy/config.yaml` and set the LiteLLM endpoint model/base URL for your
machine.

If the LiteLLM check fails before HTTP, verify local name resolution first:

```sh
dscacheutil -q host -a name sloppy-mba.local
ping -c 1 sloppy-mba.local
```

If `.local` mDNS is not available from the current host, use the router's direct
IP address in `--litellm-url` and the configured `llm.endpoints.<id>.baseUrl`.

If the ACP check fails for Claude, confirm that the installed command actually
speaks Agent Client Protocol over stdio. `claude mcp ...` is MCP server support,
not ACP agent mode; Zed uses a dedicated adapter, so configure
`plugins.delegation.acp.adapters.<id>.command` with an ACP adapter command
such as `["bunx", "@agentclientprotocol/claude-agent-acp"]` or an installed
`claude-agent-acp` binary.

ACP adapters are not limited to sub-agents. They can be selected as the
main session model profile through the same `/llm` state used for native API
endpoints:

```yaml
llm:
  defaultProfileId: claude-acp
  profiles:
    - kind: session-agent
      id: claude-acp
      label: Claude ACP
      model: sonnet
      adapterId: claude
```

For Codex subscription models, prefer the native `openai-codex` endpoint when
you want Sloppy to keep its own model/tool loop. It reads the existing Codex CLI
auth store, so run `codex login` first:

```yaml
llm:
  defaultProfileId: codex-native
  profiles:
    - kind: native
      id: codex-native
      label: Codex GPT-5.5 Low
      endpointId: openai-codex
      model: gpt-5.5
      reasoningEffort: low
```

## Config

Sloppy reads configuration from:

- `~/.sloppy/config.yaml`
- `.sloppy/config.yaml` in the current workspace

The local workspace config overrides the home config.

LLM settings are configured under `llm`.

Example:

```yaml
llm:
  endpoints:
    local-router:
      protocol: openai-chat
      baseUrl: http://sloppy-mba.local:8001/v1
      auth:
        type: env
        env: LITELLM_API_KEY
      models:
        local/test-model: {}
  defaultProfileId: openai-main
  profiles:
    - kind: native
      id: openai-main
      label: OpenAI Main
      endpointId: openai
      model: gpt-5.4
    - kind: native
      id: local-router
      label: Local Router
      endpointId: local-router
      model: local/test-model
```

Thinking output is configured under `llm.thinking` and may be overridden per
profile with `llm.profiles[].thinking`. `thinking.enabled` controls whether the
runtime requests provider thinking/reasoning, but some models cannot disable
thinking; adapters report that effective behavior instead of failing the
profile. `thinking.display` is either `visible` or `hidden`; hidden Thinking
output is still captured as public transcript state for later UI toggles, but
it is not rendered by default and is never replayed into later model calls.

Profiles can still include `reasoningEffort` (`none`, `minimal`, `low`,
`medium`, `high`, or `xhigh`) as a compatibility alias for protocols that expose
OpenAI-style reasoning controls. Prefer protocol-specific `thinking` blocks for
new config.

First-party plugins default to the lean core: `apps`, `terminal`, and `filesystem`. Plugins can also contribute session nodes, extension event projections, TUI manifests, policy rules, audit metadata, doctor checks, startup subprocess probes, and supervisor summary fields. Other provider/session plugins (`persistent-goal`, `memory`, `skills`, `web`, `browser`, `cron`, `messaging`, `vision`, `delegation`, `meta-runtime`, `spec`, `mcp`, `workspaces`, `a2a`) are opt-in. Enable and configure them in `.sloppy/config.yaml`:

```yaml
plugins:
  persistent-goal:
    enabled: true
  memory:
    enabled: true
  web:
    enabled: true
  browser:
    enabled: true
  vision:
    enabled: true
  delegation:
    enabled: true
  meta-runtime:
    enabled: true
    globalRoot: ~/.sloppy/meta-runtime
    workspaceRoot: .sloppy/meta-runtime
  spec:
    enabled: true
  workspaces:
    enabled: true
  skills:
    enabled: true
    builtinSkillsDir: skills
    skillsDir: ~/.sloppy/skills
    externalDirs: []
    templateVars: true
    viewMaxBytes: 65536
  mcp:
    enabled: true
    connectOnStart: true
    servers:
      local-demo:
        transport: stdio
        command: ["bunx", "my-mcp-server"]
        cwd: .
        envAllowlist: ["MY_MCP_TOKEN"]
      hosted-demo:
        transport: streamableHttp
        url: https://mcp.example.test/mcp
        headers:
          x-api-key: <token>
  a2a:
    enabled: true
    fetchOnStart: true
    agents:
      planner:
        cardUrl: https://agent.example/.well-known/agent-card.json
        bearerTokenEnv: A2A_AGENT_TOKEN
      local-bridge:
        url: https://agent.example/a2a/rpc
        protocolVersion: "1.0"
workspaces:
  activeWorkspaceId: sloppy
  activeProjectId: runtime
  items:
    sloppy:
      name: Sloppy
      root: ~/dev/sloppy
      configPath: .sloppy/config.yaml
      projects:
        runtime:
          name: Runtime
          root: .
          configPath: .sloppy/config.yaml
```

The MCP provider is compatibility glue, not a core architectural dependency.
It projects configured MCP tools, resources, templates, and prompts into SLOP
state at `/servers/<id>`, with affordances such as `refresh`, `call_tool`,
`read_resource`, and per-tool `call`.

The workspaces provider exposes registered workspaces and projects as state at
`/workspaces`, `/projects`, and `/config`. Selecting a workspace/project updates
the active scope and returns the config layer order (`global`, `workspace`,
`project`) that a scoped session should load. `session:serve`, the public
session supervisor, and managed TUI sessions load those scoped layers and pin
terminal/filesystem roots to the selected workspace or project folder. The
supervisor exposes `/session`, `/sessions`, and `/scopes` for creation,
per-client selection, stopping, dormant-session restore, and launch-scope resume
metadata, but it does not add privileged scheduling or provider rewiring to
core.

The A2A provider is an external interoperability bridge, not Sloppy's internal
agent-to-agent architecture. It fetches configured Agent Cards, selects a
JSON-RPC interface, exposes skills under `/agents/<id>/skills`, and tracks
remote tasks under `/tasks`. Internal topology still belongs in SLOP-native
`meta-runtime`, `delegation`, and `messaging` state.

Skills follow the `SKILL.md` directory pattern used by Hermes and agentskills.io:
`SKILL.md` is loaded on demand, while supporting files under `references/`,
`templates/`, or `scripts/` are read with `skill_view(name, file_path)`.
Workspace and global changes made through `skill_manage` require approval.

Delegation launches child agents as background child sessions while preserving the same SLOP session surface. Parent turns join child progress explicitly with the runtime-local `slop_wait_for_delegation_event` tool instead of polling `/delegation/agents`; completed children stay available for follow-up messages until closed. After retrieving a final child result, close that child unless a follow-up turn is still needed.

Delegation can also launch configured Agent Client Protocol agents as child sessions:

```yaml
plugins:
  delegation:
    enabled: true
    acp:
      enabled: true
      adapters:
        gemini:
          command: ["gemini", "--acp"]
          capabilities:
            spawn_allowed: false
            shell_allowed: false
            network_allowed: true
            filesystem_reads_allowed: true
            filesystem_writes_allowed: false
        claude:
          command: ["bunx", "@agentclientprotocol/claude-agent-acp"]
          envAllowlist: ["ANTHROPIC_API_KEY"]
          capabilities:
            spawn_allowed: true
            shell_allowed: true
            network_allowed: true
            filesystem_reads_allowed: true
            filesystem_writes_allowed: true
        codex:
          command: ["codex-acp"]
          capabilities:
            spawn_allowed: true
            shell_allowed: true
            network_allowed: true
            filesystem_reads_allowed: true
            filesystem_writes_allowed: true
```

Then pass an executor such as `{ kind: "acp", adapterId: "gemini" }` to
`delegation.spawn_agent`, or create a meta-runtime executor binding with the
same shape. Omit the executor to use the active session profile. Zed's Codex
adapter is published as `@zed-industries/codex-acp` and exposes the
`codex-acp` binary.
Routed or allow-masked ACP spawns require the adapter `capabilities` block so the
runtime can reject child bindings that exceed the adapter's declared surface.

Built-in endpoint defaults:

- `anthropic` -> `ANTHROPIC_API_KEY`
- `openai` -> `OPENAI_API_KEY`
- `openrouter` -> `OPENROUTER_API_KEY` and `https://openrouter.ai/api/v1`
- `gemini` -> `GEMINI_API_KEY`
- `ollama` -> `http://localhost:11434/v1` and no API key by default
- `openai-codex` -> Codex CLI auth store and no API key by default

You can override the endpoint/profile/model for one-shot runs with
`SLOPPY_LLM_ENDPOINT`, `SLOPPY_LLM_PROFILE`, and `SLOPPY_MODEL`.

The agent loop defaults to 32 model/tool iterations. For longer runs, set
`agent.maxIterations` in config or use `SLOPPY_MAX_ITERATIONS=80` for a one-off
run.

Within a model turn, the loop may execute a contiguous run of parallel-safe tool
calls concurrently. Parallel-safe means `query_state` or a SLOP affordance
that is explicitly `idempotent: true` and not `dangerous`; focus changes, local
session controls, malformed calls, unknown tools, approvals, and unmarked or
mutating affordances remain sequential barriers. Results are still appended to
conversation history in the original model-emitted order.

Managed profile metadata is stored in `~/.sloppy/config.yaml`.

API keys are not written to YAML:

- macOS stores them in Keychain
- Linux stores them in Secret Service via `secret-tool`
- environment variables still work, but they are surfaced in the LLM profile manager as separate env-backed profiles
- selecting a managed profile keeps using its stored key; env-backed profiles are an explicit choice instead of an implicit override
- one-shot runs explicitly routed with `SLOPPY_LLM_ENDPOINT` or `SLOPPY_MODEL` use a temporary runtime profile for that run

The current TUI uses the session provider's `/llm` state to onboard and manage
profiles, its `/apps` state to surface external provider attachment status, and
the connected `meta-runtime` app's `/proposals` state for runtime proposal
review. The Agent sees the same external app catalog through the first-party
`apps` provider and controls app load/unload from `/available`.

Useful TUI slash commands:

- `/profile openai gpt-5.4` saves a native endpoint profile without a key.
- `/profile-secret openai gpt-5.4` opens masked API-key entry.
- `/profile acp sonnet --adapter claude` saves a `session-agent` adapter-backed profile.
- `/default <profile-id>`, `/delete-profile <profile-id>`, and `/delete-key <profile-id>` manage exposed profiles.
- `/goal <objective> [--token-budget N]` starts a persistent runtime goal.
- `/goal`, `/goal pause`, `/goal resume`, `/goal complete`, and `/goal clear` inspect and control the active goal.
- `/query /extensions 2` inspects generic session extension metadata, including the backing `/extensions/goal` record.
- `/session-new [--workspace-id id] [--project-id id] [--title text]` creates and switches to a supervised session.
- `/session-switch <session-id>` switches the TUI to another supervised session.
- `/session-stop <session-id>` stops a live supervised session while keeping it restorable.
- `/inspector sessions` shows supervised sessions with turn, goal, queue, approval, and task state.
- `/runtime refresh`, `/runtime export`, `/runtime inspect [proposal-id]`, `/runtime apply <proposal-id>`, and `/runtime revert <proposal-id>` review meta-runtime state, export a portable runtime bundle, and act on topology proposals.
- `/query /llm 2` inspects the session provider; `/query <app-id>:/ 2` inspects a connected external provider listed under `/apps`.
- `/invoke [app-id:]<path> <action> <json-object>` invokes a contextual affordance from the explicit inspector path.

The composer stays immediately editable when focused. Pending approvals interrupt
the normal input loop with `[o/a] approve once` and `[d/esc] deny`.

## Design references

- `docs/README.md` for the current documentation map
- `docs/research/prior-art.md` for notes on OpenClaw, Hermes, and nearby auth/runtime approaches
- `docs/research/agent-harnesses-and-tui-audit.md` for the May 2026 agent-harness comparison and current TUI completeness audit
- `docs/02-architecture.md` for the current runtime design
- `docs/03-mvp-plan.md` for the implementation plan and near-term roadmap
- `docs/04-slop-protocol-reference.md` for the local protocol summary
- `docs/05-language-evaluation.md` for language/runtime choices
- `docs/06-agent-session-provider.md` for the concrete public UI/session provider shape
- `docs/13-meta-runtime.md` for the optional topology/evaluation provider and skill-led self-evolution boundary
- `docs/16-tui-plan.md` for the TypeScript/OpenTUI TUI architecture
- `~/dev/slop-slop-slop/spec/` for the full SLOP protocol spec

## License

MIT
