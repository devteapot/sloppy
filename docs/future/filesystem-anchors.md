# Filesystem Anchors

Future design note for live filesystem edit anchors.

The current filesystem provider supports stateless tagged range edits:
`read(include_line_tags=true)` returns line tags, and `edit_range` validates or
relocates a unique boundary-tag pair when invoked. Those returned tags are tool
result metadata, not subscribed provider state. It also keeps a bounded
provider-local cache of anchors from recent reads/searches so `edit_range` can
derive tags from `source_version` without a second tagged read; that cache is
not durable or externally addressable.

If agents need references that stay live across turns, the filesystem provider
can add an `/anchors` subtree:

```text
/anchors
  /{anchor_id}
    path="src/foo.ts"
    start_line=40
    end_line=44
    start_tag="..."
    end_tag="..."
    status="valid|moved|invalidated"
```

Tracked anchors should remain provider-owned state:

- `track_range` creates bounded, TTL-backed anchors from a tagged read.
- Provider-owned `edit`, `edit_range`, and `write` update or invalidate anchors
  for touched files before emitting state patches.
- Edits before an anchor shift line numbers and patch the anchor as `moved`.
- Edits overlapping an anchor invalidate it unless the provider can prove the
  same boundary identity still exists.
- External file changes are detected lazily on observation or through a future
  watcher; the provider may then relocate by unique boundary-tag pair or mark
  the anchor invalidated.

This should remain inside the `filesystem` provider. It should not become a
separate provider or core runtime editing policy.
