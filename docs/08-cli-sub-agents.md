# CLI-Tool Sub-Agents

## Research: Wrapping Headless Coding CLIs as Sub-Agents

**Date:** 2026-04-23
**Status:** First ACP-backed implementation landed. The generic stdout-parsing
CLI path remains design context; the checked-in v1 uses Agent Client Protocol
at the `SessionAgent` boundary.

---

## 1. The Core Idea

Sloppy currently runs sub-agents via direct LLM API calls (Anthropic, OpenAI, Gemini) through `LlmAdapter` → `Agent` → `SessionRuntime`. This doc proposes a parallel execution mode: **wrap existing headless coding CLIs** (Claude Code, Codex CLI, Pi, potentially others) as sub-agents that the orchestrator delegates to just like any native sub-agent. The first implementation chooses ACP-compatible agents before ad hoc CLI stdout adapters.

The orchestrator doesn't know or care whether the child is a subprocess or a native Agent loop — it observes the same SLOP surface (`/session`, `/turn`, `/transcript`, `/activity`, `/approvals`) and interacts through the same affordances.

**Why:**
- Instant access to best-in-class tooling (Claude Code's edit loop, Codex's sandboxing, Pi's …) without reimplementing it inside sloppy.
- Leverage the user's existing subscription/authentication — the CLI bills against its own session.
- Let an orchestrator compose specialist agents of different vendors for different sub-tasks.

**Why not:**
- Per-tool-call observability is shallower than native — we see stdout, not structured tool events.
- Approval routing is the hard part; CLI tools have their own permission UX.
- Cost/auth boundary is less legible.

---

## 2. Architectural Fit

The seam already exists. `SessionRuntime` takes an `agentFactory` option (see `src/session/runtime.ts:279`) that returns something matching the `SessionAgent` interface (`src/session/runtime.ts:173`):

```ts
export interface SessionAgent {
  start(): Promise<void>;
  chat(userMessage: string): Promise<AgentRunResult>;
  resumeWithToolResult(result: ResolvedApprovalToolResult): Promise<AgentRunResult>;
  invokeProvider(providerId, path, action, params?): Promise<ResultMessage>;
  cancelActiveTurn(): boolean;
  clearPendingApproval(): void;
  updateConfig?(config): void;
  shutdown(): void;
}
```

A subprocess-backed `SessionAgent` implementation is a drop-in replacement. `SubAgentRunner` already constructs `SessionRuntime` and `AgentSessionProvider` from an `agentFactory` option — all that changes is which factory gets wired in. Checked in now: `AcpSessionAgent`, which launches stdio ACP agents and translates ACP session updates and permission requests into the existing SLOP session surface.

### Diagram

```
Orchestrator (sloppy Agent)
   │
   │   observes same SLOP surface
   ▼
┌───────────────────────────────────────────────────┐
│ Parent ConsumerHub                                │
│  ├── delegation      (/agents, /session)          │
│  ├── orchestration   (/tasks, /handoffs)          │
│  ├── filesystem      (CAS, versioned)             │
│  └── sub-agent-{id}  ← AgentSessionProvider       │
│         │                                         │
│         │  wraps SessionRuntime                   │
│         │                                         │
│         ├── NativeSessionAgent  (LlmAdapter)
│         └── AcpSessionAgent     (stdio ACP subprocess) ┘
└───────────────────────────────────────────────────┘
                                   │
                                   ▼
                          spawn: gemini --acp
                                  other configured ACP agents
```

---

## 3. CliSessionAgent Design

A minimal shape:

```ts
interface CliAdapter {
  command: string[];                // e.g. ["claude", "--print", "--output-format", "stream-json"]
  cwd: string;                      // workspace root
  env?: Record<string, string>;
  parseStdoutChunk(chunk: string): CliEvent[];  // text | tool_start | tool_result | done
  buildInput(message: string): string;          // stdin payload
}

class CliSessionAgent implements SessionAgent {
  constructor(
    private adapter: CliAdapter,
    private callbacks: AgentCallbacks,
  ) {}

  async chat(message: string): Promise<AgentRunResult> {
    // spawn subprocess, pipe input, stream output through callbacks.onText / onToolEvent
    // resolve with { status: "completed", response: fullText } on clean exit
    // or { status: "error", ... } on non-zero
  }

  cancelActiveTurn(): boolean {
    // SIGTERM, then SIGKILL after grace period
  }

  // start, resumeWithToolResult, invokeProvider, shutdown ...
}
```

Per-tool adapters live alongside, e.g. `ClaudeCodeAdapter`, `CodexAdapter`, `PiAdapter`. Each handles its tool's specific output format and invocation.

### What flows naturally

| Concern | How it works |
|---|---|
| Streaming text | stdout chunks → `callbacks.onText(chunk)` → appended to transcript, patched to parent |
| Final result | captured assistant text → `SubAgentRunner` writes `tasks/{id}/result.md` |
| Cancellation | `SIGTERM` to child process |
| File edits | child edits workspace directly; filesystem provider drift-detection bumps version on next observation |
| Durable state | `OrchestrationProvider` tracks task progress regardless of execution mode |
| Session observability | parent subscribes to the child's `AgentSessionProvider` — turn transitions visible as patches |

### What needs work

| Concern | Problem | Options |
|---|---|---|
| Approvals | CLI has its own permission UX | (a) run with `--dangerously-skip-permissions` style flags (risky), (b) parse permission prompts from stdout and forward to parent approvals collection (fragile), (c) use the CLI's own MCP/protocol bridge if one exists (e.g. Claude Code's MCP server mode) |
| Per-tool events | we see stdout, not structured `tool_use` blocks | parse stream-json / JSON-lines output where available; fall back to text for plainer CLIs |
| Auth / cost attribution | child bills against its own account | expose in the agent item's props (`execution_mode: "cli:claude-code"`, `cost_source: "user_subscription"`), no code required |
| Resumability | most CLIs don't support mid-turn resume | `resumeWithToolResult` throws for now; parent-level `waiting_approval` doesn't reach child |
| Timeouts | runaway subprocess | per-adapter default + config override; enforce via `AbortSignal` → SIGTERM |

