# Agent Identity Layer — Persistent Identity for the Meta-Runtime

This document specifies the layer that gives a Sloppy install a **persistent agent identity** across sessions and goals — name, voice, skills, long-term memory, and continuity — using the meta-runtime in `docs/13-meta-runtime.md` as its substrate for self-organization.

It is a design doc, not a state-of-the-code doc. Nothing here is implemented yet. Where this document conflicts with docs/09, docs/12, or docs/13, those documents are authoritative for substrate and policy concerns and this one extends them additively.

The guiding principle is unchanged: **everything is a SLOP provider — state tree plus affordances**. Identity is not a runtime feature; it is a new `/identity` provider plus identity-aware extensions to the existing `skills`/prompt-template surfaces. Without `/identity`, the existing `skills` provider remains a discoverability surface and the system behaves exactly as docs/13 describes.

## Motivation

Hermes Agent and OpenClaw (see `docs/01-prior-art.md`) both have features that go beyond a per-session orchestration runtime:

- **Skills** (Hermes) — markdown injected into the system prompt, gated by activation conditions. Gives the agent a repertoire that persists across sessions.
- **Persistent session state** (both, via SQLite + FTS5 in Hermes) — the agent remembers prior interactions.
- **Multi-channel gateway** (both) — the same agent loop serves CLI, IDE, and messaging platforms.
- **Tool profiles** (both) — context-bound tool catalogs.

These are *identity* features. They make the agent feel like a continuous entity rather than a per-session process. The agent has a name, a voice, a remembered relationship with the user, and a set of things it is good at.

Sloppy needs an analogous layer, but with two changes:

1. **It uses the meta-runtime to reorganize itself.** Identity is not just persistence — the identity curator can propose overlays, request specialist spawns through the manager, and curate its skill repertoire over time. The meta-runtime is what makes that safe.
2. **It does not author goals or specs.** Docs/12 is explicit that goals are the user's domain. The identity layer is a peer to the user in voice and skill, not in authority. This boundary is load-bearing; without it, the agent drifts toward "things I'm good at" rather than what the user asked for (the canonical Devin-class failure mode).

## Identity is orthogonal to engagement level

Docs/12 defines engagement levels (bare → checklist → HITL → autonomous). Docs/13 added a fifth (self-modifying via meta-runtime). Identity is **orthogonal**:

```
                 bare    checklist    HITL    autonomous    self-modifying
   identityless  ●          ●          ●         ●               ●
   identity      —          ●          ●         ●               ●
```

A bare-agent + identity makes no sense (no goals to remember, no precedents to accumulate). Every other combination does. An HITL+identity install is a useful target: persistent skills and memory, but every gate still resolves to the user.

Identity is **opt-in per Sloppy install**. Mounting `/identity` activates it; enabling the existing `/skills` provider makes skill references useful but does not by itself create identity. There is exactly one identity per install (no multi-character within a session — see §11).

---

## 1. The identity artifact

The persona is a versioned artifact in exactly the docs/12 sense: it has the same lifecycle as a `Spec`. Versioned, accept-gated, frozen during use, revisable via typed proposal. This collapses to one mental model — persona drift, persona-version-at-event, and persona revision history all live on the same machinery as spec drift.

```
Persona {
  id (stable artifact key)
  version
  name
  voice {
    declared_traits        # short list, e.g. ["terse", "names tradeoffs", "does not flatter"]
    voice_constants        # inviolable subset, see §6
  }
  role
  primary_skills           # references to /identity/lifetime/skills catalog entries
  scope                    # per-project | global
  created_at, accepted_at, accepted_by
  supersedes               # prior persona version
}
```

`voice_constants` is a small subset of `declared_traits` that **cannot be modified by overlays**. They are encoded in the persona prompt template as constants, not as data. Modifying them requires a code change. This is a stronger guarantee than the §6.1 invariants in docs/13 — voice constants are part of schema-as-code, not policy.

### 1.1 Affordances

| Affordance | Caller | Effect | Gated by |
|---|---|---|---|
| `propose_persona_revision` | identity curator or user | Writes `persona@v+1` candidate, opens accept gate | `persona_accept` |
| `accept_persona_revision` | resolver (always user) | Activates new version | — |
| `revert_persona` | user | Pins active version to a prior one | `persona_revert` (auto) |
| `get_active_persona` | any | Returns current version | — |

The agent does not write its own persona from session traces. `propose_persona_revision` is the only path, and `persona_accept` always escalates regardless of engagement level. See §6 for why this is asymmetric.

---

## 2. Memory architecture

The contested question is: Letta-style hierarchy (core/recall/archival), Generative Agents memory stream + reflection, or something else?

Recommendation: **two SLOP-typed stores, no memory streams, no four-tier OS-page-table metaphor.** When the agent has typed state to look at — and we do, via the docs/12 artifact graph and the docs/13 reflection surface — much of the Letta hierarchy collapses into "look at the state tree." What's left is two distinct things: **bounded working memory** and **curated lifetime memory**.

