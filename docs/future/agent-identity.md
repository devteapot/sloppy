# Agent Identity Direction

This is a future-design note. No `/identity` provider is checked in today.

The old version of this document depended on the removed spec/plan/task
orchestration stack, runtime manager, overlays, and reflection counters. Those
parts are no longer current. The identity direction should be rebuilt on the
lean provider boundary described in:

- `docs/02-architecture.md`
- `docs/03-mvp-plan.md`
- `docs/13-meta-runtime.md`

## Goal

An identity layer would give a Sloppy install durable continuity:

- persona and voice preferences
- user and environment memory
- role memory
- curated skill repertoire
- export/import of that identity bundle

Identity must be a SLOP provider, not an outer runtime. Mounting it should add a
state tree and affordances; not mounting it should leave the base runtime
unchanged.

## Boundaries

Identity is content about the agent and user. It must not own:

- goals
- specs
- plans
- task scheduling
- topology mutation
- capability policy
- executor routing

Those remain user intent, provider state, or meta-runtime substrate. Identity
can propose or request changes through ordinary affordances, but it must not
silently promote itself into a planner, manager, or orchestrator.

## Skills

The skill repertoire is the main growth path.

The intended shape is:

- installed skills live under the existing `/skills` provider
- identity can reference curated skills as part of "what this agent is good at"
- recurring role-memory patterns can become skill candidates
- promotion of durable global/workspace skills remains gated
- child agents receive applicable skills at spawn time and keep them frozen for
  their lifetime

This follows the same rule as `docs/13-meta-runtime.md`: reusable strategy
belongs in skills; provider code owns state, validation, and safety.

## Memory

Identity memory should be separate from procedural skills:

- memory stores stable facts and preferences
- skills store reusable procedures
- role memory stores specialist-local heuristics until they are curated into
  skills

Do not use memory to smuggle instructions that should be skills. Do not let
identity read raw specialist traces or optimization counters unless a provider
explicitly exposes a safe summarized view.

## Open Questions

- exact `/identity` state tree shape
- import/export bundle format for identity plus skills
- spawn-time skill resolution API
- how role memory promotes candidates into skill proposals
- UI treatment for identity review and skill promotion
