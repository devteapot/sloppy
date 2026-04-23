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

4. **Delegation provider scaffold:** A simulated delegation provider exists (`src/providers/builtin/delegation.ts`) with agent lifecycle management (spawn, monitor, cancel, get_result). It is the logical home for multi-agent orchestration.

5. **Two-level subscription model:** Shallow overview subscriptions for presence/context, deeper focused subscriptions for specific subtrees.

6. **Patch-driven updates:** Providers push state changes via SLOP protocol patches. Consumers react, not query.

### What's Missing for True Filesystem-as-Orchestration

The current filesystem provider is **data-centric** -- it manages workspace files. The orchestration concept requires the filesystem to be **control-centric** -- where files themselves encode agent coordination state (task assignments, progress, handoffs, results).

**Shipped:**
- *Filesystem CAS + range reads* — per-file `version`, `expected_version` guard on `write` (atomic via per-path mutex), `start_line`/`end_line` slicing on `read`, drift detection on external edits.
- *Sub-agent federation* — `DelegationProvider` has a pluggable `runnerFactory`; registry wires a real `SubAgentRunner` via `RegisteredProvider.onHubReady`. Each sub-agent's `AgentSessionProvider` registers into the parent's `ConsumerHub` so `/session /turn /activity /approvals` arrive as live patches.
- *Durable orchestration fabric* — `OrchestrationProvider` exposes `/orchestration` (plan + counts), `/tasks` (collection), and `/handoffs` (collection) backed by files under `.sloppy/orchestration/`. CAS versions are persisted inside each JSON document and hydrated on restart.
- *Lifecycle-gated affordances* — task affordances appear/disappear by status: `start` only for pending, `complete` only for running, `fail`/`cancel`/`append_progress` for active states, `get_result` always. Handoff `respond`/`cancel` only while pending.
- *Live ↔ durable loop closed* — `SubAgentRunner` auto-creates a task on spawn, transitions it through `start → complete/fail/cancel` as its session turn progresses, and writes the final assistant text to `tasks/{id}/result.md`. Empty results do not produce a stub file.
- *Approval forwarding primitives* — `/agents/{id}.list_approvals` (fallback), `.approve_child_approval`, and `.reject_child_approval` forward decisions to the child's session provider via the parent hub.
- *Approval auto-mirror* — when a sub-agent's `session_provider_id` is registered, `DelegationProvider` subscribes to the child's `/approvals` and mirrors pending approvals into `/agents/{id}.pending_approvals` as a prop. Orchestrators see child approvals appear and disappear as patches; no polling.
- *Dependency enforcement* — `depends_on` is now load-bearing. A task's `start` affordance is hidden while any dependency is not `completed`, and an `unmet_dependencies` array is exposed on the task's props. Completing a dependency automatically unblocks downstream tasks via normal patch propagation.

**Still missing:**
- Transcript-level content refs (session provider still inlines assistant/tool-result text). Filesystem `read` is already ref-aware above `contentRefThresholdBytes`.
- Automatic push on external filesystem edits (drift is detected on query; no `fs.watch`).
- Orchestrator system prompt (Phase 4) — the plumbing is in place, but there is no curated prompt teaching an agent how to use it yet.
- Scale controls (salience filtering, depth caps) once concurrent sub-agent counts warrant them.

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
│   ├── state.json         ← pending → running → completed/failed
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
agent writes result.md ─────────► state.json to "completed"
orchestrator observes completion ──► synthesizes results
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

The current delegation provider is simulated (`src/providers/builtin/delegation.ts:1-246` — lifecycle via `setTimeout`, no real agent behind it). It evolves along **two axes simultaneously**:

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
`OrchestrationProvider` owns `.sloppy/orchestration/plan.json` and `tasks/{id}/definition|state|progress|result`. Plan and tasks are exposed as SLOP state (`/orchestration`, `/tasks`) with CAS-guarded mutations. `depends_on` stored on each task definition is enforced — `start` is gated on all deps reaching `completed`, with `unmet_dependencies` visible as a task prop.

### Phase 2: Extended Filesystem Provider with CAS *(shipped — `bd1469d`, `b70f52f`)*
Version + `expected_version` CAS live on every file node. Range reads (`start_line`/`end_line`) avoid loading full files into agent context. Drift detection bumps version on external edits.

### Phase 3: Real Sub-Agent Delegation *(shipped)*
- **Live:** `SubAgentRunner` registers each sub-agent's `AgentSessionProvider` into the parent hub via `onHubReady`. Pluggable `runnerFactory` on `DelegationProvider` keeps the simulated path for tests.
- **Durable:** when `OrchestrationProvider` is present, `SubAgentRunner` auto-creates + transitions a task per spawn, so crash-recovery and git-diffable progress come for free.

### Phase 5: Handoff Protocol *(shipped)*
`/handoffs` collection with `create_handoff(from_task, to_task, request)` and per-item `respond(response)` / `cancel`. Backed by `.sloppy/orchestration/handoffs/{id}.json`, CAS-guarded, affordances disappear once the handoff is no longer pending.

### Phase 6: Approval Routing *(shipped)*
`/agents/{id}.list_approvals` returns the child session provider's pending approvals (fallback); `.approve_child_approval(approval_id)` / `.reject_child_approval(approval_id, reason?)` forward to the child's session provider. For the state-first path, `DelegationProvider` subscribes to each registered child's `/approvals` and auto-mirrors pending entries into `/agents/{id}.pending_approvals` so the orchestrator sees them as patches without any explicit call.

### Phase 4: Orchestrator Agent Prompt *(pending)*
Write the orchestrator prompt that teaches the agent to:
- Decompose tasks into file-based task definitions
- Observe sub-agent progress via session-provider patches (live) and task-file patches (durable) — not polling
- Synthesize results from file outputs
- Handle handoffs between agents via the handoff directory

### Phase 7: Scale Controls *(partially shipped — content refs done, fan-out limits pending)*
Filesystem `read` returns a preview + content ref above `contentRefThresholdBytes` so large files don't inline into tool results. Salience filtering, depth caps, and subscription fan-out throttling for orchestrators watching many sub-agents are still future work — not yet needed at current scale.

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
