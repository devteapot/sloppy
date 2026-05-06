# ACP Child Agents

## Status

ACP-backed session-agent paths are checked in. They can run delegated children
behind the `delegation` provider and can also be selected as the main session's
LLM profile. The older subprocess-backed CLI adapter path has been removed.

Current source areas:

- `src/runtime/acp/`
- `src/runtime/delegation/`
- `src/providers/builtin/delegation.ts`
- `src/session/`

## Core Idea

Delegation spawns child sessions that expose the same public session-provider
surface as native Sloppy child agents:

```text
/session
/turn
/transcript
/activity
/approvals
```

The parent observes children through SLOP state and affordances. It does not need
a task DAG or orchestration provider to know that a child is running, blocked,
idle, cancelled, or complete.

Supported execution shapes:

- native child agent through Sloppy's LLM adapters
- ACP child agent through a configured stdio ACP adapter

The same ACP adapter configs are usable from `llm.profiles` with provider
`acp`. In that shape, `adapterId` selects the configured adapter and `model`
remains the selected model identifier exposed through `/llm`.

For ChatGPT/Codex subscription models, `openai-codex` is the native provider.
It reads the Codex CLI auth store created by `codex login` and keeps Sloppy's
own model/tool loop. Codex can also be exposed through a configured ACP adapter
such as `codex-acp` when the desired boundary is an external ACP agent.

## Delegation Boundary

`delegation.spawn_agent` accepts a goal and optional `executor` binding. The
runtime creates a child `SessionAgent` implementation:

- native `SessionAgent` for local LLM-backed children
- `AcpSessionAgent` for ACP adapters

The child session is registered into the parent hub as a provider so the parent
and UIs can subscribe to child state.

## Configuration

ACP adapters live under delegation config:

```yaml
providers:
  builtin:
    delegation: true
  delegation:
    acp:
      enabled: true
      adapters:
        claude:
          command: ["bunx", "@agentclientprotocol/claude-agent-acp"]
          envAllowlist: ["ANTHROPIC_API_KEY"]
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

Meta-runtime executor bindings can route an agent to these adapters with
`{ kind: "acp", adapterId: "claude", modelOverride: "sonnet" }`.
`modelOverride` is optional and is passed to the ACP session agent.

Main-session profile examples:

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
    - id: claude-acp
      label: Claude ACP
      provider: acp
      model: sonnet
      adapterId: claude
```

## Safety

ACP adapters can be more powerful than the child capability mask suggests, so
configured adapters should declare capabilities. Routed or allow-masked ACP
spawns are rejected when the adapter declaration does not satisfy the requested
child surface.

Adapter subprocesses do not inherit the full Sloppy process environment by
default. Sloppy passes a small process allowlist (`PATH`, `HOME`, user/shell/tmp
variables, locale variables) plus explicit adapter `env` entries. Set
`envAllowlist` to add exact environment variable names, or `inheritEnv: true`
only for adapters that intentionally need the whole ambient environment. ACP
prompt timeouts are hard bounds: if an adapter ignores cancel after
`timeoutMs`, Sloppy fails the turn and tears down that adapter process.
Adapters also default to the workspace root as their cwd, and a configured cwd
outside the workspace is rejected unless `allowCwdOutsideWorkspace: true` is set
for a trusted adapter.
`runtime:doctor --acp-adapter <id>` reports a boundary warning when an adapter
inherits the full environment or lacks a capability declaration.

## Non-Goals

- no task artifact coupling
- no orchestration-provider handoff
- no parent-owned scheduler
- no automatic workspace merge strategy

Those concerns can be added later as optional providers or adapter-specific
features without changing the child session boundary.

## Open Questions

- should adapter manifests become discoverable providers instead of config only?
- what is the best UI for child approval forwarding?
- how should spawn-time skill resolution interact with ACP children?
