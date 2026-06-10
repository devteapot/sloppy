# Architecture

Sloppy is a SLOP-native agent runtime. The kernel observes provider state,
projects affordances into model-native tools, invokes selected affordances, and
keeps the session alive across approvals, async tasks, and external provider
changes.

The runtime does not own planning, delegation strategy, review loops, or task
graphs. Those are compositions over SLOP providers.

## Lean Kernel

The default runtime includes:

- `Agent` loop and LLM adapters
- `ConsumerHub` for state subscriptions, query, invoke, and policy checks
- session provider and session supervisor providers for UI and API consumers
- durable public session snapshots with explicit stale-turn recovery
- provider discovery
- approval queue and generic dangerous-action policy
- first-party plugin catalog and runtime plugin manager
- default first-party plugins: `apps`, `terminal`, and `filesystem`

The kernel has no hard-coded orchestrator role, scheduler, task DAG, or
workflow-specific lifecycle hooks. Roles remain generic prompt/policy profiles.

## Provider Model

Everything visible to the agent is a provider state tree with affordances:

- state is primary
- affordances are secondary
- subscriptions and patches are preferred over repeated polling
- provider-native affordances are converted into model-native tool definitions
- fixed observation tools (`query_state`, `focus_state`, and `unfocus_state`)
  are Hub-owned model tools, not provider capabilities
- same-turn tool execution is conservative: the loop can run contiguous
  `query_state` calls and explicitly idempotent, non-dangerous affordance
  calls concurrently, but preserves result order and treats focus changes,
  local controls, approvals, malformed calls, unknown tools, and unmarked
  mutating affordances as sequential barriers

The Hub owns the Agent-facing State projection. Providers own their Default
projection and how their own trees resolve, summarize, window, expose lazy
detail, and retain provider-owned working state. Sloppy's Agent-facing runtime
does not rely on salience filtering or node-count compaction for scaling; the
Agent drives detail explicitly through State focus and Provider affordances.
Omitted `max_nodes` means no node-count compaction request.

Built-in capabilities ship as plugins, not privileged runtime branches. A plugin
is the first-party package and catalog unit; each plugin contributes one or more
providers and/or a session plugin. Optional plugins include `persistent-goal`,
`memory`, `skills`, `web`, `browser`, `cron`, `messaging`, `vision`,
`delegation`, `spec`, `mcp`, `workspaces`, `a2a`, and `meta-runtime`.

Public session providers speak the SLOP message protocol over local Unix
sockets — the only core transport. Remote clients connect through the
first-party WS gateway (`sloppy gateway`, `src/gateway/`), a standalone
process that relays the supervisor and per-session unix sockets over a single
WebSocket port. The relay is protocol-blind (one frame per NDJSON line), so
state tree, affordance, query, invoke, subscription, and patch semantics are
unchanged; auth and exposure policy live entirely in the gateway.

## MCP Compatibility

MCP support is an optional provider, not a second runtime architecture. The
`mcp` provider connects to configured MCP servers through the official
TypeScript SDK and projects their tools, resources, resource templates, and
prompts into SLOP state under `/servers`.

The model observes MCP servers the same way it observes every other capability:
status, inventory, errors, and server metadata appear first, while affordances
such as `refresh`, `call_tool`, `read_resource`, prompt retrieval, and
per-tool `call` remain secondary. Dangerous MCP tool annotations are preserved
on the projected SLOP affordance so the hub-level approval policy can see them.

This keeps MCP useful as ecosystem compatibility while preserving the
SLOP-native provider/state boundary for first-party runtime design.

## A2A Interoperability

A2A support is also an optional provider, not the internal agent-to-agent
architecture. The `a2a` provider fetches configured Agent Cards, selects the
first supported JSON-RPC interface, and projects remote agent capabilities into
SLOP state:

- `/agents` lists configured external agents, selected interface URLs,
  capability flags, default input/output modes, and declared skills.
- `/agents/<id>/skills` exposes Agent Card skills as state before the model
  sends work to that agent.
- `/tasks` tracks remote A2A tasks observed through `SendMessage`, `GetTask`,
  `ListTasks`, and `CancelTask`.

The provider sends `A2A-Version` headers, supports env-backed bearer/API-key
credentials, and keeps remote protocol errors visible as provider state. It
does not replace `meta-runtime`, `delegation`, or `messaging`; those remain the
SLOP-native substrate for internal topology, capability masks, child sessions,
and state-rich routing.

## Workspace And Project Scopes

The optional `workspaces` provider exposes a registry of folder-bound
workspaces and projects. It is state, not a privileged session manager:

- `/workspaces` lists configured workspace roots and workspace config paths.
- `/projects` lists projects for the active workspace.
- `/config` reports the active config layer order: global, workspace, project.

