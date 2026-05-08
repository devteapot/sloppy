# Agent Harness Research And TUI Audit

May 2026 research pass comparing Hermes Agent, OpenClaw, pi-mono, Claude
Code, Factory Droid, OpenCode, and the current Sloppy implementation.

## Executive Take

Sloppy is already strongest at the architecture boundary: state-first SLOP
providers, public session sockets, a session supervisor, `/goal`, ACP-backed
delegation, MCP/A2A compatibility as providers, and a real skills/meta-runtime
substrate. The biggest gap is product surface, not runtime substrate. The TUI
has enough plumbing to prove the public session contract, but it is not yet a
complete daily-driver interface.

The nearest useful peer for Sloppy's TUI is OpenCode because it shares the
TypeScript/OpenTUI direction and treats the terminal client as a rich client of
a server. The nearest useful peer for self-evolution is Hermes because it has
the most explicit memory/skill learning loop. The nearest useful peer for
multi-channel, long-lived personal-assistant operation is OpenClaw. The nearest
useful peer for safety and command UX is Claude Code. The nearest useful peer
for enterprise workflow UX is Factory Droid. The nearest useful peer for TUI
correctness discipline is pi-mono.

Sloppy should not copy any of their flat tool catalogs. It should copy their
operator-facing UX patterns and project them through SLOP state. Permissions,
hooks, tasks, skills, models, sessions, LSP, and verification evidence should
be visible provider state before they are actions. Reusable planning, review,
diagnosis, and topology repair should stay in skills over `meta-runtime`,
`spec`, `memory`, `activity`, and `apps`, not in hardcoded kernel policy.

## Evidence Checked

Repository evidence inspected:

- `README.md`, `docs/02-architecture.md`, `docs/03-mvp-plan.md`,
  `docs/06-agent-session-provider.md`, `docs/13-meta-runtime.md`,
  `docs/16-tui-plan.md`, and `docs/research/prior-art.md`.
- TUI code under `apps/tui/src/`, especially `app.tsx`,
  `slop/session-client.ts`, `slop/node-mappers.ts`, `state/commands.ts`,
  `state/command-palette.ts`, and route/component files.
- TUI tests in `tests/tui-session-client.test.ts`.

Verification run during this audit:

```sh
bun run tui:typecheck
bun test tests/tui-session-client.test.ts
```

Both passed; the TUI test slice ran 22 passing tests.

## Current Sloppy Baseline

Runtime strengths checked in now:

- public session provider with `/session`, `/llm`, `/turn`, `/goal`,
  `/composer`, `/transcript`, `/activity`, `/approvals`, `/tasks`, `/apps`,
  and `/queue`;
- public session supervisor for create/switch/stop over ordinary session
  provider sockets;
- SLOP-native built-in providers for terminal, filesystem, memory, skills,
  meta-runtime, browser, web, cron, messaging, delegation, spec, vision, MCP,
  workspaces, and A2A;
- dynamic affordances from visible SLOP state plus fixed observation tools;
- native Anthropic, Gemini, OpenAI-compatible, and OpenAI Codex subscription
  adapters, plus ACP session-agent paths;
- meta-runtime proposals, routes, capabilities, executor bindings, selected
  skill versions, experiments/evaluations, bundle import/export, and
  capability-mask enforcement;
- Hermes-style skill discovery with progressive `skill_view` and
  approval-gated `skill_manage`.

The gap is not "add another orchestrator." The gap is making the already-rich
state and controls usable, inspectable, and hard to misuse.

## Project Findings

### Hermes Agent

Sources:

- <https://hermes-agent.nousresearch.com/docs/>
- <https://hermes-agent.nousresearch.com/docs/developer-guide/architecture>
- <https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop/>
- <https://hermes-agent.nousresearch.com/docs/guides/work-with-skills>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>
- <https://hermes-agent.nousresearch.com/docs/user-guide/tui>

Hermes is a Python agent runtime with a large synchronous `AIAgent` loop, tool
registry, provider resolver, prompt builder, compression, callbacks,
SQLite/FTS5 session storage, gateway adapters, cron, ACP, plugins, memory
providers, and RL/trajectory tooling. Its product story centers on the
"learning loop": bounded memory, session search, agent-created skills, skill
improvement, Skills Hub, and multi-platform gateway operation.

What Hermes gets right:

