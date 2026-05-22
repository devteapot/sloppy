# TUI Plan

## Current Direction

`apps/tui` is now a TypeScript/Bun inline terminal UI built directly on
`@earendil-works/pi-tui`. It is a SLOP consumer of the public session provider
and optional public session supervisor. The default launcher behavior starts or
reuses a launch-scope managed supervisor for the current working directory, then
connects to an ordinary session-provider socket. It does not use OpenTUI,
Solid, an alternate screen, or privileged in-process runtime access.

The UI model is intentionally scrollback-preserving:

- chat transcript and composer stay in the terminal's native scrollback
- overlays are temporary bottom panels for setup, approvals, tasks, apps,
  inspector, runtime, and help
- Ctrl+K opens a command palette projected from built-in commands, live session
  state, supervisor state, and v2 plugin UI actions
- plugin UI contribution manifests are v2 `plugin.ui` manifests, not TUI-specific
  v1 `plugin.tui` manifests

## Checked-In Status

Implemented:

- default managed launch via `sloppy` in packaged mode and `bun run tui` in the
  source checkout
- launch-scope supervisor discovery by `realpath(process.cwd())`, with runtime
  sockets/logs in the process runtime directory and durable session history in
  the configured session persistence directory
- fresh-session default launch plus `sloppy --continue` for selecting the
  launch-scope resume session
- attach mode via `bun run tui -- --socket <session.sock>`
- supervisor mode via `bun run tui -- --supervisor <supervisor.sock>` or
  `--supervisor-socket <supervisor.sock>`
- public session subscriptions for `/session`, `/llm`, `/usage`, `/turn`,
  `/composer`, `/transcript`, `/activity`, `/approvals`, `/tasks`, `/apps`,
  `/plugins`, and `/queue`
- dynamic subscriptions from v2 plugin manifests
- markdown transcript rendering through pi-tui `Markdown`
- block-aware transcript rendering that keeps Thinking output plain/labeled while
  assistant and system text blocks use Markdown paths
- progressive streaming Markdown for assistant/system text blocks with
  parser-safe render-unit caching, tolerant open-fence rendering, and final
  whole-document rendering on completion
- render-layer terminal sanitization for dynamic TUI text plus Markdown escaping
  for dynamic operational fields inserted into Markdown-authored UI chrome
- inline cards for the first pending approval, first cancellable task, and queue
  preview, with actions available through the command palette
- status line with workspace, model, context usage, and plugin indicator templates
- above-composer turn status text rendered from the TUI human label mapper
- boxed composer frame with the current local interaction mode label
- mode cycling with Shift+Tab: `default`, `auto-approve`, `plan`; this is local TUI presentation state until backed by a public session policy affordance
- explicit verbosity commands: `/verbosity` reports the current presentation depth, while `/verbosity compact` and `/verbosity verbose` switch between the two modes
- composer autocomplete for command-name-only slash completion from built-in
  commands and namespaced v2 plugin action presentations whose target
  affordance is live, with partial matching and highlighted matches; built-ins
  stay unqualified, while plugin commands project as
  `/<plugin-id>:<command>` using the raw plugin id
- composer autocomplete for `@`-triggered file and directory path completion,
  rooted at the session workspace and fuzzy-matched primarily against basenames;
  accepting a file suggestion replaces the active `@` token with a plain relative
  path plus trailing space, quoting the path when it contains whitespace;
  accepting a directory inserts a plain relative path with trailing slash and no
  trailing space; matching uses path strings only,
  not file contents or symbols; absolute and parent-directory queries are not
  resolved or walked; git workspaces use `git ls-files
  --cached --others --exclude-standard`, with parent directories synthesized
  from known files and a bounded directory-walk fallback outside git repos
- command palette from route commands, queue/task/approval actions, v2 plugin
  actions, and supervisor sessions/scopes
- supervisor client leases for per-TUI session selection, auto-close accounting,
  and stop guards when another connected TUI is using a session
- dormant supervised sessions backed by snapshots and restored lazily when
  selected
- route overlays for setup, approvals, tasks, apps, inspect, runtime, and help
- plugin notifications projected into the notice line
- OSC 52 copy helper is available; direct copy binding is deferred to avoid
  stealing editor keys
- Composer sigils for first-line composer presentation: `>` is the default
  prompt, leading `/` switches the gutter to slash-command presentation, and
  leading `!` switches the gutter to shell-intent presentation; the sigil may
  hide the raw leading trigger character from the rendered input line, but
  submitted message semantics remain separate
- `!cmd` is still expanded into an explicit natural-language request for the
  terminal provider; `@` is autocomplete-only and does not rewrite submitted
  message text or attach file context
Still deferred:

- true masked API-key entry for `/profile-secret`
- archive/delete session controls; Stop Session only ends the live process while
  keeping the session restorable
- clickable or focusable per-card buttons inside the transcript
- full syntax-highlighted code blocks and richer structured diff rendering
- responsive narrow/wide layout variants beyond pi-tui wrapping and overlay width
- richer runtime proposal cards and mutating todo cards

## Architecture

### Session Client

`apps/tui/src/backend/session-client.ts` owns the public session connection. It
uses `@slop-ai/consumer` with `NodeSocketClientTransport`, subscribes to public
session state, keeps a typed `SessionViewSnapshot`, follows v2 plugin manifest
subscriptions, and invokes public affordances such as composer send, turn cancel,
goal controls, approval resolution, task cancel, LLM profile controls, and
inspect query/invoke.

### Supervisor Client

