# TUI Plan

## Goal

Build a first-party terminal UI under `apps/tui` that is a SLOP consumer of the
public agent-session provider, not a privileged runtime integration.

The TUI should make Sloppy's runtime shape visible:

- transcript and composer as the primary working loop
- turn/activity/task/approval state as live operational context
- `/llm` onboarding as an in-app flow, not a setup cliff
- `/goal` state and controls for persistent long-running work
- `/apps` attachment state as first-class context for external providers
- deeper provider inspection through explicit query/invoke views, not a flat
  tool catalog

Implementation status: `apps/tui` now contains a TypeScript/OpenTUI client that
attaches to public agent-session provider sockets. Local managed mode starts a
public session supervisor, creates an initial scoped session, and can create,
switch, or stop additional scoped sessions through that supervisor. The
inspector can compare supervised sessions using only supervisor-published
session state.

## Prior Art Notes

### Codex CLI

Codex's current TUI is Rust with Ratatui/Crossterm. Its `codex-rs/tui`
package has a broad terminal stack: `ratatui`, `crossterm`,
`unicode-width`, `pulldown-cmark`, syntax highlighting, clipboard, terminal
probing, approval conversion, app-server session handling, and many focused
modules for chat, bottom panes, reflow, terminal title, and tooltips.

Useful lessons:

- strong terminal correctness comes from owning width, reflow, clipboard,
  terminal probing, and key handling directly
- approval prompts and tool activity need dedicated UI treatment
- conservative terminal colors age better than custom palettes
- Rust/Ratatui is excellent when the runtime is also Rust or a standalone
  binary is the primary goal

Fit for Sloppy: not the first choice now. It would duplicate TypeScript protocol
types and require a bridge to the Bun runtime while the session-provider surface
is still evolving.

Sources:

- <https://github.com/openai/codex/tree/main/codex-rs/tui>
- <https://github.com/openai/codex/blob/main/codex-rs/tui/Cargo.toml>
- <https://github.com/openai/codex/blob/main/codex-rs/tui/styles.md>

### OpenCode

OpenCode's TUI lives inside the Bun/TypeScript package and uses
`@opentui/core`, `@opentui/solid`, and `solid-js`. It treats the TUI as a rich
full-screen app with routing, command registry, dialogs, themes, SDK context,
sync providers, plugin slots, mouse support, terminal title control, copy
handling, and optional attachment to a running server.

Useful lessons:

- TypeScript runtime plus TypeScript TUI keeps client/server contracts cheap
- a routed full-screen app works well once there are sessions, model dialogs,
  provider setup, status views, and plugin surfaces
- command palette plus slash commands scales better than hardcoding every
  keybinding into the chat input
- attaching to an existing server is worth designing early

Fit for Sloppy: best architectural match if the goal is a rich TUI, because
Sloppy is already Bun/TypeScript and already depends on Solid for the dashboard.

Sources:

- <https://github.com/anomalyco/opencode>
- <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/package.json>
- <https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/cli/cmd/tui>

### Pi

Pi separates a TypeScript coding agent from `@mariozechner/pi-tui`, a small TUI
library with differential rendering, synchronized output, bracketed paste,
editor, markdown, select lists, settings lists, autocomplete, inline images,
virtual terminal tests, and width utilities.

Useful lessons:

- a simple component model is easier to test and reason about than a large UI
  framework
- synchronized output and differential rendering matter for perceived quality
- built-in editor, markdown, autocomplete, settings, and virtual terminal tests
  cover most agent-TUI primitives
- every rendered line must fit width; enforce this as an invariant

Fit for Sloppy: strong MVP option. It is less expressive than OpenTUI/Solid for
large routed apps, but it would get a reliable chat/session surface running with
less UI framework complexity.

Sources:

- <https://github.com/badlogic/pi-mono>
- <https://github.com/badlogic/pi-mono/tree/main/packages/tui>
- <https://github.com/badlogic/pi-mono/blob/main/packages/tui/README.md>

### Hermes

