# TUI Plan

## Goal

Build a first-party terminal UI under `apps/tui` that is a SLOP consumer of the
public agent-session provider, not a privileged runtime integration.

The TUI should make Sloppy's runtime shape visible:

- transcript and composer as the primary working loop
- turn/activity/task/approval state as live operational context
- `/llm` onboarding as an in-app flow, not a setup cliff
- `/apps` attachment state as first-class context for external providers
- deeper provider inspection through explicit query/invoke views, not a flat
  tool catalog

Implementation status: `apps/tui` now contains a TypeScript/OpenTUI client that
attaches to the public agent-session provider socket, with a managed-session
startup path for local use.

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

The TUI should have three boundaries.

### 1. Session Client

`apps/tui/src/slop/session-client.ts`

Responsibilities:

- connect to a session provider over a Unix socket
- subscribe shallowly to `/session`, `/llm`, `/turn`, `/composer`,
  `/transcript`, `/activity`, `/approvals`, `/tasks`, and `/apps`
- expose a typed client-side store
- invoke public session affordances:
  - `/composer.send_message`
  - `/turn.cancel_turn`
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

### 2. UI Store

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

### 3. UI Shell

`apps/tui/src/ui/`

Routes:

- `chat`: default route; transcript, live activity, composer
- `setup`: LLM profile onboarding when `/llm.status=needs_credentials`
- `approvals`: pending/resolved approval review
- `tasks`: long-running provider tasks
- `apps`: external provider attachment state
- `inspect`: SLOP provider tree inspector for direct query/invoke debugging
- `settings`: model/profile/theme/keybinding settings

The shell should support attach mode first:

```sh
bun run tui --socket /tmp/slop/sloppy-session-<id>.sock
```

Then add managed mode:

```sh
bun run tui
```

Managed mode can spawn `bun run src/session/server.ts --socket ...` and then
connect to it. Attach mode must remain the cleaner contract for tests and future
multi-UI attachment.

## UX Model

### Default Screen

Use a quiet full-screen layout:

```text
┌ session/status bar: workspace · model · turn phase · apps · tokens later ┐
│ transcript                                                               │
│                                                                          │
│ live activity lane: model/tool/task/approval summaries                   │
├ composer: multiline input, queue count, disabled reason when not ready ──┤
└ hints: /help  ctrl+c cancel  tab complete  alt+enter newline             ┘
```

The first screen is the working chat surface, not a welcome page.

### Right/Bottom Inspector

Use an inspector that can be toggled between:

- Activity
- Approvals
- Tasks
- Apps
- State

On narrow terminals, collapse the inspector into modal routes. On wide
terminals, keep it as a right pane. The transcript should always retain enough
width for readable code blocks.

### Composer

Expected behavior:

- `Enter`: submit
- `Alt+Enter` or `Shift+Enter`: newline
- `Ctrl+C`: cancel active turn, otherwise clear draft, otherwise exit
- `Ctrl+D`: exit when idle
- `Tab`: complete slash command or path token
- `Up/Down`: queued drafts first, then history
- `Ctrl+U`, `Ctrl+K`, `Ctrl+W`, `Ctrl+A`, `Ctrl+E`: shell-like editing
- paste of large text should summarize/collapse into an expandable attachment
  once attachment support exists

The session provider currently sets `accepts_attachments=false`, so v1 should
only support text drafts. Design the composer data model so attachments can be
added later without changing the surrounding UI.

### Queueing

The session provider v1 rejects `send_message` while a turn is active. The TUI
should queue drafts locally when the turn is running and send the next queued
draft when `/turn.state` returns to `idle`. This mirrors Hermes' best UX while
respecting the provider contract.

Queued drafts are local UI state only.

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
- adapter id field for ACP/CLI profiles
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
- send text through `/composer.send_message`
- approve/reject pending approvals
- cancel active turn
- local queued drafts

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
- settings route and command palette

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
- no multi-session manager until the session provider exposes a public session
  listing/creation surface
- no attachments until `/composer` supports them

## Recommendation Summary

Build `apps/tui` as a Bun/TypeScript SLOP consumer using OpenTUI/Solid. Keep the
runtime headless and communicate only through the session provider. Use Codex for
terminal restraint, OpenCode for the full-screen routed TypeScript app model, Pi
for rendering/test discipline, and Hermes for chat/composer/approval UX.
