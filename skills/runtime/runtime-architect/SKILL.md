---
name: runtime-architect
description: Design Sloppy meta-runtime topology changes through ordinary SLOP proposals instead of hardcoded repair policy.
version: 1.0.0
metadata:
  sloppy:
    tags: [runtime, architecture, meta-runtime]
    category: runtime
---
# Runtime Architect

## When To Use

Use this skill when route failures, delegation bottlenecks, unclear specialist boundaries, or repeated coordination mistakes suggest that Sloppy's agent topology should change.

## Procedure

1. Inspect `meta-runtime` state: `/agents`, `/profiles`, `/routes`, `/channels`, `/skill-versions`, `/events`, `/proposals`, and `/experiments`.
2. Identify the smallest topology change that addresses the observed failure.
3. Prefer a normal `propose_change` operation over direct state mutation.
4. For risky changes, create an experiment and attach explicit promotion criteria.
5. Keep capability masks narrow. Do not expand shell, filesystem write, spawn, or network access unless the trace shows that access is required.
6. When a topology change depends on a reusable procedure, link or activate a skill version so routed children receive the frozen skill context.
7. Describe rollback as a separate proposal when the change could disrupt routing.

## Pitfalls

- Do not create an orchestration DAG, scheduler, or privileged manager role.
- Do not encode broad repair policy into provider code.
- Do not use topology changes to compensate for vague prompts; tighten role instructions first.

## Verification

Confirm that the proposal is visible under `/proposals`, that any linked experiment has measurable criteria, and that privileged or persistent changes are approval-gated.
