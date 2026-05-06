# CLI And ACP Child Agents

## Status

ACP-backed and CLI-backed child-session paths are checked in behind the
`delegation` provider. This document replaces the older orchestration-oriented
draft that assumed a parent orchestrator, `/tasks`, and durable task handoff.

Current source areas:

- `src/runtime/acp/`
- `src/runtime/cli/`
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
- CLI child agent through a configured one-shot subprocess adapter

## Delegation Boundary

`delegation.spawn_agent` accepts a goal and optional execution selection. The
runtime creates a child `SessionAgent` implementation:

- native `SessionAgent` for local LLM-backed children
- `AcpSessionAgent` for ACP adapters
- `CliSessionAgent` for CLI adapters

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
          capabilities:
            spawn_allowed: true
            shell_allowed: true
            network_allowed: true
            filesystem_reads_allowed: true
            filesystem_writes_allowed: true
```

CLI adapters use the parallel shape:

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
          timeoutMs: 600000
```

Meta-runtime executor bindings can route an agent to these adapters with
`{ kind: "acp", adapterId: "claude" }` or
`{ kind: "cli", adapterId: "codex" }`.

## Safety

ACP adapters can be more powerful than the child capability mask suggests, so
configured adapters should declare capabilities. Routed or allow-masked ACP
spawns are rejected when the adapter declaration does not satisfy the requested
child surface.

CLI adapters are trusted local subprocesses. They should be configured
deliberately, with sandbox flags where the CLI supports them. Their stdout is
streamed into the child transcript; per-tool-call observability depends on the
CLI's own output format.

## Non-Goals

- no task artifact coupling
- no orchestration-provider handoff
- no parent-owned scheduler
- no automatic workspace merge strategy
- no generic permission parser for arbitrary CLIs

Those concerns can be added later as optional providers or adapter-specific
features without changing the child session boundary.

## Open Questions

- should CLI children get isolated worktrees by default?
- should adapter manifests become discoverable providers instead of config only?
- what is the best UI for child approval forwarding?
- how should spawn-time skill resolution interact with ACP and CLI children?