Hermes uses React + Ink for the terminal UI and keeps Python in charge of
sessions, tools, model calls, and command logic. The TUI starts a gateway
process and communicates with newline-delimited JSON-RPC over stdio. Its app
model splits gateway events, slash handling, composer state, input handling,
turn lifecycle, overlays, and rendering into separate modules. It uses a static
transcript, live assistant row, queue preview, status rule, input line,
completion list, approval prompts, clarify prompts, secret input, and session
picker.

Useful lessons:

- keep backend stdout/stderr isolated from terminal rendering
- prompts should be state branches in the main app, not separate screens
- queueing while the agent is busy is a major UX improvement
- persistent goal controls should be visible in the status area without
  replacing the normal chat/composer loop
- local slash commands should handle only client-owned behavior; provider-owned
  commands should fall through to the backend/session surface

Fit for Sloppy: useful UX reference, but React/Ink is less aligned with this
repo than Solid/OpenTUI. Hermes also carries a local Ink fork, which is a signal
that stock Ink may become limiting for a sophisticated agent TUI.

Sources:

- <https://github.com/NousResearch/hermes-agent/tree/main/ui-tui>
- <https://github.com/NousResearch/hermes-agent/blob/main/ui-tui/README.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/ui-tui/package.json>

## Recommended Stack

Use TypeScript/Bun for `apps/tui`.

Recommended renderer: `@opentui/core` + `@opentui/solid`.

Why:

- shares language, package manager, runtime, and build path with Sloppy
- can consume `@slop-ai/consumer` directly over `NodeSocketClientTransport`
- reuses the repo's existing Solid direction from `apps/dashboard`
- supports a full-screen app model with routes, dialogs, command palette,
  keyboard handling, and future plugin slots
- avoids a second Go/Rust protocol model while the session-provider contract is
  still changing

Keep `@mariozechner/pi-tui` as the fallback if OpenTUI proves too unstable. Pi's
library is especially attractive for a smaller MVP, virtual terminal tests, and
strict width handling. Do not pick React/Ink unless the team explicitly wants a
React TUI stack.

Initial dependencies:

```json
{
  "@opentui/core": "^0.2.3",
  "@opentui/solid": "^0.2.3",
  "solid-js": "^1.9.12"
}
```

Existing dependency: `@slop-ai/consumer`.

Optional later dependencies:

- `marked` or a small local markdown renderer for assistant output
- `strip-ansi` and width helpers if OpenTUI does not provide enough formatting
  primitives
- clipboard support only after the basic session loop is stable

## Architecture

The TUI should have four boundaries.

### 1. Session Client

`apps/tui/src/slop/session-client.ts`

Responsibilities:

- connect to a session provider over a Unix socket
- subscribe shallowly to `/session`, `/llm`, `/turn`, `/goal`, `/composer`,
  `/transcript`, `/activity`, `/approvals`, `/tasks`, `/queue`, and `/apps`
- expose a typed client-side store
- invoke public session affordances:
  - `/composer.send_message`
  - `/turn.cancel_turn`
  - `/goal.create_goal`
  - `/goal.pause_goal`
  - `/goal.resume_goal`
  - `/goal.complete_goal`
  - `/goal.clear_goal`
  - `/approvals/{id}.approve`
  - `/approvals/{id}.reject`
  - `/tasks/{id}.cancel`
  - `/llm.save_profile`
  - `/llm.set_default_profile`
  - `/llm.delete_profile`
  - `/llm.delete_api_key`
- recover from patch gaps by trusting the consumer SDK resubscribe behavior
- never read runtime internals directly

The session client should use `@slop-ai/consumer`, not a custom protocol
implementation:

```ts
import { NodeSocketClientTransport, SlopConsumer } from "@slop-ai/consumer";

const consumer = new SlopConsumer(new NodeSocketClientTransport(socketPath));
await consumer.connect();
const transcript = await consumer.subscribe("/transcript", 2);
```

### 2. Session Supervisor Client

`apps/tui/src/slop/supervisor-client.ts`

Responsibilities:

- connect to a session supervisor over a Unix socket
- subscribe to `/session`, `/sessions`, and `/scopes`
- expose the active session socket plus running session list
- invoke public supervisor affordances:
  - `/session.create_session`
  - `/session.set_active_session`
  - `/sessions/{id}.set_active`
  - `/sessions/{id}.stop`