Selecting a workspace or project changes the provider's active scope and returns
the config layers a scoped session should load. This gives UIs and future
session orchestration a public SLOP boundary for project selection without
adding multi-session scheduling or provider rewiring to core.

The session launcher uses the same layer model. A scoped launch merges home,
workspace, and project config files in that order, then pins terminal and
filesystem roots to the selected workspace/project folder before provider
normalization. Workspace/project-scoped MCP servers, A2A agents, skills, and
meta-runtime storage therefore remain ordinary provider config rather than
special runtime branches.

## Session Supervisor

The session supervisor is a public SLOP provider for managing multiple ordinary
agent sessions. It is separate from the per-session provider:

- `/session` reports launch-scope metadata, the launch-scope resume session,
  client lease counts, and exposes `create_session`, `select_session`, and
  `reload_config`.
- `/sessions` lists live and dormant session records and exposes per-session
  `select_session` and, when live, `stop_session` affordances.
- `/scopes` lists configured workspace/project scopes that can launch new
  scoped sessions.

The supervisor intentionally has no global active session. A connected UI
registers a supervisor client lease and selects a session for that connection.
The launch-scope resume session is only the default target for `sloppy
--continue` and later managed launches that ask to continue. Multiple clients
can select different sessions concurrently.

Managed TUI launch is implemented above this agnostic supervisor. The launcher
resolves the real current working directory into a launch scope, starts or
reuses that scope's managed supervisor, creates a fresh session by default, and
attaches to the selected session's public provider endpoint. Switching sessions
changes the TUI's session endpoint; it does not collapse multiple sessions into one
provider tree. Stopping a session ends its live process while keeping its
snapshot and registry record restorable. Selecting a dormant session restores it
through the normal session snapshot recovery path. Each supervised session still
loads config through the normal scoped launcher and still exposes the standard
`/session`, `/llm`, `/turn`, `/goal`, `/extensions`, `/composer`, `/queue`,
`/transcript`, `/activity`, `/approvals`, `/tasks`, and `/apps` surface.

`/session.reload_config` on the supervisor refreshes the supervisor's cached
base config and projected `/scopes`; it does not rewrite existing live session
provider wiring. `/session.reload_config` on an individual session reloads that
session's scoped config, refreshes LLM profile state, and marks the session
restart-required when provider, plugin, policy, or agent wiring changed. Config
reload does not change approval mode; approval mode is Session state, not config
state.

The supervisor owns lifecycle bookkeeping only. It does not schedule work,
route tasks, mutate provider wiring, or become a privileged orchestrator.

## LLM Endpoints And Profiles

LLM configuration is endpoint/protocol based. An `llm.endpoints.<id>` entry
describes a deployment and wire protocol (`anthropic-messages`, `openai-chat`,
`openai-codex`, `gemini`, or a future protocol), auth mode, base URL, headers,
and model metadata. A native profile selects an endpoint plus model; a
`session-agent` profile selects an adapter-backed external session agent such as
ACP. ACP is therefore an explicit session-agent path, not an LLM provider.

The session provider exposes this as `/llm.selected_endpoint_id`,
`selected_protocol`, and profile item `endpoint_id`/`protocol` props. API keys
are never stored inline in YAML. Endpoint credentials come from the OS secure
store, endpoint-declared environment variables, no-auth local endpoints, or the
Codex CLI auth store for `openai-codex`.

## LLM Context Tail

The model sees current provider state as an ephemeral `<slop-state>` tail,
rebuilt on every model request and never persisted into conversation history.
The tail is the Hub-owned State projection: provider Default projections plus
explicit Agent-managed State focuses and small runtime/session status. The
projection preserves provider boundaries and escapes forged SLOP context tags
inside provider-controlled text. Sloppy does not rely on salience metadata for
runtime scaling and does not apply node-count compaction to the Agent-facing
state tail. This
follows the SLOP integration pattern in
`~/dev/slop-slop-slop/spec/integrations/llm-context.md`: stable conversation
history remains before the volatile state tail so prompt-cache prefixes stay
usable while the model still reasons over fresh state.

External app provider discovery registers descriptor-backed apps as lightweight
`status=unloaded` app cards by default. It does not connect discovered apps into
the agent Hub until the Agent explicitly loads them through the first-party
`apps` provider's `/available` controls. The public Session provider mirrors the
same app catalog and lifecycle controls at `/apps` for UIs and API consumers.
Unloading disconnects the provider from the agent Hub, removes its state and
affordances from the model-visible projection, and keeps the lightweight app
card so the Agent can reload it when a task needs that app again. Discovery
still owns the descriptor set; app loading only controls whether a registered
descriptor is currently connected to this Session's Hub.

