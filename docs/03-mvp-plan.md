# MVP Plan

## Goal

Deliver a working CLI agent harness that proves the SLOP-first architecture end to end.

The MVP should be able to:

1. accept a user task from the CLI
2. observe built-in provider state through SLOP
3. use provider-native tool calling to invoke affordances and consumer observation tools
4. stream responses while state stays live through subscriptions and patches
5. connect to external SLOP providers discovered from local descriptors

The thesis being tested is not “can we build another tool agent.”

It is:

**can a general agent harness be built around SLOP state + affordances instead of a flat tool registry?**

---

## Current Phase 1 status

Implemented now:

- Bun + TypeScript project scaffold
- npm-installed SLOP SDK dependencies
- config loading from `~/.sloppy/config.yaml` and workspace `.sloppy/config.yaml`
- built-in `terminal`, `filesystem`, `orchestration`, `spec`, `memory`, `skills`, `browser`, `web`, `cron`, `messaging`, `delegation`, and `vision` providers
- durable orchestration tasks with batch DAG creation, cycle rejection, plan-scoped task visibility, spec refs, audit findings, dependency normalization plus parallel-friendly coding-task dependency inference, scheduler-claimed ready tasks, pushed child results, and acceptance-criteria-gated verification with cited evidence refs
- orchestrator-mode guardrails enforced as hub `InvokePolicy` rules (`orchestratorRoleRule`, `terminalSafetyRule`, `dangerousActionRule`) that block direct file mutations, non-whitelisted shell commands, and direct delegation spawns when `roleId === "orchestrator"` so fixes stay delegated through scheduled tasks
- in-process transport for built-in providers
- live-watched provider descriptor discovery for Unix socket and WebSocket providers
- consumer hub with overview and detail subscriptions
- fixed observation tools:
  - `slop_query_state`
  - `slop_focus_state`
- dynamic affordance tool generation from visible state
- native Anthropic adapter
- OpenAI-compatible adapter for OpenAI, OpenRouter, and Ollama
- native Gemini adapter
- lazy LLM startup so the session can boot without a ready API key
- managed LLM profiles with secure credential storage for macOS and Linux
- ACP-backed delegated child agents through the `SessionAgent` boundary, preserving the same session-provider state surface
- CLI single-shot mode and REPL
- checked-in `src/session/` agent-session provider with `/llm` onboarding/profile-management state and `/apps` external-provider attachment visibility
- checked-in Go + Bubble Tea TUI under `apps/tui/` with LLM onboarding and settings management
- tests covering transport, runtime tool generation, session-provider flows, and all built-in providers

## Interface direction after Phase 1

The current CLI proves the runtime loop, but it is not the intended long-term public interface boundary.

The next interface phase should:

- keep the core runtime headless
- expose the running agent session through a public bridge or provider surface
- ensure first-party UIs use that same public boundary instead of private in-process hooks
- support multiple simultaneous UI consumers attached to one session
- start with `apps/tui/` as the first richer interface

The selected shape is an **agent-session provider**:

- the runtime remains a SLOP consumer of workspace and application providers
- the runtime also becomes a SLOP provider of transcript, turn state, approvals, and session affordances
- UIs become consumers of that session provider

This keeps the interface model aligned with the core architecture instead of inventing a separate UI-only protocol.

The concrete provider shape is defined in `docs/06-agent-session-provider.md`.

Still intentionally minimal in important ways:

- no SQLite history/search store yet
- several Phase 2 providers are still simulated/local-first rather than integrated with real external systems
- no unified policy layer across every dangerous affordance yet

---

## File layout

