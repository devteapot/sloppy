# Sloppy Core Runtime

The SLOP-native agent runtime: the kernel, the agent loop, the provider/consumer substrate, and the session boundary. This context covers `src/`. Applications built on top live under `apps/` and have their own contexts.

## Language

### Extensibility

**Provider**:
A SLOP capability exposed as a state tree plus affordances. Everything the agent can observe or act on is a provider. Providers are not privileged runtime branches.
_Avoid_: using interchangeably with Plugin.

**App**:
A descriptor-backed external Provider discovered by the Runtime. Apps are listed before they are connected, and are loaded into or unloaded from one Session's Hub explicitly.
_Avoid_: using for first-party Providers such as `terminal` or `filesystem`.

**Apps provider**:
The first-party Provider that exposes discovered external Apps to the Agent under `/available` and lets the Agent load or unload them. It projects Hub registration state; it does not own discovery, app processes, or provider internals.
_Avoid_: confusing it with the Session provider's public `/apps` mirror for UIs and external clients; using it to manage first-party Plugins or Providers.

**Plugin**:
A first-party package and the unit of the plugin catalog (`FIRST_PARTY_PLUGINS`). A Plugin may contribute one or more Providers and at most one Session plugin through the matching facet assembly; some do only one. It is the packaging/catalog unit, not a capability itself. A name shared between a Plugin and the Provider it creates (e.g. `skills`, `terminal`) refers to two distinct objects.
_Avoid_: calling a Plugin a Provider; calling the optional capabilities "optional providers" — they are Plugins.

**Session plugin**:
The Session extension a Plugin contributes (code type `SessionRuntimePlugin`). It can contribute SLOP session nodes, runtime-local turn tools, lifecycle and Turn hooks, Plugin-scoped client state, and typed client commands/contributions. A Plugin can exist without one (e.g. `terminal` contributes only a Provider) or be only one (e.g. `persistent-goal` contributes no Provider).
_Avoid_: shortening to "plugin" when the package is meant.

**Transient Plugin State**:
Session-local, Plugin-scoped state published through `PluginRuntimeContext.transientState`. It refreshes the compact Session provider and typed-client `pluginState` but is excluded from durable Session snapshots. Use it for live phases, partial captions, connection health, and resource ownership.
_Avoid_: tunnelling live runtime state through Extension records merely to trigger refreshes.

**Skill**:
A `SKILL.md` directory of instructions plus supporting files, loaded by progressive disclosure. A Skill is the runtime's **procedural memory** — a repeatable how-to workflow expressed as instructions over existing affordances. Contrast with the `memory` Provider (facts/episodic memory) and identity memory: those are different memory kinds, not Skills.
_Avoid_: treating "procedural memory" as a separate artifact — it is the role a Skill plays.

**UI**:
A client that consumes the typed Session or Supervisor API and renders it for a human. The TUI is a UI; a future web dashboard would be a UI. A UI is not a Provider and not part of the Runtime — UIs live under `apps/`.
_Avoid_: "frontend", "surface", "client" used loosely — the consumer of a Session that renders it for a human is a UI.

**Client contribution manifest**:
The declarative, UI-agnostic manifest a Session plugin publishes through the typed client snapshot. It describes typed commands/actions, status indicators, and notifications over stable snapshot paths. UI-specific presentation is an optional, ignorable hint; execution never depends on a TUI branch or a SLOP path/action pair.
_Avoid_: "TUI manifest" — the manifest is not TUI-specific.

### Session state

**Extension record**:
A namespaced, schema-versioned session state record under `/extensions` (code type `SessionExtensionRecord`), authored and owned by a Skill via `skill_manage`. A Session plugin may project an Extension record into a friendly dedicated node — e.g. the `persistent-goal` Session plugin projects the `goal` Extension record into `/goal`.
_Avoid_: bare "extension", "plugin metadata".

**Thinking output**:
Provider-returned, user-visible reasoning text or summary that may appear in assistant conversation state. It is not hidden chain-of-thought, private prompt internals, or opaque provider continuity metadata.
_Avoid_: raw thinking, chain-of-thought, private reasoning state.

### Agents

**Agent**:
The in-process agent loop — the thing that observes provider state and invokes affordances. Exactly one Agent per Session. The general concept; the terms below are its lifecycle states and topology forms.

**Child agent**:
A running Agent spawned in its own child Session via the delegation Plugin's `spawn_agent`. Exposes the same session-provider surface as its parent.
_Avoid_: "sub-agent" (used loosely in older docs).

**Remote agent**:
An external agent reached through the `a2a` Plugin via an Agent Card over JSON-RPC. Not an Agent in this runtime — it runs elsewhere.
_Avoid_: plain "agent".

