# Sloppy TUI

The first-party terminal UI under `apps/tui/`: a scrollback-preserving human UI that consumes public Session provider and Session supervisor sockets.

## Boundaries

**Launcher bootstrap surface**:
`apps/tui/src/index.ts` may import exactly `resolveLaunchScope`, `supervisorRuntimePaths`, `ensureRuntimeRoot`, `assertRemovableSocketPath` (and `type LaunchScope`) from `src/session` (the public index). Managed launch is TUI launcher behavior layered on the public supervisor; sharing the launch-scope path derivation keeps socket discovery from drifting between core and TUI.
_Avoid_: importing `src/session/launch-scope` (or any other `src/**` module) directly from the TUI; runtime internals stay behind the public sockets.

## Language

### Composer Input

**Composer sigil**:
TUI-owned leading composer presentation marker shown in the input gutter for the first logical input line when the raw first character is a recognized trigger. The default sigil is `>`; leading `/` switches the gutter to slash-command presentation; leading `$` switches the gutter to shell-intent presentation. A Composer sigil may hide the leading trigger character from the rendered input line, but it does not by itself define submitted message semantics.
_Avoid_: treating all autocomplete trigger characters as sigils; `@` remains an inline autocomplete trigger, not a Composer sigil; `!` is not a shell-intent sigil.

**Approval marker**:
TUI-owned composer-gutter presentation of the Session's approval mode. `?` means `approval_mode=normal`; `!` means `approval_mode=auto`. It is a visual marker, not a domain term or a separate mode.
_Avoid_: yolo mode, bang mode.

**Composer autocomplete**:
TUI-owned input assistance that suggests and applies text while the user edits the composer. It is not submitted message semantics, not file attachment, not context injection, and not semantic workspace search; accepted completions become ordinary composer text.
_Avoid_: treating autocomplete trigger characters as hidden commands after submission; using autocomplete for file-content or symbol search.

### Transcript Rendering

**Streaming markdown state**:
TUI-owned presentation state derived from public `/transcript` text while an assistant or system message is still streaming or errored after partial output. It includes local concepts such as stable source, mutable tail source, cached rendered lines, and synthetic render-only Markdown closers. It is recomputed from Session provider state and is not persisted, exposed by the Session provider, or written back into transcript blocks. Stable source advances only at conservative parser-safe render-unit boundaries such as blank-line-closed blocks, completed fenced code blocks, and single-line headings; table and list candidates remain tail until their block is closed. Render units are not split by byte size, and completed messages render as one final Markdown document.
_Avoid_: promoting rendered blocks, stable blocks, Markdown parser state, or synthetic closers into public Session state; treating every newline as stable.

**Block-aware transcript rendering**:
TUI presentation that renders each transcript block according to its public block type instead of flattening a message into one Markdown string. Assistant/system text blocks may use Markdown rendering; user text remains sanitized plain text; Thinking-output blocks remain plain labeled transcript display content.
_Avoid_: mixing Thinking output and assistant prose into one Markdown parse.

**Render-layer sanitization**:
TUI-owned removal of untrusted terminal control sequences immediately before rendering dynamic text from Session state, Provider state, UI contribution manifests, user input, or errors. It protects terminal output without changing persisted Session state. Renderer-generated styling may be applied after this step.
_Avoid_: storing sanitized transcript copies as canonical Session data; allowing model, user, or provider text to emit raw terminal controls.

**Markdown escaping**:
TUI render preparation that escapes Markdown metacharacters in dynamic operational UI text before inserting it into Markdown-authored UI chrome. Assistant/system text blocks are intentional Markdown content and are not Markdown-escaped.
_Avoid_: letting Provider, Session, Plugin manifest, user, or error strings change UI chrome Markdown structure.

**Markdown table-fence normalization**:
TUI-only render preparation that unwraps complete assistant/system `md` or `markdown` fenced blocks only when their body contains a pipe-table header plus separator row. Non-table Markdown fences remain code blocks; open streaming fences are not unwrapped.
_Avoid_: unwrapping all Markdown fences or mutating stored transcript text.