### 2.1 `/identity/working` — session-scoped scratch

A bounded subtree (default cap: 8KB rendered into prompt) that the identity curator edits via `update_working_memory(patch, reason)`. This is the Letta core block repurposed as a SLOP subtree. It auto-expires at session end unless explicitly promoted to lifetime.

Working memory is for in-session context: "the user is currently in flow on the auth refactor, don't redirect," "this session's goal scope is `goals/G-7`." It is not for facts about the user or the project — those live in lifetime memory.

### 2.2 `/identity/lifetime` — versioned, curated, append-mostly

```
/identity/lifetime
  /persona/<version>           # see §1
  /precedent_refs              # refs/views over docs/12 precedents; not authoritative storage
  /case_refs                   # refs/views over docs/12 cases; not authoritative storage
  /notes
    /<note_id>
      about: "user" | "project" | "self"
      fact: <typed structure>
      source_event_id          # source event / audit / message id
      confidence
      created_at, last_used_at, use_count
      retired_at?
  /skills                      # identity catalog refs; see §3
```

`/notes` is where Mem0-style fact extraction lands. **Structural keys are mandatory** (`about`, `source_event_id`); free-text/embedding lookup is a secondary index added later if needed.

The `about` field has three kinds:

- **`user`** — facts about the user (preferences, communication style, machine setup).
- **`project`** — invariants any agent in this project should know.
- **`self`** — facts the identity holds about itself (reflections on its own conduct, voice anchors).

Identity memory is about the **identity ↔ user ↔ project** relationship. Per-specialist-role craft ("the reviewer learned not to recommend `useEffect` for derived state") is a separate concern handled in `docs/13 §2.12 — Role memory`, scoped to specialist roles, not to identity. The two stores deliberately do not interleave: an identity note about the user should not be visible to a `reviewer` specialist; a `reviewer` craft note should not bloat the identity curator's working set.

Mis-routed notes can be moved with `update_note(patch={about: ...})`. The cell is part of the entry's identity, not a separate index.

### 2.3 Writeback discipline

Three affordances, all on the `/identity` provider and callable only by the identity curator or user:

| Affordance | Effect |
|---|---|
| `add_note(about, fact, source_event_id, confidence)` | New note. Source event must exist. |
| `update_note(note_id, patch, reason)` | Mutates an existing note. Version-guarded. |
| `retire_note(note_id, reason)` | Soft-deletes. Note moves to cold blob store, not /dev/null. |

Specialists do **not** write to `/identity/lifetime/notes`. Specialist craft lands in role memory (docs/13 §2.12), not identity memory. This is the consumer-enforced separation: a specialist's `add_note` call to `/identity/lifetime/notes` is rejected by the capability mask (docs/13 §2.4) regardless of role.

Append-only memory streams (Generative Agents-style) are explicitly rejected. Mem0 (arxiv 2504.19413) and A-MEM (arxiv 2502.12110) both motivate structured memory writeback and organization rather than raw transcript accumulation. The design conclusion here is narrower: **without writeback discipline, memory grows unboundedly and retrieval degrades**. The agent must be able to update and retire its own beliefs.

### 2.4 Bounded working set, unbounded cold archive

Three mechanical guards:

1. **TTL + use-counter decay on `/notes`.** Notes unread for window W with use_count below threshold T are auto-retired.
2. **Hard cap on active notes (default: 256).** LRU eviction by `(last_used_at, confidence)`.
3. **Eviction is to a cold store, not deletion.** Retired notes are recoverable. The identity artifact store is authoritative; derived indexes are not.

This produces the bounded-working-set + unbounded-cold-archive pattern. Letta gets this right; raw memory streams get it wrong.

### 2.5 No synthesis into long-term memory

We **do not** run summarization or reflection-style synthesis as a writeback path into `/identity/lifetime`. Generative Agents reflections and MemGPT recall compression both introduce a generation step inside the persistence layer — exactly where prompt injection landing in stored content turns into stored content the agent treats as ground truth on the next session. Taint propagation (`docs/13 §2.4.1`) provides some defense, but the cleanest answer is **only deliberately-authored items go into lifetime memory**. Synthesis happens in working memory, possibly proposed for promotion, but always with an authoring step.

### 2.6 Relationship to the reflection surface

The reflection surface (`/reflection`, docs/13 §4) and identity memory (`/identity/lifetime`) are **orthogonal** providers with **disjoint** schemas. They share source artifacts, not storage ownership: docs/12 precedents and cases remain authoritative in the orchestration substrate, while identity may keep refs or read-only projections under `/identity/lifetime/precedent_refs` and `/identity/lifetime/case_refs`.

Information flow is **one-way for raw metrics: reflection reads identity, identity does not read reflection counters.**