**Agent profile**:
The reusable template in the meta-runtime `/profiles` node: instructions, `defaultSkillVersionIds`, and default capability masks. Not a running Agent — the thing an Agent node is built from.

**Agent node**:
An agent declared in the meta-runtime topology graph (`/agents` node). It references an Agent profile and layers its own capability masks, skill versions, and executor binding, and sits on routes and channels. The persistent *declaration* of an agent; when a route dispatches to it, it runs as a Child agent.
_Avoid_: conflating with Agent profile (the template) or Child agent (the running instance).

### Sessions

**Session**:
The runtime instance hosting exactly one Agent — its transcript, turn state, approvals, and activity — reachable over its own socket. Every Session is launched through the same layered config launcher; "scoped" is just an adjective for which layers were active (home-only vs home + workspace + project), not a distinct kind of Session.

**Session provider**:
The compact per-Session SLOP Provider exposing deliberate agent-relevant state such as `/session`, `/turn`, `/goal`, and `/conversation`. Ordinary application clients use the typed Session API instead.

**Approval mode**:
The Session-owned setting that determines whether auto-eligible pending approval items across the whole Session are resolved by normal user action or automatically by the Runtime. The supported modes are `normal` and `auto`; `auto` does not resolve items marked `autoApprovable=false`, the mode persists with the Session snapshot, and clients render and set it without owning auto-approval behavior.
_Avoid_: approval posture, local approval policy, TUI approval mode, yolo mode.

**Session supervisor**:
A typed application service that manages many Sessions through the Supervisor API. It owns lifecycle bookkeeping only; it does not schedule or route work and is not a SLOP Provider.
_Avoid_: calling it an orchestrator.

**Managed supervisor**:
A Session supervisor process started by a launcher and discoverable by later clients using that launcher's scope key. It is still only a Session supervisor; auto-close, process spawning, and scope-key choice are launcher mechanics, not orchestration.
_Avoid_: daemon, background orchestrator, TUI supervisor.

**Launch scope**:
The launcher-owned identity for grouping managed supervisor discovery and Session registry history. For `sloppy`, the Launch scope is `realpath(process.cwd())`, not the configured Workspace or filesystem Provider root.
_Avoid_: workspace when referring to cwd-scoped launcher identity.

**Launch-scope resume Session**:
The Session id a Launch scope records as the default target for `sloppy --continue`. It changes on fresh `sloppy` launch and intentional UI session switch, not on UI close or background Session activity.
_Avoid_: last active session, last closed session.

**Session registry**:
The supervisor-owned durable index of a Launch scope's Sessions. It records Session ids, lifecycle/history metadata, and the Launch-scope resume Session; individual Session snapshots remain owned by each Session runtime.
_Avoid_: transcript store, socket registry.

**Auto-close blocker**:
A reason a live Session should keep a managed supervisor running after all Supervisor client leases are gone. Core blockers come from generic Turn state; Plugin-specific blockers must be declared by Session plugins, not hardcoded in the supervisor.
_Avoid_: supervisor policy hook, goal special case.

**Supervisor client lease**:
The supervisor-side record that one connected client has selected a Session on a managed supervisor. It is bound to the client's supervisor connection, drives supervisor auto-close, and protects Stop Session from disrupting another client.
_Avoid_: raw socket connection count, heartbeat, polling.

**New Session**:
Create a fresh Session and switch the current UI to it. This is the normal way to move on from current work while keeping previous Session history restorable.
_Avoid_: stop, restart.

**Stop Session**:
End a live Session process while keeping its snapshot and registry entry restorable. It never creates a replacement Session; use New Session for that.
_Avoid_: close, delete, archive.

**Restore Session**:
Start a stopped Session from its durable snapshot so a UI can select it again. Restore uses stale-turn recovery for interrupted Turns rather than pretending in-flight work continued.
_Avoid_: resume when specifically discussing process restart mechanics.

**Archive Session**:
Remove a Session from normal resume and switch lists while retaining its snapshot for history or later recovery. Archive is distinct from Stop Session and from Delete Session.
_Avoid_: stop, delete.

**Delete Session**:
Permanently remove a Session's registry entry and durable snapshot. It is a destructive history operation, not the normal way to stop a live process.
_Avoid_: stop, archive.

**Child session**:
The Session a Child agent runs in. Exposes the standard Session provider surface, so a parent observes its child through SLOP like any other Session.

### Affordances and tools

**Affordance**:
A provider-native action attached to provider state — the provider-side term (SLOP). Secondary to state: state is observed first, affordances act second.

