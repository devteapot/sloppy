---
name: topology-pattern-author
description: Turn successful meta-runtime topology experiments into reusable topology patterns.
version: 1.0.0
metadata:
  sloppy:
    tags: [runtime, topology, patterns]
    category: runtime
---
# Topology Pattern Author

## When To Use

Use this skill after a topology experiment has been promoted and the same coordination pattern is likely to recur.

## Procedure

1. Read the promoted experiment, applied proposal, evaluations, and rollback notes.
2. Extract the reusable shape rather than the project-specific names.
3. Rewrite the typed operations explicitly before calling `archive_topology_pattern`; the provider will not infer them from the source proposal.
4. Preserve safety-relevant constraints: capability masks, executor requirements, approval boundaries, and canary traffic limits.
5. Archive the pattern only after there is recorded evidence that the topology worked.
6. When reusing a pattern, adapt stale agent ids, channel ids, route ids, and capability ids before calling `propose_from_pattern` with explicit `ops`.

## Pitfalls

- Do not archive unpromoted experiments as reusable patterns.
- Do not carry over stale agent ids, channel ids, or route ids without adapting them.
- Do not let pattern reuse bypass validation or approval.

## Verification

Confirm the archived pattern points back to the source experiment/proposal, stores the explicit operation list you intended, and that `propose_from_pattern` creates a normal pending proposal from the adapted ops.