---

## 4. Integration Points

### Spawning

Extend `DelegationProvider.spawnAgent` params (or the `runnerFactory`) with an optional `execution_mode`:

```ts
spawn_agent({
  name: "refactor-auth",
  goal: "consolidate duplicate auth middleware",
  execution_mode: "acp:gemini",        // or "native" (default)
  model: "claude-sonnet-4-6",          // passed through to the CLI
})
```

The registry's real `runnerFactory` (in `src/providers/registry.ts`) picks the appropriate `agentFactory` for the chosen mode when constructing the `SubAgentRunner`. Native stays the default. `execution_mode` is exposed on `/delegation/agents/{id}` for inspectability.

Current native sub-agents already accept the `model` field and expose it in `/agents/{id}`, but the field is metadata only: `SubAgentRunner` still inherits the parent's resolved LLM config. Wiring per-child model selection needs an LLM config/profile overlay before `SessionRuntime` starts the child. CLI-backed agents should pass the same field through to the adapter command once that execution mode lands.

### Configuration

New config block:

```ts
providers.delegation.acp = {
  enabled: true,
  adapters: {
    "gemini": { command: ["gemini", "--acp"], env: {...} },
  },
  defaultTimeoutMs: 600_000,
}
```

Adapters discovered as a **provider manifest** under `~/.slop/providers/` would be even more SLOP-native — each CLI adapter becomes a discoverable provider rather than compiled-in config.

### Filesystem isolation

By default, the CLI runs in the orchestrator's workspace root — edits are visible to the parent via drift detection. Future option: run in a scratch worktree per sub-agent and merge on completion, for isolation.

---

## 5. Approval Routing — Deeper Look

The thorniest integration. Three realistic strategies:

### A. Delegate trust
Run CLI in skip-permissions mode. Parent observes file-level changes via the filesystem provider but doesn't approve individual tool calls. Good for tightly-scoped goals in a sandboxed workspace; dangerous otherwise. **Simplest.**

### B. Prompt parsing
Detect the CLI's permission prompt pattern in stdout, pause input, emit an approval request into the session provider's `/approvals`, resume on decision. Brittle — format changes break it — but zero CLI integration. **Reasonable for a prototype.**

### C. MCP bridge
Run the CLI with an MCP server pointed at a sloppy-provided MCP endpoint. The CLI routes its tool calls through MCP, sloppy proxies them with its own approval flow, returns results. **Cleanest but most work.** Claude Code specifically supports this well; Codex partially; Pi TBD.

Recommendation: ship **A** for a first milestone as opt-in (`trust_child: true`), plan **C** as the durable answer for Claude Code, accept that other CLIs may stay on **A** or **B** indefinitely.

---

## 6. Proposed First Slice

**Implemented v1:** ACP-compatible agents only. Prove the pattern end-to-end before generalizing to ad hoc CLI stdout adapters.

1. `AcpSessionAgent` in `src/runtime/acp/session-agent.ts`.
2. `execution_mode: "acp:<adapterId>"` wired through `spawn_agent`.
3. Optional `providers.delegation.acp.adapters` config for stdio command launch.
4. ACP permission requests mirrored into the child session `/approvals`.
5. Tests cover ACP text streaming, permission approval/resume, and delegation execution-mode state.

Defer: registry auto-discovery, non-ACP stdout adapters, ACP filesystem/terminal client-method proxying through SLOP providers, worktree isolation.

---

## 7. Open Questions

- Should CLI sub-agents share the orchestrator's workspace or always get a worktree? Worktrees isolate but complicate merges and crash recovery.
- Is there value in native + CLI hybrids? (Native orchestrator delegates planning to a Claude Code sub-agent, then directly executes the plan itself.)
- How do we handle CLIs that need interactive auth (device-code flows, browser login)? Pre-requisite: CLI already authenticated on the host.
- Should the `execution_mode` surface on the orchestration `tasks/{id}` props for inspectability?
- What is the right native-sub-agent model override shape: exact model-only override on the parent's provider/base URL, a named managed profile, or a full provider/model/base URL tuple?

---

## 8. Why This Is a Natural Fit

The seams sloppy already built for native sub-agents — pluggable `agentFactory`, `SessionAgent` interface, `SubAgentRunner` federation into the parent hub, `OrchestrationProvider` durable state — were designed around the live + durable duality, not around LLM vs subprocess. Swapping the execution mode is one adapter, not a rewrite. Everything above the `SessionAgent` boundary stays identical.

That property is the real win: **the orchestrator prompt doesn't change** when a sub-agent is a CLI versus a native Agent. The state surface is the contract.
