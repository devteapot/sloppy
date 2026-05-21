# TUI Plan

## Current Direction

`apps/tui` is now a TypeScript/Bun inline terminal UI built directly on
`@earendil-works/pi-tui`. It is a SLOP consumer of the public session provider
and optional public session supervisor. It does not use OpenTUI, Solid, an
alternate screen, or privileged in-process runtime access.

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

- attach mode via `bun run tui -- --socket <session.sock>`
- supervisor mode via `bun run tui -- --supervisor <supervisor.sock>`
- public session subscriptions for `/session`, `/llm`, `/usage`, `/turn`,
  `/composer`, `/transcript`, `/activity`, `/approvals`, `/tasks`, `/apps`,
  `/plugins`, and `/queue`
- dynamic subscriptions from v2 plugin manifests
- markdown transcript rendering through pi-tui `Markdown`
- inline cards for the first pending approval, first cancellable task, and queue
  preview, with actions available through the command palette
- status line with workspace, model, turn phase, mode chip, and plugin indicator
  templates
- mode cycling with Shift+Tab: `default`, `auto-approve`, `plan`
- command palette from route commands, queue/task/approval actions, v2 plugin
  actions, and supervisor sessions/scopes
- route overlays for setup, approvals, tasks, apps, inspect, runtime, and help
- plugin notifications projected into the notice line
- OSC 52 copy helper is available; direct copy binding is deferred to avoid
  stealing editor keys
- lightweight editor sigils: `!cmd` and `@path` are expanded into explicit
  natural-language requests for the agent/runtime

Still deferred:

- true masked API-key entry for `/profile-secret`
- clickable or focusable per-card buttons inside the transcript
- syntax-highlighted code blocks and rich diff rendering
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
when launched with `--supervisor`. It exposes active session, session list, and
scope list state, plus create/switch/stop affordances. Managed mode switches the
same `SessionClient` between ordinary session-provider sockets.

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

`chat-log.ts` renders the transcript plus inline operational cards.
`status-line.ts` renders ambient session status and plugin indicators.
`command-palette.ts` wraps pi-tui `SelectList` for Ctrl+K.
`route-overlay.ts` renders temporary route panels.
`custom-editor.ts` subclasses pi-tui `Editor` for local submission transforms.

## Interaction Map

- Enter: submit composer text or slash command
- Ctrl+K: command palette
- Shift+Tab: cycle mode chip
- Esc: close overlay, otherwise cancel active turn when cancellable
- Ctrl+K: command palette, including approval/task actions
- Ctrl+C: disconnect session/supervisor and exit

## Design Rules

- The TUI remains a consumer of public SLOP state and affordances.
- First-party UI behavior must not inspect runtime internals.
- Thinking-output visibility toggles are local TUI presentation state; they do
  not invoke a shared session affordance or mutate the public session provider.
- Toggling Thinking-output visibility re-renders both historical transcript
  blocks and future streamed turns already available through `/transcript`.
- `thinking.display=visible` expands Thinking-output blocks by default;
  `thinking.display=hidden` still shows collapsed Thinking-output blocks by
  default rather than omitting them.
- Provider/plugin surfaces should be contributed through v2 `plugin.ui` where
  possible.
- Inline UI should preserve terminal scrollback and avoid alternate-screen
  assumptions.
- Follow-on rich interactions should deepen the same public session boundary,
  not reintroduce a privileged UI/runtime branch.
