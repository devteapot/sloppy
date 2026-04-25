# Meta-Runtime — Self-Modifying Orchestration

This document specifies the layer that sits *above* the orchestration runtime described in `docs/12-orchestration-design.md`: a meta-runtime that lets the orchestration system observe and modify its own configuration, spawn specialized agents with scoped capabilities, and grow emergent structure on top of the fixed substrate.

It is a design doc, not a state-of-the-code doc. Nothing here is implemented yet. Where this document conflicts with docs/09 or docs/12, those documents are authoritative for the substrate and this one extends them additively.

The guiding principle is the same as the rest of the system: **everything is a SLOP provider — state tree plus affordances**. The meta-runtime is not special infrastructure; it is just more orchestration providers, observable and mutable through the same surfaces as `/goals`, `/specs`, `/plans`, `/tasks`.

## Motivation

The current orchestration runtime is **statically configured**. Descriptors, wiring, gate-type defaults, lifecycle policies, and verification rules are TypeScript modules. To change the runtime's behaviour during a session — tighten a gate, loosen a budget, swap a resolver, introduce a new specialist role — you stop the session and edit code.

This is fine for HITL. It is insufficient for autonomous operation, where:

- The right gate policy depends on artifacts that don't exist yet (a goal's stakes only become legible once the spec is drafted).
- The right specialization is task-specific (a security-sensitive slice wants a reviewer specialist; a docs slice does not).
- The runtime's own behaviour needs to be a learning surface (precedents, failure patterns, drift signals should feed back into config).

The meta-runtime introduces three capabilities:

1. **Config as state.** Effective runtime config is the base config plus a stack of *overlays* committed as SLOP events. Every change is auditable and reversible.
2. **Specialist agents as descriptors.** Spawned sub-agents are first-class artifacts with capability masks over the state tree and an affordance allowlist, enforced in the consumer.
3. **A reflection surface.** Telemetry about runtime behaviour (gate outcomes, retries, escalations, specialist outcomes) is state, queryable by both humans and agents.

A future *runtime manager agent* consumes the reflection surface and proposes overlays / spawns specialists. The manager is built last and is optional; the three capabilities above are useful on their own.

## Engagement levels (extended)

Docs/12 defines four engagement levels (bare → checklist → HITL → autonomous). The meta-runtime adds a fifth:

```
bare ▶ checklist ▶ HITL ▶ autonomous ▶ self-modifying
                                          (meta-runtime)
```

Each meta-runtime capability is independently opt-in:

| Capability | Activated by | Useful without manager? |
|---|---|---|
| Overlays | Mounting `/overlays` provider | Yes — humans commit overlays via affordance |
| Specialists | Mounting `/specialists` provider | Yes — humans or planner spawn specialists |
| Reflection | Mounting `/reflection` provider | Yes — surfaces telemetry to operators |
| Manager agent | Mounting `/runtime-manager` provider | No — requires the three above |

Mount none of these and the system behaves exactly as docs/12 describes.

---

## 1. Config as state — the overlay layer

### 1.1 Purpose

Make the *effective* runtime configuration a function of versioned state, not source code. The base config (descriptors, wiring, gate-type defaults, lifecycle thresholds, retry/respawn heuristics, budget defaults) is the seed. Overlays are typed patches committed to `/overlays`. The effective config at any point in time is `apply(overlays_in_order, base)`.

This gives:

- **Auditability.** Every config change is a SLOP event with author, reason, and scope.
- **Reversibility.** Revert is `revoke(overlay_id)`; the effective config recomputes.
- **Scoping.** Overlays attach to a scope (session / goal / spec / slice / gate-type, mirroring the resolver scopes in docs/12 § Gates as policy tree). Inner overrides outer.
- **Testability.** A proposed overlay can be evaluated in dry-run against the existing artifact graph before being committed.

### 1.2 What is overlay-able

Not all base config is mutable at runtime. The overlay schema enumerates the patchable surface explicitly. Anything not enumerated is fixed at process start.

| Surface | Overlay-able | Rationale |
|---|---|---|
| Gate-type defaults (HITL/auto per gate type) | Yes | Core autonomy lever. |
| Resolver bindings per scope | Yes | Direct equivalent of the policy tree in docs/12. |
| Budget caps (tokens, wall time, retries) | Yes | Adjust as goals escalate or de-escalate. |
| Retry / respawn heuristics (N, thresholds) | Yes | Tunable failure handling. |
| Verification rules per gate type (e.g. required evidence kinds) | Yes | Tighten or relax under specific scopes. |
| Specialist allowlist (which specialists may be spawned) | Yes | Capability surface control. |
| Descriptor *schemas* (artifact shapes, message types) | **No** | Schema drift breaks the audit trail. Bumped via code release. |
| Affordance signatures | **No** | Provider contract; bumped via code release. |
| Storage backends, CAS roots | **No** | Process-level wiring. |

This boundary is load-bearing. The meta-runtime can re-tune *policy* arbitrarily but cannot re-shape the artifact graph from inside. New artifact kinds require a code release; new *uses* of existing artifacts do not.

### 1.3 State-tree shape

```
/overlays
  index                    # ordered list of active overlay ids per scope
  /<overlay_id>
    metadata               # author, reason, created_at, scope, status
    patch                  # JSON-merge-patch-like document, typed
    dry_run_report         # optional, populated if dry-run was performed
    revoked_at             # null while active
    supersedes             # optional prior overlay id
```

Effective config is *not* materialized in the state tree. It is computed on read by composing overlays in scope order. Materializing it would create a second source of truth that drifts.

### 1.4 Affordances