```text
src/
├── cli.ts
├── index.ts
├── config/
│   ├── load.ts
│   ├── persist.ts
│   └── schema.ts
├── core/
│   ├── agent.ts
│   ├── approvals.ts
│   ├── consumer.ts
│   ├── context.ts
│   ├── debug.ts
│   ├── history.ts
│   ├── loop.ts
│   ├── policy.ts
│   ├── policy/
│   │   └── rules.ts
│   ├── role.ts
│   ├── subscriptions.ts
│   └── tools.ts
├── llm/
│   ├── anthropic.ts
│   ├── credential-store.ts
│   ├── factory.ts
│   ├── gemini.ts
│   ├── openai-compatible.ts
│   ├── profile-manager.ts
│   ├── provider-defaults.ts
│   ├── runtime-config.ts
│   └── types.ts
├── providers/
│   ├── approvals.ts
│   ├── descriptor-validation.ts
│   ├── discovery.ts
│   ├── node-socket.ts
│   ├── registry.ts
│   └── builtin/
│       ├── browser.ts
│       ├── cron.ts
│       ├── delegation.ts
│       ├── filesystem.ts
│       ├── in-process.ts
│       ├── memory.ts
│       ├── messaging.ts
│       ├── orchestration/
│       │   ├── classifiers.ts
│       │   ├── dag.ts
│       │   ├── index.ts
│       │   ├── normalization.ts
│       │   ├── storage.ts
│       │   └── types.ts
│       ├── skills.ts
│       ├── spec.ts
│       ├── terminal.ts
│       ├── vision.ts
│       └── web.ts
├── runtime/
│   ├── delegation/
│   │   ├── await-children.ts
│   │   ├── index.ts
│   │   ├── runner-factory.ts
│   │   └── sub-agent.ts
│   └── orchestration/
│       ├── attach.ts
│       ├── index.ts
│       ├── planning-policy.ts
│       ├── prompt.ts
│       ├── scheduler.ts
│       └── task-context.ts
└── session/
    ├── event-bus.ts
    ├── index.ts
    ├── provider.ts
    ├── runtime.ts
    ├── server.ts
    ├── service.ts
    ├── store.ts
    ├── store/
    │   ├── activity.ts
    │   ├── apps.ts
    │   ├── helpers.ts
    │   ├── index.ts
    │   ├── listeners.ts
    │   ├── llm.ts
    │   ├── mirrors.ts
    │   ├── state.ts
    │   ├── transcript.ts
    │   └── turn.ts
    └── types.ts
```

### Checked-in interface layout

```text
apps/
  tui/
src/
  cli.ts              current development shell
  core/
  llm/
  providers/
  session/            initial agent-session provider / bridge layer scaffold
```

---

## Architecture decisions

### 1. Native tool use, not custom action parsing

Provider-native tool calling is the action surface.

Dynamic affordances are converted to tool definitions, but the architecture remains SLOP-first.

This removes the need for XML or custom JSON block parsing.

### 2. Observation tools are first-class

The runtime exposes two fixed tools alongside provider affordances:

- `slop_query_state`
- `slop_focus_state`

These are consumer controls, not provider capabilities.

They preserve the distinction between:

- **observing state**
- **acting on state**

### 3. Built-ins are in-process providers

The terminal and filesystem are hosted as real SLOP providers through the SDK server implementation.

This keeps the architecture honest from day one.

### 4. Shallow-by-default subscriptions

The runtime keeps a shallow overview subscription per provider and deepens only where needed.

This is better aligned with the SLOP scaling model than root `depth=-1` subscriptions.

### 5. State is injected as an ephemeral runtime snapshot

The system prompt stays stable.

The current state snapshot is rebuilt per turn and appended as ephemeral runtime context, not persisted as if it were user-authored conversation.

### 6. Interfaces should use the same public session boundary

The first richer UI should not import the runtime through a privileged path just because it lives in the same repository.

Instead:

- the runtime exposes a session boundary
- first-party UIs consume that boundary
- third-party UIs consume that same boundary

This keeps custom interfaces first-class and makes cross-language clients realistic.

### 7. A non-TypeScript UI client is acceptable

The core runtime remains TypeScript for now.

However, once the session boundary exists, the first TUI does not need to be written in TypeScript. A Go + Bubble Tea client is a strong option because it validates the Go SLOP SDK without forcing a full core runtime port.

