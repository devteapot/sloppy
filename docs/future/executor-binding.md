# Executor Binding Direction

This document describes the current and near-term direction for choosing which
executor runs a delegated child agent.

The old version depended on the removed orchestration task stack, overlays,
runtime manager, and reflection counters. Those pieces are not current. Executor
selection now belongs to the lean delegation/meta-runtime boundary.

## Current State

Checked-in code supports two delegated child execution paths:

- native Sloppy child agents through the local LLM adapter stack
- ACP-backed child agents through configured ACP adapters

`meta-runtime` can store executor bindings:

```ts
type ExecutorBinding =
  | { kind: "llm"; profileId: string; modelOverride?: string }
  | { kind: "acp"; adapterId: string; modelOverride?: string; timeoutMs?: number };
```

A routed `agent:<id>` dispatch passes the target agent's executor binding to
`delegation.spawn_agent`.

When no executor binding is supplied, the child uses the active session LLM
profile. That profile can be native (`anthropic`, `openai`, `openrouter`,
`ollama`, `gemini`) or external (`acp`).

## Safety Boundary

Executor binding changes are capability-sensitive because they can route work to
a different trust surface. Provider code should enforce deterministic safety
checks; model-authored strategy should live in skills.

Current safety rules:

- capability masks are resolved by meta-runtime and enforced by hub policy
- routed agents must have explicit capability masks
- routed or allow-masked ACP spawns require adapter capability declarations
- ACP adapter declarations must satisfy the requested child surface
- unknown or undeclared powerful surfaces should fail closed or require human
  approval

## Near-Term Direction

Keep executor selection simple:

- session/default executor comes from config
- per-agent executor binding can live in meta-runtime state
- role defaults, cost optimization, verifier routing, and executor-selection
  playbooks should be skills or config, not hardcoded runtime policy

Avoid reintroducing:

- task-level executor routing tied to a deleted task artifact
- overlay stacks
- reflection-manager loops
- automatic provider/model switching based on opaque success metrics

## Open Questions

- whether role defaults should be config-only or provider state
- how to expose cost and capability metadata without building a manager loop
- how spawn-time skill resolution should interact with executor binding
- UI affordances for reviewing executor bindings on agents and routes