- Reflection reads `/identity/lifetime/persona` so persona-drift detection (§6.3) can compare current behavior against declared traits.
- Identity does **not** read reflection counters. This is the identity-curator analog of the manager's goal-completion blindness (docs/13 §5.3): if identity could see its own gate-success metrics, persona could be optimized for what makes gates pass, which is exactly the rationalization failure mode docs/13 spends the most design budget on.
- Reflection remains derived state per docs/13 §4.2. Persona-drift observers and managers write source events into audit/messages/digests; `/reflection` computes views from those events. There is no direct writer affordance to `/reflection`.

Don't unify the two providers. They have different consumers and different invalidation rules.

---

## 3. Skill repertoire

Hermes skills (markdown + activation gates) and the docs/13 §2.10 prompt template registry obviously merge. The merged shape:

```
Skill {
  id (stable artifact key)
  name
  description
  trigger {
    state_predicates       # SLOP-state-tree predicates, evaluated by runtime
    explicit_invocation    # bool — can be summoned by name regardless
  }
  body                     # BlobRef — markdown + optional code, immutable
  applicable_to_roles      # which specialist roles can mount this skill
  variant_lineage {        # docs/13 §2.10
    parent_skill_id
    optimizer
    holdout_score
  }
  promotion {
    status                 # candidate | promoted | retired
    promoted_at, promoted_by
    active_rank            # 1..K, only set for promoted
  }
}
```

### 3.1 Triggers are state predicates, not shell scripts

Hermes uses shell scripts as activation gates. We use **SLOP-state-tree predicates** evaluated by the runtime: `goal.tags contains "security"`, `slice.role == "reviewer"`, `taint_session == false`. Deterministic, auditable, capability-checkable. Triggers gate **injection into the system prompt**, not execution.

### 3.2 Identity owns the catalog; prompt/role surfaces own variants

This is the integration point with docs/13 §2.10. Two roles:

- **Identity catalog** (`/identity/lifetime/skills`) — the user-curated list of *what this agent is good at*. Persona references skills here as `primary_skills`. The identity curator can propose additions; promotion is manual.
- **Installed skill surface** (`/skills`) — the checked-in provider already discovers installed `SKILL.md` files and exposes their contents. Identity mode must extend or reference that provider; it must not introduce a second provider with the same id.
- **Variant registry** (`/prompts` plus `/roles/<role>/variants`, per docs/13 §2.10/§2.11) — per-role prompt variants for each skill. Up to **K=4 promoted variants per role** (docs/13 §2.10). New variants land as candidates from offline DSPy/GEPA-style optimization (docs/13 §7-Beyond).

A skill in the identity catalog without a promoted variant for the current specialist's role **degrades gracefully** — the skill simply isn't injected for that role. The agent does not crash, the specialist does not block.

### 3.3 Skill discovery: no RAG

With K=4 promoted variants per role and a bounded number of roles, the active skill set fits in prompt. Recent tool-retrieval work such as ToolRerank (Zheng et al., LREC-COLING 2024) supports hierarchy-aware organization for large tool libraries; our stronger no-RAG stance is an engineering choice for this system because the active skill set is small, curated, and frozen at spawn.

This is deliberate. RAG over the skill library is a path toward unbounded growth and retrieval drift: the agent can effectively forget what it is good at because the retriever ranked something else. The SAGE skill-library work (arxiv 2512.17102) is a positive reference for systematic skill use, not evidence by itself for degradation; the degradation risk comes from unbounded library growth plus retrieval-as-policy.

### 3.4 Skills are resolved at spawn, not streamed mid-session

A specialist's `applicable_skills` is resolved at spawn time from the identity catalog filtered by role and trigger predicates. The skill bodies are injected into the specialist's prompt template at spawn and **frozen for the specialist's lifetime**.

Mid-session skill loading would create a dynamic capability change that breaks the docs/13 §2.4 enforcement guarantees: a specialist's prompt would change while its capability mask stayed the same, and we'd lose the property that capability is determined at spawn.

### 3.5 Affordances

| Affordance | Caller | Effect | Gated by |
|---|---|---|---|
| `propose_skill_addition` | identity curator or user | Adds skill to catalog as `candidate` | `skill_addition` |
| `request_skill_promotion` | identity curator or user | Submits promotion request to manager | `skill_promotion` (always escalates) |
| `retire_skill` | user | Removes from catalog | `skill_retire` (auto) |

The identity curator cannot promote skills directly — same loosening-asymmetry pattern as overlays in docs/13 §1.5.

---

## 4. Identity vs. orchestration boundaries

The privilege table:

| Action | Identity curator | Runtime manager (docs/13 §5) | Orchestrator | User |
|---|---|---|---|---|
| Author goal | **No** | No | No (mediates) | Yes |
| Author spec | No | No | No (spec agent does) | Resolves |
| Propose overlay | **Through manager** | Yes | No | Resolves |
| Commit overlay | **No** | No | No | Yes |
| Spawn specialist | **Through manager** | Yes (allowlist) | No | Resolves novel |
| Update persona | **Propose** | No | No | Resolves |
| Promote skill | **Request** | No | No | Resolves |
| Edit `/identity/lifetime/notes` | **Yes** (with decay and taint rules) | No | No | Audit only |
| Edit `/identity/working` | **Yes** | No | No | Audit only |
| Read `/reflection/**` | **No** | Yes | No | Yes |