Session-provider `/apps.query_provider` is the explicit debugging bridge into
attached providers for external consumers. It returns provider-owned SLOP nodes
as-is; Sloppy does not strip external App metadata such as `salience` or
`focus`, because those fields may be part of the App's discovery contract.

## Filesystem File Views

Filesystem text reads create provider-owned File views under `/views` instead
of returning file bodies in Tool-result history. A text `read` returns a compact
reference and metadata such as `view_path`, `source_version`, coverage, and
line range. Loaded File views inline their loaded text in the filesystem
Default projection as working memory, so the next model request can observe the
content through the state tail. The Agent removes stale or no-longer-needed
views with an explicit filesystem `close_view` affordance.

Multiple Range views may exist for the same file and source version. A Full-file
view supersedes same-version Range views, and later partial reads are redundant
while the Full-file view is present. When the backing file version changes, File
views preserve the observed text and are marked stale rather than silently
refreshing.

## Delegation

Delegation is a provider that spawns and observes child agent sessions. It does
not understand tasks or plans. Child agents expose the same session-provider
surface as the parent, so parent agents and UIs observe child transcript,
approvals, activity, and lifecycle state through SLOP.

`spawn_agent` is nonblocking: it creates a background child session and returns
the child id. It is intentionally not marked as a dangerous affordance:
frictionless spawning is the design, and the child session enforces its own
approval gates on every dangerous affordance it invokes. The parent remains
responsible for strategy. It may continue
independent work, then explicitly park the current turn with the runtime-local
`slop_wait_for_delegation_event` tool. That wait tool watches delegation state
through `ConsumerHub.waitForStateChange()` and returns a single wake payload
when a watched child completes a turn, fails, is cancelled or closed, needs
approval, or times out. Child state patches do not start autonomous parent
turns by themselves.

Completed child sessions stay open as chat-like conversations. Their agent
items expose follow-up `send_message`, full `get_result`, approval forwarding,
and `close` controls while the child session provider remains registered.
Closing a child unregisters its session provider but keeps the summarized
delegation result in `/agents`. Parent agents should close completed children
after retrieving final results unless they need another follow-up turn.

The deprecated `task_id` spawn field is ignored for compatibility. Completed
children expose `get_result` directly on their agent item.

## Meta-Runtime

The `meta-runtime` provider is the first-class substrate for evolving internal
agent-to-agent structure. It exposes:

- `/agents`
- `/profiles`
- `/channels`
- `/routes`
- `/capabilities`
- `/executor-bindings`
- `/skill-versions`
- `/experiments`
- `/evaluations`
- `/proposals`
- `/patterns`
- `/events`
- `/approvals`

The agent changes its internal runtime by proposing typed topology operations:

- `upsertAgentProfile`
- `spawnAgent`
- `retireAgent`
- `upsertChannel`
- `rewireChannel`
- `upsertRoute`
- `setCapabilityMask`
- `setExecutorBinding`
- `activateSkillVersion`
- `deactivateSkillVersion`

This is a meta-runtime, not arbitrary source-code mutation. The provider schema
is stable; the graph, routes, capabilities, executor bindings, active skill
versions, and topology experiment records are state.

Enabled routes dispatch typed message envelopes through the provider hub:

- `agent:<id>` targets invoke `delegation.spawn_agent` using the target agent's
  profile instructions, executor binding, resolved capability masks, and
  selected skill versions.
- `channel:<id>` targets invoke `messaging.channels/{id}.send`.

Dispatch can run in single-target mode or fanout mode. Routes can carry
`matchField`, `matchMode`, and `caseSensitive` metadata for typed envelope
matching over body, topic, channel id, or metadata paths. They can also carry
`traffic.sampleRate` metadata for deterministic canary delivery without adding a
core scheduler.

The checked-in provider keeps the public surface to substrate operations:
topology mutation proposals, route dispatch, experiments/evaluations, rollback,
pattern records, import/export, approvals, and capability masks. Reusable
diagnosis, repair playbooks, architect prompts, and evaluation rubrics live in
skills over that state. Experiment promotion requires recorded evaluation
evidence, but evaluator skills own the scoring rubric. Pattern archive/reuse
requires explicit topology operations from a pattern-authoring skill rather than
copying source proposals automatically.

The meta-runtime provider can also export merged/global/workspace state and
import session/workspace/global state. Persistent imports are approval-gated.

## Storage And Approval

Meta-runtime state is layered:

- global: `~/.sloppy/meta-runtime`
- workspace: `.sloppy/meta-runtime`
- session: memory only

Workspace state wins over global state for the same id, and session state wins
over both. Persistence is scoped: saving a workspace change writes only
workspace-owned state, proposals, and events rather than copying the merged
runtime view into the workspace file. Replacing a layer removes only that layer,
so shadowed outer-layer state becomes visible again. Session proposals are
ephemeral unless explicitly re-proposed with a persistent scope.