**Tool**:
The model-native definition the LLM actually calls — the model-side term. Every Tool has one of three kinds (code: `kind: "observation" | "affordance" | "local"`):
Runtime-owned Tool names are unbranded, verb-first names; protocol branding belongs in docs and descriptions, not in the Tool name. Projected Affordance tools keep provider-derived prefixes for disambiguation.

**Affordance tool**:
A Tool projected from a provider's Affordance. The bridge between the provider side and the model side.

**Observation tool**:
A fixed, Hub-owned Tool not backed by any Provider — `query_state`, `focus_state`, and `unfocus_state`. Lets the Agent read or manage State focus on demand.
_Avoid_: "consumer controls".

**Local tool**:
A turn-scoped Tool contributed by a Plugin and run inside the agent loop, not backed by any provider — e.g. `slop_wait_for_delegation_event`. Code `kind: "local"`.
_Avoid_: "local controls"; "runtime-local tool" is an acceptable longer alias.

**Affordance label**:
The human-readable name on an Affordance (`label`). Sloppy-owned Affordances must provide one; external Providers may omit it, and consumers then fall back to summaries or action names.
_Avoid_: "tool label" when the source is provider-side Affordance metadata.

**Result kind**:
A semantic label on an Affordance's metadata (`resultKind`) declaring how a UI should render that Affordance's result — e.g. `diff`, `terminal`, `code`. An open string: a UI keeps a closed set of renderers it implements and falls back gracefully for any kind it does not know. Carried back on the `tool_result` activity record so the UI can render a tool call's result without knowing the tool.
_Avoid_: "content kind" — the concept is the kind of an Affordance *result*.

**Bounded result data**:
The size-limited structured result captured for an Affordance invocation and exposed on the matching `tool_result` activity item. The Runtime preserves this data for UIs; it does not pre-render chat receipts or UI-specific views.
_Avoid_: generic "payload" when discussing Affordance results.

### Runtime

**Runtime**:
The whole running system: the Kernel plus whatever Plugins are loaded. "The default runtime" is the Kernel plus the default Plugins.

**Kernel**:
The lean, always-present substrate that remains when every optional Plugin is removed: the Agent loop, the Hub, the Session provider and Session supervisor, provider discovery, the approval queue, and the plugin manager. It has no orchestrator role, scheduler, or task DAG.
_Avoid_: using interchangeably with Runtime.

**Hub**:
The consumer-side substrate the Kernel owns for state subscriptions, query, invoke, and policy checks across all Providers.

**Provider lifecycle event**:
A Hub-owned notification that a Provider's connection state changed inside one Session. Runtime projections such as provider mirrors follow these events; unloading a Provider clears its live mirrors, and the caller that requested load or unload does not own those side effects.
_Avoid_: making the Agent-visible App controls and public Session `/apps` controls separate lifecycle paths.

**Provider lifecycle control**:
An Affordance or public Session control that changes whether a registered Provider is connected to one Session's Hub. Lifecycle controls may be logically repeatable, but they are not idempotent for agent-loop scheduling because they change the provider graph, tool surface, and future State projection.
Lifecycle controls are not approval-gated by default; dangerous-action policy applies when invoking Provider Affordances after an App is loaded.
_Avoid_: marking load/unload controls `idempotent: true` just because repeated calls are harmless.

**Load App**:
Connect a registered App Provider that is currently unloaded, disconnected, or errored into one Session's Hub. Loading an already connected App is a no-op, and loading does not add State focus; the loaded Provider appears through its Default projection until the Agent explicitly focuses more detail.
_Avoid_: reconnect when the App may never have been connected.

**Loaded App**:
An App Provider currently connected to one live Session's Hub. A Loaded App participates in normal State projection and dynamic Affordance tool projection; loaded state is not a durable preference and is not automatically restored in a new Session.
_Avoid_: treating previous attachment as startup policy.

**Reload App**:
Disconnect a connected App Provider from one Session's Hub and then connect it again. Reload is an explicit refresh operation for a currently connected App; use Load App for unloaded, disconnected, or errored Apps.
_Avoid_: reconnect, retry.

**App lifecycle status**:
The public attachment state for an App card: `connected`, `disconnected`, `error`, or `unloaded`. Reload does not introduce a separate transitional status; the affordance call itself carries in-flight progress.
_Avoid_: loading, reloading.

**Unloaded App**:
A discovered App that is registered in one Session's Hub but intentionally disconnected from that Hub. It remains visible as a clean app card for later loading, drops any existing State focus for that Provider, and does not carry `last_error`; failed Apps use `status=error` instead.
_Avoid_: treating unloaded as a failure or stopped external process.

