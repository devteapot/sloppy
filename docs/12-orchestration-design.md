# Orchestration Design — Spec-Driven, Multi-Agent

This document captures the design for Sloppy's spec-driven orchestration model: how goals become specs become plans become executed slices, who owns what, and how the same machinery runs human-in-the-loop or autonomously.

It is a design doc, not a state-of-the-code doc. It supersedes earlier informal sketches and is the reference the implementation should be measured against. The orchestration state machine in `docs/09-orchestration-state-machine.md` is the lower-level execution substrate this design sits on top of.

## Current implementation status

The checked-in implementation has the first HITL substrate in place, additively:

- `/goals`, `/gates`, `/messages`, `/audit`, and `/blobs` are orchestration provider surfaces.
- The public session provider mirrors a bounded pending-gate summary on `/orchestration` and can resolve those HITL gates through `accept_gate` / `reject_gate`.
- `create_plan_revision` writes a proposed complete slice set and opens a `plan_accept` gate; accepting the gate activates the revision and creates schedulable `/tasks` slices.
- Docs/12 slices keep the public task API but expose `slice_id`, upstream plan/spec version refs, assumptions, attempt metadata, typed evidence claims, and slice-gate state.
- Legacy `create_plan`, `create_task`, `create_tasks`, `record_verification`, and `complete` remain valid without docs/12 gates.
- Plan execution rejects scheduling/starting when the referenced spec version is stale.
- `submit_evidence_claim` stores typed checks/observations and opens a `slice_gate` once criteria are covered by replayable or observed evidence; self-attested evidence is retained but cannot satisfy criteria.
- Plan revisions can opt slice gates into the first deterministic policy resolver: `slice_gate_resolver: "policy"` auto-accepts a slice gate only after typed evidence covers every criterion and records the policy/evidence refs on the gate.
- `record_verification` is still a compatibility affordance and writes a minimal legacy `EvidenceClaim`.
- `run_final_audit` replays allowlisted replayable evidence commands against the current workspace, stores audit output as blobs, and HITL plan completion requires a passing final audit.
- Plan and plan-revision creation can carry configured wall-time and retry-per-slice budgets, including provider-level defaults from config. Digest generation reports budget burn and opens a `budget_exceeded` gate when a plan exceeds its wall-time cap; over-budget `retry_of` replacements are rejected and open a `budget_exceeded` gate for the logical slice.
- `generate_digest` on `/digests` writes immutable typed digest payloads summarizing headline state, slice changes, escalations, policy auto-resolutions, near-misses, drift metrics, configured wall-time/retry budget state, and next slices.
- The spec provider persists goal-version refs, accepted specs, immutable spec version snapshots, and criterion metadata on requirements.

Full scoped policy trees, token/cost budgets, precedents, push delivery for digests, and automated spec/planner runners remain future work.

## Engagement levels

This machinery is **opt-in and additive**, not mandatory. Architecturally, every component below is implemented as a SLOP provider stack — state tree + affordances — consistent with the project principle that the core stays small and capabilities come from providers (see `CLAUDE.md`). The core agent loop (observe state, invoke affordance) does not know orchestration exists. Mount no orchestration provider, get a bare agent.

The design forms a spectrum, not a switch:

```
bare agent  ──▶  agent + checklist  ──▶  HITL spec-driven  ──▶  autonomous
   (core)        (informal goals)        (full doc 12)         (policy tree)
```

A user stops at the level that fits the task:

| Engagement level | When to use | What's active |
|---|---|---|
| Bare agent | One-off fixes, exploratory work, single-turn tasks | Core loop only. No goal/spec/plan artifacts. |
| Agent + checklist | Multi-step task with light structure, no formal acceptance criteria | Goal artifact only. No planner; no spec agent. User gates everything. |
| HITL spec-driven | Multi-agent work with real correctness stakes | Full goal/spec/plan/slice pipeline. All gates resolve to user. |
| Autonomous | Long-running goals with tolerable autonomy | Same as HITL plus policy-tree resolvers, precedents, digest. |

