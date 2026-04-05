# Sloppy

Sloppy is a SLOP-native agent harness.

It is built around the idea that agents should observe application state and invoke contextual affordances, not reason over a flat global tool list.

## Why this exists

Most agent harnesses inherit MCP or function-calling assumptions:

- tools are global
- the model must infer when each tool applies
- state is reconstructed indirectly through read tools or screenshots

Sloppy moves the integration boundary to the SLOP protocol instead:

- providers expose semantic state trees
- affordances appear on the nodes where they are valid
- the consumer subscribes to state and receives patches over time
- the LLM sees state and actions together, in context

This project is explicitly inspired by OpenClaw and Hermes Agent, but it replaces their tool/plugin center of gravity with a SLOP-first runtime.

## Current status

Pre-alpha, but no longer docs-only.

Current Phase 1 implementation includes:

- Bun + TypeScript project scaffold
- Anthropic/Claude adapter using native `tool_use`
- consumer hub for built-in and discovered SLOP providers
- two built-in in-process providers:
  - `terminal`
  - `filesystem`
- fixed observation tools:
  - `slop_query_state`
  - `slop_focus_state`
- dynamic affordance tools generated from visible SLOP state
- CLI single-shot mode and interactive REPL
- initial end-to-end tests for transport and built-in providers

## Architecture at a glance

```text
LLM (Claude tool_use)
        |
        v
RuntimeToolSet
  - fixed observation tools
  - dynamic affordance tools
        |
        v
Agent Loop
  - history
  - state context
  - tool execution
        |
        v
ConsumerHub
  - built-in providers
  - discovered SLOP providers
  - overview/detail subscriptions
        |
        v
SLOP providers
```

The important detail is that `tool_use` is only the LLM adapter layer.

The actual runtime model is still SLOP:

- `query`
- `subscribe`
- `patch`
- `invoke`

## What is implemented now

### Filesystem provider

The filesystem provider is stateful, not just a bag of file actions.

It exposes:

- a focused workspace directory
- directory entries as state
- last search results as state
- recent filesystem operations as state

It supports affordances such as:

- `set_focus`
- `read`
- `write`
- `mkdir`
- `search`

### Terminal provider

The terminal provider exposes:

- current shell session state
- recent command history
- background tasks as status nodes

It supports affordances such as:

- `execute`
- `cd`
- `cancel`
- `show_output`

## Development

Install dependencies:

```sh
bun install
```

Run checks:

```sh
bun run typecheck
bun run build
bun run test
```

Run the CLI:

```sh
export ANTHROPIC_API_KEY=...
bun run src/cli.ts "list the files in the current workspace"
```

Interactive mode:

```sh
export ANTHROPIC_API_KEY=...
bun run src/cli.ts
```

## Config

Sloppy reads configuration from:

- `~/.sloppy/config.yaml`
- `.sloppy/config.yaml` in the current workspace

The local workspace config overrides the home config.

Anthropic credentials are read from the environment variable named by `llm.apiKeyEnv`.

## Design references

- `docs/02-architecture.md` for the current runtime design
- `docs/03-mvp-plan.md` for the implementation plan and near-term roadmap
- `docs/04-slop-protocol-reference.md` for the local protocol summary
- `docs/05-language-evaluation.md` for language/runtime choices
- `~/dev/slop-slop-slop/spec/` for the full SLOP protocol spec

## License

MIT
