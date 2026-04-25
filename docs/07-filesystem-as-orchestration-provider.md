# Filesystem-as-Orchestration-Provider

## Research: Agent Orchestration via Shared Filesystem State

**Date:** 2026-04-23
**Author:** Research agent, spawned by Hermes
**Status:** Phases 1–6 landed — filesystem CAS (atomic under concurrent writes), sub-agent federation, durable `OrchestrationProvider` (with persisted versions), handoffs, parent→child approval forwarding with auto-mirror, and task dependency enforcement are all shipped. Each `SubAgentRunner` auto-mirrors its lifecycle into a `tasks/{id}/` directory.

---

## 1. The Core Idea

The hypothesis: **the filesystem itself can serve as the shared state layer for multi-agent orchestration**. Instead of optimistic polling, read-before-write, or a centralized message bus, agents observe file state through the existing SLOP filesystem provider's subscription/patch mechanism. When a file changes, all consumers are notified. The orchestrator always has real-time visibility into every agent's state, and every agent always has real-time visibility into the filesystem.

This is not novel filesystem-as-storage; it is filesystem-as-**orchestration-protocol**.

**Two complementary layers.** Durable coordination state (plans, task definitions, results, handoffs) lives in the filesystem provider — inspectable, diffable, crash-recoverable. Live agent state (current turn, pending messages, approvals, activity stream) is exposed through a per-agent **session provider** (see `docs/06-agent-session-provider.md`), so orchestrators can observe a running sub-agent without re-reading `progress.md` on every tick. The filesystem is the durable fabric; the session provider is the live surface. Both speak SLOP, both push patches, both are observed the same way.

---

## 2. Current Architecture Analysis

### What Sloppy Already Has

The SLOP architecture already implements the conceptual foundation for this:

1. **State-first design:** The runtime observes state trees first, invokes affordances second. The filesystem provider exposes directory listings, search results, and recent operations as state -- not blind file-read tools.

2. **Subscription-based updates:** The ConsumerHub maintains overview and detail subscriptions per provider. Patches arrive push-style, not via polling. The `patchListener` callback updates the in-memory tree immediately.

3. **Provider registry:** Every built-in capability (terminal, filesystem, memory, skills, browser, web, cron, messaging, delegation, vision) is a SLOP provider. The architecture says "everything is a provider."

4. **Delegation provider scaffold:** A simulated delegation provider exists (`src/providers/builtin/delegation.ts`) with agent lifecycle management (spawn, push-observed state, cancel, and completed-result retrieval for standalone agents). Task-linked agents push results through the orchestration task and do not advertise `get_result`, keeping orchestrated runs patch-driven. It is the logical home for multi-agent orchestration.

5. **Two-level subscription model:** Shallow overview subscriptions for presence/context, deeper focused subscriptions for specific subtrees.

6. **Patch-driven updates:** Providers push state changes via SLOP protocol patches. Consumers react, not query.

### What's Missing for True Filesystem-as-Orchestration

The current filesystem provider is **data-centric** -- it manages workspace files. The orchestration concept requires the filesystem to be **control-centric** -- where files themselves encode agent coordination state (task assignments, progress, handoffs, results).