- Skill progressive disclosure is strong: compact skill list at startup,
  `skill_view(name)` when needed, and specific supporting-file reads only when
  needed.
- Memory has explicit budgets and a frozen prompt snapshot. This protects
  prompt cache stability and keeps the model aware of memory capacity.
- SQLite plus FTS5 session search is a mature answer to "where did we discuss
  this before?"
- Cron jobs are agent tasks, can attach skills, deliver to platforms, and
  prevent recursive scheduling loops.
- TUI launch and UX notes emphasize instant first frame, non-blocking input,
  overlays, live session panel, alternate-screen rendering, paste collapse,
  image/file attachment normalization, and same slash command semantics as the
  classic CLI.

What to use in Sloppy:

- Add a session-search provider or extend `memory` with an indexed transcript
  search surface. It should expose search state and result affordances, not just
  a model-only tool.
- Add visible memory budget and source state to the TUI. Hermes' small fixed
  memory budget is less important than the UX: users and agents see what will
  persist and how full it is.
- Preserve the skill progressive-disclosure design and add first-class skill
  installation/update/review UI later.
- Treat cron and goal work as stateful provider surfaces with skill
  attachments. Sloppy already has `cron` and `/goal`; the TUI should show them
  together.

Where Sloppy should diverge:

- Hermes' central agent loop and registry are large and tool-first. Sloppy's
  SLOP provider boundary is cleaner. Keep runtime policy out of core.
- Hermes uses many gateway/platform branches. Sloppy should expose providers
  through `/apps` and let UIs consume common SLOP state rather than adding
  platform-specific control paths to the kernel.

### OpenClaw

Sources:

- <https://github.com/openclaw/openclaw>
- <https://docs.openclaw.ai/concepts/agent>
- <https://docs.openclaw.ai/concepts/session-tool>
- <https://docs.openclaw.ai/tools/skills-config>
- <https://docs.openclaw.ai/tools/clawhub>

OpenClaw is a TypeScript personal assistant with a Gateway control plane,
channels, a single embedded agent runtime built on Pi core, workspace bootstrap
files, skills, session JSONL, steering/follow-up queue modes, subagent session
tools, sandboxing for non-main sessions, plugins, and ClawHub.

What OpenClaw gets right:

