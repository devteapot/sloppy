# Architecture

## Design principles

1. **State is primary.** The runtime observes state trees first and invokes affordances second.
2. **Everything is a provider.** Built-in capabilities and external applications both enter the system through SLOP providers.
3. **Tool use is only an adapter.** Provider-native tool calling is the LLM-facing execution format, not the architectural model.
4. **Subscriptions beat polling.** The harness should stay on live state through `snapshot` + `patch`, then deepen only where needed.
5. **Thin core, fat providers.** The runtime coordinates history, subscriptions, and model calls; capability-specific logic lives in providers.
6. **The core is headless.** Human-facing interfaces should consume a public session boundary instead of importing privileged runtime internals.

---

## Runtime overview

```text
TUI / Web UI / IDE / Voice UI / other agents
        |
        v
Agent Session Provider
  - transcript
  - turn status
  - tool activity
  - approvals
  - session affordances
        |
        v
Agent Runtime
  - LLM adapter (Anthropic/OpenAI-compatible/Gemini)
  - RuntimeToolSet
  - Agent Loop
  - ConsumerHub
        |
        v
Providers
  - built-in in-process providers
  - external unix/websocket providers
```

The key difference from a traditional tool harness is that the runtime does not start from a registry of global tools.

It starts from a set of subscribed state trees.

The agent process therefore plays both roles:

- **consumer** of workspace and application providers
- **provider** of agent-session state to user interfaces and other clients

---

## Core components

### 1. Agent loop

`src/core/loop.ts`

Responsibilities:

- build the current visible state context
- expose fixed observation tools plus dynamic affordance tools
- call the model
- execute tool calls
- append tool results to history
- continue until the model ends the turn naturally

This loop is intentionally small. It should feel closer to Hermes's clean orchestration layer than OpenClaw's deeply integrated runtime stack.

### 2. Consumer hub

`src/core/consumer.ts`

Responsibilities:

- connect to all registered providers
- maintain one `SlopConsumer` per provider
- keep a shallow overview subscription per provider
- optionally keep one deeper focused subscription per provider
- route `query` and `invoke` calls through a hub-level `InvokePolicy` (see §8)
- own a single `ApprovalQueue` (`approvals`) that backs every per-provider
  `/approvals` collection
- expose the merged visible state to the rest of the runtime

This is the architectural center of Sloppy. It replaces the plugin/tool registry layer that dominates MCP-first runtimes.

Each `invoke` call flows through `policy.evaluate({ providerId, action, path, params, roleId, config })` before reaching the provider. A `deny` decision raises `PolicyDeniedError`; a `require_approval` decision enqueues the call into `hub.approvals` and returns the SLOP `approval_required` error. Approving the queued entry re-invokes the action with `confirmed: true`. The default policy is `allowAllPolicy`, so call sites and tests that do not install rules see no behavior change.

### 3. Runtime tool set

`src/core/tools.ts`

The runtime exposes two kinds of tools to the selected model:

1. **Fixed observation tools**
   - `slop_query_state`
   - `slop_focus_state`
2. **Dynamic affordance tools**
   - generated from the currently visible provider state using `affordancesToTools()`

All LLM-facing tool parameters are emitted as a strict JSON Schema object:
`type: "object"`, explicit `properties`, explicit `required`, and
`additionalProperties: false`. Provider affordance params remain the source of
truth; the runtime normalizes them for OpenAI, Anthropic, and Gemini adapters so
models see the same contract everywhere.

This is important.

The LLM still uses native tool calling, but the runtime preserves the SLOP distinction between:

- observation by the consumer
- action by the provider

### 4. Context builder

`src/core/context.ts`

Responsibilities:

- render visible provider trees with `formatTree()`
- shrink state using depth, node-budget, and salience heuristics
- keep the system prompt stable and place live state in an ephemeral runtime snapshot message

The state snapshot is not persisted as user-authored conversation. It is rebuilt for each model turn.

### 5. History manager

`src/core/history.ts`

Responsibilities:

- keep the recent real user turns
- preserve assistant/tool-result bundles inside those turns
- truncate oversized tool results before they poison the context window

OpenClaw's tool-result compaction discipline is the right influence here, but the initial implementation is intentionally smaller.

### 6. Provider registry and discovery

`src/providers/registry.ts`
`src/providers/discovery.ts`

Responsibilities:

- create built-in providers
- discover external SLOP providers from descriptor files
- watch descriptor directories and reconcile external providers live
- attach the right transport per provider

The current implementation supports:

- built-in in-process providers for terminal, filesystem, orchestration, memory, skills, browser, web, cron, messaging, delegation, spec, and vision
- external Unix socket providers
- external WebSocket providers

The orchestration provider now exposes the docs/12 HITL artifact layer
additively beside the legacy task state machine: `/goals`, `/gates`,
`/messages`, `/precedents`, `/audit`, `/blobs`, and `/digests`, plus plan-revision and typed-evidence
affordances on `/orchestration` and `/tasks`. Legacy `create_plan`,
`create_task`, `create_tasks`, `record_verification`, and task completion stay
available without docs/12 gates. Accepted plan revisions opt into HITL gating:
their slices require typed evidence, an accepted `slice_gate`, a fresh referenced
spec version, and a passing final audit before plan completion. Final audit
replays allowlisted replayable evidence commands against the current workspace
and stores command output as orchestration blobs.
As a first policy-resolver increment, plan revisions may set
`slice_gate_resolver: "policy"`, and provider config may set scoped gate-policy
defaults at the session, goal, spec, and slice levels. Evidence-complete slice
gates using the policy resolver are accepted deterministically with policy and
evidence refs recorded on the gate.
Precedents and case records are persisted under `.sloppy/precedents/` with
deterministic structural keys, optional question embeddings, semantic or lexical
match bands, use counters, contradiction flags, and explicit invalidation on
overlapping spec revisions. Opted-in lookup/inference `SpecQuestion` messages
can auto-resolve from high-confidence precedent matches or from borderline
matches accepted by an injected or LLM-profile-backed tie-break policy hook,
with the policy, precedent, score, score source, band, structural keys, and
answer recorded on the resolved protocol message. Borderline rejections keep the
question open with a persisted escalation attempt.
Digests are generated on demand as immutable typed records summarizing headline
state, escalations, policy auto-resolutions, near-misses, persisted drift events
and metrics, configured wall-time/retry/token/cost budget burn, next slices, and
typed control actions for dashboard or terminal renderers, including budget-cap
raise refs that invoke `/budget.raise_budget_cap`. Escalation, final, and
status-change digests also create pending push-delivery outbox records under the
orchestration store; configured generic, Slack, or email transports can dispatch
those records through `/digests` while the store retains attempt counts, delivery
errors, and external refs. No network digest delivery is enabled by default.
When a
plan exceeds its configured wall-time budget, digest
generation opens a `budget_exceeded` gate for the resolver. When a retry would
exceed the configured retry-per-slice cap, the replacement is rejected and a
`budget_exceeded` gate is opened for that logical slice. Token and USD cost
usage is persisted as budget-usage records, summarized in digests, and opens
the same gate type when a configured cap is exceeded. Raising covered caps
updates the active plan budget and resolves matching open budget gates.
Evidence submission and task completion now run deterministic drift/guardrail
checks. Evidence regressions, repeated same-class failures, untraced
dependency/public-surface changes, accepted-criterion mismatches, and
blast-radius cap violations create blocking `drift_escalation` gates;
irreversible-action risk declarations always create user gates; blocking drift
prevents policy auto-accept by forcing the slice gate back to the user resolver.
File-only coverage gaps are persisted as warning drift events and surfaced in
provider state and digests.

The spec provider owns spec artifacts and now persists immutable version
snapshots under `.sloppy/specs/`, with optional `goal_id`/`goal_version` refs and
criterion metadata on requirements. Spec acceptance is gated through an accepted
orchestration `spec_accept` gate, while the orchestration provider remains the
coordination owner for gates and plan execution.
The session provider exposes `start_spec_driven_goal` as the public docs/12
entrypoint: it creates/revises the goal, writes spec-agent protocol messages,
opens the `spec_accept` gate, optionally accepts the spec, writes planner-owned
plan-revision proposals, and can accept the plan gate into schedulable slices.

### 7. Agent session provider

Checked-in location: `src/session/`.

Responsibilities:

- expose a running agent session as SLOP state
- accept user-facing session affordances such as `send_message`, `cancel_turn`, `approve`, `reject`, and LLM-profile management actions
- stream transcript updates, tool activity, and pending approvals through `snapshot` + `patch`
- mirror provider-native approvals and async tasks from downstream providers into session state
- expose LLM readiness, saved profiles, and onboarding state without leaking secrets
- support multiple concurrent consumers attached to the same session
- keep the first-party UI on the same public contract that third-party UIs will use

This boundary is the intended long-term interface surface for Sloppy. The current CLI REPL is a development shell, not the final public integration model.

The concrete session tree and affordance contract are defined in `docs/06-agent-session-provider.md`.

### 8. Policy, roles, and runtime extensions

A small set of seams in the core let provider/role behavior layer onto the
generic kernel without the kernel knowing about any specific extension.

**`InvokePolicy` (`src/core/policy.ts`).** A pluggable boundary on
`ConsumerHub.invoke`. A policy returns `allow`, `deny`, or `require_approval`
for an `InvokeContext` carrying the provider id, action, path, params, the
optional `roleId` for the current run, and the live config. `CompositePolicy`
chains rules and short-circuits on the first non-allow decision.
`PolicyDeniedError` is the stable error type. Built-in rules in
`src/core/policy/rules.ts`:

- `terminalSafetyRule` — elevates destructive shell commands and file
  output redirection to `require_approval` (replaces the inline
  `looksDestructive` check that used to live in the terminal provider).
- `orchestratorRoleRule` — denies file mutations, direct delegation spawns,
  and non-whitelisted shell commands when `roleId === "orchestrator"`.
- `dangerousActionRule` — auto-elevates any affordance whose action descriptor
  is marked `dangerous: true` to `require_approval`.

The terminal provider's old `cd` traversal escape was tightened during this
move: `cd` now rejects paths that resolve outside the workspace root.

**`ApprovalQueue` (`src/core/approvals.ts`).** Single source of truth for
every approval request the system surfaces. `ConsumerHub.approvals` is the
hub-owned instance; per-provider `/approvals` SLOP collections (built by
`ProviderApprovalManager` in `src/providers/approvals.ts`) are filtered views
backed by the shared queue once attached. The external SLOP shape is
unchanged: `/approvals/{id}` with `approve`/`reject` actions on each provider.

**`RoleProfile` and `RoleRegistry` (`src/core/role.ts`).** Roles are
`{ id, systemPromptFragment?, transformInvoke?, attachRuntime?, ... }`.
`transformInvoke` rewrites tool params before dispatch (used by the
orchestrator role to inject planning-policy edges). `RoleRegistry` holds role
factories registered by extensions in `attachRuntime`; the agent resolves a
role by id at start time so the kernel never names specific roles.

**`attachRuntime` extension pattern.** Both providers and roles can implement
`attachRuntime(hub, config, ctx)`. The agent calls these on start and passes a
`RuntimeContext` containing `hub`, `config`, a generic `publishEvent` on the
event bus, the `roleRegistry`, and `delegationHooks` (a `setTaskContextFactory`
seam exposed by the delegation runtime). This is how the orchestration
extension wires its role, hub policy rule, scheduler-event forwarding, and
TaskContext factory in without the kernel knowing about orchestration.

**`TaskContext` (`src/runtime/orchestration/task-context.ts`).** The opaque
contract a sub-agent runner receives from whichever extension owns a task.
The runner calls `ensureTask`, `buildInitialPrompt`, `recordTransition`,
`recordCompletion`, and `recordFailure`, and consults
`disableBuiltinProviders` to strip planning-layer providers from child runtimes
— it never references orchestration directly. (Confirmed: `src/session/*` and
`src/runtime/delegation/sub-agent.ts` carry zero orchestration references.)

**Coding-domain planning policy (`src/runtime/orchestration/planning-policy.ts`).**
The classifiers (`isScaffoldTask`, `isUiTask`, `isDataModelTask`,
`isDocumentationTask`, `isVerificationTask`) and `inferBatchDependencyRefs`
live in the role layer, not the orchestration provider. The orchestrator
role's `transformInvoke` injects inferred edges into `create_tasks` params
before dispatch; the provider only validates explicit `depends_on`.

---

## Interface model

### Consumers are not only LLMs

SLOP does not require the consumer to be a language model.

For Sloppy, a terminal UI, web UI, IDE integration, or voice client can consume the same session provider that wraps the running agent.

That keeps the architecture consistent:

- downstream capabilities still arrive as provider state and affordances
- upstream interfaces also see state and affordances, not ad hoc imperative RPC

### Shared session state vs local UI state

The session provider should expose state that is meaningful across multiple clients:

- transcript and multimodal message content
- LLM readiness and saved profile summaries
- active turn status
- tool calls, tool results, and async tasks
- pending approvals and policy gates
- current visible provider summaries and focus
- external app attachment summaries and connection errors

It should not try to own purely local rendering state such as:

- cursor position
- scroll offsets
- pane focus
- theme or layout choices

Those belong to the individual UI unless collaborative UI behavior is explicitly desired.

### Multi-client and multimodal sessions

Multiple consumers should be able to attach to the same agent session at the same time.

This implies:

- the session state must be patch-friendly and shareable
- inputs and outputs should not assume text-only rendering
- large or binary artifacts should be represented through content references rather than inlined blobs

### Future agent-to-agent use

This same shape can support future agent-to-agent communication.

Another agent could consume a session or delegation provider and interact through state plus affordances instead of a custom RPC layer.

That opens the door to supervisor-worker patterns, review loops, and delegated subtasks, while still requiring clear identity, authorization, and cycle-avoidance rules.

The checked-in ACP integration follows this rule: Agent Client Protocol agents are launched only behind the `SessionAgent` boundary for delegated children. Their prompt stream, tool updates, permissions, and cancellation are translated into the same SLOP session-provider state; ACP does not replace the core provider/consumer model.

---

## Subscription strategy

The harness uses a two-level default subscription model.

### Overview subscription

Each connected provider gets a shallow root subscription.

Purpose:

- provider presence
- top-level context
- visible affordances on important roots
- patch-driven updates without loading the full app

### Detail subscription

The model can move a provider into deeper focus via `slop_focus_state`.

Purpose:

- drill into one subtree that matters right now
- carry that deeper state into future turns
- avoid global `depth=-1` subscriptions

### One-off query

`slop_query_state` performs a deeper read without changing the maintained focus.

This follows the scaling guidance in the SLOP spec rather than the usual “subscribe to everything and hope it fits” approach.

---

## Built-in provider shapes

### Terminal provider

The terminal provider is stateful.

It exposes:

- `session` context node
- `history` collection
- `tasks` collection

Example shape:

```text
[root] terminal: Terminal
  [context] session (cwd="/repo", shell="/bin/zsh")  actions: {execute(...), cd(path: string)}
  [collection] history
    [item] cmd-1 (command="printf hello", status="ok")  actions: {show_output}
  [collection] tasks
    [item] task-123 (status="running", message="Running")  actions: {cancel, show_output}
```

Long-running commands are represented as async task nodes under `tasks`.

### Orchestration provider

The orchestration provider is a durable planning and verification surface backed
by `.sloppy/orchestration/`, with docs/12 precedents stored under
`.sloppy/precedents/`. It is implemented as a directory of focused
modules under `src/providers/builtin/orchestration/` (`types.ts`, `storage.ts`,
`normalization.ts`, `classifiers.ts`, `dag.ts`, `precedents.ts`, and `index.ts`
for the class facade) rather than a single file.

The provider itself is generic: it validates explicit `depends_on` references,
rejects dependency cycles, enforces verification/finding gates, and persists
state. It does not classify tasks or invent dependency edges. Coding-domain
planning policy (scaffold/UI/data/docs/verification heuristics and inferred
parallel-friendly edges) lives in `src/runtime/orchestration/planning-policy.ts`
and is applied by the orchestrator role through `RoleProfile.transformInvoke`
on `create_tasks` invocations — see §8.

The orchestration runtime is not special-cased by the kernel. It registers
itself via the `attachRuntime` extension hook (see §8). On attach, it:

- registers the `orchestrator` role on the agent's `RoleRegistry`,
- installs `orchestratorRoleRule` on the hub policy,
- exposes a `TaskContext` factory through `DelegationRuntimeHooks` so
  scheduled sub-agents inherit task lifecycle behavior, and
- forwards scheduler events through the runtime event bus' generic
  `publishEvent` channel.

It exposes:

- `orchestration` context node for the active plan and plan-level actions
- `tasks` collection with task definitions, state, dependencies, result previews,
  spec refs, audit links, finding refs, and verification coverage
- `handoffs` collection for typed cross-task questions, artifact requests,
  decisions, dependency signals, and responses
