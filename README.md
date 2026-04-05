# Sloppy

A SLOP-first agent harness that operates applications natively through state observation and contextual affordances.

Named after the owl mascot of the [SLOP protocol](https://github.com/agnt-io/slop).

## What is this?

Sloppy is an AI agent runtime built around the SLOP (Semantic Layer for Observable Programs) protocol. Instead of relying on flat tool registries (MCP, function calling), Sloppy agents **observe application state** and **invoke contextual affordances** — the same way a human interacts with software by looking at what's on screen and clicking what's available.

### How it differs from existing agent harnesses

| Traditional (MCP-based) | Sloppy (SLOP-native) |
|---|---|
| Agent gets a flat list of 40+ tools | Agent subscribes to semantic state trees |
| Tools are always available, globally | Affordances appear/disappear based on context |
| Agent must reason about which tool fits | Available actions are scoped to current state |
| No visibility into application state | Full state tree with salience and attention hints |
| Pull-based: list tools, call tool | Push-based: subscribe, receive patches, invoke |

### Example

An MCP agent interacting with a todo app:
```
tools: [create_todo, list_todos, get_todo, update_todo, delete_todo, toggle_todo, ...]
```

A Sloppy agent interacting with the same app:
```
state: todos
  props: { count: 3, incomplete: 1 }
  affordances: [create]
  children:
    - item/1: { title: "Buy milk", done: true }    affordances: [toggle, delete]
    - item/2: { title: "Write docs", done: false }  affordances: [toggle, delete, edit]
    - item/3: { title: "Ship it", done: true }      affordances: [toggle, delete]
```

The agent sees what exists, what matters, and what it can do — right now, in context.

## Architecture

```
┌─────────────────────────────────────────────┐
│                 Sloppy Agent                 │
│                                              │
│  ┌──────────┐    ┌──────────┐               │
│  │ LLM      │◄──►│ Planner  │               │
│  │ Provider  │    │          │               │
│  └──────────┘    └────┬─────┘               │
│                       │                      │
│  ┌────────────────────▼──────────────────┐  │
│  │         SLOP Consumer Core            │  │
│  │                                        │  │
│  │  subscribe() → state tree cache        │  │
│  │  patches    → update cache             │  │
│  │  invoke()   → execute affordance       │  │
│  │  query()    → one-shot read            │  │
│  └────────────────────────────────────────┘  │
│                       │                      │
│  ┌────────────────────▼──────────────────┐  │
│  │        Provider Registry              │  │
│  │                                        │  │
│  │  Local apps (Unix socket discovery)    │  │
│  │  Web apps (WebSocket)                  │  │
│  │  CLI tools (stdio)                     │  │
│  │  Built-in providers (native)           │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │      Built-in SLOP Providers         │   │
│  │  (terminal, filesystem, web, memory)  │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

## Status

**Pre-alpha** — architecture and planning phase.

See [docs/](./docs/) for detailed design documents.

## License

MIT
