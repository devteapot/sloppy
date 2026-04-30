# Memory tiers

> **Status: superseded — split across `docs/13-meta-runtime.md §2.11` (role memory) and `docs/14-agent-identity.md §2` (identity memory). Routing model carried forward, substrate replaced.**
>
> This document was an early sketch from before the meta-runtime (`docs/13`) and identity layer (`docs/14`) were designed. Its `(general/role × global/project)` matrix collapsed two distinct concerns that are now separated:
>
> - **The "general" tier** (user facts, project invariants, self-knowledge) lives in `docs/14 §2` — identity memory. Owned and written by the identity-tier; about the agent ↔ user ↔ project relationship.
> - **The "role" tier** (specialist craft, per-role heuristics) lives in `docs/13 §2.11` — role memory. Owned and written by specialists of that role; about how the role does its job. The `(role × global/project)` axis is preserved verbatim via the `scope` field.
>
> The two stores are deliberately disjoint. Specialists do not read identity memory; identity does not read role memory. This is the cross-talk fix the original docs/11 motivation called for, mechanically enforced via capability masks instead of by file-layout convention.
>
> **What changed structurally.** The substrate is no longer flat markdown injected into the system prompt. Notes are SLOP-typed entries with structural keys, CAS-versioned writeback (Mem0-style add/update/retire), TTL + LRU decay with cold-archive eviction, and taint enforcement. The Hermes-style "frozen markdown snapshot at session start" is replaced by live-within-mask SLOP reads at spawn time (docs/13 §2.12).
>
> **What's still relevant.** The Phase 2 self-correction-loop heuristics below — post-turn nudge on correction, confirmation capture, cell-mismatch detection, decay markers — are not directly implemented but should be reconsidered when implementing the decay/eviction logic in docs/13 §2.11 and docs/14 §2.4.
>
> Do not extend this document. Update docs/13 §2.11 (role memory) or docs/14 §2 (identity memory) instead.

---

Status: design sketch — captures the intended shape of agent memory before we build the provider out beyond the current flat store.

## Motivation

Hermes ships a two-file baseline (`MEMORY.md` for agent notes, `USER.md` for user profile) injected as a frozen system-prompt snapshot at session start, with a single `memory` tool that adds, replaces, and removes entries via short substring matches. Character budgets force the agent to consolidate when full, which produces a self-correcting loop: corrections accumulate as new entries, contradictions get edited, stale lines get pruned.

That works, but it collapses two independent axes into one file:

- **Whose memory is this?** — facts that belong to the user across every agent vs. craft that belongs to a specific agent role across every project they touch.
- **Where does it apply?** — globally vs. only inside this project.

Sloppy can spawn many agents (orchestrator, reviewers, focused sub-agents). Mixing "the user prefers terse responses" with "the frontend-reviewer agent learned not to recommend `useEffect` for derived state" in one file means every agent rereads the other's notes and the budget fills with cross-talk.

## The model

Two tiers, each with optional project scoping:

|              | Cross-project (global)                 | Project-bound                                    |
|---|---|---|
| **General** (shared by all agents)     | user identity, machine facts, communication style | project-wide invariants any agent should know   |
| **Role** (shared by one agent kind across projects) | the role's accumulated craft, conventions, lessons | role-specific learnings tied to this codebase   |

Layout:

```
~/.sloppy/memory/
  general.md                  — global, all agents
  roles/<role>.md             — global, this role only

<project>/.sloppy/memory/
  general.md                  — project-bound, all agents
  roles/<role>.md             — project-bound, this role only
```

A given agent session loads the cells that apply to it: always `general` (global + project) and, if the agent has a role identity, the matching `roles/<role>.md` (global + project). Frozen-snapshot semantics from Hermes carry over — load once at session start, write durably mid-session, snapshot refreshes on next start.

The point of the split is **routing on write**, not just on read. When the agent records a memory, it picks the cell based on the nature of the fact:

- "user prefers Bun over npm" → general / global
- "this repo's tests must hit a real Postgres, not a mock" → general / project
- "frontend-reviewer: prefer CSS variables over inline style props" → role / global
- "frontend-reviewer: this project's design tokens live in `src/theme/`" → role / project

If the agent gets it wrong, a later turn can move the entry. The cell is part of the entry's identity, not a separate index.

## Phase 1 — lean markdown

Smallest version that captures the model:

- One memory provider, four file paths resolved per session from `(scope, role)`.
- Single `memory` tool with `add`, `replace`, `remove` actions. Each takes a `cell` argument (`general` | `role`, plus implicit scope from current project) and substring-based targeting like Hermes.
- Per-cell character budget. When a cell is full, `add` fails with a message telling the agent to consolidate first.
- Frozen snapshot: all four cells (or however many apply) are concatenated into the system prompt at session start under labelled fences. Mid-session writes go to disk but don't change the prompt until the next session.
- No search, no embeddings, no compaction job. If a cell gets noisy, the agent edits it.

This is enough to validate the routing model end-to-end and to start collecting real memory content we can study.

## Phase 2 — self-correction loop

Once Phase 1 is in use, layer in the behaviors that make the memory actually improve over time rather than just accumulate:

- **Post-turn nudge.** After a turn where the user corrected the agent ("no, don't do X", "stop summarizing"), prompt the agent to record the correction into the appropriate cell before the next turn. Corrections are the highest-signal memory writes; capturing them reliably is the main lever.
- **Confirmation capture.** Same nudge for validated non-obvious choices ("yes, the bundled PR was right") — Hermes only captures negative signal, which makes agents drift toward over-caution. Saving positive confirmations keeps the agent from re-litigating decisions the user already approved.
- **Budget-driven consolidation.** When a cell hits ~80% of its budget, the next turn surfaces a "consolidate" hint rather than waiting for a hard fail at 100%. The agent merges duplicates and drops stale entries proactively.
- **Cell-mismatch detection.** If an entry in `general` mentions a role name, or an entry in a role file mentions another role, flag it for relocation on next read. Cheap heuristic; catches the common drift where everything ends up in `general` because that's the easy default.
- **Decay markers.** Project memories that reference deadlines or in-progress work get a `decay-after:` marker. The post-turn nudge prompts the agent to verify or remove expired entries when it next encounters them. Borrowed from the auto-memory pattern in this repo's CLAUDE-level memory — project memories rot fastest, so the loop has to actively prune them.

Phase 2 is still pure markdown plus prompt scaffolding. No new storage, no new infra. The self-correcting behavior is in the loop, not the store.

## Out of scope (for now)

Pluggable backends (Hindsight knowledge-graph, mem0, supermemory, FTS5 session search) are the obvious next step once we have real memory load to justify them. Deferred until Phase 1+2 produce evidence that flat markdown is the bottleneck.
