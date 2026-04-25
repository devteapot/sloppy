# Patched dependencies

Each patch here is local tech debt. We carry it until the upstream fix lands; then we drop the patch and the corresponding `patchedDependencies` entry in `package.json`.

When you add a patch, add an entry below with the same shape: what it changes, why, and the removal condition.

## `@slop-ai/core@0.2.0`

**What it changes:** Adds `optional?: boolean` to `ParamDef` and updates `normalizeParams` to skip required-marking for parameters flagged optional, so providers can declare optional affordance arguments without the JSON schema rejecting omissions.

**Why:** The shipped 0.2.0 treats every declared param as required, which forces every Sloppy provider that wants an optional argument to either re-marshal params or fork the descriptor. The patch is the smallest viable fix.

**Remove when:** SLOP core ships native optional-param support (track upstream — TODO: file an issue and link it here once available).

## `@slop-ai/consumer@0.2.0`

**What it changes:** Fixes `isFieldSegment` so mutations under `/<node>/affordances` are classified as field updates rather than child additions. Without this, mirrors over a focused subtree miss affordance changes.

**Why:** The bug surfaces as stale tool surfaces in the run loop — affordances added or removed dynamically don't propagate to the model context until the consumer re-subscribes.

**Remove when:** SLOP consumer fixes the segment classification upstream (TODO: link the upstream PR/commit here once filed).
