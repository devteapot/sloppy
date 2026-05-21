# Expose Thinking Output as Transcript Display State

Thinking output is provider-returned, user-visible reasoning text or summary, not hidden chain-of-thought or private prompt internals. Sloppy stores Thinking output as assistant transcript display content so UIs and resumed sessions can render it consistently, but never replays it into later model calls, state tails, activity summaries, tool results, goal evidence, or continuation prompts.

`thinking.display=hidden` means collapsed by default, not private; captured Thinking output remains public session transcript state. Opaque provider continuity metadata is separate internal adapter state keyed to the originating provider/profile/model and is never exposed through the public session provider.
