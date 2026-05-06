---
name: delegation-orchestration
description: Coordinate Sloppy child agents through the delegation provider without polling, including parent-side parallel work, result retrieval, and child-session cleanup.
version: 1.0.0
metadata:
  sloppy:
    tags: [runtime, delegation, orchestration]
    category: runtime
---
# Delegation Orchestration

## When To Use

Use this skill when a task asks for child agents, sub-agents, parallel exploration, delegated review, or merging delegated findings.

## Procedure

1. Spawn the requested child agents with focused goals and clear read/write boundaries.
2. If the user asked you to also work "in the meantime" or "in parallel", do your own independent work before the first delegation wait.
3. Join child progress with `slop_wait_for_delegation_event`; do not repeatedly query `/delegation/agents` as a polling loop.
4. Treat each wait as one wake event. Wait again when more children remain active.
5. Call `get_result` for each completed child before relying on its findings.
6. If a child needs a follow-up, use `send_message` and wait again.
7. After retrieving a child's final result, call `close` unless you still need a follow-up turn.
8. Merge child findings with your own findings and identify which conclusions came from which source when useful.

## Pitfalls

- Do not treat `spawn_agent` success as a completed result.
- Do not skip parent-side work when the user explicitly requested it.
- Do not leave completed child sessions open after the final result is retrieved.
- Do not synthesize from `result_preview` alone when `get_result` is available.

## Verification

Before final response, confirm every spawned child is either still intentionally open for follow-up or has been closed after `get_result`.