**Shipped:**
- *Filesystem CAS + range reads* — per-file `version`, `expected_version` guard on `write` (atomic via per-path mutex), `start_line`/`end_line` slicing on `read`, drift detection on external edits.
- *Sub-agent federation* — `DelegationProvider` has a pluggable `runnerFactory`; registry wires a real `SubAgentRunner` via `RegisteredProvider.onHubReady`. Each sub-agent's `AgentSessionProvider` registers into the parent's `ConsumerHub` so `/session /turn /activity /approvals` arrive as live patches. The runtime scheduler calls `spawn_agent` with `task_id` for ready tasks; the child result is pushed into that orchestration task and `/agents/{id}.get_result` is hidden.
- *Durable orchestration fabric* — `OrchestrationProvider` exposes `/orchestration` (plan + counts), `/tasks` (collection), `/handoffs` (collection), and `/findings` (collection) backed by files under `.sloppy/orchestration/`. CAS versions are persisted inside each JSON document and hydrated on restart.
- *Spec source of truth* — `SpecProvider` exposes `/specs` backed by `.sloppy/specs/`, including active spec metadata, requirements, decisions, and proposed changes. Orchestration tasks can link to spec requirements or decisions with `spec_refs`.
- *Scheduler-assisted execution* — `OrchestrationScheduler` watches task and agent patches, claims ready pending tasks with the CAS-backed `schedule` affordance, starts delegated agents when capacity is available, and emits dashboard-visible scheduler events.
- *Lifecycle-gated affordances* — task affordances appear/disappear by status: `schedule`/`start` for ready pending tasks, `start` for scheduled tasks, `attach_result`/`start_verification` around running/verifying, `complete` only for verifying, `fail`/`cancel`/`append_progress` for active states, and `get_result` only after a task has reached a terminal state with a durable result. Handoff `respond`/`cancel` only while pending.
- *Live ↔ durable loop closed* — `SubAgentRunner` auto-creates or attaches to a task on spawn, transitions it through `start → verifying/fail/cancel` as its session turn progresses, and pushes the child result into the task's `result.md` before final verification/completion.
- *Approval forwarding primitives* — `/agents/{id}.list_approvals` (fallback), `.approve_child_approval`, and `.reject_child_approval` forward decisions to the child's session provider via the parent hub.
- *Approval auto-mirror* — when a sub-agent's `session_provider_id` is registered, `DelegationProvider` subscribes to the child's `/approvals` and mirrors pending approvals into `/agents/{id}.pending_approvals` as a prop. Orchestrators see child approvals appear and disappear as patches; no polling.
- *Dependency enforcement + retries* — `depends_on` is now load-bearing. A task's `start` affordance is hidden while any dependency is not satisfied, and an `unmet_dependencies` array is exposed on the task's props. Dependency refs are normalized to canonical task ids from ids, names, `client_ref` values, and aliases like `task-1`; `create_tasks` can batch-create a DAG with local refs so the orchestrator does not need to guess generated ids. The provider rejects dependency cycles before writing a batch, so a malformed DAG does not leave half-created blocked tasks behind. For common coding plans, the orchestrator role layers conservative missing edges on top via a `RoleProfile.transformInvoke` hook (`src/runtime/orchestration/planning-policy.ts`): docs and final verification wait for code-producing tasks, and non-scaffold producers wait for scaffold; data/context and UI implementation work can fan out after scaffold unless the model explicitly adds a blocking edge. The provider itself only validates explicit `depends_on`. Replacements use `retry_of`, which marks the failed task `superseded` and links it via `superseded_by`; a superseded dependency is satisfied once its replacement completes.
- *Verification evidence* — tasks expose generic `record_verification` / `get_verifications` affordances and summarize verification counts plus acceptance-criteria coverage in state. The schema is domain-neutral (`kind`, `status`, `summary`, optional `criteria`/`command`/`evidence`/`evidence_refs`) so code tasks can record build/test/lint/format checks while non-code tasks can record smoke checks, review outcomes, benchmarks, or other acceptance evidence. A task with acceptance criteria cannot move from `verifying` to `completed` until every criterion is covered by `passed` or `not_required` evidence. Passed evidence that covers criteria must include `evidence_refs`; file-like refs are validated against the workspace, including simple `*.js`/`*.css` style globs. Sub-agent summaries alone are not enough to prove criteria that name exact files, identifiers, exports, imports, or UI text.
- *Audit findings* — `/findings` records structured audit drift with `severity`, `spec_refs`, `evidence_refs`, and a recommended resolution (`repair`, `spec_change`, or `accept_deviation`). A plan cannot complete while a blocking finding is still open; findings can create linked repair tasks or be accepted, dismissed, or marked fixed after re-audit.
- *Orchestrator guardrails* — orchestrator-mode invocations may inspect state/files and run a small whitelist of verification commands (`build`, `lint`, `test`, `typecheck`), but direct filesystem mutations, direct delegation spawns, and non-whitelisted shell commands are rejected at the `ConsumerHub` boundary by `orchestratorRoleRule` (`src/core/policy/rules.ts`). The rule activates only when the run loop tags the invocation with `roleId === "orchestrator"`. The orchestration extension installs this rule via `attachOrchestrationRuntime` (`src/runtime/orchestration/attach.ts`) using `hub.addPolicyRule(...)`. Repairs must be delegated through a new/retry task, preserving the orchestrator/worker split in the runtime rather than only in the prompt.

**Still missing:**
- Transcript-level content refs (session provider still inlines assistant/tool-result text). Filesystem `read` is already ref-aware above `contentRefThresholdBytes`.
- Automatic push on external filesystem edits (drift is detected on query; no `fs.watch`).
- Scale controls (salience filtering, depth caps) once concurrent sub-agent counts warrant them.
- Recorded-fixture e2e test (deterministic CI replay of a known-good live run). The env-gated live-LLM test exists; fixture capture does not.

Both axes of the core architecture are load-bearing and audited.

---

## 3. Industry Patterns: What Exists Elsewhere

### 3.1 Microsoft Copilot Studio: Orchestrator-Subagent Pattern

