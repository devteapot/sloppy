---
name: persistent-goal
description: Drive Sloppy persistent session goals through extension-backed metadata instead of hardcoded planning policy.
version: 1.0.0
metadata:
  sloppy:
    tags: [runtime, goal, extension]
    category: runtime
    extension:
      namespace: goal
      schema_version: 1
      cleanup:
        mode: ttl
        ttl_ms: 604800000
        description: clear_goal removes live state immediately; completed goals are retained briefly for audit.
---
# Persistent Goal

## When To Use

Use this skill when a persistent session goal is active or when the runtime asks you to continue one.

## Procedure

1. Treat `/goal` as the public projection and `/extensions/goal` as the durable backing metadata.
2. Work from current SLOP provider state; do not rely on hidden memory from earlier turns.
3. Take the next concrete action toward the objective before narrating progress.
4. Use existing providers and affordances rather than adding runtime policy for repeatable procedures.
5. If the work reveals a reusable procedure, prefer a skill update or meta-runtime proposal.
6. Report meaningful progress, blockers, or completion through `slop_goal_update`.
7. Include concrete evidence such as changed file paths, tests run, audit logs, decisions made, or explicit blockers.

## Status Guidance

- Use `progress` when work moved forward and more work may remain.
- Use `blocked` when the next action cannot proceed without external input, missing credentials, missing files, or unavailable tools.
- Use `complete` only when the objective is genuinely satisfied and evidence is available.

## Cleanup

The runtime removes live goal metadata when `clear_goal` is invoked. Completed goal records may remain until their retention window expires so UIs and operators can inspect the outcome. Do not delete extension metadata merely because this skill was not loaded for a turn; request cleanup only when the goal is complete, obsolete, or explicitly cleared by the user.

## Verification

Before marking complete, check that the requested outcome is visible in public state, files, tests, or provider results. If verification cannot be performed, report the limitation as evidence instead of claiming completion.
