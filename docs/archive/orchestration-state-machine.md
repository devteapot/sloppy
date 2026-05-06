# Archived: Removed Orchestration State Machine

This document is retained only as a historical pointer. The orchestration task
state machine it described is not part of the current checked-in runtime.

The deleted design included:

- an `orchestration` provider with task lifecycle state
- a runtime scheduler
- task DAG dependency handling
- verification-gated task completion
- child-result handoff into task artifacts

Those runtime pieces were removed from v1. The current architecture is described
in:

- `docs/02-architecture.md`
- `docs/03-mvp-plan.md`
- `docs/13-meta-runtime.md`

Current rule: do not rebuild task DAGs, schedulers, or task-lifecycle hooks in
core. If goal/spec/task workflows return, they should be optional SLOP providers
or skills layered over provider state, not privileged runtime machinery.
