---
name: runtime-route-repair
description: Diagnose failed meta-runtime route dispatch and propose minimal route or endpoint repairs.
version: 1.0.0
metadata:
  sloppy:
    tags: [runtime, routing, repair]
    category: runtime
---
# Runtime Route Repair

## When To Use

Use this skill when `dispatch_route` records `route.failed`, `route.unmatched`, repeated fallback behavior, or fanout/canary traffic reaches the wrong endpoint.

## Procedure

1. Read recent `/events` and group failures by route id, envelope type, and target.
2. Inspect the affected `/routes`, `/agents`, `/channels`, `/capabilities`, `/executor-bindings`, and `/skill-versions`.
3. Classify the failure:
   - missing target
   - channel membership mismatch
   - route matcher too narrow or too broad
   - capability mask too strict for the intended child surface
   - executor binding cannot satisfy the requested child capabilities
   - active skill version cannot be loaded into the routed child context
4. Propose the smallest repair:
   - retarget an existing route
   - add a narrow route matcher
   - add a channel participant
   - create a fallback specialist with a constrained capability mask
   - quarantine a bad route by lowering traffic or disabling it
5. Link the proposal to an experiment for canary rollout when behavior is uncertain.

## Pitfalls

- Do not create broad catch-all routes unless the user explicitly wants a triage sink.
- Do not loosen capability masks just to make an adapter work.
- Do not hide repeated failures by deleting events; use them as evidence.

## Verification

Dispatch a representative envelope after the proposal applies, then confirm `route.dispatched` reaches the expected target and no new capability-policy failure appears.