Microsoft's guidance describes the "Russian doll" or "Magentic" pattern: a primary orchestrator delegates to subordinate specialist agents. Key insights relevant to our idea:

- **Child Agents** are subordinate agents managed within the same solution
- **Connected Agents** are external, standalone agents owned by different teams
- The pattern is ideal for open-ended use cases where specialists are already available
- It is NOT recommended for consistency-critical, strongly sequential, or time-sensitive use cases

The Microsoft model relies on a **shared state store** (Cosmos DB or in-memory) that all agents access. This confirms that shared state is a universal requirement in orchestrator-orchestration -- the question is *what* provides that shared state.

### 3.2 Microsoft Agent Framework: MCP-Driven Patterns

Microsoft's Agent Framework demonstrates 4 multi-agent patterns (Single, Reflection, Handoff, Magentic) with a critical design insight: **pattern swapping via configuration**. A common runtime, memory layer, and observability sits beneath interchangeable coordination strategies.

The insight for our filesystem-as-provider approach: if the filesystem is a SLOP provider, then orchestration strategy becomes just another provider configuration. The orchestrator doesn't need special-cased logic -- it consumes filesystem state through the same provider boundary that any consumer uses.

### 3.3 Anthropic Multi-Agent Research System

Anthropic's Research feature uses an Orchestrator-Worker pattern with:

- **Lead Researcher:** Analyzes query, creates strategy, saves plan to memory (critical for preventing context overflow)
- **Subagents:** Operate in parallel with their own context windows
- **CitationAgent:** Post-processing verification

Key metrics:
- 90.2% improvement over single-agent on internal research evaluations
- ~15x more tokens than standard chat
- Parallel subagent spawning cuts research time by up to 90%
- Three factors explain 95% of variance: token usage (80%), subagent coordination, and tool design

Critically, Anthropic's system uses **Memory** as the shared state. The lead saves plans to memory, subagents read from it, and the lead synthesizes from it. **Memory is the orchestration fabric.**

In our filesystem-as-provider model, the **filesystem replaces Memory as the orchestration fabric.** This is significant because:

1. Filesystem state is **durable** (persists beyond agent lifetime)
2. Filesystem state is **inspectable** (human-readable, diffable, version-controlled)
3. Filesystem state is **observable** (via SLOP subscriptions, not polling)

### 3.4 LangGraph: State Management Pattern