- keep session lifecycle separate from per-session transcript/turn state

The supervisor is a SLOP provider, not an in-process TUI manager. Switching a
session tells the `SessionClient` to attach to a different session-provider
socket.

### 3. UI Store

`apps/tui/src/state/`

Keep remote state and local UI state separate.

Remote state:

- session metadata
- LLM profiles and credential readiness
- turn state
- transcript
- activity
- approvals
- tasks
- apps
- runtime proposals

Local UI state:

- active route
- selected side pane
- scroll offsets
- command palette query
- composer draft
- queued drafts
- input history
- detail visibility
- focused approval/task/provider

Do not write local UI state back into the session provider. The session provider
explicitly excludes drafts, cursor position, pane focus, and layout.

### 4. UI Shell

`apps/tui/src/ui/`

Routes (only `chat` renders persistently; the others render inside
overlays):

- `chat`: persistent transcript + composer surface
- `setup`: LLM profile onboarding overlay (auto on `needs_credentials`)
- `approvals`: pending approval review overlay (mostly redundant with the
  inline approval cards; kept for resolved-history review)
- `tasks`: long-running provider task overlay (inline cards cover the live
  state)
- `apps`: external provider attachment overlay
- `runtime`: meta-runtime proposal/route/capability overlay
- `inspect`: SLOP state tree query/invoke overlay
- `settings`: model/profile/theme overlay

Routes still exist as a typed enum because the palette, slash parser, and
secret-prompt flow refer to them, but only the `chat` route is rendered as
the persistent surface. Every other route renders inside an overlay frame
when opened. The command palette is built from the same navigation registry
plus live session, supervisor, and meta-runtime state. Current shortcuts:

- `Ctrl+K`: command palette (primary nav)
- `Ctrl+I`: inspector overlay
- `Shift+Tab`: cycle mode (default → auto-approve → plan)
- `Esc`: close topmost overlay (or cancel approval)
- `Ctrl+C`: cancel turn · clear draft · or exit
- `@path`, `!cmd`, `/cmd`: composer sigils for file mention, inline bash,
  slash command

The shell should support attach mode first:

```sh
bun run tui --socket /tmp/slop/sloppy-session-<id>.sock
```

Managed mode starts a supervisor and attaches to the active session:

```sh
bun run tui
bun run tui -- --workspace-id sloppy --project-id runtime
```

The TUI can also attach through an existing supervisor:

```sh
bun run tui -- --supervisor-socket /tmp/slop/sloppy-supervisor.sock
```

Direct session attach mode must remain the cleaner contract for tests and
single-session multi-UI attachment. Managed supervisor mode forwards
workspace/project scope flags to the session launcher; the launcher loads
home/workspace/project config layers and pins terminal/filesystem roots to the
selected scope.

## UX Model

### Direction (post-2026-05 redesign)

The earlier plan called for an 8-route horizontal tab strip plus a 34%
always-on right "inspector" pane that could be toggled between six modes. In
practice this created two parallel navigation systems (route + inspector
mode) that drift out of sync, ate transcript width on wide terminals, and
disappeared entirely on narrow terminals while the modes they hosted had no
fallback. None of the references we surveyed (Claude Code, Factory droid,
opencode, hermes-agent, openclaw, pi-mono) use a horizontal tab strip for
primary navigation. The convergent pattern is **one linear chat stream, a
command palette for navigation, a mode chip near the input, and overlays for
configuration**.

The redesign adopts that pattern. Specifically:

- The chat stream is the only persistent view. Approvals, tasks, runtime
  proposals, and goal status render as inline interactive blocks within the
  stream — not as separate routes.
- Configuration surfaces (setup, settings, apps detail, inspect, runtime
  proposal review) are **overlays** opened from the palette or by slash
  command. They float on top of the chat; closing returns to chat.
- A **command palette** (Ctrl+K) is the primary navigation. Its contents are
  built from the navigation registry plus live SLOP affordances discovered
  from `/apps`, supervised sessions, and the meta-runtime — not a hard-coded
  registry. This is the SLOP-native point: the palette grows when providers
  attach.
