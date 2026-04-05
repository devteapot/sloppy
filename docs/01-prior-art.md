# Prior Art Analysis

Evaluation of existing agent harnesses and how SLOP changes the architecture.

## Projects Evaluated

### OpenClaw

**Language:** TypeScript
**Architecture:** Gateway + Pi agent runtime + plugin system + multi-channel messaging

#### Relevant Components

| Component | Location | What it does | Reusable? |
|---|---|---|---|
| Pi agent runtime | `src/agents/pi-embedded-runner/run.ts` | Streaming LLM loop, tool dispatch, history compaction | Pattern only — tightly coupled to Pi's SessionManager |
| Tool catalog | `src/agents/tool-catalog.ts` | Profile-based tool filtering (minimal/coding/full) | Pattern — adapt for SLOP provider capabilities |
| Plugin SDK | `src/plugin-sdk/` | Clean boundary between extensions and core | Pattern — good separation model |
| Config system | `src/config/` | Zod-validated typed configuration | Reuse approach directly |
| Context guard | `src/agents/pi-embedded-runner/tool-result-context-guard.ts` | Token-aware result truncation | Reuse concept |
| MCP integration | `src/agents/mcp-*.ts`, `pi-bundle-mcp-*.ts` | Optional MCP tool discovery via mcporter bridge | Replace entirely with SLOP |
| Gateway protocol | `src/gateway/protocol/` | Custom WebSocket RPC for control plane | Replace with SLOP transport |
| Channel system | `src/gateway/`, extensions/ | Multi-platform messaging (Discord, Telegram, etc.) | Skip — not our scope |

#### Key Takeaways

- **MCP is already optional** — treated as a plugin transport, not core dependency. Good validation that tool discovery can be swapped.
- **Pi agent loop is battle-tested** but monolithic (63KB single file). We want a cleaner decomposition.
- **Plugin SDK boundary** is well-designed — third-party code only imports from `openclaw/plugin-sdk/*`. Worth emulating.
- **Tool profiles** (minimal/coding/messaging/full) map naturally to SLOP provider capability sets.
- **Approval workflows** for dangerous operations — important for production agents, not MVP.

---

### Hermes Agent

**Language:** Python
**Architecture:** Synchronous agent loop + registry-based tools + gateway for messaging platforms

#### Relevant Components

| Component | Location | What it does | Reusable? |
|---|---|---|---|
| Agent loop | `run_agent.py` (~200 lines of essential logic) | Synchronous LLM → tool call → loop | Pattern — clean and minimal |
| Tool registry | `tools/registry.py` | Self-registering tool system, no circular imports | Pattern — SLOP replaces with affordances |
| Tool orchestration | `model_tools.py` | Discovery, dispatch, async bridging | Pattern only |
| Toolset system | `toolsets.py` | Grouping + composition + platform presets | Adapt for built-in provider organization |
| Session state | `hermes_state.py` | SQLite + FTS5 for conversation history | Reuse approach |
| Skill system | `skills/`, `optional-skills/` | Markdown + shell scripts injected into system prompt | Reuse concept directly |
| MCP integration | `tools/mcp_tool.py` | Optional MCP client, graceful degradation | Replace entirely with SLOP |
| Terminal environments | `tools/environments/` | Docker/SSH/Modal/local backend abstraction | Adapt for sandboxed execution |
| Gateway | `gateway/run.py` | Async messaging platform adapters | Skip — not our scope |
| ACP adapter | `acp_adapter/` | IDE integration (VS Code, Zed, JetBrains) | Future consideration |
| CLI | `cli.py`, `hermes_cli/` | TUI with prompt_toolkit + Rich | Pattern — we'll build simpler |

#### Key Takeaways

- **Three-layer tool architecture** (registry → orchestration → implementations) is clean. SLOP collapses the first two layers — affordances replace the registry, state trees replace orchestration.
- **Async bridging is painful in Python** — multiple event loop management hacks, thread-local storage, persistent loops to prevent "Event loop is closed" errors. TypeScript avoids this entirely.
- **Registry-based self-registration** (`tools/*.py` calls `registry.register()` at import time) is elegant. For SLOP, built-in providers self-register the same way.
- **Graceful degradation** — tools gate on availability via `check_fn()`, MCP is optional, agent continues with remaining tools. Same principle applies to SLOP providers.
- **Skill system** is language-agnostic (just markdown) and proven effective. Direct reuse.
- **Session persistence** via SQLite with FTS5 full-text search is well-designed. Worth adopting.

---

## What Both Projects Get Right

1. **Optional MCP** — Neither treats MCP as load-bearing. It's a plugin layer for external tool discovery. This validates our approach of replacing it entirely.
2. **Tool profiles/presets** — Both filter available tools by context. SLOP does this natively via salience and contextual affordances.
3. **Conversation compaction** — Both handle context window overflow by compressing history. Essential for any agent.
4. **Provider abstraction** — Both work with any OpenAI-compatible API. We should too.
5. **Graceful degradation** — Both continue operating when optional capabilities are unavailable.

## What Both Projects Get Wrong (for our purposes)

1. **Flat tool registries** — Every tool is globally available, forcing the LLM to reason about relevance from descriptions alone. SLOP scopes actions to state.
2. **No application state awareness** — The agent can call tools but can't observe the application between calls. SLOP's subscribe/patch model solves this.
3. **Tools are imperative, not contextual** — `delete_todo(id=5)` vs clicking "delete" on a todo node that exposes it. The latter requires no parameter because the context is the node.
4. **Monolithic tool definitions** — Tool schemas are defined once at startup. SLOP affordances are dynamic — they change as state changes.

## The Fundamental Shift

```
Traditional:  Agent → [pick tool from flat list] → [construct params] → [execute] → [hope state changed]
SLOP:         Agent → [observe state tree] → [see available affordances] → [invoke on node] → [receive patches]
```

The agent stops being a tool-calling machine and starts being a state-observing, action-taking entity — much closer to how humans operate software.
