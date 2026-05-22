# Sloppy Core Runtime

The SLOP-native agent runtime: the kernel, the agent loop, the provider/consumer substrate, and the session boundary. This context covers `src/`. Applications built on top live under `apps/` and have their own contexts.

## Language

### Extensibility

**Provider**:
A SLOP capability exposed as a state tree plus affordances. Everything the agent can observe or act on is a provider. Providers are not privileged runtime branches.
_Avoid_: using interchangeably with Plugin.

**Plugin**:
A first-party package and the unit of the plugin catalog (`FIRST_PARTY_PLUGINS`). A Plugin may contribute one or more Providers (`createProviders`) and at most one Session plugin (`createSessionPlugin`); some do only one. It is the packaging/catalog unit, not a capability itself. A name shared between a Plugin and the Provider it creates (e.g. `skills`, `terminal`) refers to two distinct objects.
_Avoid_: calling a Plugin a Provider; calling the optional capabilities "optional providers" — they are Plugins.

**Session plugin**:
The session-provider extension a Plugin produces via `createSessionPlugin` (code type `SessionRuntimePlugin`). It registers into the session provider, contributing session nodes, runtime-local turn tools, hooks, policy rules, and a declarative UI contribution manifest. A Plugin can exist without one (e.g. `terminal` contributes only a Provider) or be only one (e.g. `persistent-goal` contributes no Provider).
_Avoid_: shortening to "plugin" when the package is meant.

**Skill**:
A `SKILL.md` directory of instructions plus supporting files, loaded by progressive disclosure. A Skill is the runtime's **procedural memory** — a repeatable how-to workflow expressed as instructions over existing affordances. Contrast with the `memory` Provider (facts/episodic memory) and identity memory: those are different memory kinds, not Skills.
_Avoid_: treating "procedural memory" as a separate artifact — it is the role a Skill plays.

**UI**:
A client that consumes a Session provider (or Session supervisor) over its socket and renders it for a human. The TUI is a UI; a future web dashboard would be a UI. A UI is not a Provider and not part of the Runtime — UIs live under `apps/`.
_Avoid_: "frontend", "surface", "client" used loosely — the consumer of a Session that renders it for a human is a UI.

**UI contribution manifest**:
The declarative, UI-agnostic manifest a Session plugin publishes (code type `UiContributionManifest`, exposed at `/plugins`) describing how it extends a UI: state subscriptions, affordance-bound actions, status indicators, and notifications. UI-specific presentation is an optional, ignorable hint keyed by UI; the manifest itself names no rendering technology.
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
The per-Session public SLOP Provider exposing one Session's surface (`/session`, `/turn`, `/transcript`, `/goal`, `/approvals`, `/activity`, `/tasks`, …). The boundary first-party UIs and external clients consume.

**Session supervisor**:
A separate public SLOP Provider that manages many Sessions — `/sessions`, `/scopes`, `create_session`, `set_active`. Owns lifecycle bookkeeping only; it does not schedule or route work.
_Avoid_: calling it an orchestrator.

**Child session**:
The Session a Child agent runs in. Exposes the standard Session provider surface, so a parent observes its child through SLOP like any other Session.

### Affordances and tools

**Affordance**:
A provider-native action attached to provider state — the provider-side term (SLOP). Secondary to state: state is observed first, affordances act second.

**Tool**:
The model-native definition the LLM actually calls — the model-side term. Every Tool has one of three kinds (code: `kind: "observation" | "affordance" | "local"`):

**Affordance tool**:
A Tool projected from a provider's Affordance. The bridge between the provider side and the model side.

**Observation tool**:
A fixed, consumer-side Tool not backed by any provider — `slop_query_state` and `slop_focus_state`. Lets the Agent read or focus state on demand.
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

> **Dev:** The Agent called `slop_query_state` mid-turn. Is that an affordance?
> **Expert:** No. That's an Observation tool — a fixed Tool with no Provider behind it. An Affordance tool is the only kind of Tool projected from a Provider's Affordance. The third kind, a Local tool like `slop_wait_for_delegation_event`, can park the Turn.

> **Dev:** Can the UI show the model's thinking?
> **Expert:** Only Thinking output: provider-returned text or summaries intended to be visible. Hidden chain-of-thought and opaque provider continuity metadata are not public Session state.
