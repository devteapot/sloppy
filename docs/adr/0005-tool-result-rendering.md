# Tool Result Rendering By Result Kind

The session runtime carries bounded structured affordance results into `/activity` and the TUI renders those results by semantic `resultKind`.

`resultKind` is declared on SLOP affordance metadata. It is not inferred from provider ids, tool names, paths, or action names. The first built-in producers are:

- `terminal` for shell command transcripts.
- `diff` for filesystem edit results.

The session provider keeps `/transcript` conversation-focused and publishes tool execution details through `/activity`. Transcript messages and activity items both carry a monotonic session-local `seq`, so UIs can compose a chat stream without relying on wall-clock timestamps.

## Considered Options

- **Infer renderers from provider/action names** — rejected. It would hardcode plugin knowledge into the UI and would not scale to third-party providers.
- **Promote tool calls into `/transcript` blocks** — rejected. Transcript remains conversation data; operations remain activity data.
- **Put result kind inside each result payload** — rejected as the canonical source. Payloads are provider-owned data; rendering semantics belong to affordance metadata.
- **Fetch full result content with `content_ref`** — deferred. Current results are bounded before entering session state; large-content retrieval can be added later if a real producer needs it.

## Consequences

UIs own view composition over public session state. They may interleave `/activity` tool cards into the transcript view by `seq`, but they must dispatch renderers by result kind only. Invocation errors render from activity status and error fields, while successful logical failures remain renderer-specific data.