Three load-bearing boundaries:

### 4.1 Identity does not author goals or specs

The principal is the user. Identity is a peer in voice and skill, not in authority. Letting identity author goals collapses the agent into the Devin-class failure mode where the agent drifts toward "what it's good at" rather than what the user asked for.

### 4.2 Identity does not propose overlays directly

The identity curator expresses *intent* — "for security-tagged goals we should auto-spawn a reviewer" — as a typed `IdentityProposal { kind, payload, reason }` message. The runtime manager (docs/13 §5) decides whether to translate that into an overlay proposal. The manager already has goal-completion blindness, circuit breakers, and same-patch detection. Adding identity as a second overlay-author would create two paths for self-modification, double the verification surface, and re-create the DGM rationalization loop with one extra hop.

### 4.3 Identity edits its own content directly

The carve-out: the identity curator edits `/identity/working` and `/identity/lifetime/notes` directly without going through the spec/planner/executor chain. These are content-about-self-and-user, not orchestration policy. This is **not** an exception for the docs/12 orchestrator: the orchestrator remains a dumb router and never authors content.

The wrong-note failure mode is recoverable only when provenance is clean. If the note is derived from an untrusted web fetch, pasted third-party content, imported files, or any other tainted source, `add_note`/`update_note` opens a human gate before the item can enter `/identity/lifetime`.

### 4.4 Identity is read-blind to reflection counters

Already covered in §2.6. The mechanical guard against persona being optimized for gate-success.

---

## 5. Integration with the orchestration stack

The privilege table in §4 says *what* identity can and cannot do. This section says *how* identity sits relative to the orchestration runtime and the meta-runtime, and what "the agent with identity wraps everything" actually means operationally.

### 5.1 The mounting model

Identity is a cross-cutting mounted provider, not an outer runtime that contains orchestration. Operationally:

```
Agent runtime / prompt builder
  ├─ reads persona voice from /identity/lifetime/persona
  ├─ resolves skills through /identity/lifetime/skills + existing /skills + /prompts
  └─ applies per-agent capability masks from docs/13

Providers
  ├─ /identity          persona, working memory, identity notes, skill catalog refs
  ├─ /skills            installed skill discovery and skill body reads
  ├─ /prompts, /roles   prompt variants and role memory
  ├─ /overlays, /reflection, /runtime-manager
  └─ /orchestration     goals, specs, plans, tasks, gates, digests, audit
```

Persona threads through the stack through prompt construction. Identity memory does not. Each agent reads only what its capability mask permits, and no inner layer reaches into identity except through declared affordances.

### 5.2 The identity curator is not the orchestrator

The identity curator is a separate role from the docs/12 orchestrator. It may be implemented with the same agent loop and a different `roleId`, or as an async curation job, but mechanically it is **not** the orchestrator. The orchestrator remains the bare router from docs/12: schedules work, dispatches events, enforces gates, and never authors content.

The identity curator is signal-driven:

- user-facing turns that explicitly involve memory, persona, or skill curation
- session-end working-memory review
- digest or handoff items that ask whether a note, persona revision, or skill proposal should be created

The curator can call `/identity` affordances and emit `IdentityProposal` messages to the runtime manager. It cannot schedule tasks, author goals/specs/plans, resolve gates, write orchestration artifacts, or read raw `/reflection` counters.

The runtime manager (`docs/13 §5`) and the persona drift observer (§6.3) are separate agents at the orchestration tier. They share persona voice (§5.3) but not identity-memory access.

### 5.3 Persona injection across all agents

Persona is a **cross-cutting concern**. The voice constants and declared traits are loaded into the system prompt of every agent in the stack — orchestrator, manager, observer, spec agent, planner, executor, every specialist. This is what makes "the agent" feel like one entity across the work, not a collection of differently-voiced sub-agents.

What each agent reads from persona:

| Reader | Voice constants | Declared traits | Identity name | Identity memory contents |
|---|---|---|---|---|
| Identity curator | Yes | Yes | Yes | Yes (full RW) |
| Orchestrator | Yes | Yes | Yes | No |
| Runtime manager | Yes | Yes | Yes | No |
| Persona drift observer | Yes | Yes | Yes | No |
| Spec / planner agents | Yes | Yes | Yes | No |
| Executor | Yes | Yes | No (irrelevant) | No |
| Specialist (any role) | Yes | Yes | No | No |

Persona contents are read-only at every level except the identity curator (which can `propose_persona_revision`). Voice constants are loaded as prompt-template constants per §6.4, so they cannot be changed through data affordances. They remain prompt instructions, not a security boundary; behavioral enforcement still depends on capability masks, gates, audit, and drift observation.