- The workspace bootstrap is understandable to users: `AGENTS.md`, `SOUL.md`,
  `TOOLS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, and `USER.md`.
- Session tools are explicit: list/history/send/spawn/yield/subagents/status.
  `sessions_yield` is especially useful because it ends the current turn and
  lets the follow-up event arrive naturally instead of requiring model-side
  polling.
- Session history returned to agents is safety-filtered: thinking/control
  scaffolding stripped, credentials redacted, large histories bounded.
- Skill load order and skill allowlists are operationally explicit.
- ClawHub versioning, metadata, install/update flows, compatibility checks, and
  moderation hooks are the right shape for a future skill/plugin ecosystem.
- Steering modes are product-real: users can inject steering at model
  boundaries while an agent is busy.

What to use in Sloppy:

- Add a SLOP-native "session recall" surface that mirrors OpenClaw's
  `sessions_list` and `sessions_history`, but as state under the session
  supervisor or a session-history provider.
- Add a visible "yield until child/event" UX to the TUI for delegated sessions.
  Sloppy already has explicit delegation wait semantics; the UI should make
  that a first-class pending state.
- Use OpenClaw-style skill source metadata, lock state, local-modified warnings,
  and compatibility validation if Sloppy gets skill import/update beyond local
  directories.
- Add channel-safe redaction and bounded-history rules before transcript recall
  is shown to agents or UIs.

Where Sloppy should diverge:

- OpenClaw remains built around a single embedded runtime plus gateway-owned
  session/tool wiring. Sloppy should keep every capability behind provider
  state and avoid treating channels as privileged runtime branches.
- ClawHub's registry model is useful, but installable code and markdown skills
  need stronger local review and approval state in Sloppy.

### pi-mono

Sources:

- <https://github.com/badlogic/pi-mono>
- <https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md>
- <https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/tui/README.md>
- <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md>

Pi is a minimal TypeScript terminal coding harness plus separate packages for
LLM APIs, agent core, coding agent CLI, TUI library, web UI, Slack bot, and vLLM
pods. Its philosophy is to keep the core minimal and let users add subagents,
plan mode, permissions, custom UIs, MCP, and other features through TypeScript
extensions, skills, prompt templates, themes, and pi packages.

What Pi gets right:

- The TUI library enforces line width: rendered lines must not exceed width.
  That is a useful quality invariant for every serious TUI.
- Differential rendering, synchronized output, bracketed paste, built-in
  editor/markdown/select/settings components, inline images, overlays, and
  autocomplete are exactly the primitives Sloppy's TUI needs.
- The coding agent has strong session UX: JSONL session tree, `/tree`,
  branching, `/fork`, `/clone`, compaction, message queue steering/follow-up,
  model cycling, context files, and external editor support.
- Extensions are powerful enough to add custom tools, commands, keyboard
  shortcuts, event handlers, UI components, subagents, plan mode, permission
  gates, git checkpoints, SSH/sandbox execution, and MCP.
- Pi's "No MCP / No subagents / No permission popups / No plan mode" stance is
  valuable as design pressure: if a feature can live outside the kernel, it
  probably should.

What to use in Sloppy:

- Add terminal render tests that check width invariants and key flows. Even if
  Sloppy stays on OpenTUI, Pi's "line must fit" rule should become a local test
  invariant.
- Copy the branchable session-tree UX, but source it from the public session
  provider or transcript store.
- Add external-editor handoff for the composer.
- Keep customization points data-driven and provider-driven before adding more
  core features.

Where Sloppy should diverge:

- Pi intentionally skips several features Sloppy already needs as first-party
  state: approvals, goals, provider apps, meta-runtime, and supervisor
  sessions. Sloppy should not underbuild those surfaces, but it should copy
  Pi's testing discipline.

### Claude Code

Sources:

- <https://code.claude.com/docs/en/overview>
- <https://code.claude.com/docs/en/slash-commands>
- <https://code.claude.com/docs/en/sub-agents>
- <https://code.claude.com/docs/en/permissions>
- <https://code.claude.com/docs/en/hooks>
- <https://code.claude.com/docs/en/output-styles>

Claude Code is a commercial agentic coding tool across terminal, IDE, desktop,
and web. The strongest references for Sloppy are command UX, permissions,
subagents, hooks, skills, memory files, output styles, status line
customization, and checkpointing.

What Claude Code gets right:

- Slash commands cover actual daily workflows: `/agents`, `/compact`,
  `/config`, `/cost`, `/doctor`, `/init`, `/mcp`, `/memory`, `/model`,
  `/permissions`, `/review`, `/rewind`, `/status`, `/usage`, `/vim`, and more.
- Subagents are defined by markdown/frontmatter, have separate context windows,
  focused prompts, tool restrictions, model selection, permissions, scoped MCP,
  preloaded skills, hooks, foreground/background execution, persisted
  transcripts, and explicit resume paths.
- Permissions are productized: read-only does not prompt, Bash and edits do,
  rules are versionable, deny takes precedence, and modes include default,
  accept-edits, plan, auto, don't-ask, and bypass.
- Hooks are a broad lifecycle API: session start/end, prompt submit/expansion,
  pre/post tool, permission request/denied, task/subagent events, compaction,
  config/cwd/file changes, worktree create/remove, MCP elicitation, async,
  HTTP, prompt, agent, and MCP-tool hooks.
- Skills have converged with custom commands. A skill can be a slash command,
  auto-loaded when relevant, include supporting files, use frontmatter
  invocation controls, and dynamically inject context.

What to use in Sloppy:

- Make command, keybinding, and help definitions a single source of truth. The
  current Sloppy TUI already has help/parser drift.
- Add a SLOP provider for permission policy and hook registrations rather than
  burying them in config. The TUI should show rules, source files, and pending
  prompts.
- Model foreground/background child sessions explicitly in TUI, including
  permission propagation and clarifying-question routing.
- Add checkpoint/rewind state as a provider later. This maps naturally to a
  filesystem/git provider, not a TUI-only feature.

Where Sloppy should diverge:

- Claude Code tool permissions are tool-name centric. Sloppy should retain
  provider/path/action contextual approvals. If a rule is added, it should
  match provider, path, affordance, capability mask, and possibly envelope
  metadata.

### Factory Droid

Sources:

- <https://docs.factory.ai/>
- <https://docs.factory.ai/cli/getting-started/overview>
- <https://docs.factory.ai/reference/cli-reference>
- <https://docs.factory.ai/cli/features/missions>
- <https://docs.factory.ai/cli/configuration/custom-droids>
- <https://docs.factory.ai/cli/configuration/skills>
- <https://docs.factory.ai/cli/configuration/settings>
- <https://docs.factory.ai/cli/features/droid-control>

Factory Droid is a commercial, enterprise-oriented coding agent across CLI,
desktop, exec/CI, IDEs, Slack/Linear/Jira-style integrations, cloud machines,
custom droids, missions, readiness, hooks, plugins, skills, MCP, and QA/demo
automation.

What Factory gets right:

- It separates interactive `droid`, headless `droid exec`, and automation
  output formats (`json`, `stream-json`, `stream-jsonrpc`).
- Autonomy levels are named in user terms: default read-only, low safe edits,
  medium local dev, high CI/CD/deployment, and explicit unsafe bypass.
- Missions make long-running work a collaborative planning phase followed by an
  orchestration view: features, milestones, skills, progress tracking, and
  intervention/redirect.
- Custom droids are markdown subagents in project/user scopes with prompts,
  tools, model preference, and tool policy.
- Skills and custom commands are merged, and skills can be user-invoked or
  Droid-invoked.
- Droid Control turns verification into a product workflow: plan, drive
  terminal/browser/desktop, capture evidence, report pass/fail, and optionally
  render demo videos.
- Settings are interactive and persisted, including model, reasoning effort,
  autonomy, diff mode, sound, hooks, IDE auto-connect, and command allow/deny.

What to use in Sloppy:

- Build a "Mission" UX on top of existing `/goal`, `spec`, `meta-runtime`,
  `delegation`, and `tasks` state. Do not add a core scheduler; present a
  structured plan and intervention surface in the TUI.
- Add `session:exec` or equivalent machine-readable one-shot mode only after
  the public session provider can emit a stable event stream.
- Add an evidence/verification provider inspired by Droid Control. It should
  store test plans, browser/terminal captures, and pass/fail evidence as SLOP
  state. This would make Sloppy's runtime claims inspectable.
- Add interactive settings that write normal config/profile state through
  provider affordances, not a separate local settings editor.

Where Sloppy should diverge:

- Factory's enterprise integration breadth should not become Sloppy's core.
  Sloppy should first make provider state composable enough that integrations
  remain ordinary providers.

### OpenCode

Sources:

- <https://github.com/anomalyco/opencode>
- <https://opencode.ai/docs/tui/>
- <https://opencode.ai/docs/keybinds/>
- <https://opencode.ai/docs/agents/>
- <https://opencode.ai/docs/permissions/>
- <https://opencode.ai/docs/lsp/>
- <https://opencode.ai/docs/config/>
- <https://github.com/sst/opentui>

OpenCode is an open-source TypeScript/Bun coding agent with strong TUI focus,
provider-agnostic model routing, LSP support, primary agents, subagents,
sessions, sharing, permissions, configurable keybinds, custom tools, MCP, ACP
support, and client/server architecture.

What OpenCode gets right:

- TUI basics are direct and discoverable: `@file` references, `!bash`, slash
  commands, `/editor`, `/export`, `/models`, `/sessions`, `/undo`, `/redo`,
  `/share`, `/themes`, `/thinking`, and separate `tui.json` configuration.
- Keybindings are user-configurable and use a leader key to avoid terminal
  conflicts. The list is comprehensive: app exit, editor, themes, sidebar,
  status, tool details, sessions, child sessions, messages, model/variant,
  commands, agents, input editing, history, terminal title, and thinking
  display.
- Agents are explicit: primary build/plan and subagents general/explore. Plan
  is restricted by default, Explore is fast/read-only, General can handle
  complex multi-step work.
- Permissions have allow/ask/deny, wildcard and object syntax, external
  directory guards, `.env` denial defaults, and per-agent overrides.
- LSP diagnostics are first-class context for the model, with built-in server
  discovery across many languages and configurable/custom servers.
- Config layering is mature: remote/org, global, custom env path, project,
  `.opencode` directories, and inline env content. Configs merge instead of
  replacing.

What to use in Sloppy:

- Use OpenCode as the main TUI product bar. Sloppy already chose
  `@opentui/core` and `@opentui/solid`; the missing work is product depth.
- Add configurable keybindings and a command registry, then generate help,
  slash suggestions, palette actions, and tests from that registry.
- Add `!bash` and real `@file` inclusion/attachment semantics or remove those
  hints from the TUI until they exist.
- Add an LSP provider that exposes diagnostics, symbols, and code actions as
  state. This is a better Sloppy fit than embedding LSP logic inside the agent.
- Add session navigation and branch/fork UX after the transcript store supports
  it.

Where Sloppy should diverge:

- OpenCode's permissions and tools are still mostly tool/action catalogs.
  Sloppy should keep affordances scoped to provider nodes and make dynamic
  capability visibility part of the UI.

## Cross-System Comparison

| System | Runtime center | Extension unit | Session model | TUI/UX center | Safety model | Sloppy takeaway |
| --- | --- | --- | --- | --- | --- | --- |
| Hermes | Monolithic Python `AIAgent`, registry, gateway | skills, plugins, memory providers, cron | SQLite/FTS5, profiles, gateway platforms | CLI plus modern TUI | approvals, containers, authz, prompt scanning | copy learning loop and search, not registry core |
| OpenClaw | Gateway plus Pi core | skills, plugins, ClawHub | JSONL sessions, session tools, queue modes | channel-first assistant and control UI | sandbox non-main, skill/plugin warnings | copy session tools and skill registry metadata |
| pi-mono | Minimal TS coding agent | extensions, skills, prompts, themes, packages | JSONL tree, branch/fork/compact | strict terminal editor and session tree | container/extension-owned gates | copy width tests, queue UX, external editor |
| Claude Code | Commercial agent loop | skills/commands, subagents, hooks, settings | terminal/IDE/web sessions, subagent transcripts | command-rich terminal/IDE | deny/ask/allow, modes, hooks, sandbox | copy command/permission/hook UX |
| Factory Droid | Commercial platform | skills, plugins, custom droids, missions | local, exec, CI, desktop/web/org | enterprise workflows, missions, QA evidence | autonomy levels, approvals, org settings | copy mission and evidence UX over SLOP state |
| OpenCode | TS/Bun client/server | agents, plugins, custom tools, MCP, config | sessions plus child sessions | OpenTUI, keybinds, LSP, command palette | permissions, external directory, per-agent rules | closest TUI/product peer |
| Sloppy | SLOP providers and public session provider | providers, skills, meta-runtime proposals, ACP adapters | session provider, supervisor, queue, goal | current OpenTUI app, still thin | approval queue, provider policy, capability masks | preserve architecture, invest in TUI and policy UX |

## TUI Audit

### What Is Implemented

Files inspected:

- `apps/tui/src/index.tsx`: starts managed supervisor mode by default,
  supports direct `--socket`, existing `--supervisor-socket`, workspace/project
  scope flags, alternate screen, OpenTUI/Solid renderer, mouse mode, and clean
  shutdown.
- `apps/tui/src/slop/session-client.ts`: subscribes to `/session`, `/llm`,
  `/turn`, `/goal`, `/composer`, `/transcript`, `/activity`, `/approvals`,
  `/tasks`, `/apps`, and `/queue`; invokes composer, turn cancel, approvals,
  tasks, queue cancel, goal controls, LLM profile operations, and inspector
  query/invoke against session or attached app providers.
- `apps/tui/src/slop/supervisor-client.ts`: connects to session supervisor
  state and exposes supervised session create/switch/stop.
- `apps/tui/src/app.tsx`: main shell, command dispatch, route overlays,
  inspector overlay, pending approval prompt, queue preview, slash suggestions,
  file suggestions, notice line, composer, footer, status bar, palette, secret
  prompt, and supervisor session operations.
- `apps/tui/src/routes/*`: chat, setup, approvals, tasks, and apps route
  overlays.
- `tests/tui-session-client.test.ts`: mapper tests, command parser tests,
  palette action tests, initial route tests, queue mapping tests, and live mock
  SLOP socket tests for session client/app proxy/queue.

Current strengths:

- The TUI consumes the public session provider. It is not a privileged runtime
  integration.
- Managed mode goes through the public supervisor and then attaches to an
  ordinary session socket.
- Initial render does not wait for connection; it starts with a local snapshot
  and updates when SLOP subscriptions arrive.
- Local command parser rejects obvious inline API keys for `/profile`.
- `/apps` inspection can attach to external provider sockets or the built-in
  session proxy for `meta-runtime`.
- `/goal` state is visible in the status bar and has local commands.
- Queue state is visible and queued messages can be cancelled.
- Approvals are visible inline and as an overlay. Dangerous approvals require
  Shift confirmation.

### Completeness By Surface

| Surface | Current state | Completeness |
| --- | --- | --- |
| Basic chat | transcript, markdown, streaming marker, composer, send/cancel | usable MVP |
| Tool/activity display | inline collapsed/expanded tool lines from `/activity` | useful, not rich |
| Approvals | inline card, focused prompt, overlay history | good MVP |
| Queue | preview and cancel command | good MVP |
| Goal | status bar and slash controls | functional, weak detail view |
| LLM setup | profile list, set default, delete profile/key, masked secret command | functional but not guided enough |
| Sessions | managed supervisor, create/switch/stop, session strip only with >1 sessions | functional but not discoverable enough |
| Apps/providers | list, inspect connected providers | functional debugger |
| Runtime/meta-runtime | commands proxy to query/apply/revert/export | thin; not a real proposal review UX |
| Inspector | query/invoke tree view, copy selected line | useful but primitive |
| Settings | route type/help mention exists, no route implementation | incomplete |
| Command palette | live actions for routes, goal, queue, apps, sessions | useful but not enough ranking/scroll/config |
| Slash commands | autocomplete and parser for many commands | drift with help; no single registry |
| `@file` | fuzzy path completion only | incomplete; does not inject/attach file content |
| `!bash` | mentioned in design docs, not implemented in parser/composer | missing |
| External editor | not implemented | missing |
| Attachments/images | transcript media display only; composer says no attachments | missing by provider design |
| Visual/terminal QA | typecheck and logic tests only | weak |

### Concrete UX Gaps

1. Help and parser are out of sync.
   - `HelpOverlay` advertises `/default`, `/delete-profile`, `/delete-key`,
     and `/inspector [activity|approvals|tasks|apps|sessions|state]`.
   - `parseLocalCommand` does not implement those commands. `/settings` is in
     `TuiRoute` and help, but `ROUTE_NAMES` excludes it and
     `NonChatRouteView` has no settings route.
   - This is a daily-driver trust issue. The UI should never advertise a
     command that falls through to the agent unless that is intentional and
     labeled.

2. The mode chip is mostly cosmetic.
   - `Shift+Tab` cycles `default`, `auto-approve`, and `plan`.
   - The current code updates local UI state and notices. It does not alter
     runtime policy, meta-runtime planning behavior, or approval handling.
   - Auto-approve text says pending approvals will be auto-approved
     non-dangerous only, but there is no code path that auto-approves them.

3. `!bash` is missing.
   - `docs/16-tui-plan.md` names `!cmd` as a composer sigil.
   - The parser only handles slash commands. Non-slash text, including `!ls`,
     goes to `/composer.send_message`.
   - If Sloppy wants an OpenCode/Factory-style bash mode, implement it through
     a terminal-provider affordance and show the result as activity.

4. `@file` is only autocomplete.
   - `file-catalog.ts` completes paths, but the submitted message is still raw
     text. No file content or attachment is injected by the TUI.
   - That can be fine if the agent interprets `@path`, but then it is a model
     convention, not a UI feature. The UX should say so or implement real
     attachment/context injection once `/composer.accepts_attachments` is true.

5. Runtime proposal UX is not feature-complete.
   - `RuntimeRoute` mainly says meta-runtime is accessed through `/apps` and
     lists commands.
   - There is no proposal list, operation diff, approval state, route matcher
     view, capability-mask explanation, event timeline, or inline proposal card
     in chat.
   - The underlying provider is much richer than the UI.

6. Settings and profile onboarding are too command-driven.
   - Setup route lists profiles and has keyboard actions, but profile creation
     requires `/profile` or `/profile-secret`.
   - Factory, Claude Code, and OpenCode all turn settings/providers/models into
     navigable UI flows. Sloppy currently exposes a thin list plus command
     syntax.

7. Keybindings are hardcoded and undocumented behavior is uneven.
   - OpenCode's `tui.json` has user-configurable keybinds and a leader key.
   - Sloppy has hardcoded `Ctrl+K`, `Shift+Tab`, `Esc`, `Ctrl+C`, `Ctrl+D`,
     arrow history, approval keys, and route-specific keys.
   - This is acceptable for pre-alpha but should move to a registry before the
     key surface grows.

8. Command palette is useful but shallow.
   - It truncates to 10 commands, has simple substring matching, no scrolling,
     no sections, no recent commands, no keybinding display beyond a single
     shortcut string, and no provider-affordance discovery beyond app inspect.
   - The plan says command palette contents should grow from live SLOP
     affordances; current implementation only partially does that.

9. `apps/tui/src/app.tsx` is too large.
   - It is 1174 lines and owns connection event handling, route state, command
     dispatch, runtime commands, goal commands, session supervisor operations,
     overlay rendering, and composer behavior.
   - This will slow down UX iteration. Split command execution, key handling,
     overlay state, and composer logic before adding more modes.

10. There are no visual or terminal interaction tests.
    - Current tests cover mappers, parser, palette data, and SLOP client
      behavior.
    - There is no virtual terminal harness, screenshot/golden render, width
      invariant test, paste test, or interactive key-flow test.
    - This is the main reason TUI quality can regress silently.

## Recommended Next Steps

### P0: Make The TUI Trustworthy

- Create a single command registry that generates slash suggestions, help rows,
  palette entries, parser coverage tests, and dispatcher cases.
- Fix or remove advertised commands that do not work: `/default`,
  `/delete-profile`, `/delete-key`, `/settings`, and `/inspector ...`.
- Either implement `!bash` through the terminal provider or remove `!cmd` from
  hints until it exists.
- Clarify `@file`: either treat it as literal model-visible syntax or implement
  provider-backed file content insertion/attachments.
- Change the auto-approve/plan mode labels until they have runtime effect, or
  wire them to provider policy/meta-runtime affordances.

### P1: Turn Runtime State Into Product UI

- Build a real runtime overlay over the `meta-runtime` app proxy:
  proposals, operations, capability masks, route matchers, approvals,
  event timeline, export/import status, and apply/revert results.
- Add inline runtime proposal cards in chat, not only `/runtime` commands.
- Add a real goal detail overlay with objective, budget, elapsed time,
  continuation count, last update, evidence, pause/resume/complete/clear, and
  link to relevant turns.
- Add session comparison view from supervisor state: active/running sessions,
  queued count, pending approvals, tasks, goals, last activity, switch/stop.

### P2: Raise Terminal UX Quality

- Add a virtual terminal/render test harness that exercises key flows:
  first connect, needs-credentials setup, send message, busy queue,
  approval prompt, app inspect, command palette search, and resize.
- Add line-width assertions for core renderers and transcript/tool previews.
- Add paste handling and collapse large paste into a pending attachment once
  the composer provider supports attachments.
- Add external editor handoff for long prompts.
- Split `app.tsx` into shell, command execution, composer, overlays, and
  runtime/goal/session controllers.

### P3: Add High-Leverage Providers

- Session/search provider: indexed transcript and activity search with
  redaction and bounded result windows.
- LSP provider: diagnostics, symbols, code actions, and server readiness as
  SLOP state.
- Permission/hook provider: user-visible rules, sources, lifecycle hooks,
  pending prompts, allow/deny results, and audit trail.
- Verification/evidence provider: terminal/browser/test captures, pass/fail
  records, and replayable evidence for completed goals.

### P4: Productize Skills And Missions

- Add skill source metadata, compatibility checks, installed/proposed versions,
  review/apply/revert UI, and usage telemetry views.
- Model "missions" as a TUI projection over existing `/goal`, `spec`,
  `meta-runtime`, `delegation`, `tasks`, and evidence provider state. Do not
  add a scheduler/DAG to core.
- Add foreground/background delegated session UX inspired by Claude Code,
  OpenCode, and OpenClaw, while preserving Sloppy's public session-provider
  boundary.

## Priority Backlog

1. Fix command/help drift and add a command registry test.
2. Decide `!bash` and `@file` semantics, then make the composer honest.
3. Replace cosmetic mode labels with real state or remove overstated claims.
4. Build the meta-runtime proposal overlay from `/apps` proxy state.
5. Add visual/virtual-terminal TUI tests and line-width checks.
6. Add goal/session detail overlays.
7. Split `app.tsx` before the next large TUI feature.
8. Add LSP diagnostics as a provider.
9. Add session search/memory budget UI.
10. Add verification/evidence provider and surface it in goal completion.

The order matters. The TUI needs trust and testability before more agent
intelligence is exposed through it.
