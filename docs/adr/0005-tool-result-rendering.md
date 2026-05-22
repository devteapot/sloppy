# Tool Result Rendering By Result Kind

The session runtime carries bounded result data into `/activity`; it does not pre-render chat receipts or UI-specific views. UIs render that data by semantic `resultKind` and local presentation depth.

Affordance `label` is also provider-side metadata. Sloppy-owned Affordances must provide it, and the runtime snapshots the observed label onto `tool_call` and `tool_result` activity items at invocation time so UIs do not infer names from provider ids, tool names, paths, or action names. External Providers may omit `label`; consumers then fall back to summaries or raw affordance identity.

`resultKind` is declared on SLOP affordance metadata. It is not inferred from provider ids, tool names, paths, or action names. The first built-in producers are:

- `terminal` for shell command transcripts.
- `diff` for filesystem edit results.
- `code` for filesystem read results.

The session provider keeps `/transcript` conversation-focused and publishes tool execution details through `/activity`. Transcript messages and activity items both carry a monotonic session-local `seq`, so UIs can compose a chat stream without relying on wall-clock timestamps.

Assistant-authored fenced `diff` or `patch` Markdown is transcript content, not an Affordance result. It may share add/remove colors with the `diff` result-kind renderer, but it must not reuse structured diff receipt behavior such as file headers, status, hunk metadata, or operation semantics.

The TUI has two presentation depths: `compact` and `verbose`. `compact` is the default chat timeline mode and renders tool activity as receipts. `verbose` is the evidence mode and should render the bounded result data. A result-kind renderer may use raw pretty printing as a fallback at whichever depth is appropriate for that kind.

Compact views may visually group adjacent tool receipts only after composing the stream in monotonic `seq` order. Grouping is by provider-scoped affordance identity (`provider`, `action`, invocation-time `label`, and `resultKind` when known), while the group title renders the label. Verbose views render one activity pair at a time.

## Considered Options

- **Infer renderers from provider/action names** — rejected. It would hardcode plugin knowledge into the UI and would not scale to third-party providers.
- **Have the runtime pre-shape compact receipts** — rejected. The same bounded result data should serve every UI; presentation policy belongs to each UI and its result-kind renderers.
- **Promote tool calls into `/transcript` blocks** — rejected. Transcript remains conversation data; operations remain activity data.
- **Put result kind inside each result payload** — rejected as the canonical source. Payloads are provider-owned data; rendering semantics belong to affordance metadata.
- **Fetch full result content with `content_ref`** — deferred. Current results are bounded before entering session state; large-content retrieval can be added later if a real producer needs it.

## Consequences

UIs own view composition over public session state. They may interleave `/activity` tool cards into the transcript view by `seq`, but they must dispatch renderers by result kind only. Invocation errors render from activity status and error fields, while successful logical failures remain renderer-specific data.