Each layer in this document only activates when its artifacts exist. Gates need artifacts to gate. Precedents need gates to consult them at. Drift detection needs typed evidence claims to compute over. The full machinery is the upper bound, not the floor.

## Layered artifacts

Four versioned artifacts, each owned by exactly one role:

```
goal   ──(spec agent)──▶  spec   ──(planner)──▶  plan   ──(executors)──▶  reality
  ▲                                                                          │
  └────────────────── observation / drift detection ◀────────────────────────┘
```

| Artifact | Owner | Captures | Versioned on |
|---|---|---|---|
| **Goal** | user (mediated by orchestrator) | North star intent. May be fuzzy and evolve. | Every accepted revision. |
| **Spec** | spec agent | Concrete capture of the goal as testable intent. | Every accepted revision. |
| **Plan** | planner agent | Sequenced slices that turn current code into spec-compliant code. References `spec_version` and the repo commit it planned against. | Every accepted revision. |
| **Slice result** | executor agent | The code change for one slice plus its evidence. | Per execution attempt. |

Each artifact references the version of the artifact above it. A plan referencing a stale spec version is a hard error at execution time.

## Roles

Sharply separated. Each role only writes its own artifact and only reads upstream artifacts.

- **Orchestrator** — dumb router. Schedules work, enforces gates, dispatches events. Never authors content.
- **Spec agent** — authors the spec. Iterates with the user until accepted. Answers `SpecQuestion`s from the planner.
- **Planner agent** — authors the plan. Reads spec + repo on demand, drafts plan, iterates until accepted. Decides on revisions when executors hit problems mid-flight.
- **Executor agent(s)** — execute one slice each. Decompose their slice into an internal plan, produce code + evidence. Never talk to the spec agent directly.
- **Resolver** — the entity (human or policy) that decides gates. See § Gates as policy tree.

Spec agent and planner are not the same agent in two modes — they have different success criteria (intent capture vs. executable derivation) and should be evaluated separately.

## The handshake protocol

Inter-agent communication is typed and one-way upward. Free-form chat between agents is disallowed.

Message types live in the SLOP state tree as the substrate. Minimum set:

| Message | From → To | Purpose |
|---|---|---|
| `SpecQuestion` | planner → spec agent | Resolve ambiguity, gap, or contradiction with code. Tagged `lookup` / `inference` / `judgment` / `conflict`. |
| `SpecRevisionProposal` | spec agent → user (or resolver) | Propose a spec bump in response to a question or executor escalation. |
| `PlanRevisionProposal` | planner → user (or resolver) | Propose a plan revision (slice add/remove/reorder). |
| `EscalationRequest` | executor → planner | Slice cannot be completed as planned. Carries failure class + evidence. |
| `EvidenceClaim` | executor → orchestrator | Slice claims done; evidence attached for slice-gate evaluation. |
| `GoalRevision` | any → user (or resolver) | Propose a goal change. Tagged `minor` (refinement) or `material` (intent change). |

### Initial flow

1. User intent → spec agent drafts spec → user iterates → **spec v1 frozen**.
2. Planner reads spec v1 + explores repo on demand → drafts plan referencing spec v1 and pinning the commit it planned against. Records structural assumptions per slice (files, symbols, commit SHA). → user iterates → **plan v1 frozen**.
3. Orchestrator dispatches slices to executors per the plan.

### Mid-flight escalation (one-way upward)

```
Executor → Planner (EscalationRequest with evidence)
   Planner decides:
   ├─ plan-only fix → PlanRevisionProposal → resolver
   └─ spec issue → SpecQuestion to spec agent
        ├─ clarification (no spec change) → recorded as plan provenance
        └─ SpecRevisionProposal → resolver
              accepted → spec bumps, plan re-derives affected slices,
                         dependent slices invalidate, in-flight slices pause
```

Executors never bypass the planner. The planner never bypasses the spec agent. This keeps the spec's authorial voice singular and makes every decision auditable.