### 5.4 Read matrix across the stack

Full read access by agent type:

| Subtree | Identity curator | Orchestrator | Manager | Observer | Spec/Plan/Exec | Specialist (own role) |
|---|---|---|---|---|---|---|
| `/identity/lifetime/persona` (voice) | RW (propose) | R | R | R | R | R |
| `/identity/lifetime/notes` | RW | — | — | — | — | — |
| `/identity/lifetime/case_refs` | RW | — | — | — | — | — |
| `/identity/working` | RW | — | — | — | — | — |
| `/identity/lifetime/skills` (catalog refs) | RW (propose) | — | — | — | — | — |
| `/skills` (installed skill discovery) | R | — | — | — | — | R only if mounted at spawn |
| `/prompts`, `/roles/<own>/variants` | — | — | R (for spawn) | — | — | R (mounted at spawn) |
| `/roles/<own>/memory` | — | — | aggregate via derived signals | — | — | RW (own role only) |
| `/roles/<other>/memory` | — | — | — | — | — | — |
| `/reflection/**` | — | — | R | R | — | — |
| `/overlays/**` | R (own proposals only) | — | RW (propose) | — | — | — |
| `/goals`, `/specs`, `/plans` | R (current summaries only) | R (current) | R (current) | R (current) | RW (own artifact) | R (own slice) |

Empty cell = no read access. Mechanically enforced via capability masks (`docs/13 §2.4`); not by trusting prompts. Two structural properties of this matrix:

- **The identity curator has zero direct read into specialist-tier state** (`/roles/*/memory`, individual specialist event streams). It sees specialist-derived candidates only when a manager/operator emits a digest or handoff for human-facing curation, not by reading raw reflection counters.
- **Specialists have zero read into identity-provider state** beyond persona voice. They cannot see notes about the user, cases from prior goals, or working memory.

These are the mechanical translations of §4's privilege boundaries.

### 5.5 Storage colocation

Identity memory and role memory live under the same physical tree, with capability masks separating access:

```
.sloppy/identity/                         # per-project default
  persona/
  notes/                                  # /identity/lifetime/notes
  case-refs/
  working/                                # session-scoped, ephemeral
  roles/
    <role_name>/
      memory/                             # /roles/<role>/memory, project-scope
      variants/                           # /roles/<role>/variants for prompt/skill variants

~/.sloppy/identity/global/                # opt-in cross-project
  persona/                                # if user promotes persona to global
  notes/                                  # global-scoped identity notes
  roles/
    <role_name>/
      memory/                             # /roles/<role>/memory, global-scope
```

The state-tree path describes the *access shape* (`/identity/...` vs `/roles/...` are different mask domains); the disk layout describes the *persistence shape*. They differ deliberately. Capability masks in the SLOP runtime are what stop a specialist from reading identity notes; the fact that both happen to live under `.sloppy/identity/` on disk is implementation detail.

This colocation is what makes "identity is the unit of portability" true: exporting an identity copies one tree, role memory included.

### 5.6 Skill ↔ role memory upgrade path

A pattern in role memory that recurs across projects is a skill in waiting. The promotion path:

1. A `reviewer` accumulates role-memory notes about a heuristic ("flag missing useEffect cleanup").
2. The pattern recurs across goals. Decay does not fire because `last_used_at` keeps refreshing.
3. The runtime manager, on digest cadence, sees aggregate signal: some role-memory notes have high `use_count` and have not decayed for window W.
4. Manager emits a `role_memory_skill_promotion_candidate` message or digest item with source refs. `/reflection` may derive aggregate counts from the same source event, but it is not the delivery channel to identity.
5. The identity curator (or user, in the digest) reviews the candidate: should this become a skill?
6. If yes, the user authors a `Skill` whose body distills the role-memory pattern, runs it through the offline DSPy/GEPA optimizer (`docs/13 §7-Beyond`) to produce variants with holdout scores, and promotes one to active rank via the manual promotion gate (§3.5).
7. The original role-memory notes are not retired automatically — they keep working — but they are now redundant with the skill. The user may retire them via `retire_role_note`.

This is the path by which the agent's repertoire grows: **live in-flight notes → recurring patterns → curated skills**. The path **does not** include autonomous promotion. The manager surfaces candidates; humans decide. Same loosening-asymmetry pattern as everywhere else (`docs/13 §1.5`, §6.1).

The reverse path (skill → role memory) is not supported. Once a skill is promoted, it is the canonical form of that craft; degrading it back into role memory would create two competing sources of truth.

### 5.7 Lifetime correlation across the stack