**App card**:
The lightweight catalog entry for an App under the Apps provider's `/available` collection or the Session provider's `/apps` mirror. It is identified by stable `provider_id`; descriptor updates replace the card in place for the same id, but it is not a proxy for the App's downstream state tree or Affordance catalog.
_Avoid_: expanding unloaded Apps into shadow provider trees.

**Descriptor removal**:
Removal of an App descriptor from discovery. If the App is loaded, descriptor removal disconnects it from the Session Hub, clears live attachment metadata, and removes its App card.
_Avoid_: leaving orphaned connected Apps after their descriptor is gone.

**Connected affordance registry**:
The Hub-owned metadata learned from a Provider's currently connected state trees, including dangerous Affordance markers. It belongs to the current Provider attachment and is cleared on unload or reload before being rebuilt from the freshly connected Provider state.
_Avoid_: keeping stale Affordance metadata alive because an App card still exists.

**App process owner**:
The system that starts, stops, or supervises an external App process. A Session may connect to or unload the App's Provider, but it is not the App process owner unless a separate provider explicitly says so.
_Avoid_: making `unload_provider` terminate descriptor-backed external Apps.

**State focus**:
Hub-owned consumer attention over one or more Provider paths. Focused paths are kept in future ephemeral state-tail projections until explicitly removed. State focus is not Provider state, not UI expand/collapse state, and not the user's visual focus inside a UI.
`focus_state` adds or updates one focused path; it does not replace all focuses for that Provider. Removing focused paths is a separate Observation tool operation.
The Hub does not automatically evict State focuses. The Agent owns State projection hygiene by explicitly removing stale focuses; the Runtime may expose diagnostics or warnings but must not silently mutate the focus set.
`unfocus_state` removes only the exact Hub State focus for a provider/path and is idempotent. It does not invoke Provider Affordances or delete Provider-owned loaded state; Provider cleanup remains an explicit Provider Affordance such as a file-view `close_view`.
_Avoid_: expand/collapse when discussing the Runtime or Hub; use expand/collapse only for UI presentation metaphors.

**State projection**:
The Hub-owned construction of the Agent's model-facing state view from Provider overview subscriptions, State focuses, and small Runtime/Session status. It is the single Agent-side stitching point for the ephemeral state tail; Providers still own how their own trees resolve, summarize, window, and expose lazy detail.
_Avoid_: treating the TUI's Session view snapshot as the Agent's State projection.

**Default projection**:
The Provider-owned state shape returned for a shallow root subscription before the Agent expresses extra State focus. It is provider-specific: small Providers may inline all useful state, while large Providers should expose summaries, stubs, windows, or lazy nodes. The Default projection must be navigable enough for the Agent to decide what to inspect next, but detail after that is Agent-driven through Observation tools.
_Avoid_: assuming every Provider must be summary-only by default.

**Node-count compaction**:
Provider/SDK support for `max_nodes`-bounded output. Sloppy's Agent-facing Runtime does not use node-count compaction for State projection; it relies on Provider Default projections and Agent-driven State focus instead. The protocol/SDK may still support `max_nodes` for compatibility with other Consumers.
_Avoid_: using `max_nodes: -1` as an unlimited sentinel; omitted `max_nodes` is the unlimited request shape.

**Salience metadata**:
Optional Provider-owned metadata that Consumers may use for attention hints. Sloppy's Agent-facing Runtime does not use salience for filtering or scaling, but it preserves Provider-owned metadata when querying external App trees; Agent attention is expressed through State focus instead.
Sloppy-owned first-party Providers should not emit legacy salience/focus hints as a substitute for explicit State focus.
_Avoid_: treating salience as the primary Runtime scaling mechanism; stripping metadata from external App trees.

**File view**:
Provider-owned loaded text state for a filesystem file. A File view lets file content live in Provider state and State projection instead of permanent Tool-result history.
File views live under the filesystem Provider's top-level `/views` collection, not under directory entry nodes. File entry nodes may expose lightweight loaded-view counts or view-list affordances, but loaded content remains in `/views` so it stays stable when directory focus changes. Loaded File views are included in the filesystem Default projection as Provider-owned working memory; cleanup is an explicit filesystem Affordance such as `close_view`, not Hub `unfocus_state`.
Loaded File views inline their loaded text content in the filesystem Default projection. A Range view inlines only its loaded line window; a Full-file view inlines the whole loaded file content.
When the backing file version changes, the File view preserves the observed text and is marked stale with the current file version. The Provider does not silently refresh stale views; the Agent refreshes by reading again or removes the stale view with explicit cleanup.
Filesystem text `read` Affordance results should return compact File view references and metadata, not the text content itself. Text content belongs in File view state so it can leave the permanent Tool-result history and be removed later with explicit Provider cleanup.

