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

Current checked-in implementation includes:

- Bun + TypeScript project scaffold
- provider-native LLM adapter layer with:
  - native Anthropic/Claude support
  - OpenAI-compatible support for OpenAI, OpenRouter, and Ollama
  - native OpenAI Codex subscription support through the Codex CLI auth store
  - native Gemini support
- consumer hub for built-in and live-discovered SLOP providers
- built-in in-process providers:
  - `terminal`
  - `filesystem`
  - `memory`
  - `skills`
  - `meta-runtime`
  - `browser`
  - `web`
  - `cron`
  - `messaging`
  - `delegation`
  - `spec`
  - `vision`
- fixed observation tools:
  - `slop_query_state`
  - `slop_focus_state`
- dynamic affordance tools generated from visible SLOP state
- CLI single-shot mode and interactive REPL
- initial `src/session/` scaffold for a headless agent-session provider
- idle session startup without an API key
- persisted LLM profile metadata plus secure API-key storage on macOS and Linux
- env-loaded provider keys exposed as selectable LLM profiles instead of silently overriding the active choice
- ACP and CLI adapter profiles as first-class session model profiles, so a main session can run through a configured external agent such as Codex CLI instead of only native API adapters
- session-provider LLM/profile onboarding and management state
- session-provider `/apps` attachment state for external provider visibility and debugging
- TypeScript/OpenTUI TUI under `apps/tui/` that consumes the public session-provider socket
- canvas + HTML dashboard prototype under `apps/dashboard/`
- optional meta-runtime provider for agent profiles, nodes, channels, typed route envelopes, fanout/canary dispatch, enforced child capability masks, executor bindings, selected skill-version context for routed children, topology experiments/evaluations, proposals, topology pattern records, scoped storage, events, and import/export. Reusable self-evolution strategy lives in skills over this substrate.
- end-to-end tests for transport, consumer/runtime wiring, session state, and all built-in providers

## Interface direction

The current CLI is the first development surface, not the long-term public interface boundary.

Near-term direction:

- keep the core runtime headless
- add richer interfaces under `apps/`, starting with `apps/tui/`
- keep the dashboard prototype read-only until it consumes the public SLOP provider surface directly
- expose the running agent session through a public bridge or provider surface
- have first-party and third-party UIs use that same public contract
- allow multiple UIs to attach to the same session concurrently

This means the agent process is expected to act both as:

- a **consumer** of workspace and application providers
- a **provider** of agent-session state to UIs and other clients

## Architecture at a glance

```text
Session agent profile (native LLM adapter, ACP adapter, or CLI adapter)
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

### Additional built-in providers

The runtime now ships with a broader first-party provider surface beyond terminal and filesystem.

These providers are currently implemented as in-process SLOP providers:

- `memory` for persistent recall-like state, search, compaction, and approval-gated destructive clears
- `skills` for skill-based progressive skill loading (`skill_view`), supporting files, nested `metadata.sloppy`, agent-managed skill edits (`skill_manage`), proposed skill activation, and approval-gated persistent workspace/global writes
- `meta-runtime` for evolving internal agent-to-agent topology through SLOP state, including route dispatch to delegated agents or messaging channels, topology proposals, experiment/evaluation records, per-profile/per-agent skill-version context for routed children, scoped persistence, and child capability-mask enforcement. Runtime architect prompts, repair/triage playbooks, automatic evidence scoring, and reusable topology pattern authoring should be expressed as skills over this state rather than long-term provider policy.
- `browser` for tab state, navigation history, and simulated screenshots
- `web` for search/read operations plus browsed-history state
- `cron` for scheduled jobs and job lifecycle state
- `messaging` for channel/message history and send affordances
- `delegation` for subagent lifecycle state, cancellation, result retrieval, and optional ACP/CLI-backed child execution
- `spec` for active specs, requirements, decisions, and proposed spec changes
- `vision` for simulated image-generation and image-analysis workflows

They follow the same architectural rule as terminal/filesystem: state first, affordances second.

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

### Built-in provider registry

All built-ins are created through `src/providers/registry.ts` and can be enabled or disabled from config under `providers.builtin`.

Provider-specific config now exists for:

- `terminal`
- `filesystem`
- `memory`
- `skills`
- `web`
- `browser`
- `cron`
- `messaging`
- `delegation`
- `vision`

The `spec` provider uses the configured filesystem workspace root and currently
does not require a provider-specific config block.

## Development

Install dependencies:

```sh
bun install
```

Run checks:

```sh
bun run typecheck
bun run tui:typecheck
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

Run the TypeScript/OpenTUI TUI:

```sh
bun run tui
```

By default this starts a managed session provider and attaches to it. To attach
to an existing session provider socket, use:

```sh
bun run tui -- --socket /tmp/slop/sloppy-session-<id>.sock
```

Run the dashboard prototype:

```sh
bun run dashboard:serve
```

The dashboard serves `http://localhost:8787` by default. It is currently a
developer prototype and should move toward consuming the public session/provider
surface directly.

Run the runtime smoke harness:

```sh
bun run runtime:smoke
```