| Affordance | Inputs | Effect | Gated by |
|---|---|---|---|
| `propose_overlay` | scope, patch, reason | Writes overlay in `proposed` state, runs dry-run | None (write-only) |
| `commit_overlay` | overlay_id, expected_base_version | Activates overlay | `overlay_accept` gate |
| `revoke_overlay` | overlay_id, reason | Marks overlay revoked; effective config recomputes | `overlay_revoke` gate |
| `dry_run_overlay` | overlay_id | Replays recent gate decisions under proposed config; reports diff | None (read-only) |
| `get_effective_config` | scope | Returns composed config at scope | None |

`expected_base_version` on `commit_overlay` is the standard CAS pattern from docs/09 — the overlay carries the version of the effective config it was authored against, and the commit is rejected if a newer overlay landed first.

### 1.5 Gate types added

| Gate | Default resolver (HITL) | Default resolver (autonomous) |
|---|---|---|
| `overlay_accept` (manual scope) | escalate | escalate |
| `overlay_accept` (gate-type-tuning scope) | escalate | auto if delta is within "softening to auto" of a gate already auto-resolvable; else escalate |
| `overlay_accept` (budget tightening) | auto | auto |
| `overlay_accept` (budget loosening) | escalate | escalate |
| `overlay_revoke` | auto if the net delta is tightening or no-op; escalate if it loosens | auto if the net delta is tightening or no-op; escalate if it loosens |

Revocation is evaluated as a diff from current effective config to post-revoke effective config. Reverting a budget-tightening overlay, for example, is a budget loosening and must go through the loosening resolver. Loosening is always more guarded than tightening. This is asymmetric on purpose: an autonomous system that can grant itself slack is the failure mode; one that can tighten itself and reverse is fine.

### 1.6 Dry-run semantics

A dry-run replays the last *N* gate decisions in the affected scope under the proposed effective config and reports:

- Decisions that would have flipped (auto → escalate or vice versa).
- Decisions that would have been blocked entirely (e.g. a tighter budget).
- Specialists that would have been disallowed.

Dry-run is advisory, not blocking. It exists so the resolver of `overlay_accept` has a concrete diff rather than an abstract patch.

**Implementation note.** Dry-run requires a replayable orchestration event log in addition to the optimistic CAS versioning described in `docs/09`. The current docs/09 task-version CAS prevents conflicting writes; it is not, by itself, a history that can answer "would this overlay have changed past decisions?" Phase A must therefore add append-only event records for gate decisions, policy inputs, specialist spawn decisions, and budget checks before `dry_run_overlay` can be more than a structural validation.

### 1.7 Open questions

- **Patch format.** JSON-merge-patch is simple but lossy on arrays (replace vs merge). RFC-6902 JSON-Patch is precise but verbose. Likely answer: typed patches per surface (e.g. `GatePolicyPatch`, `BudgetPatch`) rather than a generic format.
- **Conflict between simultaneous overlays at the same scope.** First-writer-wins via CAS; the second proposer sees the new base and re-proposes. No three-way merge.
- **TTLs.** Do overlays expire? Probably yes for budget-loosening overlays (auto-revert on goal completion), no for policy overlays.

---

## 2. Specialist agents as descriptors

### 2.1 Purpose

Today, the executor in docs/12 is a single role with full access to the orchestration provider surface. To support fine-grained delegation — "spawn a reviewer that can read this slice's evidence and write findings, but cannot read other slices, cannot write code, cannot spawn further agents" — specialists must be:

- **First-class artifacts.** Versioned, audit-logged, suspendable, killable.
- **Capability-scoped.** Their view of the state tree and the affordances they can call are explicitly enumerated in their spec.
- **Enforced at the consumer.** Capability checks happen in the SLOP consumer / runtime, not by trusting the specialist's prompt.

### 2.2 Specialist spec

A specialist is defined by:

```
SpecialistSpec {
  id                         # cas-keyed
  role                       # e.g. "reviewer", "diagnostician", "doc-writer"
  parent                     # spawning agent id (executor, planner, manager)
  scope                      # session / goal / spec / slice that bounds lifetime
  prompt_template_id         # reference to a versioned prompt template
  prompt_inputs              # bound values for the template

  capabilities {
    state_tree_reads         # list of { provider, path } patterns, deny-by-default
    state_tree_writes        # list of { provider, path } patterns, deny-by-default
    affordances              # explicit { provider, path, action, effects } allowlist
    spawn_allowed            # bool — can this specialist spawn further specialists?
    max_spawn_depth          # if spawn_allowed, hard cap
  }

  budget {
    tokens
    wall_time
    tool_calls
  }

  lifecycle {
    on_scope_end             # "kill" | "detach" | "persist"
    on_budget_exceeded       # "kill" | "escalate"
    on_parent_terminated     # "kill" | "reparent_to_orchestrator"
  }

  termination {
    reason                   # null while running
    final_artifact_ref       # e.g. findings id, review id
    terminated_at
  }
}
```

### 2.3 Capability masks

Reads and writes are expressed as path patterns over provider-scoped SLOP state trees. The patterns are matched in the consumer before any state read or affordance call.

Example for a reviewer specialist scoped to slice `S-7`:

```yaml
state_tree_reads:
  - provider: orchestration
    path: /specs/{spec_version}                    # full spec at the bound version
  - provider: orchestration
    path: /plans/{plan_version}/slices/S-7         # the slice metadata
  - provider: orchestration
    path: /tasks/{task_id_for_S-7}/evidence/**     # evidence under this slice
  - provider: orchestration
    path: /blobs/evidence/{task_id_for_S-7}/**      # blobs linked from that evidence
  - provider: orchestration
    path: /findings/scope=slice/S-7/**             # prior findings on this slice
state_tree_writes:
  - provider: orchestration
    path: /findings/scope=slice/S-7                # collection target for submit
  - provider: orchestration
    path: /findings/scope=slice/S-7/**             # may write its own findings
  - provider: orchestration
    path: /messages/parent                         # may message only its parent
affordances:
  - provider: orchestration
    path: /findings/scope=slice/S-7
    action: submit
    effects: [write]
  - provider: orchestration
    path: /blobs/evidence/{task_id_for_S-7}/**
    action: read
    effects: [read]
  - provider: orchestration
    path: /messages/parent
    action: send
    effects: [write]  # only to parent
spawn_allowed: false
```

