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

## State-Loaded Reads

A possible next step is to make `read` load a bounded source view into
filesystem provider state instead of returning the full file content as a tool
result. The immediate tool result could be only a compact reference: path,
version, `source_version`, line range, byte count, and truncation status. The
next model turn would observe the loaded view through the ephemeral
`<slop-state>` tail.

This may be more efficient than carrying file contents in tool-result history:
tool results are cumulative conversation history, while provider state can be
focused, windowed, replaced, or evicted. The state tail must stay aggressively
scoped, otherwise loading large or stale views into every model call would erase
the benefit.

Useful constraints for this direction:

- keep source views bounded by byte, line, and count limits;
- include only focused, recent, or explicitly referenced views in state;
- return compact refs from `read`, not duplicate content in history and state;
- keep large files on preview plus explicit range reads;
- let `edit_range` consume `source_version` from these provider-owned views;
- keep audit logs recording read/edit events without preserving full file bodies
  in conversation history.
