# Filesystem Source-View Edits

This note tracks the Antirez follow-up idea discussed from
<https://antirez.com/news/166>: instead of asking the model to carry line tags
or old text back into an edit call, the provider remembers the file view it
returned. The model can then ask to replace a line range from that view.

The filesystem provider keeps a bounded cache keyed by path and source version.
When `read` returns text, it may also return `source_version`. A later
`edit_range` call supplies:

```json
{
  "path": "src/example.ts",
  "source_version": 12,
  "edits": [{ "start_line": 40, "end_line": 48, "new_text": "..." }]
}
```

Before writing, the provider checks that the current file still contains the
same remembered line text at lines 40-48. If the range changed, the edit fails
with `range_conflict`; it does not silently relocate.

This is smaller than a shared `/anchors` provider:

- source views are provider-local and bounded;
- references are short-lived and tied to observed text;
- the model does not see hashes;
- normal file edits do not need to propagate global anchor state.

A future shared-anchor system may still make sense for durable cross-tool or
cross-provider references, but source-view edits should be tried first because
they fit the current SLOP provider boundary with less machinery.