- `findings` collection for structured audit findings tied to tasks and spec refs

Tasks are stateful contracts, not just labels. `create_tasks` can batch-create a
DAG with local `client_ref` values; dependency refs are normalized to canonical
task ids from ids, names, refs, or aliases. Tasks may also carry `kind`,
`spec_refs`, `audit_of`, and `finding_refs` so spec-driven implementation,
audit, and repair loops stay visible as durable state. The provider rejects
dependency cycles before writing a batch, and task/handoff/finding visibility is
scoped to the current plan id so a cancelled or completed plan does not leak
stale blockers into the next run. For common coding plans, missing scaffold,
docs, and final verification edges are conservatively inferred so setup still
precedes file-producing implementation work, while independent implementation
tasks such as data/context and UI can fan out after scaffold unless the model
explicitly adds a blocking dependency. If a
model accidentally passes the task array as a JSON string, parseable arrays are
accepted and normalized into the same typed task definitions. Task completion is
gated by verification: when
`acceptance_criteria` exist, every criterion must be covered by `passed` or
`not_required` verification evidence before `complete` appears as a successful
path. Verification records can cite `evidence_refs` such as file paths,
commands, state paths, screenshots, or URLs so UIs can audit whether claims are
backed by concrete artifacts. Passed evidence covering acceptance criteria must
include refs, and file-like refs are validated against the workspace before the
verification record is accepted. Plan completion is also blocked while a
blocking audit finding remains open; findings can be repaired through linked
tasks, accepted as intentional deviations, dismissed, or marked fixed after
re-audit. In orchestrator mode, file mutations, direct delegation spawns, and
non-whitelisted shell commands are rejected at the hub policy boundary by the
`orchestratorRoleRule` (`src/core/policy/rules.ts`), which the orchestration
extension installs through `hub.addPolicyRule(...)` on attach. The rule
activates only when the run loop tags an invocation with
`roleId === "orchestrator"` via `hub.setInvocationMetadata({ roleId })`. The
orchestrator may still run a small whitelist of verification commands
(`build`, `lint`, `test`, `typecheck`); repairs must be delegated through
tasks.

Sub-agent context is scoped at the task boundary. When a scheduled task starts,
`SubAgentRunner` builds a work packet from the task definition, acceptance
criteria, completed dependency result previews, linked findings, and
requirements/decisions named by `spec_refs`. Child runtimes have their
orchestration, delegation, and spec providers disabled so they perform leaf work
against an explicit contract instead of recursively rewriting the plan or spec.
If a child needs more context, it records that need through its final result or a
typed handoff.

Handoffs are structured records, not free-form chat. A request can include
`kind` (`question`, `artifact_request`, `review_request`, `decision_request`, or
`dependency_signal`), `priority`, `blocks_task`, `spec_refs`, and
`evidence_refs`. Responses can cite `decision_refs`, supporting `evidence_refs`,
and `unblock: true` when the answer is intended to release the receiver.

### Spec provider

The spec provider is a durable source-of-truth surface backed by
`.sloppy/specs/`.

It exposes:

- `specs` collection with active spec metadata and spec-level actions
- per-spec `requirements`, `decisions`, and `changes` child collections

Specs are intentionally separate from orchestration plans. A spec can outlive a
single run, while orchestration tasks reference concrete spec requirements or
decisions through `spec_refs`. Proposed changes are recorded under the spec and
must be approved or rejected instead of letting implementation drift silently
rewrite the source of truth.

Runtime execution is now scheduler-assisted rather than model-scheduled. The
orchestration provider remains the durable state source, but a lightweight
`OrchestrationScheduler` watches task and delegation patches, computes runnable
pending tasks, claims them with the task-level `schedule` affordance, and starts
delegated agents when capacity is available. The scheduler emits
`task_unblocked`, `task_scheduled`, `task_started`, `scheduler_idle`, and
`scheduler_blocked` events for dashboard visibility. The model still creates and
revises plans, records verification evidence, handles handoffs, and decides
retry/repair semantics; it should not manually spawn delegation agents for
ready orchestration tasks.

### Filesystem provider

The filesystem provider is also stateful.

It exposes:

- `workspace` collection with a focused directory
- `search` collection for the last search results
- `recent` collection for recent filesystem operations

Example shape:

```text
[root] filesystem: Filesystem
  [collection] workspace (focus="src")  actions: {set_focus(path), read(path), write(path, content), mkdir(path), search(pattern, path)}
    [collection] entries
      [item] index.ts  actions: {read, write(content)}
      [item] components  actions: {focus}
  [collection] search
  [collection] recent
```

This keeps directory listings and search results visible as state, rather than forcing the model to rediscover them through imperative read tools.

### Phase 2 built-in providers

These are opt-in; defaults are lean. Only `terminal`, `filesystem`, `memory`, and `skills` are enabled by default — the rest are flipped on via `providers.builtin.<name>: true` in config (or via `withOrchestratorBuiltins(config)` for the orchestrator-role bundle).

The provider surface now extends beyond the initial terminal/filesystem pair.

Additional built-ins currently checked in:

- `memory`
  - `session`, `memories`, `tags`, `approvals`
  - supports memory add/search/update/delete, compaction, weak-memory pruning, and approval-gated clear-all
  - planned tiering (general vs role, cross-project vs project-bound) is sketched in `docs/11-memory-tiers.md`
- `skills`
  - `session`, `skills`, `approvals`
  - supports skill discovery refresh and reading installed skill content
- `browser`
  - `session`, `tabs`, `history`
  - supports navigation, tab switching/closing, screenshots, and history traversal
- `web`
  - `session`, `search`, `history`, `approvals`
  - supports web search, URL reads, and result/history replay
- `cron`
  - `session`, `jobs`, `approvals`
  - supports adding, running, toggling, deleting, and clearing scheduled jobs
- `messaging`
  - `session`, `channels`, `approvals`
  - supports channel creation/removal, outbound send, and message-history reads
- `delegation`
  - `session`, `agents`
  - supports agent spawning, push-observed lifecycle state, cancellation, and result retrieval
- `spec`
  - `specs`
  - supports active specs, requirements, decisions, and proposed spec changes
- `vision`
  - `session`, `images`, `analyses`, `approvals`
  - supports image generation, image analysis, cached outputs, and result inspection

---

## Why native provider tool use

Sloppy does not use a custom XML or JSON action parser.

Instead:

- visible affordances are converted to provider-native tool definitions
- fixed observation tools are added alongside them
- tool input contracts use a normalized JSON Schema object with explicit required fields
- Anthropic emits `tool_use`, OpenAI-compatible providers emit tool calls, and Gemini emits `functionCall`
- the runtime maps tool names back to `{ provider, path, action }`

This resolves two early design questions:

1. We do not need a custom action syntax.
2. Affordance-to-tool mapping stays dynamic and state-driven.

---

## Influences: reuse vs replace

### Reuse from OpenClaw

- tool-result truncation discipline
- strong runtime boundaries between config, model adapter, and execution loop
- cautious handling of long-running operations and partial failure

### Reuse from Hermes

- clean agent loop orchestration
- skills and memory as future layers, not Phase 1 blockers
- practical session persistence ideas for later SQLite-backed history/search

### Replace from both

- flat tool catalogs
- MCP as the primary capability model
- plugin registries as the central abstraction
- read tools as the main way the model reconstructs application state

The central replacement is simple:

**tool registry → consumer hub + provider state**

---

## Current tradeoffs

- The adapter layer supports native Anthropic and Gemini integrations plus an OpenAI-compatible path for OpenAI, OpenRouter, and Ollama.
- The initial history strategy is bounded and truncated, not yet summarized by a compaction model call.
- Provider discovery is live watched and fully reconciles descriptor add, update, and remove events, but unsupported transports are still skipped.
- The published SLOP npm packages are used directly, but the harness currently relies on the browser-safe consumer entrypoint because the top-level consumer package export is not usable as-is.
- The session provider mirrors downstream provider-native approvals and async tasks into shared session state, exposes shallow external app attachment state for TUI/debug visibility, and mirrors compact orchestration gate/digest controls for dashboard and TUI clients.
- The broader built-in provider surface is now real, but several providers still use simulated or local-only implementations where external integrations are not wired yet (notably browser, delegation, and vision).
- Skill discovery exposes both item-level affordances and a session-level `view_skill(name)` fallback because direct item invocation on skills hit a routing quirk during implementation.

These are acceptable tradeoffs for the current pre-alpha runtime. None of them alter the core SLOP-first design.