Affordance entries are not global tool names. They bind a provider, target node path pattern, action name, and declared effect classes. This is required by SLOP's node-local affordance model: many valid affordances are parameterless because the target is implicit in the node being invoked.

Pattern syntax is glob-with-templates. Templates resolve at spawn time against the parent's bound context (e.g. `{spec_version}` → the spec the parent was working against). After spawn, templates are frozen — a reviewer for spec v2 cannot see spec v3 just because v3 was accepted later.

### 2.4 Enforcement model

Every state read and affordance call from a specialist passes through a **capability gate** in the runtime:

```
specialist.read(provider, path)
  → mask_check(spec.capabilities.state_tree_reads, provider, path)
  → if denied: raise CapabilityViolation, log to audit, do NOT silently empty-result

specialist.invoke(provider, target_path, action, args)
  → match { provider, target_path, action } against spec.capabilities.affordances
  → for each declared effect, mask_check target_path against state_tree_reads/state_tree_writes
  → for each path-like arg, mask_check against reads/writes as appropriate
  → spawn_specialist requires spec.capabilities.spawn_allowed AND depth < cap
```

The target node path is checked even when the affordance has no path parameter. This closes the parameterless-affordance bypass: `complete` on `/tasks/T-1` is still a write to `/tasks/T-1`, even if the action input is `{}`. Providers must either declare affordance effects in their descriptors, or the meta-runtime must maintain an effect registry for built-ins. Unknown effect shape defaults to denied for specialists.

Violations are hard errors and audit events. They are never silent denials — the specialist must be able to know it tried something out-of-scope so it can re-plan rather than retry.

The specialist's prompt is told its capability surface but is not trusted with it. Prompts drift; consumer enforcement does not.

### 2.4.1 Taint propagation

Identity-based capability is insufficient when a specialist's *inputs* are attacker-controlled. A reviewer with legitimate write access to `/findings` can be coerced via prompt injection in a fetched web page or a pasted spec fragment to write findings that exfiltrate state through their content. (Cf. EchoLeak / CVE-2025-32711 in the M365 Copilot stack, and the MiniScope information-flow model.)

Mitigation is a per-session taint flag, propagated mechanically:

- Blobs in `/blobs` carry a `trust` field: `internal` (authored by orchestration agents or the user directly) or `untrusted` (web fetches, external file imports, pasted content from unbounded sources).
- A specialist that reads any `untrusted` blob acquires a `tainted_session` flag for the remainder of its lifetime.
- While `tainted_session` is set, the runtime auto-escalates any of: irreversible affordances, writes to `/specs`, `/plans`, `/overlays`, `/specialists`, and `spawn_specialist` calls — *regardless of the static capability mask*.

This is orthogonal to the static masks and never grants capability — it only narrows. The flag is one-way (no untaint affordance); a tainted specialist that needs to do high-risk work terminates and the parent re-spawns a fresh specialist with explicit, scoped re-fetch.

### 2.5 Privilege tiers

Two tiers, no arbitrary nesting:

| Tier | Examples | Can spawn | Can mutate config |
|---|---|---|---|
| **Orchestration agents** | Spec agent, planner, executor, runtime manager | Specialists only | Manager only, via overlays |
| **Specialists** | Reviewer, diagnostician, doc-writer, security-checker | No (default) | No |

A specialist with `spawn_allowed: true` can spawn further specialists, but the spawned chain inherits a depth counter and a *capability monotone* — a child cannot have any capability the parent did not have. This is enforced at spawn time by intersecting the proposed capabilities with the parent's.

The capability monotone is what prevents privilege escalation through the spawn graph. A reviewer without write access to `/specs` cannot spawn a child with that access, regardless of what the reviewer's prompt asks for.

### 2.6 State-tree shape

```
/specialists
  index
  /<specialist_id>
    spec                   # SpecialistSpec above
    status                 # spawning | running | suspended | terminated
    audit                  # capability violations, re-spawns, escalations
    parent_chain           # full chain back to root orchestrator
    /events
      <event_id>           # invocations, decisions, message sends
```

### 2.7 Affordances

| Affordance | Caller | Effect | Gated by |
|---|---|---|---|
| `spawn_specialist` | orchestration agent or `spawn_allowed` specialist | Creates specialist in `spawning` state, resolves capabilities, starts loop | `specialist_spawn` gate |
| `suspend_specialist` | parent or orchestrator | Pauses without termination | None |
| `resume_specialist` | parent or orchestrator | Resumes if budget remains | None |
| `terminate_specialist` | parent, orchestrator, or self | Marks terminated; no further events accepted | None |
| `request_capability_extension` | specialist | Submits extension request to parent; parent decides | `specialist_capability_extend` gate |

`request_capability_extension` is the legitimate path for a specialist that finds itself under-scoped. It does not grant the capability — it asks the parent to revisit the spec. Without this, specialists either silently fail or work around their scope, both bad.

### 2.8 Gate types added

| Gate | Default (HITL) | Default (autonomous) |
|---|---|---|
| `specialist_spawn` | escalate for novel role; auto for known role within allowlist | auto if within allowlist; escalate otherwise |
| `specialist_capability_extend` | escalate | escalate (always — extension is privilege escalation) |

