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

## Implemented: State-Loaded Reads

Text `read` now loads a File view into filesystem Provider state instead of
returning the file content as a Tool result. The immediate Tool result is only
a compact reference: `view_path`, path, version,
`source_version`, coverage, line range, byte count, and truncation status. The
next model turn observes the loaded view through the ephemeral `<slop-state>`
tail because loaded File views are included in the filesystem Default
projection.

This may be more efficient than carrying file contents in tool-result history:
tool results are cumulative conversation history, while provider state can be
focused, windowed, or explicitly closed. The state tail must stay scoped by the
Agent, otherwise loading large or stale views into every model call would erase
the benefit.

Useful constraints for this direction:

- loaded File views live under top-level `/views`, not under directory entries;
- inline the loaded text content in `/views` by default;
- return compact refs from `read`, not duplicate content in history and state;
- keep large files on preview plus explicit range reads;
- let `edit_range` consume `source_version` from these provider-owned views;
- allow multiple Range views for distant regions of the same file;
- let a Full-file view supersede same-version Range views for that file;
- mark views stale when the backing file version changes instead of silently
  refreshing them;
- remove views only through explicit Provider cleanup such as `close_view`;
- keep audit logs recording read/edit events without preserving full file bodies
  in conversation history.

## Future: Optimistic View Updates

The current implementation stale-marks loaded file views when the backing file
version changes. That preserves the exact text the Agent observed and keeps
`source_version` validation simple.

A later optimization may update affected File views optimistically after a
successful provider-owned edit or write when the Provider can prove the next
view content deterministically:

- `edit_range` could update the lines covered by the edited source view and mark
  unaffected same-file views stale or refreshed depending on overlap;
- strict string `edit` could update a Full-file view when the Provider has the
  complete observed content and the edit applied cleanly;
- writes could replace a Full-file view when the write content is the complete
  new file text.

This should remain a Provider-local optimization. The safety key stays
`source_version`: optimistic updates must not weaken stale-view detection or make
the Agent believe unobserved text was observed.