LangGraph (LangChain's workflow engine) represents interactions as graphs (nodes/edges) with **state persistence** for long-running workflows. The critical difference from our approach: LangGraph keeps state in a Python object graph with checkpointing. Our approach pushes state to an external, observable data source (the filesystem).

This trades some query flexibility for **decoupling**: agents don't need shared libraries or runtime memory to coordinate.

### 3.5 Databricks Agent Framework

Databricks builds multi-agent systems with session routing, workflow orchestration, and **thread-based state abstraction** supporting session isolation and checkpointing (pause/resume/fault recovery). Their persistent storage uses Cosmos DB. Again, shared state is the universal pattern -- the implementation detail (filesystem) is what's novel.

---

## 4. The Filesystem-as-Provider Architecture

### 4.1 High-Level Design

```
┌─────────────────────────────────────────────────┐
│                 Orchestrator Agent              │
│  (task decomposition, strategy, synthesis)      │
├─────────────────────────────────────────────────┤
│  Observes: /orchestration filesystem state      │
│  Modifies: task assignments via write actions   │
└─────────────────────────────────────────────────┘
                      │
           SLOP filesystem provider (patch push)
                      │
┌─────────────────────┼───────────────────────────┐
│                     ▼                           │
│            /workspace/.sloppy/                   │
│           ┌───────────────────┐                  │
│           │  orchestration/   │                  │
│           │  ├── plan.json    │  ← orchestrator  │
│           │  ├── tasks/       │  ← task defs     │
│           │  │   ├── task-1/  │  │  progress,     │
│           │  │   │   ├── state │  │  result,      │
│           │  │   │   ├── log   │  │  handoff      │
│           │  │   └── task-2/  │  │  notes        │
│           │  ├── results/     │  ← subagent      │
│           │  │   ├── task-1.md │  │  outputs      │
│           │  │   └── task-2.md │              │
│           │  ├── handoff/     │  ← cross-agent   │
│           │  │   └── req-1.md  │  │  requests    │
│           └───────────────────┘              │
└─────────────────────────────────────────────────┘
                      │
           SLOP filesystem provider (patch push)
                      │
┌─────────────────────┼───────────────────────────┐
│                     ▼                           │
│   ┌──────────────────────────────────────┐      │
│   │  Subagent A     │  Subagent B        │      │
│   │  reads tasks/   │  reads tasks/      │      │
│   │  writes results/│  writes results/   │      │
│   │  observes handoff/│ observes handoff/ │      │
│   └──────────────────────────────────────┘      │
└─────────────────────────────────────────────────┘
```

### 4.2 State File Conventions

Directory structure under `/workspace/.sloppy/orchestration/`:

**Plan file** (`plan.json`):
```json
{
  "session_id": "sess-abc123",
  "query": "Research the competitive landscape",
  "strategy": "breadth-first decomposition",
  "max_agents": 5,
  "created_at": "2026-04-23T10:00:00Z",
  "status": "active"
}
```

**Task directory** (`tasks/task-1/`):
```
tasks/
├── task-1/
│   ├── definition.json    ← goal, boundary, tools, constraints
│   ├── state.json         ← pending → running → verifying → completed/failed
│   ├── progress.md        ← running log, iterative thinking
│   ├── result.md          ← final output (written on completion)
│   ├── handoff_requests/  ← cross-agent requests
│   └── handoff_responses/ ← responses to requests from other agents
```

### 4.3 State Transitions

```
orchestrator creates plan.json ──► agent observes via subscription
agent reads task definition.json ──► agent sets state.json to "running"
agent writes to progress.md ────► patches push to all observers
agent finishes leaf work ───────► state.json to "verifying"
orchestrator records verification ─► state.json to "completed" + result.md
```

Key principle: **writes trigger patches, patches trigger reactions**. No polling, no optimistic fetches.

### 4.4 Conflict Resolution

Since multiple agents can write to the same files, we need a protocol:

1. **Ownership model:** Each task directory is owned by one agent. No concurrent writes to the same file.
2. **Append-only logs:** `progress.md` is append-only. Agents append, don't overwrite.
3. **Atomic handoffs:** Handoff requests go into separate files. Responses are in separate files. No contention.
4. **Version-guarded writes (CAS):** Every file node in the filesystem state tree carries a monotonically-increasing `version` (leveraging SLOP's existing patch `version` semantics — see `spec/core/messages.md:109`). Write and patch affordances take an `expectedVersion` parameter; the provider rejects the operation if the current version does not match. Because the consumer's `StateMirror` advances version on every inbound patch, the agent's live view is always current — it passes the version it just saw, no defensive re-read required. This is the primitive that makes shared files (e.g. `plan.json`, parent-owned indices) safe without exclusive ownership.

---

## 5. Integration with SLOP Architecture

### 5.1 The Filesystem Provider as Coordination Layer

Currently, the filesystem provider (`src/providers/builtin/filesystem.ts`) manages:
- Workspace directory listing
- Focused directory
- Search results
- Recent operations

For orchestration, we extend it to also expose:

```text
[root] filesystem: Filesystem
  [collection] workspace (focus="/workspace")  ← current
  [collection] orchestration                   ← NEW
    [collection] tasks
      [item] task-1 (status="running", progress="40%")
      [item] task-2 (status="pending")
    [collection] handoffs
      [item] req-1 (status="pending", from="task-1", to="task-2")
    [context] session (agents=3, max=5, status="active")
```

**Implementation note:** the shipped design keeps orchestration and filesystem as *separate* SLOP providers (`orchestration` and `filesystem`), both backed by the same workspace directory. The orchestration provider owns `.sloppy/orchestration/` and exposes `/orchestration`, `/tasks`, `/handoffs` as typed state with lifecycle-gated affordances. The filesystem provider still serves arbitrary file I/O on the rest of the workspace. Agents get the structured coordination surface without conflating it with general file browsing; both sit in the same `ConsumerHub` and agents subscribe to whichever they need.

### 5.2 Delegation Provider Evolution

The delegation provider (`src/providers/builtin/delegation.ts`) carries a
simulation path for tests but in real runs is wired to a `SubAgentRunner`
through the registry's `runnerFactory`. It evolves along **two axes simultaneously**:

- **Durable axis — filesystem-backed state.** Task definitions, progress logs, results, and handoffs are files under `.sloppy/orchestration/tasks/`. This is what survives a crash and what a human can `git diff`.
- **Live axis — session provider per sub-agent.** Each spawned sub-agent runs a real `Agent` loop and exposes its own `/session`, `/turn`, `/transcript`, `/activity`, and `/approvals` state (the same shape first-party UIs already consume — see `docs/06-agent-session-provider.md`). The orchestrator's `ConsumerHub` subscribes to the sub-agent's session provider just like any other provider.

Concretely:

```
DelegationProvider (current, simulated)
  └── agents: Map<string, DelegationAgent>
  └── spawnAgent: in-memory setTimeout simulation

DelegationProvider (proposed, real)
  ├── Durable layer (filesystem):
  │     spawnAgent    → writes tasks/{id}/definition.json (patch pushed)
  │     cancel        → writes tasks/{id}/cancel signal
  │     getResult     → reads tasks/{id}/result.md
  │     recovery      → on restart, re-hydrates from tasks/ directory
  └── Live layer (session providers):
        each sub-agent registers its own session provider in the hub
        orchestrator observes /session/turn, /activity, /approvals live
        send_message   → queues a turn on the sub-agent's session
        (no polling: status changes arrive as patches)
```

The two layers serve different questions: **"what is this agent doing right now?"** is answered by the session provider; **"what has this agent produced, and how do we resume if it crashed?"** is answered by the filesystem. Neither replaces the other. The simulation is eliminated on both axes.

Orchestration plugs into the agent runtime through the generic `attachRuntime` extension hook (`src/runtime/orchestration/attach.ts`). On attach it registers the `orchestrator` role on the agent's `RoleRegistry` (`src/core/role.ts`), installs `orchestratorRoleRule` on the hub policy, and exposes a `TaskContext` factory through `DelegationRuntimeHooks` so `SubAgentRunner` can build per-task work packets and report transitions without ever importing orchestration. Scheduler events (`task_unblocked`, `task_scheduled`, `task_started`, `scheduler_idle`, `scheduler_blocked`) ride on the runtime event bus' generic `publishEvent` channel rather than a dedicated callback. The kernel does not name orchestration anywhere — `src/session/*` and `src/runtime/delegation/sub-agent.ts` carry zero orchestration references; sub-agents consume `TaskContext` opaquely.

### 5.3 Subscription Strategy

Using SLOP's existing two-level subscription model:

**Orchestrator subscribes to:**
- Overview: `/orchestration` (shallow, sees all task statuses)
- Detail: `/orchestration/tasks` (deeper, sees individual task progress)

**Subagent subscribes to:**
- Overview: `/orchestration/session` (sees orchestration state)
- Detail: `/orchestration/tasks/{my-task-id}` (sees its own task, handoffs)

This matches Anthropic's pattern: the lead (orchestrator) has broad visibility, subagents have focused visibility.

---

## 6. Why This Solves the Core Problem

### 6.1 Eliminating Optimistic Fetch

Current problem: an orchestrator spawns a subagent, then must poll or query to know if it completed. Every iteration of the loop includes a "has the subagent finished?" query.

With filesystem-as-provider: the orchestrator's filesystem subscription receives a patch the instant the subagent writes to its task file. No query needed. The orchestrator's next iteration already has the latest state baked into the context.

### 6.2 Read-Before-Write Prevention

Current problem has two shapes, and the deeper one is the cross-agent case:

- *Self-write verification (minor):* an orchestrator writes a task, then reads it back to confirm — wasted tokens. The inbound patch that follows the write makes the reread unnecessary; the next context snapshot already reflects the new state.
- *Cross-agent staleness (major):* Agent A wants to modify a file that Agent B (or the orchestrator) may have just touched. Today the safe move is a defensive re-read before writing. With live subscriptions plus a per-file `version` field, Agent A's `StateMirror` holds the current version at all times. A write via `write(path, content, expectedVersion: current)` either succeeds against the version it actually saw, or returns a conflict it can react to — never silently overwrites. The re-read collapses into the subscription that was already open.

The subscription + versioned write is what eliminates read-before-write as a *discipline*. Ownership conventions (§4.4) reduce how often contention happens; CAS makes the remaining cases correct.

### 6.3 Deterministic State Observability

Current problem: agent state is ephemeral (in-memory, in process). If an agent crashes, state is lost.

With filesystem-as-provider: state is durable. Crash recovery is possible by reading the last completed state from files. Human inspection and debugging are trivial.

### 6.4 Token Efficiency

Every polling query consumes LLM tokens (the query tool call, the model's response processing). By replacing queries with push-based subscriptions:

- The orchestrator eliminates "check subagent X" queries
- Context snapshots include latest state without explicit tool calls
- Anthropic found that token usage explains 80% of performance variance; reducing wasteful queries directly improves effective throughput

---

## 7. Comparison with Existing Approaches

| Approach | State Location | Update Mechanism | Durability | Observability |
|----------|---------------|------------------|------------|---------------|
| In-memory (current) | Process memory | Variable | Lost on crash | None |
| Central DB (Microsoft) | Database | Push/pull | Durable | Via API |
| Memory (Anthropic) | Session memory | Push within session | Session-limited | Via memory API |
| LangGraph checkpoint | Checkpoint store | Push | Durable | Via checkpoint API |
| **Filesystem (proposed)** | **Files on disk** | **Push (SLOP patches)** | **Durable + inspectable** | **Native (SLOP subscription)** |

The filesystem approach is unique because:
1. **State is human-readable** -- no serialization format ambiguity
2. **State is version-controlable** -- git diff shows what changed
3. **State is observable without special APIs** -- the filesystem provider already exposes it
4. **State is portable** -- files can be shared, archived, debugged externally

---

## 8. Proposed Implementation Phases

### Phase 1: Orchestration File Schema *(shipped)*
`OrchestrationProvider` (now a directory of focused modules under `src/providers/builtin/orchestration/` — `types.ts`, `storage.ts`, `normalization.ts`, `classifiers.ts`, `dag.ts`, `index.ts` for the class facade) owns `.sloppy/orchestration/plan.json`, `tasks/{id}/definition|state|progress|result|verifications`, and `findings/{id}.json`. Plan, tasks, and findings are exposed as SLOP state (`/orchestration`, `/tasks`, `/findings`) with CAS-guarded mutations where lifecycle state can conflict. `depends_on` stored on each task definition is enforced — `start` is gated on all deps reaching `completed`, or a `superseded` dependency whose replacement completed, with `unmet_dependencies` visible as a task prop. Task definitions can carry `kind`, `spec_refs`, `audit_of`, and `finding_refs` for spec-driven implementation, audit, and repair loops. `create_tasks` batch-creates dependency graphs with local refs and acceptance criteria; it validates explicit `depends_on`, rejects dependency cycles before writing the batch, and scopes task/handoff/finding visibility to the current plan id so a cancelled run cannot block the next plan. If a model accidentally stringifies the task array, the runtime accepts parseable JSON arrays and normalizes them to the same typed task list. Single `create_task` calls also normalize existing task names, refs, and aliases to canonical ids. Completion is gated on verification and audit: tasks move `running → verifying → completed`, `complete` requires a `passed` or `not_required` verification record, and `complete_plan` rejects open blocking findings. When acceptance criteria exist, every criterion must be covered by verification evidence before completion. Failed replacements are represented with `create_task({ retry_of })`, which links the new task and marks the old task `superseded`.

The provider does not classify tasks or invent dependency edges. The coding-domain heuristics (`isScaffoldTask`, `isUiTask`, `isDataModelTask`, `isDocumentationTask`, `isVerificationTask`) and the inferred parallel-friendly edges live in `src/runtime/orchestration/planning-policy.ts` and are applied by the orchestrator role's `RoleProfile.transformInvoke` hook before `create_tasks` reaches the provider. Other roles, or the same role with a different planning policy, can swap this hook without touching the provider.

### Phase 1.5: Spec Provider and Audit Findings *(shipped)*
`SpecProvider` owns `.sloppy/specs/active.json` and `specs/{id}/metadata|spec|requirements|decisions|changes`. The active spec is exposed through `/specs`, and implementation/audit tasks can cite spec requirements or decisions with `spec_refs`. Proposed spec changes live with the spec instead of being inferred upward from implementation drift. Audit findings live under `/findings`, can spawn repair tasks via `create_repair_task`, and block plan completion while a blocking finding remains open.

### Phase 2: Extended Filesystem Provider with CAS *(shipped — `bd1469d`, `b70f52f`)*
Version + `expected_version` CAS live on every file node. Range reads (`start_line`/`end_line`) avoid loading full files into agent context. Drift detection bumps version on external edits.

### Phase 3: Real Sub-Agent Delegation *(shipped)*
- **Live:** `SubAgentRunner` registers each sub-agent's `AgentSessionProvider` into the parent hub via `onHubReady`. Pluggable `runnerFactory` on `DelegationProvider` keeps the simulated path for tests.
- **Durable:** when `OrchestrationProvider` is present, `SubAgentRunner` auto-creates + transitions a task per spawn through `running → verifying`; the orchestrator records verification and completes the task, so crash-recovery and git-diffable progress come for free without marking unverified work done.
- **Scoped:** scheduled children receive a generated work packet containing only the attached task, acceptance criteria, dependency result previews, linked findings, and spec requirements cited by `spec_refs`. Child runtimes disable orchestration, delegation, and spec providers so plan/spec mutation stays parent-owned.

### Phase 5: Handoff Protocol *(shipped)*
`/handoffs` collection with `create_handoff(from_task, to_task, request, kind?, priority?, spec_refs?, evidence_refs?, blocks_task?)` and per-item `respond(response, decision_refs?, evidence_refs?, unblock?)` / `cancel`. Backed by `.sloppy/orchestration/handoffs/{id}.json`, CAS-guarded, affordances disappear once the handoff is no longer pending. Supported kinds are `question`, `artifact_request`, `review_request`, `decision_request`, and `dependency_signal`.

### Phase 6: Approval Routing *(shipped)*
`/agents/{id}.list_approvals` returns the child session provider's pending approvals (fallback); `.approve_child_approval(approval_id)` / `.reject_child_approval(approval_id, reason?)` forward to the child's session provider. For the state-first path, `DelegationProvider` subscribes to each registered child's `/approvals` and auto-mirrors pending entries into `/agents/{id}.pending_approvals` so the orchestrator sees them as patches without any explicit call.

### Phase 4: Orchestrator Agent Prompt *(shipped)*
`agent.orchestratorMode` (default `false`) switches `buildSystemPrompt` to append an orchestrator preamble that teaches: observe `/specs`, `/orchestration`, `/findings`, and `/agents` first; `create_plan` → `create_tasks` (with local refs, real dependencies, spec refs, and acceptance criteria) → let the scheduler start ready tasks with scoped work packets → resolve typed handoffs/approvals → `record_verification(criteria: ..., evidence_refs: ...)` → record/resolve findings → `complete_plan`. The delegation rule is explicit: leaf work (file edits, shell, research) belongs to scheduled sub-agents; the orchestrator writes task state through `/orchestration`, audit state through `/findings`, keeps plan/spec mutation parent-owned, and does not manually call `spawn_agent`. Two worked examples are included.

Documentation tasks should depend on the implementation tasks they describe. Their acceptance criteria should include checking the docs against actual scripts, filenames, and implemented features so READMEs do not overclaim drag-and-drop, delete/edit flows, dependencies, or file layouts that the generated app does not contain.

Prompt lives in `src/runtime/orchestration/prompt.ts` and is contributed to the system prompt via the orchestrator role's `systemPromptFragment` hook. Verified against a real OpenAI-compatible endpoint (Qwen3-35B) via `tests/orchestration-e2e.test.ts` — plan completed, two tasks with dependency, CAS retry exercised organically.

### Phase 7: Scale Controls *(partially shipped — content refs done, fan-out limits pending)*
Filesystem `read` returns a preview + content ref above `contentRefThresholdBytes` so large files don't inline into tool results. Salience filtering, depth caps, and subscription fan-out throttling for orchestrators watching many sub-agents are still future work — not yet needed at current scale.

---

## 8.5 Running it

### End-to-end test (live LLM)

`tests/orchestration-e2e.test.ts` is gated on `SLOPPY_E2E_LLM=1` and skipped in default CI. It spins up an `Agent` in orchestrator mode with a tmpdir workspace and feeds a two-file dependency goal (write `a.txt=HELLO`, then write `b.txt=OLLEH` from `a.txt`'s reversed content). Assertions are patch-and-file based: both files present with expected content, `plan.json.status === "completed"`, at least two tasks with at least one `depends_on`.

Run against any OpenAI-compatible endpoint:

```bash
SLOPPY_LLM_PROVIDER=openai \
SLOPPY_LLM_BASE_URL=http://<host>:<port> \
SLOPPY_MODEL=<model-id> \
OPENAI_API_KEY=<key-or-stub> \
SLOPPY_E2E_LLM=1 \
SLOPPY_DEBUG=all \
bun test tests/orchestration-e2e.test.ts
```

Anthropic/Gemini: swap `SLOPPY_LLM_PROVIDER` and the key env var. Timeout is 5 min; on failure the test dumps the debug log + orchestration listing under `test-artifacts/e2e-*/` so you can read what the model did wrong. The typical first-run failure mode is prompt-shaped (model skips `create_plan`, executes leaf work directly, forgets `depends_on`) — iterate on `ORCHESTRATOR_PROMPT` in `src/runtime/orchestration/prompt.ts`.

### Debug logging

`SLOPPY_DEBUG=all` emits single-line JSON to stderr across six scopes: `sub-agent`, `orchestration`, `filesystem`, `delegation`, `hub`, `loop`. Comma-separate to filter (`SLOPPY_DEBUG=sub-agent,orchestration`). Key events worth watching: `orchestration.create_plan`/`update_task`/`complete_plan`, `sub-agent.transition`, `filesystem.write_version_conflict` (CAS retries), `loop.turn` (per-iteration stop reason + tool call count).

### Demo script (manual)

`bun run demo:orchestrate "<goal>"` runs a one-shot orchestrator against a fresh `.sloppy-demo/` workspace, leaving `.sloppy-demo/.sloppy/orchestration/` populated for inspection. The demo enables the filesystem, terminal, delegation, and orchestration providers, with both filesystem and terminal rooted in `.sloppy-demo/`. Useful alongside the TUI for watching live provider patches.

If you set `SLOPPY_LLM_PROVIDER`, `SLOPPY_MODEL`, `SLOPPY_LLM_BASE_URL`, or `SLOPPY_LLM_API_KEY_ENV` for the demo run, Sloppy rebuilds the runtime LLM config from those process env values and ignores managed profiles/default profile ids for that invocation. This keeps local OpenAI-compatible demos from accidentally falling back to stored cloud credentials.

---

## 9. Risks and Tradeoffs

### Risks
1. **File I/O latency:** Disk reads/writes are slower than in-memory operations. Mitigated by the fact that most agent coordination happens at the iteration level, not the sub-iteration level. Live sub-turn signals (tool calls in progress, token streaming) go through the session provider, not the filesystem, so the disk is not on the hot path.
2. **File locking:** Concurrent writes to the same file need careful handling. The ownership model (one agent per task directory) avoids this for task-local state; CAS covers the residual shared-file case (plan.json, index files).
3. **Security:** The orchestrator writes files the LLM can read. Malicious content in orchestration files could poison the context. Mitigated by workspace-root containment (already enforced by the filesystem provider).
4. **Subscription fan-out:** An orchestrator watching N sub-agents × M patches/sec can saturate its context budget and throughput. Mitigated by salience filtering, depth-0 overviews for the sub-agent collection, and detail subscriptions only on the focal agent.
5. **Scratchpad leakage:** A sub-agent's chain-of-thought should not spill into the orchestrator's subscription tree. Keep full scratchpad behind an affordance; expose only a truncated `scratchpad_preview` property as state.

### Tradeoffs
1. **Durability vs. speed:** File-backed state is durable but slower. For a system where coordination happens between turns (not within a turn), the latency impact is negligible.
2. **Simplicity vs. flexibility:** A flat file structure is simple but less queryable than a database. This is acceptable because the orchestrator already knows what to look for (its own task definitions).
3. **Coupling:** The orchestration logic lives in files rather than code. This makes it inspectable but means the "protocol" is partly encoded in file format conventions.

---

## 10. Alignment with SLOP Principles

This design is fully consistent with SLOP's core principles:

1. **State is primary.** The orchestrator observes the orchestration state tree, not a tool catalog.
2. **Everything is a provider.** The filesystem provider becomes both a data provider and an orchestration protocol provider.
3. **Tool use is only an adapter.** The orchestrator uses filesystem write affordances, but the architecture is state-first.
4. **Subscriptions beat polling.** Patch-driven updates from the filesystem replace query-driven polling.
5. **Thin core, fat providers.** Orchestration logic lives in the filesystem provider, not the core loop.
6. **The core is headless.** The orchestration interface is the same SLOP provider boundary that external clients use.

---

## 11. Key References

- Microsoft: "Orchestrator and Subagent Multi-Agent Patterns" -- hierarchical delegation with clear separation of concerns
- Microsoft: "MCP-Driven Patterns in Agent Framework" -- pattern swapping via configuration, shared state store
- Anthropic: "How we built our multi-agent research system" -- orchestrator-worker, memory as shared state, 90%+ improvement
- LangGraph: State persistence for long-running workflows
- Databricks: Thread-based state with checkpointing and fault recovery

---

## 12. Conclusions

The filesystem-as-orchestration-provider concept is viable because:

1. The SLOP architecture already provides the subscription/patch mechanism needed for push-based state updates
2. Industry multi-agent systems universally rely on shared state; the filesystem is a natural, durable, inspectable shared state layer
3. This eliminates the two biggest token-wasting patterns in multi-agent orchestration: optimistic polling and read-before-write verification
4. It extends naturally from the existing delegation provider and filesystem provider without requiring new protocols or transports
5. It aligns perfectly with SLOP's state-first design philosophy

Phases 1–6 have shipped and multiple correctness audits have been addressed (atomic CAS, guard-before-write for `complete`, persisted versions, status-gated affordances, dependency enforcement, auto-mirrored approvals, append-only progress no longer bumps CAS versions). Content references for large filesystem reads have also shipped as part of Phase 7. Remaining work: the orchestrator system prompt (Phase 4), `fs.watch` push on external edits, transcript-level content refs (session provider), and the remaining Phase 7 scale controls (salience filtering, depth caps) once concurrent sub-agent counts warrant them.
