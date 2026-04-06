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
- provider-native LLM adapter layer with:
  - native Anthropic/Claude support
  - OpenAI-compatible support for OpenAI, OpenRouter, and Ollama
  - native Gemini support
- consumer hub for built-in and live-discovered SLOP providers
- two built-in in-process providers:
  - `terminal`
  - `filesystem`
- fixed observation tools:
  - `slop_query_state`
  - `slop_focus_state`
- dynamic affordance tools generated from visible SLOP state
- CLI single-shot mode and interactive REPL
- initial `src/session/` scaffold for a headless agent-session provider
- idle session startup without an API key
- persisted LLM profile metadata plus secure API-key storage on macOS and Linux
- env-loaded provider keys exposed as selectable LLM profiles instead of silently overriding the active choice
- session-provider LLM/profile onboarding and management state
- Go + Bubble Tea TUI onboarding/settings flow under `apps/tui/`
- initial end-to-end tests for transport and built-in providers

## Interface direction

The current CLI is the first development surface, not the long-term public interface boundary.

Near-term direction:

- keep the core runtime headless
- add richer interfaces under `apps/`, starting with `apps/tui/`
- expose the running agent session through a public bridge or provider surface
- have first-party and third-party UIs use that same public contract
- allow multiple UIs to attach to the same session concurrently

This means the agent process is expected to act both as:

- a **consumer** of workspace and application providers
- a **provider** of agent-session state to UIs and other clients

## Architecture at a glance

```text
LLM adapter (Anthropic/OpenAI-compatible/Gemini)
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
  - live-discovered SLOP providers
  - overview/detail subscriptions
        |
        v
SLOP providers
```

The important detail is that provider-native tool calling is only the LLM adapter layer.

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

Run the CLI with the default Anthropic config:

```sh
export ANTHROPIC_API_KEY=...
bun run src/cli.ts "list the files in the current workspace"
```

Interactive mode with the default Anthropic config:

```sh
export ANTHROPIC_API_KEY=...
bun run src/cli.ts
```

Run the session provider surface:

```sh
bun run session:serve
```

If no ready model profile is configured, the session still starts and waits for a UI to attach.

Run the Go TUI against a running session provider:

```sh
cd apps/tui
go run .
```

## Config

Sloppy reads configuration from:

- `~/.sloppy/config.yaml`
- `.sloppy/config.yaml` in the current workspace

The local workspace config overrides the home config.

LLM settings are configured under `llm`.

Example:

```yaml
llm:
  provider: openai
  model: gpt-5.4
  defaultProfileId: openai-main
  profiles:
    - id: openai-main
      label: OpenAI Main
      provider: openai
      model: gpt-5.4
tui:
  keybinds:
    leader: ctrl+x
```

Provider defaults:

- `anthropic` -> `ANTHROPIC_API_KEY`
- `openai` -> `OPENAI_API_KEY`
- `openrouter` -> `OPENROUTER_API_KEY` and `https://openrouter.ai/api/v1`
- `gemini` -> `GEMINI_API_KEY`
- `ollama` -> `http://localhost:11434/v1` and no API key by default

You can override the provider, model, or base URL with `SLOPPY_LLM_PROVIDER`, `SLOPPY_MODEL`, and `SLOPPY_LLM_BASE_URL`.

Managed profile metadata is stored in `~/.sloppy/config.yaml`.

API keys are not written to YAML:

- macOS stores them in Keychain
- Linux stores them in Secret Service via `secret-tool`
- environment variables still work, but they are surfaced in the LLM profile manager as separate env-backed profiles
- selecting a managed profile keeps using its stored key; env-backed profiles are an explicit choice instead of an implicit override

The current TUI uses the session provider's `/llm` state to onboard and manage those profiles.

TUI-specific settings are configured under `tui`.

- `tui.keybinds.leader` sets the leader sequence for TUI actions. The default is `ctrl+x`.
- The TUI settings screen currently exposes only the leader key and writes changes back to `~/.sloppy/config.yaml`.
- The composer stays immediately editable when focused; non-composer form fields enter edit mode with `enter`.

## Design references

- `docs/02-architecture.md` for the current runtime design
- `docs/03-mvp-plan.md` for the implementation plan and near-term roadmap
- `docs/04-slop-protocol-reference.md` for the local protocol summary
- `docs/05-language-evaluation.md` for language/runtime choices
- `docs/06-agent-session-provider.md` for the concrete public UI/session provider shape
- `~/dev/slop-slop-slop/spec/` for the full SLOP protocol spec

## License

MIT