**Full-file view**:
A File view covering the whole file for a specific source version. A full-file view supersedes same-version Range views for that file.

**Range view**:
A File view covering a specific line window for a file and source version. Multiple Range views may exist for distant regions of the same file until a Full-file view exists for the same source version.

**View supersession**:
Filesystem rule that a successful Full-file view removes redundant same-version Range views for that file. If a same-version Full-file view already exists, later partial reads are redundant and should return the existing Full-file view reference instead of creating new Range views.

### Workspaces and config

**Workspace**:
A folder-bound root with its own config file — the outer container. Holds Projects.

**Project**:
A project folder belonging to a Workspace — the inner unit.

**Config layer**:
One of `global`, `workspace`, or `project` — the three config sources merged in that order (later overrides earlier) to produce a Session's effective config.

**Scope**:
A launchable target: a Workspace, optionally narrowed to a Project. Listed under the Session supervisor's `/scopes`; launching a Session into a Scope fixes which Config layers it merges and pins its terminal/filesystem roots.
_Avoid_: the glossary uses Scope only for the launch target — note the code also reuses the word `scope` for the Config layer enum.

### Meta-runtime topology

The `meta-runtime` Plugin is the substrate for evolving internal agent-to-agent structure. Its graph is state; the Agent changes the graph by proposing typed topology operations.

**Message envelope**:
The typed payload dispatched through the meta-runtime (code `RouteMessageEnvelope`): `id`, `source`, `topic`, `body`, metadata.
_Avoid_: bare "message".

**Route**:
A meta-runtime rule (code `RouteRule`) that matches Message envelopes by `matchField` / `matchMode` and, on match, dispatches them to a target — `agent:<id>` (an Agent node) or `channel:<id>` (a Channel). Carries `traffic.sampleRate` for deterministic canary delivery. A rule, not a destination.

**Channel**:
A participant group in the topology graph (code `AgentChannel`, with `participants`). A `channel:<id>` dispatch target sends via `messaging.channels/{id}.send`, but only for envelopes whose source is a participant. A destination, not a rule.

**Capability mask**:
An allow or deny set scoping what an Agent node or Agent profile may do. Session-scoped deny masks count as tightening and auto-apply; allow masks require approval.

**Executor binding**:
The record (`/executor-bindings`) describing how and where a given agent's loop is executed.

**Skill version**:
A pinned version of a Skill (`/skill-versions`), activated via `activateSkillVersion`. Agent profiles list `defaultSkillVersionIds`; Agent nodes list `skillVersionIds`; selected versions are frozen into a routed Child agent's goal at spawn.
_Avoid_: treating Skill versions as ambient global prompt state.

**Experiment**:
A recorded topology experiment (`/experiments`) comparing graph variants; promotion requires recorded evaluation evidence.

### Loop and consumers

**Consumer**:
The other half of the SLOP Provider/Consumer duality: anything that observes Provider state and invokes affordances through the Hub. Three kinds here — the Agent itself, first-party UIs (the TUI), and external API clients.

**Turn**:
One cycle of the Agent loop: build the context with the live state tail, call the LLM, execute the resulting Tool calls. Projected at `/turn`. A Turn can be *parked* (e.g. by a Local tool awaiting a delegation event); *stale-turn recovery* restores a Turn interrupted by a crash.

## Example dialogue

> **Dev:** Is `memory` a provider or a plugin?
> **Expert:** Both, at different layers. The `memory` Plugin is the catalog package. It calls `createProviders` to register the `memory` Provider — that's the capability with the state tree and affordances. Some plugins also produce a Session plugin; `memory` may or may not. Don't say "the memory plugin's affordances" — affordances belong to the Provider.

> **Dev:** A Route fired and an agent picked up the work. Which agent?
> **Expert:** The Route matched a Message envelope and dispatched it to an `agent:<id>` target — that's an Agent node, the topology declaration. Dispatch then spawned it as a Child agent: a real running Agent in its own Child session. The Agent node isn't running; the Child agent is.

> **Dev:** The Agent called `query_state` mid-turn. Is that an affordance?
> **Expert:** No. That's an Observation tool — a fixed Tool with no Provider behind it. An Affordance tool is the only kind of Tool projected from a Provider's Affordance. The third kind, a Local tool, can park the Turn.

> **Dev:** Can the UI show the model's thinking?
> **Expert:** Only Thinking output: provider-returned text or summaries intended to be visible. Hidden chain-of-thought and opaque provider continuity metadata are not public Session state.