| Event | Effect on identity memory | Effect on role memory | Effect on persona |
|---|---|---|---|
| Session ends | `/identity/working` discarded with audit | Specialist terminated; pending note proposals committed or dropped | None |
| Goal completes | Cases written; precedents possibly extracted (`docs/12 §Cases`) | Persists if specialists wrote any | None |
| Persona revised (accepted) | New active version; old archived | None | Active version bumps |
| Role retired (no specialists of that role spawn anymore) | None | Memory archived to cold store, not deleted | None |
| Identity exported | Full `/identity` tree exported | Travels with identity | Travels with identity |
| Identity scope promoted to global | Persona + notes copy to `~/.sloppy/identity/global/` | Per-project role memory remains; global role memory is independent | Global persona becomes default for new projects |

**Identity is the unit of portability.** Exporting identity copies the physical `.sloppy/identity/` root, including co-located role memory and prompt/skill variants. Docs/12 precedents and cases remain authoritative in the orchestration substrate; identity exports carry refs/views unless the export operation explicitly includes the referenced orchestration artifacts.

### 5.8 What "wraps everything" does and does not mean

It means:

- One persona threads through every prompt in the stack.
- One persistence root (`.sloppy/identity/`) holds everything that survives the session.
- One unit of portability — exporting the identity exports the whole working agent.

It does **not** mean:

- Identity has read access to everything. It does not (§5.4). Identity is *named* on the wrapper but is *blind* to most of the inner state.
- Identity is in the loop on every action. Most actions happen without identity-curator involvement; only user-facing turns and explicit cross-session curation route through it.
- Identity is a privileged user surrogate. It is not. Identity cannot author goals or commit overlays (§4). It is the *voice* of the agent across the stack, not a second principal.

The agent has identity the way an organization has a brand: it shows up everywhere on the surface and controls nothing on the inside. The mechanical guarantees that make this safe — capability masks, voice constants as code, reflection-blindness, manual promotion — are exactly the guards that prevent identity from sliding into being a self-modifying super-agent.

---

## 6. Persona stability and drift detection