`apps/tui/src/backend/supervisor-client.ts` talks to the public session supervisor
in managed mode or when launched with `--supervisor`. It exposes the
launch-scope resume session, the session list, and scope list state, plus
create/select/stop affordances. Managed mode switches the same `SessionClient`
between ordinary session-provider sockets.

The supervisor does not own one global active session. Each connected TUI
registers a supervisor client lease and updates that lease when its selected
session changes. The launch-scope resume session is the default target for
`sloppy --continue`; a plain `sloppy` creates a fresh session and makes that
new session the resume target. Stopping a session never creates a replacement.
If a stopped session is selected later, the supervisor restores it from its
snapshot and lets the normal stale-turn recovery path explain any interrupted
work.

### Manifest Projection

`apps/tui/src/state/manifest-projection.ts` projects v2 plugin UI manifests:

- `actions` become command-palette entries when their target affordance is live
- `indicators` become status-line segments and runtime overlay text
- `notifications` are evaluated in `state/plugin-notifications.ts` and surfaced
  through the notice line
- `subscriptions` are consumed by `SessionClient` for dynamic state coverage

### UI Components

`apps/tui/src/ui/app.ts` owns the pi-tui root, keyboard handling, command
execution, overlays, mode, notices, and session/supervisor updates.

`chat-log.ts` renders the transcript plus inline operational cards. Transcript rendering is block-aware: assistant/system text blocks use Markdown paths, Thinking-output blocks use plain labeled text, and tool activity remains separate `/activity` data.
`status-line.ts` renders ambient session status and plugin indicators.
`command-palette.ts` wraps pi-tui `SelectList` for Ctrl+K.
`route-overlay.ts` renders temporary route panels.
`custom-editor.ts` subclasses pi-tui `Editor` for local submission transforms and composer completion.
`composer-autocomplete.ts` is a façade over separate slash-command and workspace-rooted `@` file-path autocomplete providers; each provider owns its own trigger rules, matching, and apply behavior.

The composer owns the input frame, prompt gutter, placeholder, autocomplete presentation, and local mode label rendering. The mode label, live slash entries, and session workspace root are passed from `AppUi`; the composer does not own runtime policy.

## Interaction Map

- Enter: submit composer text or slash command
- Ctrl+K: command palette
- Shift+Tab: cycle mode chip
- Esc: close overlay, otherwise clear slash-command draft, otherwise cancel active turn when cancellable
- Ctrl+K: command palette, including approval/task actions
- Ctrl+C: disconnect session/supervisor and exit

## Design Rules

- The TUI remains a consumer of public SLOP state and affordances.
- Interaction mode labels in the composer frame are local TUI presentation state for now; `auto-approve` does not imply runtime approval policy until a public session affordance backs it.
- Turn state is rendered above the composer through a TUI-owned human label mapper, not as raw `state:phase` debug text; this leaves room for animated status text or spinners later without changing session state.
- First-party UI behavior must not inspect runtime internals.
- Managed launch, `--continue`, and auto-close are TUI launcher behavior on top
  of the agnostic public supervisor. The supervisor itself stays a SLOP provider
  for session lifecycle bookkeeping.
- Thinking-output visibility toggles are local TUI presentation state; they do
  not invoke a shared session affordance or mutate the public session provider.
- Toggling Thinking-output visibility re-renders both historical transcript
  blocks and future streamed turns already available through `/transcript`.
- `thinking.display=visible` expands Thinking-output blocks by default;
  `thinking.display=hidden` still shows collapsed Thinking-output blocks by
  default rather than omitting them.
- User transcript text remains sanitized plain text in the existing muted box
  presentation. Progressive Markdown rendering is scoped to assistant/system
  text blocks. Streaming blocks use render-unit segmentation and tolerant
  Markdown preparation; errored blocks use one tolerant full render with
  synthetic closers; completed blocks use one sanitized final Markdown render.
  Thinking-output blocks remain plain labeled transcript display content so
  their visibility policy stays separate from assistant prose rendering.
- Streaming stability advances at conservative parser-safe Markdown render-unit
  boundaries, not at every newline or byte-size threshold: table and list
  candidates stay mutable until their block closes. Completed messages render as
  one sanitized final Markdown document so final output matches whole-document
  parsing.
- Render-layer sanitization applies before display to dynamic text from
  transcript, activity, plugin manifests, provider/session state, user input,
  and errors. Dynamic operational UI text inserted into Markdown-authored UI
  chrome is also Markdown-escaped; assistant/system text blocks are intentional
  Markdown content and are not Markdown-escaped. Markdown table-fence
  normalization applies only to complete assistant/system `md` or `markdown`
  fenced blocks whose body contains a pipe table, and stored Session state
  remains unchanged.
- Tool-result rendering has two presentation depths: `compact` is the default
  receipt-first chat timeline mode, while `verbose` renders bounded result data
  for evidence and debugging. Result-kind renderers choose any raw pretty-print
  fallback per kind.
- Compact tool card labels come from the invocation-time affordance `label` exposed
  on `/activity`; the TUI falls back to summaries or raw affordance identity only
  when external providers omit a label.
- Compact grouping is a visual transform after sequence ordering. It groups adjacent
  receipts by provider-scoped affordance identity and renders the group title from
  the invocation-time label; verbose mode keeps individual activity pairs.
- Provider/plugin surfaces should be contributed through v2 `plugin.ui` where
  possible.
- Inline UI should preserve terminal scrollback and avoid alternate-screen
  assumptions. Progressive Markdown may cache stable and tail rendered lines
  inside components, but it must not introduce a separate commit queue, render
  timer, or permanent scrollback append lifecycle outside pi-tui.
- Follow-on rich interactions should deepen the same public session boundary,
  not reintroduce a privileged UI/runtime branch.