- The **horizontal tab strip is removed.** A thin **session strip** is
  rendered only when the supervisor reports more than one running session,
  and lists session id / turn state / goal / pending counts as a top bar.
- The **always-on right inspector pane is removed.** The state-tree
  inspector becomes a full-screen overlay (Ctrl+I) — power-user surface, not
  primary UX.
- A **mode chip** sits next to the composer. Shift+Tab cycles
  `default → auto-approve → plan`. Plan mode wires to the meta-runtime when
  attached and otherwise notices that no planner is available.
- `@path`, `!cmd`, and `/cmd` sigils in the composer (file mention, inline
  bash, slash command) are the unified fast paths.

### Default screen

```text
┌ session strip (only when >1 sessions): ● a · ○ b · ○ c                   ┐
├ status bar: workspace · model · secure store · turn phase · goal · mode  ┤
│                                                                          │
│ chat transcript                                                          │
│   [user] …                                                               │
│   [assistant] …                                                          │
│   ┌─ approval needed: terminal.execute  [a] approve [d] deny ─────       │
│   ┌─ runtime proposal: enable A2A capability  [a]pply [r]evert ────      │
│   ┌─ task: long-running provider work  3/5  [x] cancel ─────────         │
│                                                                          │
├ mode: PLAN ───────────────────────────────────────── goal: rewrite … ────┤
│ > _                                                                       │
│ Ctrl+K palette · ⇧⇥ mode · Ctrl+I inspect · @file · !bash                │
└──────────────────────────────────────────────────────────────────────────┘
```

The first screen is still the working chat surface, not a welcome page.

### Overlays

Anything that is not the live chat conversation is an overlay opened from
the palette (or by slash command). Overlays float over the chat, accept
their own keyboard, and close on Esc.

Current overlays:

- **Help** — hotkeys and slash command reference.
- **Command palette** — primary nav.
- **Setup** — LLM profile creation when `/llm.status=needs_credentials` (or
  on demand). Auto-opened on first connect when credentials are missing.
- **Settings** — read-only model/profile listing with delete/default
  actions.
- **Apps** — external provider list. Selecting an app opens the inspector
  overlay scoped to that app.
- **Inspect** — SLOP state-tree query/invoke debugger. Opened with Ctrl+I or
  `/query` / `/invoke`.
- **Runtime** — meta-runtime proposals, routes, capability masks. Opened
  with `/runtime` or from the palette.
- **Secret prompt / approval prompt** — already overlays in the prior
  implementation; these stay.

There are no full-screen "routes" anymore. The TUI shell renders chat
underneath every overlay so the user never loses transcript context.

### Inline blocks in chat

Things that were previously dedicated routes are surfaced as live
interactive cards inside the transcript:

- **Pending approvals** — bordered card with provider/action/reason and
  `[a] approve / [d] deny` keys (Shift+A required for dangerous).
- **Runtime proposals** (when meta-runtime attached) — proposal card with
  `[a]pply / [r]evert / [i]nspect`.
