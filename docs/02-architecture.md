# Architecture

## Design principles

1. **State is primary.** The runtime observes state trees first and invokes affordances second.
2. **Everything is a provider.** Built-in capabilities and external applications both enter the system through SLOP providers.
3. **Tool use is only an adapter.** Provider-native tool calling is the LLM-facing execution format, not the architectural model.
4. **Subscriptions beat polling.** The harness should stay on live state through `snapshot` + `patch`, then deepen only where needed.
5. **Thin core, fat providers.** The runtime coordinates history, subscriptions, and model calls; capability-specific logic lives in providers.

---

## Runtime overview

```text
LLM adapter (Anthropic/OpenAI-compatible/Gemini)
        |
        v
RuntimeToolSet
  - slop_query_state
  - slop_focus_state
  - dynamic affordance tools from visible state
        |
        v
Agent Loop
  - history
  - context building
  - tool execution
        |
        v
ConsumerHub
  - provider connections
  - overview subscriptions
  - detail subscriptions
  - invoke/query routing
        |
        v
Providers
  - built-in in-process providers
  - external unix/websocket providers
```

The key difference from a traditional tool harness is that the runtime does not start from a registry of global tools.

It starts from a set of subscribed state trees.

---

## Core components

### 1. Agent loop

`src/core/loop.ts`

Responsibilities:

- build the current visible state context
- expose fixed observation tools plus dynamic affordance tools
- call the model
- execute tool calls
- append tool results to history
- continue until the model ends the turn naturally

This loop is intentionally small. It should feel closer to Hermes's clean orchestration layer than OpenClaw's deeply integrated runtime stack.

### 2. Consumer hub

`src/core/consumer.ts`

Responsibilities:

- connect to all registered providers
- maintain one `SlopConsumer` per provider
- keep a shallow overview subscription per provider
- optionally keep one deeper focused subscription per provider
- route `query` and `invoke` calls
- expose the merged visible state to the rest of the runtime

This is the architectural center of Sloppy. It replaces the plugin/tool registry layer that dominates MCP-first runtimes.

### 3. Runtime tool set

`src/core/tools.ts`

The runtime exposes two kinds of tools to the selected model:

1. **Fixed observation tools**
   - `slop_query_state`
   - `slop_focus_state`
2. **Dynamic affordance tools**
   - generated from the currently visible provider state using `affordancesToTools()`

This is important.

The LLM still uses native tool calling, but the runtime preserves the SLOP distinction between:

- observation by the consumer
- action by the provider

### 4. Context builder

`src/core/context.ts`

Responsibilities:

- render visible provider trees with `formatTree()`
- shrink state using depth, node-budget, and salience heuristics
- keep the system prompt stable and place live state in an ephemeral runtime snapshot message

The state snapshot is not persisted as user-authored conversation. It is rebuilt for each model turn.

### 5. History manager

`src/core/history.ts`

Responsibilities:

- keep the recent real user turns
- preserve assistant/tool-result bundles inside those turns
- truncate oversized tool results before they poison the context window

OpenClaw's tool-result compaction discipline is the right influence here, but the initial implementation is intentionally smaller.

### 6. Provider registry and discovery

`src/providers/registry.ts`
`src/providers/discovery.ts`

Responsibilities:

- create built-in providers
- discover external SLOP providers from descriptor files
- watch descriptor directories and reconcile external providers live
- attach the right transport per provider

The current implementation supports:

- built-in in-process providers
- external Unix socket providers
- external WebSocket providers

---

## Subscription strategy

The harness uses a two-level default subscription model.

### Overview subscription

Each connected provider gets a shallow root subscription.

Purpose:

- provider presence
- top-level context
- visible affordances on important roots
- patch-driven updates without loading the full app

### Detail subscription

The model can move a provider into deeper focus via `slop_focus_state`.

Purpose:

- drill into one subtree that matters right now
- carry that deeper state into future turns
- avoid global `depth=-1` subscriptions

### One-off query

`slop_query_state` performs a deeper read without changing the maintained focus.

This follows the scaling guidance in the SLOP spec rather than the usual “subscribe to everything and hope it fits” approach.

---

## Built-in provider shapes

### Terminal provider

The terminal provider is stateful.

It exposes:

- `session` context node
- `history` collection
- `tasks` collection

Example shape:

```text
[root] terminal: Terminal
  [context] session (cwd="/repo", shell="/bin/zsh")  actions: {execute(...), cd(path: string)}
  [collection] history
    [item] cmd-1 (command="printf hello", status="ok")  actions: {show_output}
  [collection] tasks
    [item] task-123 (status="running", message="Running")  actions: {cancel, show_output}
```

Long-running commands are represented as async task nodes under `tasks`.

### Filesystem provider

The filesystem provider is also stateful.

It exposes:

- `workspace` collection with a focused directory
- `search` collection for the last search results
- `recent` collection for recent filesystem operations

Example shape:

```text
[root] filesystem: Filesystem
  [collection] workspace (focus="src")  actions: {set_focus(path), read(path), write(path, content), mkdir(path), search(pattern, path)}
    [collection] entries
      [item] index.ts  actions: {read, write(content)}
      [item] components  actions: {focus}
  [collection] search
  [collection] recent
```

This keeps directory listings and search results visible as state, rather than forcing the model to rediscover them through imperative read tools.

---

## Why native provider tool use

Sloppy does not use a custom XML or JSON action parser.

Instead:

- visible affordances are converted to provider-native tool definitions
- fixed observation tools are added alongside them
- Anthropic emits `tool_use`, OpenAI-compatible providers emit tool calls, and Gemini emits `functionCall`
- the runtime maps tool names back to `{ provider, path, action }`

This resolves two early design questions:

1. We do not need a custom action syntax.
2. Affordance-to-tool mapping stays dynamic and state-driven.

---

## Influences: reuse vs replace

### Reuse from OpenClaw

- tool-result truncation discipline
- strong runtime boundaries between config, model adapter, and execution loop
- cautious handling of long-running operations and partial failure

### Reuse from Hermes

- clean agent loop orchestration
- skills and memory as future layers, not Phase 1 blockers
- practical session persistence ideas for later SQLite-backed history/search

### Replace from both

- flat tool catalogs
- MCP as the primary capability model
- plugin registries as the central abstraction
- read tools as the main way the model reconstructs application state

The central replacement is simple:

**tool registry → consumer hub + provider state**

---

## Current tradeoffs

- The adapter layer supports native Anthropic and Gemini integrations plus an OpenAI-compatible path for OpenAI, OpenRouter, and Ollama.
- The initial history strategy is bounded and truncated, not yet summarized by a compaction model call.
- Provider discovery is live watched and fully reconciles descriptor add, update, and remove events, but unsupported transports are still skipped.
- The published SLOP npm packages are used directly, but the harness currently relies on the browser-safe consumer entrypoint because the top-level consumer package export is not usable as-is.

These are acceptable Phase 1 tradeoffs. None of them alter the core SLOP-first design.