### 2.9 Sibling reconciliation

When a parent spawns ≥2 concurrent specialists on overlapping scope (same slice, same spec section, same finding target), the parent **must** surface each child's output to the others before any of them is committed downstream. The reconciliation step is owned by the parent, audited, and not optional.

This sounds like it contradicts the docs/12 handshake protocol rule that specialists never communicate directly, but does not. Specialists still produce one-way upward messages; the parent is the authoritative reader and merger. The rule says: when work overlaps, the merge step is not a privilege the parent can skip. Without it, two reviewers with non-empty findings on the same slice produce a coherence failure of the kind documented in production multi-agent systems (Cognition's "Don't Build Multi-Agents", 2025) — incompatible local choices that the parent never reconciles because it never compares them.

Reconciliation outcomes:

- **Concordant** — all specialists agree within tolerance; parent commits union of findings.
- **Discordant** — parent invokes a `reconciliation_resolve` gate; resolver chooses, escalates, or requests a re-spawn.
- **Contradictory on a load-bearing fact** — always escalates.

Specialists with non-overlapping scope (different slices, different finding targets) require no reconciliation step.

### 2.10 Prompt template registry

Specialists reference `prompt_template_id`. The `/prompts` provider stores immutable, hash-keyed templates as blobs (not descriptors). Each template carries optimization lineage: parent template, optimizer that produced it, holdout score.

To prevent the registry quietly accreting into an unbounded skill-library surface, the registry caps **active promoted variants per role at K=4**. Promotion of a fifth variant retires the oldest active one (it remains in the immutable store; only its `promoted` flag flips). This is a local guard against retrieval and prompt bloat in Voyager/SAGE-style systems, not a claim that those papers report degradation. Promotion is always a manual action by a human reviewer, never threshold-driven from telemetry. See §5.6 for why.

### 2.11 Role memory

Specialists accumulate craft over their lifetime — the `reviewer` role's heuristics, the `diagnostician`'s common failure-class patterns, the `doc-writer`'s prose conventions. Prompt template variants (§2.10) capture *promoted* craft as data, but specialists also need a writable surface for in-progress observations between sessions. That surface is **role memory**.

This is conceptually the "role tier" from the earlier markdown sketch in `docs/11-memory-tiers.md` (now superseded for substrate). It is **not** identity memory (`docs/14 §2`) — identity memory is about the agent ↔ user ↔ project relationship, role memory is about specialist craft. The two stores stay disjoint by design: a `reviewer` specialist must not see "the user prefers Bun" (irrelevant to its task and crowds the prompt); the identity curator must not see "reviewer learned to flag missing `useEffect` cleanups" (irrelevant to user-facing voice).

#### State-tree shape

```
/roles
  /<role_name>
    /memory
      /<note_id>
        scope                  # "global" | "project"
        fact                   # typed structure per role
        source_event_id        # CAS key from a prior specialist event
        confidence
        created_at, last_used_at, use_count
        retired_at?
    /variants                  # §2.10 prompt template variants live here too
```

The `scope` field gives the role-axis half of the docs/11 routing matrix: `global` notes are craft that travels with the role across projects; `project` notes are role-specific learnings tied to this codebase. Identity memory provides the other half (`user` / `project` / `self`).

#### Writeback discipline

Specialists at spawn read role memory matching their role and applicable scopes (project notes for the current project + global notes). Reads happen at spawn time and are **frozen for the specialist's lifetime** — same rule as skills (`docs/14 §3.4`), and for the same reason: dynamic mid-session memory loading would break the §2.4 capability enforcement guarantees.

| Affordance | Caller | Effect |
|---|---|---|
| `add_role_note(scope, fact, source_event_id, confidence)` | specialist of that role | New note. Capability-checked: a `reviewer` cannot write to `/roles/diagnostician/memory`. |
| `update_role_note(note_id, patch, reason)` | specialist of that role | Mutates an existing note. CAS-versioned. |
| `retire_role_note(note_id, reason)` | identity curator or user | Soft-deletes. Specialists cannot retire — they propose; the identity curator (or user) decides. |

The retire-asymmetry is deliberate. A specialist may notice that a note has gone stale, but if it could retire its own craft we'd reintroduce a self-modification feedback loop at the role tier. Retire is identity-curator only.

#### Decay and cap

Same mechanical guards as identity notes (`docs/14 §2.4`):

- TTL + use-counter decay.
- Hard cap on active notes per role (default: 128).
- LRU eviction by `(last_used_at, confidence)`.
- Eviction is to a cold store, not deletion.

The per-role cap is half the identity-notes cap because role memory is read into a *specialist's* prompt, which is more constrained than the identity curator's. If a role's working set exceeds the cap, that's a signal the role should fork (e.g. `reviewer-frontend` and `reviewer-backend`), not that the cap should grow.

#### Tainted specialists cannot write role memory

Extends §2.4.1. A specialist whose session is tainted may have ingested attacker-controlled content; its `add_role_note` calls are rejected. This closes the role-memory analog of the EchoLeak class.

#### No cross-role reads

A `reviewer` specialist reads only `/roles/reviewer/memory/**`. There is no affordance for cross-role memory access. If two roles legitimately need to share craft, the answer is to fork a parent role and have both inherit, not to grant cross-reads. Cross-role reads recreate the docs/11 cross-talk failure mode.

### 2.12 Open questions resolved

- **State-tree read semantics.** Specialists see the **live tree within mask, frozen template parameters at spawn**. New events under masked-in subtrees are visible as they land; values that were template-bound at spawn (e.g. `{spec_version}`) do not refresh. Implementation: a checkpointer-subscription model (LangGraph-style) over the masked subtree, not snapshot copies.
- **Cross-specialist coordination.** Forbidden directly; required transitively when scope overlaps (see §2.9). Same rule as docs/12 § The handshake protocol, with the reconciliation refinement.

---

## 3. Spawn affordances and budgets

### 3.1 Purpose

Without explicit budgets, "spawn a specialist" is unbounded. Budgets exist at two levels:

- **Per-specialist** — declared in the spec, enforced by the runtime.
- **Aggregate** — per-goal, per-session caps that bound *total* specialist activity.

### 3.2 Budget dimensions

| Dimension | Per-specialist | Aggregate (per-goal) |
|---|---|---|
| Tokens (input + output) | Hard cap | Hard cap |
| Wall time | Hard cap | Soft warning, then hard cap |
| Tool calls | Hard cap | — |
| Spawn depth | Hard cap | — |
| Concurrent specialists | — | Hard cap (default: 4) |
| Specialists spawned (lifetime) | — | Hard cap (default: 32) |

Aggregate caps live in the goal's effective config and are overlay-able. Per-specialist caps are set at spawn time and frozen.

### 3.3 Enforcement

Token and tool-call counters are maintained in the specialist's state subtree. Each LLM call and affordance invocation increments them in the same transaction as the call's audit event. When a hard cap is hit:

- `kill` lifecycle → specialist terminated, parent notified via standard escalation message.
- `escalate` lifecycle → specialist suspended, `budget_exceeded` gate opened for resolver.

Aggregate caps hit before per-specialist caps when many small specialists run in parallel. The aggregate breach blocks `spawn_specialist` (returns explicit error) rather than killing existing specialists. Existing work is sunk cost; new work is not.

**No spawn priorities.** Spawn requests are FIFO under the aggregate cap. There is no priority queue, no preemption, no "this is a high-priority spawn, evict a low-priority specialist." Adding priorities is the kind of complexity that pays off only at scales the meta-runtime is not designed for, and creates a class of starvation bugs we don't want to debug. If a goal genuinely needs more concurrent specialists, the answer is an overlay raising the aggregate cap (which escalates by §1.5 loosening asymmetry), not a priority system.

### 3.4 Gate types added

`budget_exceeded` already exists in docs/12 (always escalate). The meta-runtime adds:

| Gate | Default (HITL) | Default (autonomous) |
|---|---|---|
| `aggregate_specialist_cap` | escalate | escalate |

### 3.4.1 Gate schema migration

The gate names introduced by the meta-runtime are schema changes, not free-form strings. Before the corresponding providers land, the checked-in orchestration `GateType` and generic `open_gate` descriptor must be extended for: `overlay_accept`, `overlay_revoke`, `specialist_spawn`, `specialist_capability_extend`, `reconciliation_resolve`, `aggregate_specialist_cap`, and `manager_action_review`.

`budget_exceeded` exists in docs/12 as a design-level gate, but it is not in the current checked-in gate enum. Budget enforcement must add it to the same schema migration. This keeps the "schema is code" invariant in §6.1 honest.

### 3.5 Open questions

- **Token accounting at the LLM adapter layer.** Requires the adapters in `src/llm/` to emit usage on a callback hook the runtime can attach. Implementable today but not implemented.
- **Cost ≠ tokens.** A reviewer that reads 100 evidence blobs without LLM calls costs storage I/O. Initial answer: ignore, treat tokens as the only currency. Revisit if storage I/O becomes load-bearing.

---

## 4. Reflection surface

### 4.1 Purpose

For the runtime to learn from itself — and for operators to debug it — runtime behaviour must be queryable as state, not as logs. The reflection provider exposes:

- Per-gate-type outcome counts and latencies.
- Re-prompt / respawn / escalation rates per slice and per role.
- Specialist spawn/termination history with outcomes.
- Overlay history with effect (did acceptance rates shift after this overlay landed?).
- Drift signals computed over typed evidence claims (referenced from docs/12 § Evidence schema).

### 4.2 State-tree shape

Counters split by typed *reason*, not just outcome. Raw "gate X escalated 80%" gives the manager (and the operator) nothing to act on. "Gate X escalated 80%, of which 70% were `evidence_insufficient` on `observed`-class checks" points at a concrete overlay (raise replayable-evidence requirement for that gate-type). This follows the GEPA / DSPy result that diagnostic side information beats scalar reward for downstream optimization (arxiv 2507.19457).

Reasons are typed enums per gate-type, not free text. Adding a new reason is a code change (it's part of the schema, per §6.1).

```
/reflection
  /gates
    /<gate_type>
      counts                 # opened, auto_resolved, escalated, failed
      escalation_reasons     # { <reason>: count } — typed enum per gate-type
      auto_reasons           # { <reason>: count } — why auto-resolved (precedent, default, override)
      latency_p50/p95
      window                 # time range covered
  /slices
    /<slice_id>
      attempts               # ordered attempt records
      outcome
      total_budget_used
  /specialists
    /by_role
      /<role>
        spawned, terminated_normal, terminated_killed, terminated_violated
        avg_budget_used
  /overlays
    /<overlay_id>
      pre_window_metrics
      post_window_metrics
      attributable_delta     # heuristic; flagged as such
  /drift
    /<spec_version>
      signal                 # statistical drift score
      contributors           # which slice evidence drives it
```

The reflection provider is **derived state**. It is computed (or incrementally maintained) from the artifact graph, not authored. There are no affordances to write to `/reflection` directly.

### 4.3 Affordances

Read-only:

| Affordance | Purpose |
|---|---|
| `query_gate_outcomes` | Filter by type, scope, window |
| `query_specialist_outcomes` | Filter by role, scope, window |
| `query_drift` | Drift signals for a spec version |
| `get_overlay_effect` | Attribution heuristic for an overlay |

### 4.4 Computation model

Two layers:

- **Eager counters.** Updated transactionally with the underlying event (gate decided → counter incremented). Cheap, always current.
- **Periodic rollups.** Batched computations over events, e.g. drift signals, overlay attribution, p95 latencies. Run by a scheduled job, results cached in `/reflection`.

Periodic rollups are not real-time. The reflection surface advertises a `last_computed_at` per subtree so consumers can decide whether to wait for a fresh rollup.

### 4.5 Open questions

- **Attribution.** "Did this overlay improve outcomes?" is a causal-inference question and the system cannot run randomized trials on itself. The honest answer is "we report pre/post deltas labelled as correlational." Consumers (manager agent, operator) decide what to do with that.
- **Privacy of failure data.** A reviewer specialist that consistently fails is a useful signal but also a noisy one. Reflection includes raw counts; subjective quality assessments stay out.

---

## 5. The runtime manager agent

### 5.1 Purpose

An orchestration-tier agent (per docs/12 § Roles) whose only job is to read the reflection surface and propose overlays or specialist spawns in response to signals. It does **not** author goals, specs, or plans. It does **not** resolve gates that it itself opens.

### 5.2 Trigger model

The manager is **signal-driven, not continuous**. It is invoked when:

| Signal | Source | Manager action menu |
|---|---|---|
| Slice failed verification ≥ 3 times, dominant failure reason known | `/reflection/slices` | spawn specialist matched to reason (diagnostician for env, reviewer for spec misread) |
| Gate of type X escalates ≥ 80% with one dominant `escalation_reason` (≥ 60% of escalations) | `/reflection/gates` | propose overlay targeting that reason; otherwise no-op |
| Spec drift signal exceeds threshold | `/reflection/drift` | message planner with `EscalationRequest` (no overlay) |
| Aggregate specialist cap hit | budget event | propose budget overlay; default no-op |
| Goal idle ≥ T with open gates | scheduler | digest, no action |

Triggers key on **reason distribution**, not raw rates. A gate-type with 80% escalation but no dominant reason is *noise* — the manager takes no action because there is no concrete overlay it could propose. Acting on rates without reason concentration is how overlay churn (§5.5) starts.

The action menu is **fixed** at this stage. The manager picks from the menu; it does not invent new action types. This is the "training wheels" version mentioned in the conversation that produced this doc — free-form self-rewriting only after the menu version proves stable.

### 5.3 Capability surface

| Capability | Granted? |
|---|---|
| Read `/reflection/**` | Yes, through a manager view that redacts goal-completion and final-outcome fields |
| Read `/goals`, `/specs`, `/plans` (current goal scope) | Yes, excluding terminal goal outcome fields |
| Read task/finding operational summaries | Yes — attempts, failure classes, open gates, and reason distributions only |
| Read raw `/tasks`, `/audit`, or user `/digests` | **No** |
| Read goal *completion status* / final audit result | **No** during the goal; post-goal manager digest only after actions are frozen |
| `propose_overlay` | Yes |
| `commit_overlay` | **No** — must go through resolver |
| `spawn_specialist` (from fixed allowlist of roles) | Yes |
| Author goals/specs/plans | **No** |
| Resolve any gate | **No** |

The manager is privileged over the reflection and overlay surface but is *not* a resolver. Its proposals go through the same gate machinery as anyone else's.

The manager does not consume the same raw state tree that a human dashboard consumes. It gets a redacted manager input view, derived from `/reflection`, `/gates`, `/tasks`, `/findings`, and scheduler events, with terminal goal status, final audit pass/fail, and user digest headline status removed.

The **goal-completion blindness** row is load-bearing. The manager sees gate outcomes (auto/escalate/fail), failure classes, and reason distributions; it does not see whether the goal ultimately shipped. This is the mechanical guard against the goal-rationalization failure mode named in §6.2 — a manager that knew "did we ship" as a signal would, against repeated goals, evolve overlays that loosen gates whenever shipping is at risk. Mechanical blindness, not policy, is what stops this. Goal completion is exposed only in a post-goal manager digest after the manager's overlays and specialist spawns for that goal are frozen. That digest is archival/evaluation input for future manual review, not a trigger source for current-goal action.

### 5.4 Lifecycle

The manager is mounted at session scope when the meta-runtime is active. It runs in response to triggers, then idles. It has its own budget (tokens, decisions per goal) and can be suspended via overlay.

### 5.5 Stop conditions and circuit breaker

A circuit breaker freezes the manager when *any* of:

- Effective config has been mutated by the manager ≥ N times in window M without a verified gate pass on any goal in scope.
- The manager has proposed the same patch (modulo whitespace) ≥ 2 times in a goal.
- Aggregate manager-driven specialist budget exceeded.

When frozen, the manager is suspended; existing overlays remain in effect; humans must explicitly resume.

### 5.6 Menu-item promotion is manual

Each menu item begins in **training-wheels** mode: every invocation is reviewed by a human before it commits anything (manager proposes an action, the proposal opens a `manager_action_review` gate that always escalates). Promotion of a menu item from training-wheels to autonomous is a **manual decision by a human reviewer**, never derived from telemetry.

Threshold-driven promotion ("auto-promote when success rate > T") looks principled but reintroduces exactly the rationalization loophole §6.2 names: a manager allowed to influence its own promotion criteria — even indirectly, via the actions it takes that contribute to the success metric — has a feedback loop into its own autonomy. This is the failure mode demonstrated by the Darwin Gödel Machine (arxiv 2505.22954) and Gödel Agent (arxiv 2410.04444) lines, where symmetric self-modification against a scalar reward drives constraint erosion. The fix is mechanical: promotion is not a function the manager can influence.

In practice this means a human reviewer periodically inspects manager-proposed actions, the overlays they produced, and the downstream gate outcomes. If a particular menu item has produced clean, useful proposals, the reviewer flips it to autonomous. Demotion (autonomous → training-wheels) is symmetric and may be threshold-driven, since tightening the leash is always safe (§1.5).

### 5.7 Open questions

- **Objective function beyond the menu.** A general objective ("optimize gate outcomes") is too underspecified and will rationalize. Keep menu-driven indefinitely; expand the menu by adding new items, not by relaxing the constraint that the manager picks from a fixed set.
- **Manager evaluation.** How do we know the manager is helping vs. churning config? The credible answer is held-out goals run with and without manager intervention, comparing aggregate gate-outcome distributions. This is awkward to operate in production but follows the Reflexion / GEPA evaluation pattern. Until that is set up, manual review of overlay-attributed deltas is the interim.

---

## 6. Risks and invariants

The meta-runtime introduces new failure modes. The following invariants are non-negotiable; implementations that violate them are bugs.

### 6.1 Invariants

1. **Schema is code.** Artifact and message schemas cannot change at runtime. Overlays touch policy, not shape.
2. **Capability monotone.** A child specialist has a capability surface that is a subset of its parent's. Enforced at spawn.
3. **No silent denials.** Capability violations and budget breaches are explicit errors visible to the violator. Empty results from out-of-scope reads are forbidden.
4. **Resolver separation.** No agent resolves a gate it opened. The manager proposes; resolvers (humans or policy) decide.
5. **Reversibility.** Every overlay is revocable. Every specialist is killable. Effective config recomputes on revoke.
6. **Audit completeness.** Every overlay commit, specialist spawn, capability violation, and budget breach is in `/audit`. No path to a hidden change.
7. **Loosening asymmetry.** Tightening (more gates escalate, smaller budgets) auto-resolves more aggressively than loosening. Autonomous loosening of its own constraints is escalated by default.

### 6.2 Failure modes worth naming

Each named failure mode includes the canonical SOTA instance that demonstrated it, where one exists. Naming the source makes the risk concrete rather than abstract and makes it easy for future contributors to verify the mitigation is still load-bearing.

- **Spawn cascade.** A specialist spawns a specialist spawns a specialist. Mitigated by `max_spawn_depth`, aggregate caps, and capability monotone (each layer can only narrow). No canonical public failure case; the theoretical risk is enough.
- **Runaway loops (AutoGPT-class).** An agent reflects, retries, reflects, retries, never converging. AutoGPT-style systems without strong completion/evaluation boundaries are the public instance; MetaGPT's benchmark discussion (arxiv 2308.00352) reports AutoGPT failing to produce executable output on tasks where more structured workflows succeed. Mitigated by §3 budgets, §5.5 circuit breaker, and same-patch detection.
- **Overlay churn.** Manager flips a gate auto/escalate every cycle. Same root cause as runaway loops, applied to config rather than to a single agent. Mitigated by circuit breaker and same-patch detection.
- **Groupchat coordination failure (ChatDev / MetaGPT-class).** Multi-agent systems with full-history conversation between agents accumulate coordination and verification failures; arxiv 2503.13657 identifies inter-agent misalignment and task-verification failures as core MAS failure modes. Mitigated structurally: docs/12 §The handshake protocol and §2.9 here forbid direct specialist-to-specialist chatter. There is no groupchat surface to blow up.
- **Skill/template accretion (Voyager / SAGE-class).** Skill-library systems are useful, but an unbounded active prompt/template set becomes a retrieval and prompt-budget surface in this design. Mitigated by §2.10 active-variant cap (K=4 per role); immutable history may grow, but the active set is small and manually promoted.
- **Capability creep via tainted inputs (EchoLeak / MCP-class).** A specialist with legitimate write access ingests attacker-controlled content and is coerced into misusing its capability. CVE-2025-32711 (M365 Copilot zero-click exfiltration) is the textbook instance; the broader class is studied under "information flow for tool-using agents" (MiniScope, arxiv 2512.11147; Log-To-Leak on MCP). Mitigated by §2.4.1 taint propagation.
- **Capability creep via extension grants.** Repeated `request_capability_extension` accepted ratchets the surface up. Mitigated: extensions always escalate to human resolver in autonomous mode; overlays cannot grant capabilities to running specialists, only to future spawns.
- **Sibling incoherence (Cognition-class).** Concurrent specialists on overlapping scope produce locally-correct but mutually-incompatible output the parent never reconciles. Cognition's writeup ("Don't Build Multi-Agents", 2025) is the public instance. Mitigated by §2.9 mandatory reconciliation.
- **Reflection lying.** Eager counters drift from underlying events under partial failure. No canonical public instance, but a known general risk in any eventually-consistent telemetry system. Mitigated by periodic recomputation from the event log; counters are advisory if `last_computed_at` is stale beyond threshold.
- **Goal rationalization at the policy layer (Gödel-class).** Manager loosens a gate so the goal completes. The Darwin Gödel Machine (arxiv 2505.22954) and Gödel Agent (arxiv 2410.04444) lines demonstrate this in practice: symmetric self-modification against a scalar success metric drives constraint erosion. Mitigated by §1.5 loosening asymmetry, §5.3 goal-completion blindness, and §5.6 manual menu-item promotion. This is the failure mode the meta-runtime spends the most design budget on, because it is the one that is hardest to detect after the fact.

---

## 7. Phased rollout

The four capabilities are independent. They land in this order, each useful on its own.

### Phase A — Overlay layer (no manager, no specialists)

- `/overlays` provider with `propose_overlay`, `commit_overlay`, `revoke_overlay`, `dry_run_overlay`.
- Effective-config composition for the surfaces enumerated in §1.2.
- `overlay_accept` / `overlay_revoke` gates wired through existing resolver machinery.
- Audit entries on every commit/revoke.

**Demo:** during an HITL session, an operator tightens slice-gate verification rules for a sensitive goal via an overlay, then revokes it after the goal completes. No code change.

### Phase B — Specialists (no manager)

- `/specialists` provider with `spawn_specialist`, `suspend`, `resume`, `terminate`, `request_capability_extension`.
- Capability mask enforcement in the runtime / consumer.
- Capability monotone at spawn.
- Budget accounting per specialist.
- A small initial role allowlist: `reviewer`, `diagnostician`, `doc-writer`. Each with a versioned prompt template.

**Demo:** an executor that hits a slice gate failure spawns a `diagnostician` specialist with read-only access to the slice's evidence. The diagnostician writes a finding; the executor re-prompts using it.

### Phase C — Reflection surface

- `/reflection` provider with eager counters and periodic rollups.
- Read-only query affordances.
- Drift signal computation over typed evidence (depends on docs/12 evidence schema being landed).

**Demo:** an operator queries gate outcomes for the past goal and sees `spec_question.judgment` escalation rate; manually proposes an overlay that escalates `spec_question.inference` too, since most inferences in this goal escalated post-hoc.

### Phase D — Runtime manager (training wheels)

- `/runtime-manager` provider with a fixed action menu.
- Signal-driven invocation (not continuous).
- Circuit breaker and same-patch detection.
- Manual review of all manager-driven overlays for the first N goals.

**Demo:** a goal with three repeated slice failures triggers the manager to spawn a diagnostician unprompted; outcome is logged; resolver reviews.

### Beyond Phase D

Cross-session learning, expanded manager menu, evaluation loop. None of this is in scope for this doc; it is what becomes possible if the four phases work. Two parts of "beyond" deserve specificity now so future contributors don't reinvent them ad hoc:

- **Cross-session learning is offline.** Concretely: prompt-template evolution following the DSPy / GEPA pattern (arxiv 2507.19457) — accumulated traces from completed goals form a corpus, an offline optimizer proposes new template variants against an evaluator with a held-out set, and successful variants enter the registry as candidate (not promoted) entries. Promotion to `promoted` remains a manual human action per §2.10. There is no online learning loop; the live system never updates its own prompts mid-session. This deliberately rules out the closed feedback loop that DGM-class systems use, for the same reason §5.6 rules out threshold-driven menu promotion.
- **Expanding the action menu is a code change**, not an autonomous capability. New menu items are added in source, reviewed, and start in training-wheels. The menu does not grow at runtime.

Free-form manager actions (manager invents action types) are explicitly **not** on the roadmap. They are not "the next phase"; they are a different design that this doc rejects.

---

## 8. Cross-references and related work

### Internal

- `docs/09-orchestration-state-machine.md` — substrate, CAS, verification gate.
- `docs/12-orchestration-design.md` — artifacts, roles, gates as policy tree, evidence schema. The meta-runtime extends docs/12; conflicts resolve in docs/12's favour for substrate concerns.
- `docs/11-memory-tiers.md` — superseded routing sketch for role memory. The `auto_with_precedent` gate model lives in docs/12's precedent/case design, not in docs/11.
- `src/providers/builtin/orchestration/descriptor-*.ts` — current descriptor pattern. Meta-runtime providers follow the same pattern (state subtree + descriptors + affordances).

### External — load-bearing references

The design choices marked with rationale in this doc draw on the following work. These are pointers, not endorsements; some are cited as the failure mode to avoid.

- **Cognition, "Don't Build Multi-Agents"** (cognition.ai, 2025) — sibling-incoherence failure case, motivating §2.9.
- **MiniScope: Least Privilege for Tool-Calling Agents** (arxiv 2512.11147) — information-flow model behind §2.4.1 taint propagation.
- **EchoLeak / CVE-2025-32711** — concrete prompt-injection-via-tainted-input case in M365 Copilot, also motivating §2.4.1.
- **Why Do Multi-Agent LLM Systems Fail?** (arxiv 2503.13657) — empirical taxonomy of MAS failures, especially inter-agent misalignment and task verification failures; supports the no-groupchat stance in §2 and §6.2.
- **MetaGPT** (arxiv 2308.00352) — structured multi-agent workflow and benchmark contrast with less-structured AutoGPT/AgentVerse approaches; context for the docs/12 typed handoff design.
- **Voyager** (arxiv 2305.16291) and **SAGE: Reinforcement Learning for Self-Improving Agent with Skill Library** (arxiv 2512.17102) — skill-library systems; motivate keeping immutable history separate from a capped active variant set in §2.10.
- **GEPA optimizer in DSPy** (arxiv 2507.19457; dspy.ai) — diagnostic side information beats scalar reward; motivates §4.2 reason-typed counters and §7 cross-session learning.
- **Reflexion** (arxiv 2303.11366) — verbal-feedback self-improvement; the foundational pattern §5.7 points to for held-out evaluation.
- **Darwin Gödel Machine** (arxiv 2505.22954) and **Gödel Agent** (arxiv 2410.04444) — symmetric self-modification with scalar reward; cited as the *negative* case for §1.5, §5.3, §5.6, §6.2, and §7-Beyond.
- **LangGraph checkpointer model** (langchain.com) — implementation reference for §1.6 dry-run and §2.11 specialist read semantics.
- **MCP / ACP / A2A protocol survey** (arxiv 2505.02279) — context for the SLOP-native vs. flat-tool-registry design choice.