- **Long-running tasks** — task card with progress and `[x] cancel`.
- **Todo / plan blocks** — when the meta-runtime publishes a structured
  plan, the TUI renders it as an inline mutating checkbox stream (Claude
  Code's idiom). The block updates in place rather than re-printing.

This gives the *feel* of dashboard panels without leaving the linear stream.

### Composer

Expected behavior:

- `Enter`: submit
- `Alt+Enter` or `Shift+Enter`: newline
- `Ctrl+C`: cancel active turn, otherwise clear draft, otherwise exit
- `Ctrl+D`: exit when idle
- `Ctrl+N` / `Ctrl+P`: cycle routes
- `Tab`: complete slash command or path token
- `Up/Down`: queued drafts first, then history
- `Ctrl+U`, `Ctrl+K`, `Ctrl+W`, `Ctrl+A`, `Ctrl+E`: shell-like editing
- paste of large text should summarize/collapse into an expandable attachment
  once attachment support exists

The session provider currently sets `accepts_attachments=false`, so v1 should
only support text drafts. Design the composer data model so attachments can be
added later without changing the surrounding UI.

### Queueing

The session provider exposes submitted-message queueing through `/queue`.
Calling `/composer.send_message` while a turn is active appends shared submitted
input to that queue, and the runtime drains it FIFO when the active turn
finishes.

Unsubmitted drafts remain local UI state only.

### Goals

The session provider exposes persistent long-running work through `/goal`.

TUI commands:

- `/goal <objective> [--token-budget N]`
- `/goal`
- `/goal pause [message]`
- `/goal resume [message]`
- `/goal complete [message]`
- `/goal clear`

The status bar should show active goal status, token usage, elapsed time, and a
truncated objective. Goal state remains runtime-owned shared state, not local
TUI state. Native model-driven goal turns can also report progress, blockers,
or completion through the runtime-local `slop_goal_update` tool; those reports
surface back through `/goal` as message, evidence, and update/completion source
fields.

### Sessions

When a supervisor is attached, the TUI can manage multiple scoped sessions
without reading runtime internals.

TUI commands:

- `/session-new [--workspace-id id] [--project-id id] [--title text]`
- `/session-switch <session-id>`
- `/session-stop <session-id>`

The command palette also exposes one-click creation from configured
workspace/project scopes and switching/stopping for running sessions. Session
lists and scopes come from the supervisor; each session item includes live
turn state, goal status, queued-message count, pending approval count, running
task count, and last activity time. Transcript, detailed turn, detailed goal,
approvals, queue, and apps still come from the currently attached session
provider. `/inspector sessions` renders this comparison state without merging
provider trees or importing runtime internals.

### Runtime Proposals

The `runtime` route treats the optional `meta-runtime` provider as an external
SLOP app, not as a privileged in-process integration. It discovers the connected
app from `/apps`, queries `meta-runtime:/proposals`, and invokes
`apply_proposal` or `revert_proposal` on `/proposals/{id}`. Persistent or
privileged proposals still flow through the provider approval path, so the
ordinary `/approvals` prompt remains the authority for final approval.

The route lists proposed items first, shows scope, approval requirement, summary,
rationale, and typed operation names, and supports refresh, inspect, apply, and
revert commands. It also shows route matchers, capability masks, and recent
meta-runtime events so typed-envelope delivery and capability-mask failures are
visible without dropping into the raw inspector. `/runtime export` invokes
`meta-runtime:/session export_bundle` and shows the portable bundle result in
the inspector. The command palette mirrors proposal actions and bundle export.

### Approvals

Pending approvals should interrupt the normal input loop with a focused prompt:

```text
Approve terminal.execute at /session?
Reason: Command marked dangerous

[o] once   [s] session   [d] deny
```

For v1, map public session affordances exactly:

- approve once through `/approvals/{id}.approve`
- reject through `/approvals/{id}.reject`

Do not invent broader approval scopes until the provider exposes them.

### LLM Onboarding

When `/llm.status=needs_credentials`, the main route should show the transcript
and disabled composer, with the setup panel focused:

- provider picker
- model field with provider defaults
- adapter id field for ACP profiles
- base URL field for OpenAI-compatible profiles
- API key secret input
- save profile
- make default

No API key should ever be echoed in state, logs, or transcript.

### Provider/App Visibility

The `/apps` route should list external providers:

- provider id/name
- transport
- status
- last error

The `runtime` route is the richer treatment for the built-in `meta-runtime` app;
the generic `apps` and `inspect` routes remain available for direct provider
debugging.

Selecting an app should open the `inspect` route for direct SLOP query. This is
important for Sloppy because external app state is the main integration surface.

### State Inspector

The inspector is a developer feature, not the primary UX:

- list providers from discovered app/session state
- query a session path or external app target with depth/window options
- show node type, props, summary, salience, focus, urgency
- list affordances on the selected node
- invoke affordances through generated forms

This must preserve the SLOP mental model: state tree first, contextual
affordances second.

## Visual Direction

Terminal visual design should be simpler than the dashboard design system.
Borrow Codex's restraint:

- default terminal foreground for most text
- dim for secondary metadata
- cyan for selection/status hints
- green for success
- red for errors/destructive actions
- avoid custom RGB colors by default
- no decorative borders around every component

Use the repo's dark "Nocturnal Observer" design language only as tone:

- dark base
- sparse neon green for truly high-intent actions
- blue/cyan for secondary state
- tight, information-dense layout

Do not implement glassmorphism, large editorial type, or complex gradients in
the terminal. They do not translate well across terminal themes.

## File Layout

```text
apps/tui/
  package.json              # optional only if app-local scripts are useful
  tsconfig.json
  src/
    index.tsx               # CLI args, TTY guard, renderer bootstrap
    app.tsx                 # top-level providers/routes
    slop/
      session-client.ts     # SLOP consumer wrapper
      supervisor-client.ts  # session-supervisor consumer wrapper
      node-mappers.ts       # SlopNode -> typed snapshots
      actions.ts            # invoke helpers
    state/
      session-store.ts      # remote state store
      ui-store.ts           # route, panes, drafts, queue, history
    routes/
      chat.tsx
      setup.tsx
      approvals.tsx
      tasks.tsx
      apps.tsx
      inspect.tsx
      settings.tsx
    components/
      transcript.tsx
      message-row.tsx
      markdown.tsx
      composer.tsx
      activity-lane.tsx
      approval-prompt.tsx
      command-palette.tsx
      picker.tsx
      status-bar.tsx
      state-tree.tsx
    lib/
      width.ts
      history.ts
      terminal.ts
      format.ts
    __tests__/
      node-mappers.test.ts
      queue.test.ts
      approval-actions.test.ts
```

## Implementation Phases

### Phase 1: Attach-Only MVP

- scaffold `apps/tui`
- add `bun run tui`
- connect to `--socket`
- subscribe to session-provider paths
- render transcript, turn state, activity, approvals, tasks, apps
- render meta-runtime proposals through the runtime route
- send text through `/composer.send_message`
- approve/reject pending approvals
- cancel active turn
- render and cancel submitted `/queue` items

Validation:

- unit tests for node mappers and queue behavior
- a mock SLOP session provider for TUI tests
- manual attach to `bun run session:serve`

### Phase 2: Onboarding And Settings

- `/llm` setup flow
- model/profile picker
- API key secret entry
- default profile switching
- delete profile/key confirmations
- settings route
- command palette with live route/goal/session/queue/app/runtime actions

Validation:

- tests for save profile action mapping
- no secret value appears in logs/state snapshots

### Phase 3: Provider Inspector

- app/provider list
- query path/depth/window
- state tree view
- affordance form generation
- invoke result display

Validation:

- mock provider tree snapshots and action schemas
- rejected/dangerous affordance handling

### Phase 4: Rich Terminal Polish

- markdown rendering
- diff/code block rendering
- persistent input history
- OSC 52 copy if safe
- terminal title
- narrow/wide responsive layouts
- optional mouse support

## Non-Goals For V1

- no custom orchestration DAG UI
- no MCP-style tool catalog
- no privileged direct imports from runtime internals
- no hidden model reasoning display
- no hidden in-process multi-session manager; session lifecycle must go through
  the public supervisor provider
- no attachments until `/composer` supports them

## Recommendation Summary

Build `apps/tui` as a Bun/TypeScript SLOP consumer using OpenTUI/Solid. Keep
the runtime headless and communicate only through the session provider.

The 2026-05 redesign tightens the UX around one chat stream + overlays +
palette, drawing the following lessons from prior art: from **opencode** the
Cmd+K palette and the unification of slash + keybind + category; from
**Claude Code** the Shift+Tab mode chip, inline mutating todo block, and
collapsible tool-call cards; from **factory droid** the `!` bash escape and
session verbs (`/fork`, `/rewind`); from **pi-mono** the steering vs
follow-up message queueing and editor border-color as ambient state; from
**hermes-agent** incremental markdown reuse for streaming; from
**openclaw** the streaming reconciliation logic and double-tap Ctrl+C.
Sloppy adds two SLOP-native concerns the references do not have: an
affordance-driven palette (items grow when providers attach) and a thin
session strip rendered only when the supervisor reports more than one
session.
