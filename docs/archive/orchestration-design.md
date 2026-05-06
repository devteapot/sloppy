# Archived: Spec-Driven Orchestration Design

This document is retained as historical design context only. It no longer
describes the current checked-in runtime.

The old design described a large spec/plan/task orchestration stack with
orchestrator, planner, executor, gate, digest, audit, and policy-tree concepts.
That stack is not present in `src/` today and should not be treated as the target
runtime architecture.

The current direction is leaner:

- the kernel observes SLOP provider state and invokes contextual affordances
- `delegation` spawns and observes child sessions without understanding tasks
- `meta-runtime` models agent topology, routes, capabilities, executor bindings,
  proposals, and experiments as provider state
- workflow policy and recurring procedures should live in skills or optional
  providers, not in kernel branches

Use these documents as the source of truth instead:

- `docs/02-architecture.md`
- `docs/03-mvp-plan.md`
- `docs/13-meta-runtime.md`
- `docs/16-tui-plan.md`

If a future product needs formal goals/specs/plans again, start from the current
provider boundary and rebuild the workflow as an opt-in provider or skill
collection. Do not resurrect the old built-in orchestration runtime.