Temporary non-privileged changes can apply without approval. Session-scoped deny
capability masks are treated as tightening and can auto-apply. Persistent changes
and privileged changes require approval, including global/workspace writes,
allow capability masks, executor bindings, agent spawns, and
skill activation.

## Skills

The `skills` provider remains compatible with Hermes/agentskills.io-style
`SKILL.md` directories and uses progressive disclosure. `/skills` exposes a
compact index; `skill_view(name)` loads `SKILL.md`; `skill_view(name,
file_path)` loads a supporting file under the skill directory. It reads nested
`metadata.sloppy`, category, platform, tag, and supporting-file metadata. The
index also exposes extension-record metadata and lightweight usage telemetry (`view_count`,
`last_viewed_at`, and aggregate `skill_views_count`) so curator skills can
review which procedural memories are actually being used. The built-in
`skill-curator` skill uses this state plus transcript/activity evidence to
propose minimal `skill_manage` changes without adding a scheduler or repair
policy to the runtime.

The public session provider has a generic `/extensions` metadata substrate for
skill-backed session features and a `/plugins` registry for first-party session
runtime plugins. Plugins can contribute session nodes, extension-record event
projections, runtime-local turn tools, queued or automatic turns, snapshot
migration/recovery hooks, startup/shutdown hooks, policy rules, audit metadata
enrichers, doctor checks, startup subprocess probes, supervisor summary fields,
and declarative TUI manifests without adding feature-specific branches to the
provider, TUI, or doctor core. TUI palette entries invoke public session
affordances declared by plugin manifests and are filtered by the live actions
available at their SLOP path. Runtime-local tools are stamped with their owning
plugin id so future policy, dispatch, and telemetry can keep plugin boundaries
visible. When enabled, `/goal` is a stable projection contributed by the bundled
`persistent-goal` plugin over the `goal` extension record owned by the bundled
`persistent-goal` skill; the plugin owns stale-turn goal recovery, while the
runtime provides the generic durable snapshot envelope. The `goal` field on
the public session snapshot is likewise plugin-derived: session plugins
register snapshot projections that the store runs on every snapshot read, so
goal-specific schema and serialization live entirely in the plugin
(`persistent-goal/goal-schema.ts`) rather than in the session store. The skill defines the
working procedure and completion evidence expectations. Extension-record cleanup
is manual plus TTL, so missing or unloaded skills do not delete state automatically.

Agents can create and maintain procedural memory through `skill_manage`:
`create`, `patch`, `edit`, `delete`, `write_file`, and `remove_file`.
Session-scoped changes apply in memory. Workspace and global writes route
through approvals before touching persistent skill artifacts. Persistent
activation refuses to overwrite an existing skill path. If skill names collide,
precedence is session, workspace, global, builtin, then imported.

The registry mounts global/workspace skill layers beneath the configured
meta-runtime roots:

- `~/.sloppy/meta-runtime/skills`
- `.sloppy/meta-runtime/skills`

It also scans the configured builtin skill root, defaulting to `skills/`.

Meta-runtime `activateSkillVersion` records can link to skills-provider
proposals. Session skill proposals may activate during meta-runtime proposal
apply; workspace/global skill proposals must be activated through the skills
provider first. When routed child agents are spawned through meta-runtime
routes, selected active skill versions from `profile.defaultSkillVersionIds` and
`agent.skillVersionIds` are resolved through `skill_view` and frozen into the
child goal. A route fails visibly if a selected skill cannot be loaded or if the
agent has no explicit capability mask.

Self-extensibility should primarily grow through skills. If a recurring
procedure can be expressed as instructions plus existing SLOP affordances, it
belongs in a skill or skill script rather than provider code. Provider code is
reserved for deterministic state mutation, exact integrations, approvals, and
safety enforcement.

## Public Consumers

First-party UIs and external clients should use the same provider/session
boundary:

- session provider for transcript, turn state, approvals, activity, tasks, and
  app/provider attachment state, plus generic extension metadata when a
  dedicated projection is not enough
- session supervisor for multi-session listing, scoped creation, switching, and
  stopping
- direct provider query/invoke for deeper capability-specific surfaces
- no privileged in-process UI integration

## Design Boundaries

The runtime intentionally does not include:

- built-in orchestration DAGs
- central schedulers for coding plans
- gate/digest/precedent infrastructure
- MCP-style flat tool catalogs
- special task lifecycle hooks in the kernel
- hardcoded self-repair or topology-optimization playbooks

Those features can be rebuilt as optional plugins, SLOP providers, or skills if they
prove useful, but they are not part of the lean runtime.