By default this creates a temporary workspace, wires `meta-runtime`, `messaging`,
`delegation`, `skills`, and `filesystem`, applies a session topology proposal,
dispatches a typed route envelope, and verifies that the message lands in a SLOP
channel. Native, ACP, and CLI delegated-child paths can be checked explicitly:

```sh
bun run runtime:smoke -- --mode native
bun run runtime:smoke -- --mode acp --acp-adapter claude
bun run runtime:smoke -- --mode cli --cli-adapter codex
```

Native mode uses the active LLM profile selected by the LLM profile manager
unless `--profile <id>` is provided. For a local OpenAI-compatible router, point
the run at that endpoint with the normal one-shot LLM environment overrides, for
example:

```sh
SLOPPY_LLM_PROVIDER=openai \
SLOPPY_MODEL=<model> \
SLOPPY_LLM_BASE_URL=http://sloppy-mba.local:8001/v1 \
OPENAI_API_KEY=<router-key-or-dummy> \
bun run runtime:smoke -- --mode native
```

Check live runtime dependencies before a smoke run:

```sh
bun run runtime:doctor \
  --litellm-url http://sloppy-mba.local:8001/v1 \
  --acp-adapter claude \
  --cli-adapter codex
```

Use `.sloppy/config.example.yaml` as the local workspace config shape for the
Claude ACP and Codex CLI adapters. Copy those adapter blocks into
`.sloppy/config.yaml` and set the LiteLLM model/base URL for your machine.

If the LiteLLM check fails before HTTP, verify local name resolution first:

```sh
dscacheutil -q host -a name sloppy-mba.local
ping -c 1 sloppy-mba.local
```

If `.local` mDNS is not available from the current host, use the router's direct
IP address in `--litellm-url` and `SLOPPY_LLM_BASE_URL`.

If the ACP check fails for Claude, confirm that the installed command actually
speaks Agent Client Protocol over stdio. `claude mcp ...` is MCP server support,
not ACP agent mode; Zed uses a dedicated adapter, so configure
`providers.delegation.acp.adapters.<id>.command` with an ACP adapter command
such as `["bunx", "@agentclientprotocol/claude-agent-acp"]` or an installed
`claude-agent-acp` binary.

CLI mode runs a configured subprocess-backed child session. It is intended for
tools such as Codex CLI or local custom agents that can complete from one prompt.
Use `{prompt}` and `{model}` placeholders when the subprocess needs the user
prompt or selected model as argv/env/cwd text:

```yaml
providers:
  delegation:
    cli:
      enabled: true
      defaultTimeoutMs: 600000
      adapters:
        codex:
          command: ["codex", "exec", "--model", "{model}", "--ephemeral", "--sandbox", "read-only", "{prompt}"]
```

ACP and CLI adapters are not limited to sub-agents. They can be selected as the
main session model profile through the same `/llm` state used for native API
providers:

```yaml
llm:
  provider: cli
  model: gpt-5.5
  adapterId: codex
  defaultProfileId: codex-gpt55
  profiles:
    - id: codex-gpt55
      label: Codex GPT-5.5
      provider: cli
      model: gpt-5.5
      adapterId: codex
```

For Codex subscription models, prefer the native `openai-codex` provider when
you want Sloppy to keep its own model/tool loop instead of delegating the whole
turn to `codex exec`. It reads the existing Codex CLI auth store, so run
`codex login` first:

```yaml
llm:
  provider: openai-codex
  model: gpt-5.5
  reasoningEffort: low
  defaultProfileId: codex-native
  profiles:
    - id: codex-native
      label: Codex GPT-5.5 Low
      provider: openai-codex
      model: gpt-5.5
      reasoningEffort: low
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
```

Profiles can include `reasoningEffort` (`none`, `minimal`, `low`, `medium`,
`high`, or `xhigh`) for providers that expose OpenAI-style reasoning controls.

Built-in providers default to a lean set: `terminal`, `filesystem`, `memory`, and `skills`. Heavier providers (`web`, `browser`, `cron`, `messaging`, `vision`, `delegation`, `metaRuntime`, `spec`) are opt-in. Enable them in `.sloppy/config.yaml`:

```yaml
providers:
  builtin:
    web: true
    browser: true
    vision: true
    delegation: true
    metaRuntime: true
    spec: true
  skills:
    builtinSkillsDir: skills
    skillsDir: ~/.sloppy/skills
    externalDirs: []
    templateVars: true
    viewMaxBytes: 65536
  metaRuntime:
    globalRoot: ~/.sloppy/meta-runtime
    workspaceRoot: .sloppy/meta-runtime
```

Skills follow the `SKILL.md` directory pattern used by Hermes and agentskills.io:
`SKILL.md` is loaded on demand, while supporting files under `references/`,
`templates/`, or `scripts/` are read with `skill_view(name, file_path)`.
Workspace and global changes made through `skill_manage` require approval.

Delegation can also launch configured Agent Client Protocol agents as child sessions while preserving the same SLOP session surface:

```yaml
providers:
  builtin:
    delegation: true
  delegation:
    acp:
      enabled: true
      adapters:
        gemini:
          command: ["gemini", "--acp"]
          capabilities:
            spawn_allowed: false
            shell_allowed: false
            network_allowed: true
            filesystem_reads_allowed: true
            filesystem_writes_allowed: false
        claude:
          command: ["bunx", "@agentclientprotocol/claude-agent-acp"]
          capabilities:
            spawn_allowed: true
            shell_allowed: true
            network_allowed: true
            filesystem_reads_allowed: true
            filesystem_writes_allowed: true
        codex:
          command: ["codex-acp"]
          capabilities:
            spawn_allowed: true
            shell_allowed: true
            network_allowed: true
            filesystem_reads_allowed: true
            filesystem_writes_allowed: true
```

Then pass an executor such as `{ kind: "acp", adapterId: "gemini" }` to
`delegation.spawn_agent`, or create a meta-runtime executor binding with the
same shape. Omit the executor to use the active session profile. Zed's Codex
adapter is published as `@zed-industries/codex-acp` and exposes the
`codex-acp` binary.
Routed or allow-masked ACP spawns require the adapter `capabilities` block so the
runtime can reject child bindings that exceed the adapter's declared surface.

Delegation can also launch trusted CLI subprocesses as child sessions. The
runtime streams stdout into the child transcript and exposes the result through
the same delegated-agent state:

```yaml
providers:
  builtin:
    delegation: true
  delegation:
    cli:
      enabled: true
      adapters:
        codex:
          command: ["codex", "exec", "--ephemeral", "--sandbox", "read-only"]
```

Then pass `{ kind: "cli", adapterId: "codex", modelOverride: "gpt-5.5" }` to
`delegation.spawn_agent`, or create the same shape as a meta-runtime executor
binding. `modelOverride` is optional; if present it expands `{model}` in the
adapter command.

Provider defaults:

- `anthropic` -> `ANTHROPIC_API_KEY`
- `openai` -> `OPENAI_API_KEY`
- `openrouter` -> `OPENROUTER_API_KEY` and `https://openrouter.ai/api/v1`
- `gemini` -> `GEMINI_API_KEY`
- `ollama` -> `http://localhost:11434/v1` and no API key by default
- `acp` and `cli` -> configured adapter profiles and no API key by default

You can override the provider, model, adapter id, or base URL with
`SLOPPY_LLM_PROVIDER`, `SLOPPY_MODEL`, `SLOPPY_LLM_ADAPTER_ID`, and
`SLOPPY_LLM_BASE_URL`.

The agent loop defaults to 32 model/tool iterations. For longer runs, set
`agent.maxIterations` in config or use `SLOPPY_MAX_ITERATIONS=80` for a one-off
run.

Managed profile metadata is stored in `~/.sloppy/config.yaml`.

API keys are not written to YAML:

- macOS stores them in Keychain
- Linux stores them in Secret Service via `secret-tool`
- environment variables still work, but they are surfaced in the LLM profile manager as separate env-backed profiles
- selecting a managed profile keeps using its stored key; env-backed profiles are an explicit choice instead of an implicit override
- one-shot runs explicitly routed with `SLOPPY_LLM_PROVIDER`, `SLOPPY_MODEL`, `SLOPPY_LLM_ADAPTER_ID`, `SLOPPY_LLM_BASE_URL`, or `SLOPPY_LLM_API_KEY_ENV` rebuild their runtime LLM config from the process env and ignore managed profiles for that run

The current TUI uses the session provider's `/llm` state to onboard and manage
profiles, and its `/apps` state to surface external provider attachment status.

Useful TUI slash commands:

- `/profile openai gpt-5.4 --base-url <url>` saves a profile without a key.
- `/profile-secret openai gpt-5.4` opens masked API-key entry.
- `/profile cli gpt-5.5 --adapter codex` saves an ACP/CLI adapter-backed profile.
- `/default <profile-id>`, `/delete-profile <profile-id>`, and `/delete-key <profile-id>` manage exposed profiles.
- `/query /llm 2` inspects the session provider; `/query <app-id>:/ 2` inspects a connected external provider listed under `/apps`.
- `/invoke [app-id:]<path> <action> <json-object>` invokes a contextual affordance from the explicit inspector path.

The composer stays immediately editable when focused. Pending approvals interrupt
the normal input loop with `[o/a] approve once` and `[d/esc] deny`.

## Design references

- `docs/README.md` for the current documentation map
- `docs/research/prior-art.md` for notes on OpenClaw, Hermes, and nearby auth/runtime approaches
- `docs/02-architecture.md` for the current runtime design
- `docs/03-mvp-plan.md` for the implementation plan and near-term roadmap
- `docs/04-slop-protocol-reference.md` for the local protocol summary
- `docs/05-language-evaluation.md` for language/runtime choices
- `docs/06-agent-session-provider.md` for the concrete public UI/session provider shape
- `docs/13-meta-runtime.md` for the optional topology/evaluation provider and skill-led self-evolution boundary
- `docs/16-tui-plan.md` for the TypeScript/OpenTUI TUI architecture
- `~/dev/slop-slop-slop/spec/` for the full SLOP protocol spec

## License

MIT