---

## What we reuse from OpenClaw and Hermes

### Reuse from OpenClaw

- aggressive tool-result size control
- careful separation between runtime, config, and model glue
- respect for long-running operations and partial failure

### Reuse from Hermes

- a clean tool-use loop shape
- future skill and memory concepts
- practical session persistence ideas for later phases

### What changes fundamentally

- no flat core tool catalog
- no MCP-first plugin center
- no requirement to reconstruct state via read tools

The provider state tree becomes the primary capability surface.

---

## Next interface phase

### Deliverables

- agent-session provider or equivalent public bridge
- session state model for transcript, tool activity, approvals, and multimodal content references
- support for multiple concurrent UI consumers
- first richer UI under `apps/tui/`

### Success criteria

- the runtime can be driven without importing private `Agent` internals
- two clients can observe the same session and stay in sync through patches
- a non-TypeScript UI client can talk to the session boundary without special-case glue

---

## Phase 1 scope

### A. Core runtime

Deliverables:

- `Agent` orchestration class
- history manager
- context builder
- provider-native LLM adapter layer
- CLI entrypoint

Success criteria:

- `bun run src/cli.ts "list the files in the current workspace"` works
- `bun run src/cli.ts` enters REPL mode
- model responses stream while tool calls execute through the runtime loop

### B. SLOP consumer layer

Deliverables:

- multi-provider consumer hub
- overview and focus subscriptions
- invoke/query routing
- live-watched descriptor-based provider discovery

Success criteria:

- built-in providers connect immediately
- external Unix socket and WebSocket descriptors are discovered at startup and reconciled live when descriptor files change
- the runtime can focus a subtree with `slop_focus_state`

### C. Built-in providers

Deliverables:

- stateful terminal provider
- stateful filesystem provider
- stateful memory provider
- discoverable skills provider
- browser/web provider pair
- cron scheduler provider
- messaging provider
- delegation provider
- spec provider
- vision provider
- in-process transport bridge

Success criteria:

- the agent sees directory state instead of blind file tools
- the agent sees command history and async task state instead of blind shell execution only
- the agent can inspect and act on memory/skills/browser/web/cron/messaging/delegation/spec/vision state through the same provider boundary
- state changes are reflected back through new snapshots/patches

### D. Test slice

Deliverables:

- transport test
- runtime tool generation test
- filesystem provider integration test
- terminal provider integration test
- integration coverage for memory, skills, browser, web, cron, messaging, delegation, and vision providers

Success criteria:

- `bun run test` passes locally without hitting any external LLM provider

---

## Commands

```sh
bun install
bun run typecheck
bun run build
bun run lint
bun run test
```

Current single-test commands:

```sh
bun test
bun test tests/filesystem-provider.test.ts
bun test tests/filesystem-provider.test.ts --test-name-pattern "writes files"
```

---

## Dependencies

### Runtime

- `bun`
- `@slop-ai/core`
- `@slop-ai/consumer`
- `@slop-ai/server`
- `@anthropic-ai/sdk`
- `@google/genai`
- `openai`
- `yaml`
- `zod`

### Development

- `typescript`
- `bun test`
- `@biomejs/biome`
- `@types/node`

The SDK dependencies are installed from npm, not linked from the local SLOP workspace.

---

## Immediate next steps

After the current implementation, the most important follow-ups are:

1. keep hardening the agent-session provider boundary as the public interface surface
2. build the first `apps/tui/` client against that public boundary
3. harden adapter compatibility coverage across Anthropic, OpenAI-compatible providers, and Gemini
4. broaden ACP adapter coverage and replace simulated Phase 2 providers with real external integrations where appropriate
5. improve approval and policy enforcement for dangerous affordances
6. add SQLite-backed history and search

---

## Non-goals for MVP

- MCP compatibility as a primary abstraction
- a large plugin system
- browser extension support
- learning loops, RL, or training infrastructure

Those may come later, but they should be built on top of the SLOP-first core rather than replacing it.
