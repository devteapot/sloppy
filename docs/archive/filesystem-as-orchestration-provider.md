# Archived: Filesystem-As-Orchestration Provider

This document is retained only as historical research. It does not describe the
current runtime.

The current filesystem provider remains data-centric:

- focused workspace directory
- directory entries
- search results
- recent operations
- contextual file affordances

It is not the durable control plane for task orchestration. The old proposal
assumed an `OrchestrationProvider`, scheduler-assisted task execution, lifecycle
gates, and orchestrator guardrails. Those runtime pieces are not checked in.

Current direction:

- keep filesystem behavior stateful and workspace-contained
- keep delegation task-agnostic
- keep `meta-runtime` focused on topology state, routing, approvals,
  experiments, and capability masks
- express recurring workflow strategy as skills or optional providers

See `docs/02-architecture.md`, `docs/03-mvp-plan.md`, and
`docs/13-meta-runtime.md` for the current design.