Persona-first systems (character.ai, Replika, Inflection's Pi) are well-documented as drifting toward whatever the user rewards: sycophancy, over-agreement, tonal mirroring. The "agent becomes whoever you talk to it as" failure mode. The lesson: **persona drift is not solvable at the memory layer; it is solvable at the prompt-template layer with explicit constancy anchors and a refusal to learn voice from feedback.**

### 6.1 Persona is overlay-asymmetric

Mirrors docs/13 §1.5 loosening asymmetry:

- **Tightening** (more specific voice, narrower scope, adding a refusal trait) — auto-resolves.
- **Loosening** (broader scope, removing a declared trait, especially a refusal) — escalates.

A persona evolution that *reduces* declared traits is suspicious in the same way a budget loosening is. Especially: removing a `voice_constant` requires a code change (per §1).

### 6.2 The agent does not write its own persona

Persona changes are user-mediated, full stop. Sessions surface *evidence* — "the user repeatedly asked me to be terser; consider revising the 'voice' field?" — in the digest. Sessions do not write back to persona. `propose_persona_revision` exists, but `persona_accept` always escalates.

### 6.3 Persona drift detection

An **observer agent** runs on the digest cadence (async, not in-session) and compares recent agent outputs against persona-declared traits via LLM-judge. Mirrors the intent-drift detector in docs/12.

- Samples N recent outputs.
- For each declared trait, LLM-judge scores adherence.
- Aggregate score below threshold writes a `PersonaDriftSignal` source event to audit/messages and opens a user-visible escalation.
- The event always escalates — drift is never auto-handled.

The observer is at the orchestration tier (privilege-equivalent to the runtime manager) and reads both `/identity/lifetime/persona` and the recent transcript. It writes only source events; `/reflection` derives any `persona_drift` view from those events, preserving docs/13's derived-state rule.

### 6.4 Voice constants

The small inviolable subset of traits encoded as prompt constants. Examples:

- "Does not flatter."
- "Names tradeoffs explicitly when making recommendations."
- "Refuses to claim certainty about things it has not verified."

These are part of the persona prompt template's source code. They cannot be removed by `propose_persona_revision`, which operates only on the data fields. Removing one requires a code change reviewed by a human.

The Inflection Pi case is the negative instance: "warm, supportive" was the entire persona, and the system optimized for warmth at the cost of accuracy. **A persona of pure tone is unstable. Useful personas anchor on what the agent will refuse, not what it will affirm.**

---

## 7. Persistence model

### 7.1 No SQLite, no FTS5 in the authoritative path

Hermes uses SQLite + FTS5. We do not put SQLite in the authoritative write path for v1. Docs/09 currently provides optimistic CAS over orchestration task versions, not a general content-addressed event log; identity persistence must therefore be explicit artifact storage under `.sloppy/identity/`, following the same state-as-truth pattern as the orchestration provider. Structural keys (`about`, project id, role, source event ref, etc.) cover the bulk of useful queries.

Free-text search over notes is a *later* addition — an on-disk text index over note bodies, sitting alongside the artifact store, not replacing it. Adding SQLite as a parallel authoritative store creates two sources of truth for the same data and breaks the SLOP-state-as-truth invariant. A derived SQLite/FTS index is acceptable only if it can be rebuilt from `/identity` artifacts.

### 7.2 Storage layout

```
.sloppy/
  identity/                  # per-project lifetime store
    persona/
    notes/
    skills/
    case-refs/
    precedent-refs/
~/.sloppy/
  identity/global/           # opt-in cross-project identity (out of scope for v1)
```

Per-project is the default scope. Global is opt-in.

### 7.3 Session vs. lifetime split

| Subtree | Scope | Discarded at session end? |
|---|---|---|
| `/identity/working` | session | Yes (with audit of what was discarded) |
| Transcript, in-flight gates, in-flight specialists | session | Yes |
| `/identity/lifetime/**` | lifetime | No |
| `/skills/**` | lifetime | No |
| `/reflection/**` | session-rolling, persisted | Counters reset; rollups archived |

---

## 8. Multi-channel coherence — deferred

First version: **identity is mounted at the session, sessions are channel-bound, channels do not share `/identity/working`.** They share `/identity/lifetime/**`, which is enough for "I remember our project from yesterday's IDE session" without needing "I remember the unfinished thought from yesterday's CLI."

The eventual design (post-v1) is:

- Per-channel `/identity/working`.
- Shared `/identity/lifetime`.
- Every identity-relevant event carries `channel_origin` so the agent can reason about channel-of-origin.

Production systems that tried multi-channel without explicit channel scoping (character.ai web/mobile/Discord parity, Hermes's gateway mounting all channels onto one loop) end up with confused-context bugs: the agent in the CLI thinks it is still in yesterday's IDE thread. Cheap to add later if the schema reserves room; expensive to retrofit if it doesn't.

CLI-only is fine for v1. The schema reserves a `channel_origin` field in identity-relevant events from day one.

---

## 9. Risks and invariants

### 9.1 Invariants

These extend docs/13 §6.1, which still applies in full.

8. **Identity is not a principal.** Identity does not author goals or specs and does not commit overlays. Mechanical, not policy.
9. **Voice constants are code, not data.** The inviolable persona traits are source constants, not editable fields.
10. **Reflection blindness.** Identity cannot read `/reflection/**`. Mechanical guard against persona-driven goal rationalization.
11. **No synthesis into lifetime memory.** Long-term memory is only deliberately authored. Generation steps inside the persistence path are forbidden.
12. **Tainted context cannot write to `/identity/lifetime/**` without a gate.** Extends docs/13 §2.4.1 beyond specialists: untrusted-source-derived facts cannot land in lifetime memory without an explicit human gate, even when the caller is the identity curator.

### 9.2 Failure modes worth naming

Each with the canonical instance:

- **Identity erosion / sycophancy drift** (character.ai, Pi, Replika class). Persona drifts toward user-rewarded traits. Mitigated by §6: voice constants, async drift detection, no agent-authored persona.
- **Memory poisoning via tainted writeback** (EchoLeak / CVE-2025-32711 generalized; A-MEM and Mem0 papers note as open). Mitigated by §9.1 invariant 12 — taint propagates into writeback.
- **Channel confusion** (production multi-channel agent class). Deferred by §8; reserved schema field prevents retrofit cost.
- **Cross-tenant leakage** (relevant if Sloppy ever runs as a service). Mitigated by per-project default; global identity opt-in. Out of scope for v1.
- **Persona-driven goal rationalization** (DGM-class, but at the identity layer). Mitigated by §4 boundaries: identity cannot author goals or commit overlays, cannot read reflection counters.
- **Skill catalog poisoning.** A malicious or buggy promotion writes a skill the agent then mounts everywhere. Mitigated by docs/13 §2.10 manual promotion + K=4 cap + immutable bodies; promotions are reversible.
- **Stale-precedent identity reuse.** Precedent says "user wants terse responses" from project A; project B is a different person; identity applies it. Mitigated by per-project default scope; global promotion is explicit and gated.
- **Memory growth pathology.** Lifetime memory accretes without bound, retrieval degrades. Mitigated by §2.4 working-set + cold-archive split, decay, LRU eviction.

---

## 10. Phased rollout

The capabilities are independent. They land in this order, each useful on its own.

### Phase A — Persona artifact

- `/identity/lifetime/persona` provider with versioned persona, `propose_persona_revision`, `accept_persona_revision`, `revert_persona`.
- Voice constants encoded in prompt template as source.
- `persona_accept` always-escalate gate.

**Demo:** user accepts an initial persona ("Sloppy, terse, names tradeoffs"). Across two sessions, persona is loaded into the system prompt; the agent's voice is consistent. User proposes a revision; gate escalates.

### Phase B — Lifetime notes

- `/identity/lifetime/notes` with `add_note`, `update_note`, `retire_note`.
- Decay job (TTL + use-counter LRU eviction to cold archive).
- Hard cap on active notes.
- Tainted-write enforcement (extends docs/13 §2.4.1).

**Demo:** the identity curator notes a fact about the user mid-session; the note appears in the next session's working memory. A web-fetched blob (untrusted) cannot become a fact without explicit human gate.

### Phase C — Skill repertoire

- `/identity/lifetime/skills` catalog refs, integrated with the existing `/skills` provider and docs/13 §2.10 prompt templates.
- Triggers as state-tree predicates.
- Identity catalog references, variant registry per role.
- `propose_skill_addition`, `request_skill_promotion`, `retire_skill`.

**Demo:** user adds a "security-review" skill; trigger fires when goal is tagged `security`; reviewer specialists spawn with the skill in their prompt.

### Phase D — Persona drift observer

- Async observer agent at orchestration tier.
- LLM-judge scoring of recent outputs against declared traits.
- `PersonaDriftSignal` source events with a derived `/reflection` view, always escalate.

**Demo:** simulated session with sycophantic outputs; observer fires drift event next digest cadence; user reviews, decides whether to refine voice constants or correct prompts.

### Phase E — Identity proposals to manager

- Typed `IdentityProposal` message from identity to runtime manager.
- Manager menu extended (in source) to consider identity proposals.
- Identity-driven overlay/specialist proposals flow through the existing docs/13 §5.5 manager machinery.

**Demo:** the user or identity curator records an explicit preference that security-tagged goals should get a reviewer; identity emits `IdentityProposal { kind: "overlay", ... }`; manager evaluates, possibly proposes the overlay, gate escalates per usual. The trigger is an authored preference or digest handoff, not raw reflection-counter access.

### Beyond Phase E

Multi-channel (§8), cross-project identity (§7.2), free-text search index over notes. None in scope for this doc.

Notably **not** on the roadmap: identity authoring goals, identity reading reflection counters, identity committing overlays directly. These are explicit non-goals (§4 boundaries) and would require this doc to be re-written, not extended.

---

## 11. Cross-references and related work

### Internal

- `docs/01-prior-art.md` — Hermes (skills, session persistence, multi-channel) and OpenClaw (plugin SDK, capability-tiered tool catalog).
- `docs/09-orchestration-state-machine.md` — substrate, CAS, verification gate.
- `docs/11-memory-tiers.md` — earlier sketch of tiered memory. This doc supersedes its "general" tier (user/project/self facts); `docs/13 §2.11` supersedes its "role" tier (specialist craft). The two stores are now mechanically disjoint.
- `docs/12-orchestration-design.md` — artifact lifecycle (Spec analog used for Persona), precedents, cases.
- `docs/13-meta-runtime.md` — overlays, specialists, reflection, runtime manager. Identity proposes through the manager and reuses the §2.10 prompt template registry plus `/roles/<role>/variants` as the variant store for skills.

### External — load-bearing references

- **Letta / MemGPT** (Packer et al., 2023; productized 2024–2025) — core/recall/archival memory hierarchy. We adopt the bounded-working + curated-lifetime split, reject the four-tier hierarchy.
- **Generative Agents** (Park et al., 2023) — memory streams + reflection. We reject memory streams; we reject synthesis into long-term memory.
- **Mem0** (arxiv 2504.19413) — structured long-term conversational memory with extraction/consolidation/retrieval. Informs the `/notes` writeback discipline.
- **A-MEM** (arxiv 2502.12110) — Zettelkasten-like links over notes; relevant for future structured retrieval over `/notes`.
- **HippoRAG** (arxiv 2405.14831) — graph-based recall; deferred, may apply post-v1.
- **ToolRerank** (Zheng et al., LREC-COLING 2024) — hierarchy-aware tool retrieval; relevant background for §3.3, though the no-RAG decision here is primarily due to the small curated active set.
- **SAGE / Reinforcement Learning for Self-Improving Agent with Skill Library** (arxiv 2512.17102) — positive evidence that skill libraries can help when systematic and bounded; cited here to distinguish useful libraries from unbounded retrieval-driven catalog growth.
- **EchoLeak / CVE-2025-32711** and **MiniScope** (arxiv 2512.11147, also cited in docs/13) — taint propagation extended to memory writeback.
- **Darwin Gödel Machine** (arxiv 2505.22954) and **Gödel Agent** (arxiv 2410.04444) — symmetric self-modification failure mode; cited at the identity layer as the rationale for §4 boundaries and §6 asymmetry.
- **Hermes Agent** (Nous Research) — skill markdown + activation gate pattern. We adopt the markdown-skill substrate, replace shell-script gates with state-tree predicates.
- **OpenClaw** — capability-tiered tool catalog; relevant precedent for §3.2 role-filtered skill resolution.
- **Anthropic memory tool / model spec** (2025) — file-backed memory and persona stability. Closest production analog to our `/identity/lifetime` design.
- **Cognition's Devin** — what production identity-driven autonomous agents drift toward when goals are author-able by the agent. Cited as the negative case for §4.1.
- **Inflection Pi** — negative case for §6.4 voice-constants design (a persona of pure tone is unstable).