## Per-agent internal plans

Each executor decomposes its assigned slice into an internal plan when it picks up work. The general (planner-authored) plan stays stable; specialization happens at execution time and travels with the slice's evidence trail. The planner does not micro-decompose slices upfront.

## Gates as policy tree

Every decision point — spec accept, plan accept, slice gate, audit, irreversible action, goal revision — is a **gate** with a **resolver**. Mode is not a flag; it is a default resolver attached at a scope.

### Scopes (outer → inner)

```
session  ▶  goal  ▶  spec  ▶  slice  ▶  gate-type
```

Inner scopes override outer. A session may default to autonomous; a high-stakes goal inside it can pin HITL; routine slice-gates inside an HITL goal can still auto-resolve.

### Per-gate-type defaults

| Gate | Sensible autonomous default |
|---|---|
| Slice gate (tests pass, evidence attached) | auto-resolve |
| Plan accept | auto-resolve if `spec_version` unchanged from prior accepted plan; else escalate |
| Spec accept | escalate (intent capture is the user's domain) |
| `SpecQuestion: lookup` | auto-resolve |
| `SpecQuestion: inference` | auto-resolve with precedent; record inference as plan provenance |
| `SpecQuestion: judgment` | escalate |
| `SpecQuestion: conflict` | escalate (auto-resolving picks which spec sentence wins — that is intent change in disguise) |
| `GoalRevision: minor` | auto-resolve, log |
| `GoalRevision: material` | always escalate |
| Irreversible action | always escalate |
| Budget exceeded | always escalate |

"HITL preset" sets all gates to escalate. "Autonomous preset" sets the auto-resolvable ones to auto. Users can hand-tune per scope.

Current implementation note: the only policy resolver implemented so far is the deterministic slice-gate evidence-complete rule. It records `resolved_by=policy`, `resolution_policy_ref`, and `resolution_evidence_refs` on the gate. All spec, plan, goal, irreversible-action, and generic open gates still require explicit resolution unless future policy layers add narrower rules.

### SpecQuestion classification

Classify at emission time (by the planner), not at resolution time:

- **lookup** — answer is in the spec text; planner needs to be pointed at it.
- **inference** — answer follows from spec + reasonable defaults.
- **judgment** — genuine intent ambiguity.
- **conflict** — spec contradicts itself or the codebase.

When unsure of class, treat as `judgment`. False escalations are cheap; false auto-resolves are how goals drift silently.

### Per-goal policy example

```yaml
goal: "ship feature X autonomously by Friday"
autonomy:
  default: auto
  escalate:
    - irreversible
    - spec_revision
    - goal_revision.material
    - budget_exceeded
  auto_with_precedent:
    - spec_question.lookup
    - spec_question.inference
  budget:
    tokens: 5M
    wall_time: 48h
    retries_per_slice: 3
  digest: daily
```

## Goal evolution

Goal revisions are typed events with: proposed delta, evidence/reason, magnitude (`minor` / `material`). Minor refinements may auto-apply with logging in autonomous mode. Material changes always escalate to a human regardless of mode. Without this guard, an autonomous agent will rationalize its way into a goal it can satisfy rather than the one the user set.

## Failure handling: re-prompt vs respawn

When a slice gate fails, decide based on three signals:

1. **Context health** — looping, contradicting itself, transcript bloated/poisoned → respawn fresh.
2. **Failure class** — missed test or small bug → re-prompt with failure attached. Misread spec / wrong mental model → respawn with corrected framing. Tool/env failure → fix env, re-prompt.
3. **Iteration count + budget** — after N (default 2–3) re-prompts without convergence, escalate to planner; the slice may be mis-scoped.

Default heuristic: **re-prompt once, respawn on the second failure, escalate to planner on the third.**

## Audit timing

Per-slice gates are cheap and local: compiles, slice tests pass, evidence attached. The full **spec audit** runs once at the end against the integrated codebase, comparing reality to spec v_final. Conflating per-slice gates with the audit makes early agents over-fit to a partial picture and slows the inner loop.

## Evidence schema

Every slice attaches typed evidence to its `EvidenceClaim`. The schema serves three readers — slice gates (mechanical), drift detection (statistical), audit (integration-level) — so it has to be typed, not free-form.

### Shape

```ts
EvidenceClaim {
  slice_id, attempt_id, executor_id, timestamp
  at_commit: SHA              // commit before this slice's diff
  diff_ref: ChangesetRef

  checks: Check[]
  observations: Observation[]

  criterion_satisfaction: Array<{
    criterion_id: string       // refs spec acceptance criteria
    evidence_refs: string[]    // ids of checks/observations supporting it
    kind: "replayable" | "observed"
  }>

  provenance: {
    spec_sections_read: string[]
    clarifications_used: SpecQuestionId[]
    files_inspected: { path: string; commit: SHA }[]
    planner_assumptions: string[]
  }

  risk: {
    files_modified: string[]
    public_surface_delta: SurfaceDelta
    irreversible_actions: IrreversibleAction[]
    deps_added: string[]
  }
}

Check {
  id; type: "test" | "typecheck" | "lint" | "build" | "custom"
  command: string             // exact replay command
  exit_code: number
  output_ref: BlobRef         // bulk output stored on disk, ref in state
  duration_ms: number
  verification: "replayable" | "self_attested"
}

Observation {
  id; type: string            // open vocabulary
  description: string
  captured_data_ref?: BlobRef
  replay_recipe?: string
  verification: "observed"
}
```

### Six categories of evidence

1. **Diff** — the changeset itself.
2. **Checks** — deterministic, replayable verification (tests, typecheck, lint, build).
3. **Observations** — non-deterministic but recorded ("started dev server, clicked X, screenshot here").
4. **Criterion satisfaction map** — which evidence supports which acceptance criterion. The bridge from raw receipts to spec-level claim.
5. **Provenance** — what the executor knew when deciding.
6. **Risk declaration** — files modified, public-surface delta, irreversible actions, deps added. Feeds blast-radius caps and intent-drift detection.

### Load-bearing rules

1. **Verification class is per-item, not per-slice.** Each check/observation carries `verification: replayable | observed | self_attested`. Slice gates only count `replayable` and `observed` toward satisfaction. Self-attested is logged but never satisfies a gate alone.
2. **Criterion ↔ evidence mapping is bidirectional checkable.** Every accepted criterion must be referenced by ≥1 evidence item. Code change touching files unrelated to any mapped criterion is a coverage-gap signal feeding intent-drift detection.
3. **Acceptance criteria are authored by the spec agent, not the executor.** The executor produces evidence *satisfying* criteria; it does not author criteria. Otherwise tests pass but constrain nothing.
4. **Replay manifest is mandatory.** Every `replayable` check carries enough to re-run mechanically.
5. **Observed evidence weights less in drift math.** A criterion satisfied only by observations is a soft flag — fine for things that resist automation (UX feel, design judgment), suspicious for things that should be testable.
6. **Storage split.** Schema lives in SLOP state. Bulk artifacts (test output, screenshots, logs) live on disk as blobs, referenced by `BlobRef`. Retention attaches to blobs, not state.

### Acceptance criteria: code or text

Both are allowed. Code criteria (test file path, executable script) are unambiguous and weight heavily. Text criteria ("the API returns 401 for unauthenticated requests") are flagged as `observed`-class and weight less in drift math. The spec agent is nudged toward code criteria; text is the escape hatch for what genuinely resists mechanical verification. Bias toward moving fast — the final audit catches what slips through.

### Re-verification policy

The orchestrator **trusts executor-reported check results mid-flight** for inner-loop speed, and **re-runs the entire replayable evidence corpus at final audit** against final HEAD. This catches both lies and integration regressions in one pass without paying the cost on every slice gate. Sampling is not used — audit re-run is the truth check.

## Drift detection

"Drift" is three different signals conflated under one word. Each has a distinct response.

### 1. Progress drift — *not getting closer to done*

Signal: **distance-to-spec velocity.**

Distance-to-spec is computable because spec acceptance criteria are typed and machine-evaluable: each criterion is `satisfied` / `unsatisfied` / `unknown` against current HEAD. `distance = weighted count of unsatisfied + unknown`.

Velocity = `Δ(distance) / Δ(budget_consumed)`. Alarm fires when:
- velocity ≤ 0 for K consecutive slices, or
- projected exhaustion: `current_distance / current_velocity > remaining_budget`.

This forces specs to have machine-evaluable criteria — a discipline worth having anyway.

### 2. Coherence drift — *the system is contradicting itself*

Multiple signals; any one trips a soft alarm, evidence regression is hard-fail:

- **Re-plan rate** — `PlanRevisionProposals / slices_completed`.
- **Spec revision rate** — `SpecRevisionProposals / time`.
- **Question density** — `SpecQuestions / slice` — high means systemic ambiguity, not local.
- **Evidence regression** — slice N's completion flips a previously-satisfied criterion back to unsatisfied. Hard fail, immediate escalate.
- **Failure clustering** — same failure class across N+ slices. Means planner mis-modeled something structural.

### 3. Intent drift — *solving the wrong problem*

Hardest to detect mechanically. Signals (all derived from typed evidence):

- **Coverage gap** — code touched in a slice that doesn't map to any spec section. Each slice declares satisfied criteria; diff against the changeset's actual blast radius.
- **Off-plan slices** — planner proposed a slice not derivable from the spec.
- **Abstraction emergence** — new modules/abstractions appearing that aren't named in spec.
- **Goal-revision pressure** — high rate of `GoalRevision` proposals, especially `material`.

A system can be making fast progress (good velocity) on entirely the wrong thing — intent drift is the only signal that catches this.

### Response matrix

| Drift type | Default response |
|---|---|
| Progress drift | Pause, escalate to planner — slice may be mis-scoped or spec unreachable. |
| Coherence drift (soft) | Notify resolver in next digest. |
| Coherence drift (evidence regression) | Hard fail, immediate escalate. |
| Intent drift | Always escalate to user, regardless of mode. |

### Who computes drift

- **Progress + coherence**: the orchestrator computes synchronously on every `EvidenceClaim` acceptance. Deterministic, cheap.
- **Intent drift**: a dedicated observer agent subscribes to evidence events and runs LLM-judgement passes asynchronously ("does this code actually map to spec section 3.2?"). Async because it's expensive and not on the critical path.

All three feed off the same typed evidence substrate; drift detection and evidence schema are effectively one design problem.

## Guardrails (autonomous mode)

These apply universally, but are load-bearing in autonomous mode:

1. **Budgets** — tokens, wall time, $, retries — per goal, per spec, per slice. Blowing a budget is itself an escalation event.
2. **Irreversibility classifier** — every proposed action tagged `reversible` / `reversible-with-effort` / `irreversible`. Irreversible actions always escalate, regardless of mode.
3. **Blast radius caps** — max files touched per slice, max external calls, max concurrent agents.
4. **Stopping conditions** — explicit. Goal achieved → halt and report. Goal unreachable within budget → halt and report. Stuck (N consecutive failures of same type) → halt and escalate.
5. **Drift alarm** — if executor actions stop reducing distance-to-spec for K iterations, escalate. (Mechanics: see § Open threads.)

## Invariants

- Every artifact references the version of the artifact above it.
- Every gate auto-resolution is reviewable: traceable to the policy that decided it and the evidence that satisfied it. Autonomous ≠ invisible; autonomous = asynchronous review.
- Every cross-agent message is typed and persisted in SLOP state.
- The orchestrator never authors content. Authorship is always traceable to a named role.
- Spec frozen during planning. If the user revises spec mid-planning, that is an explicit `spec.revise` action that invalidates the plan-in-progress.

## Precedent format

When a gate is configured `auto_with_precedent`, the resolver looks up past decisions on similar questions. The schema is structured around defeating one specific failure mode: an LLM thinking two questions are similar when they aren't.

### Shape

```ts
Precedent {
  id, created_at, last_used_at, use_count

  context: {
    project_id
    goal_id?
    spec_version_at_creation: SpecVer
    question_class: "lookup" | "inference"   // judgment/conflict ineligible
    spec_sections_referenced: string[]       // structural key
    code_areas: string[]                     // structural key (module ids / globs)
  }

  question: {
    text: string                             // verbatim original
    canonical_summary: string                // normalized for matching
    embedding: number[]
    raised_by_role: "planner" | "executor"
  }

  resolution: {
    decided_by: "user" | "policy" | "supervisor_agent"
    answer: string
    reasoning?: string
    evidence_refs?: string[]
  }

  health: {
    matches_promoted: number
    matches_escalated_anyway: number
    contradicted: boolean
    invalidated_by?: SpecRevisionId
    expires_at?: timestamp
  }
}
```

### Matching pipeline

```
candidate question
   │
   ▼
structural pre-filter (deterministic, exact match on keys)
   │
   ▼
embedding similarity within candidates  ──── score
   │
   ├─ score ≥ HIGH      → auto-resolve, log precedent_id + score
   ├─ HIGH > score ≥ LOW → LLM-judge tiebreak ("are these equivalent?")
   │                        result: auto-resolve OR escalate
   └─ score < LOW       → escalate (potentially create new precedent)
```

The structural pre-filter requires shared `project_id`, `question_class`, ≥1 `spec_sections_referenced`, and ≥1 overlapping `code_area`. Structural keys are deterministic; they don't hallucinate. LLM-judge stays out of the hot path — only invoked in the borderline band.

### Load-bearing rules

1. **Only `lookup` and `inference` produce precedents.** `judgment` and `conflict` resolutions are context-specific user decisions and don't generalize.
2. **Spec-version invalidation is automatic.** When a `SpecRevision` lands, precedents whose `spec_sections_referenced` overlap with the revised sections are marked `invalidated_by`. Reuse forces escalation. Primary defense against stale precedent.
3. **Code revisions down-weight, don't invalidate.** Code under `code_areas` changes constantly; full invalidation on every diff would re-ask everything. Code change reduces match confidence proportionally.
4. **TTL split by class.** `lookup` precedents have no TTL (true as long as the spec section says what it says). `inference` precedents default to ~90 days or N spec versions — contingent on context that drifts.
5. **Health-driven decay.** Successful reuse increments `matches_promoted`. User override of a precedent-driven decision flips `contradicted = true` — contradicted precedents don't auto-apply; reuse forces re-confirmation, which either repairs the precedent or retires it.
6. **Per-project by default.** Storage: `.sloppy/precedents/` in the repo, versioned with code so teams share a precedent base. Optional `.sloppy/precedents/private/` (gitignored) for personal precedents. Promotion to global is explicit user action.
7. **Every auto-resolve is reviewable.** The digest shows precedent id, match score, structural keys that matched, link to original resolution. User can mark "this one was wrong" → flips `contradicted`. Pruning happens through use, not manual maintenance.

### Structural key authoring

Keys are auto-extracted by default — the planner already cites spec sections and the slice already declares blast radius, so the data exists. The planner can override/refine when emitting the `SpecQuestion`. Keys are validated at precedent-creation time: must be non-empty, must reference real spec sections / known code areas.

### Case records (for `judgment` resolutions)

`judgment` resolutions can't be precedents — they don't auto-resolve. But they leave a weaker trace: a **case record**. When a structurally similar `judgment` question arrives, the resolver surfaces past cases to the human ("you decided X for a similar judgment last week — apply the same reasoning?"). Cases inform; precedents auto-resolve. Same structural keys, no automation. Prevents the user from making contradictory judgment calls without realizing it.

## Digest design

In autonomous mode the digest is the user's only window into what happened. It has one job: **let the user calibrate trust without reading the full trace.** Two failure modes to design against:

- **Too quiet** — only shows successes; user can't tune policy; surprises only surface when something breaks.
- **Too noisy** — full event log; user skims, misses what mattered, eventually stops reading.

Middle path: show what's load-bearing for trust, link to everything else.

### Cadence

Per-goal, not per-session. Configurable in policy (`digest: daily | on_milestone | on_escalation_only | continuous`). Default for long-running goals: daily + on_escalation. Always emit a final digest when a goal completes/halts/aborts. Short goals lean on milestone-driven; long goals lean on time-driven.

### Sections (in order)

1. **Headline** — max ~5 lines. Goal status (`on_track` / `at_risk` / `blocked` / `completed` / `halted`), distance-to-spec delta, budget burn vs. plan, highest-severity event since last digest. If the user reads only this, they should know whether to act.
2. **What changed** — slices completed / started / in-flight / blocked / failed; plan, spec, goal revisions. Compressed; full diffs linked.
3. **Escalations** — every gate that escalated, in full. Non-negotiably complete — no compression. Trust depends on the user knowing every escalation, not a summary.
4. **Auto-resolutions worth seeing** — significance-filtered. Include if (a) the action affected something outside the slice's declared blast radius, or (b) confidence/score was within margin of escalation threshold. Always include irreversible actions that auto-resolved (should be near-zero; if non-zero, the policy is wrong) and `material`-adjacent goal revisions classified as `minor`.
5. **Near-misses** — what almost escalated but didn't. Coherence-drift soft alarms below threshold, borderline precedent matches that auto-resolved, failed slice attempts that succeeded on retry. This section is what most autonomous UIs miss; without it the user only sees the path taken, never the one almost taken, and cannot tell whether thresholds are right.
6. **Drift dashboard** — current values of each drift signal vs. its threshold. Distance-to-spec velocity, re-plan / spec-revision / question rates, coverage gap, goal-revision pressure. Sparklines or plain-text deltas.
7. **Budget** — burn rate + projection. Tokens, wall time, $ vs. caps. Projected exhaustion vs. projected goal completion.
8. **What's next** — slices about to dispatch, pending escalations awaiting user, time of next digest.

### Load-bearing rules

1. **Every section links to the source data.** The digest is a summary; the trace is the truth. Every entry has a deeplink (slice id, precedent id, escalation id, evidence blob). A digest that can't be drilled into is just a story.
2. **Headline is bounded.** ~5 lines. If the system can't summarize a goal's state in 5 lines, that itself is a signal.
3. **Auto-resolution section has explicit non-empty default.** If everything auto-resolved cleanly, say so ("12 auto-resolutions, all in high-confidence band, none touching irreversible actions"). Empty section ≠ silent confidence.
4. **User actions are first-class.** Each digest ends with one-click actions: approve pending escalation, contradict precedent, raise budget cap, halt goal. The digest is not just a report — it's the control surface.
5. **Diffable across digests.** Each digest references the prior and surfaces deltas (drift trending which way, escalation rate vs. last period). Without trend, individual digests are point-in-time and hard to read.
6. **Same data structure for human and machine.** Digest renders from a typed payload, not ad-hoc. Future renderers (terminal, web dashboard, Slack, scheduled reports) all consume the same payload.

### Delivery: push and pull

Both. Push on escalations and goal-status changes by default. Daily push is opt-in. Routine pull avoids notification fatigue, which is the fastest way for the digest to start being ignored. The pull location is a known address per goal so the user can return to it whenever.

### Action surface: in-digest

User actions are taken in the digest itself, not out-of-band. Read digest → act in same context. The cost is a richer rendering layer; the benefit is escalations don't sit unhandled because the user couldn't be bothered to context-switch.

The interactive digest is intended to be hosted in `apps/dashboard/` — that app is already the natural surface for SLOP state visualization. Other renderers (terminal in `apps/tui/`, static markdown for archival, Slack summaries) consume the same typed payload but degrade gracefully: terminal exposes numbered actions, static markdown falls back to copy-pasteable CLI invocations.
