# Prior Art Analysis

Evaluation of existing agent harnesses and how SLOP changes the architecture.

## May 2026 Market Update

This refresh looked at current docs and source-level PRs for Codex CLI,
OpenCode, Hermes Agent, OpenClaw, Pi TUI, MCP, Claude Code, and A2A.

### What to Copy

- **Codex `/goal`**: persisted objective state, explicit pause/resume/clear
  controls, usage accounting, and runtime-owned continuation are the right
  shape for long-running work. Sloppy should keep the state in the public
  session provider and keep strategy out of core. Source: OpenAI Codex PRs
  `#18073`, `#18076`, `#18077`, `#20082`.
- **OpenCode config layering**: global, project, `.opencode` directory, env,
  and managed config precedence is the right model for future
  workspace/project scopes. Sloppy already has home plus workspace config; the
  next step is first-class workspace/project records that select scoped config
  layers rather than ad hoc cwd-only behavior. Source:
  <https://opencode.ai/docs/config/>.
- **OpenCode TUI controls**: configurable keybinds, command palette, sessions,
  themes, mouse toggle, and external editor handoff are worth copying. Sloppy
  should keep function-key navigation only as a fallback and move toward a
  command registry over hardcoded shortcuts. Source:
  <https://opencode.ai/docs/tui/>.
- **Hermes learning loop**: progressive skills, session search, memory, and
  skill curation are the correct self-evolution unit. Sloppy should continue to
  make reusable behavior a skill over provider state, not a provider policy.
  Source: <https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/>.
- **Hermes native MCP skill**: MCP compatibility is valuable, but it should be
  a compatibility provider/skill that projects MCP tools/resources/prompts into
  SLOP state and affordances. It should not turn Sloppy into an MCP-first tool
  catalog. Source:
  <https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/mcp/mcp-native-mcp>.
- **Pi TUI discipline**: line-width invariants, bracketed paste handling,
  autocomplete, and virtual terminal tests are important quality bars for a
  serious terminal UI. Source:
  <https://github.com/badlogic/pi-mono/tree/main/packages/tui>.
- **Claude Code custom commands/subagents/permissions**: markdown command
  files, scoped subagent tool access, and permission rules are proven UX. In
  Sloppy these map to skills, meta-runtime profiles/capability masks, and
  provider-level approval policy. Sources:
  <https://docs.claude.com/en/docs/claude-code/slash-commands> and
  <https://docs.claude.com/en/docs/claude-code/subagents>.

### Where to Diverge

- **Do not copy flat tool catalogs.** MCP tools and Claude/OpenCode tool lists
  should be projected as stateful SLOP providers so the model sees state plus
  contextual affordances.
- **Do not put planner policy in the runtime.** `/goal` belongs in session
  lifecycle state, but scoring, completion evidence, repair loops, and
  topology optimization belong in skills over `meta-runtime`, `spec`, memory,
  and activity state.
- **Treat A2A as an external interoperability reference, not the internal
  architecture.** A2A's Agent Card, task lifecycle, messages, artifacts, and
  streaming/push delivery model are useful for boundary adapters. Internally
  Sloppy already has state trees, affordances, channels, delegated session
  providers, and meta-runtime routes. The current A2A 1.0 spec makes
  `supportedInterfaces`, JSON-RPC/gRPC/HTTP+JSON bindings, `A2A-Version`
  negotiation, and task history/artifact separation explicit. Source:
  <https://a2a-protocol.org/dev/specification/>.
- **Treat MCP as compatibility.** The official TypeScript SDK supports Bun and
  exposes clients for stdio and Streamable HTTP; Sloppy should use that for an
  MCP compatibility provider. Source:
  <https://github.com/modelcontextprotocol/typescript-sdk>.

### Current Product Direction

1. Add `/goal` to the public session provider first. It gives Sloppy a
   long-running task loop without introducing a scheduler or DAG.
2. Add an MCP compatibility provider next. It should expose configured MCP
   servers as SLOP state with tool/prompt/resource affordances, approvals, and
   health state.
3. Add first-class workspaces/projects after that. A workspace/project should
   be selectable session state with a linked folder and scoped config layers,
   not a special-case filesystem cwd.
4. Add A2A as an external-provider bridge for opaque agent collaboration.
   Prefer SLOP-native routes internally so state observation remains primary.

Current implementation status in this branch:

- `/goal` is implemented in the public session provider, runtime continuation
  loop, and TUI command/status surfaces.
- MCP compatibility is implemented as an opt-in SLOP provider using the
  official TypeScript SDK for stdio and Streamable HTTP servers.
- Workspace/project scope is implemented as an opt-in provider that exposes
  configured roots and global/workspace/project config layer order.
- A2A interoperability is implemented as an opt-in SLOP provider that fetches
  Agent Cards, projects declared skills, selects JSON-RPC interfaces, sends
  text/data parts through `SendMessage`, and tracks remote tasks through
  `GetTask`, `ListTasks`, and `CancelTask`.

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

## OpenAI Subscription Auth Approaches

The nearby projects split "OpenAI auth" into two very different things:

- normal OpenAI Platform API-key access against `api.openai.com`
- ChatGPT subscription auth for Codex-style models and `chatgpt.com/backend-api/*`

For `sloppy`, that distinction matters. The subscription path is not just another secret string. It has a different token shape, refresh lifecycle, model catalog, and transport behavior.

### Approach Summary

| Project | Shape | Auth ownership | Runtime boundary | Tradeoff |
|---|---|---|---|---|
| T3 Code | Reuse Codex CLI | Codex CLI owns session | `codex login`, `codex app-server` | Least custom auth code, most external dependency |
| OpenCode | Direct OAuth implementation | App owns session | Internal fetch wrapper rewrites to ChatGPT/Codex endpoints | Self-contained, but highest upstream fragility |
| Hermes Agent | Separate `openai-codex` provider | App owns session | Runtime resolves Codex tokens into a Codex-specific base URL | Smallest clean first-party implementation |
| OpenClaw | Separate `openai-codex` provider and transport family | App-owned OAuth with optional Codex CLI reuse | Provider plugin + distinct `openai-codex-responses` transport | Cleanest long-term boundary, most machinery |

### T3 Code

- Treats Codex authentication as something the official `codex` CLI already handles.
- Checks `codex login status` and tells the user to run `codex login` when needed.
- Uses `codex app-server` and `account/read` to probe account state and plan capabilities.

This is the lowest-risk path if the goal is "support whatever Codex CLI supports" rather than "own the login flow ourselves." The downside is that the product now depends on another installed tool, its config layout, its auth lifecycle, and its version compatibility.

### OpenCode

- Implements the OpenAI/Codex auth flow directly.
- Supports browser PKCE with a localhost callback server.
- Supports a headless device-auth flow as a fallback.
- Stores `access`, `refresh`, `expires`, and `accountId` in its own auth store.
- Rewrites model requests to `https://chatgpt.com/backend-api/codex/responses` and injects the OAuth bearer token plus `ChatGPT-Account-Id` when present.

This is the most self-contained UX. It is also the most coupled to current OpenAI auth and endpoint details, so it carries more maintenance risk if upstream behavior shifts.

### Hermes Agent

- Treats Codex as a separate provider: `openai-codex`.
- Uses direct device-code login against OpenAI auth endpoints.
- Stores tokens in Hermes-owned auth state under `~/.hermes/auth.json`.
- Can import `~/.codex/auth.json`, but treats that as compatibility or migration, not the primary session model.
- Refreshes expiring access tokens before runtime use and resolves a Codex-specific base URL.

This is a good "own the auth session, keep the implementation small" model. It avoids depending on the Codex CLI while also avoiding the more involved browser-callback flow as the primary UX.

### OpenClaw

- Also treats Codex as a separate provider: `openai-codex`.
- Gives it a separate transport family, `openai-codex-responses`, rather than hiding it under generic OpenAI-compatible handling.
- Supports first-class OAuth login.
- Supports optional Codex CLI credential reuse.
- Uses provider-owned auth profiles with stable ids derived from email or JWT identity claims.
- Explicitly marks reused external Codex CLI profiles as a compatibility path rather than the preferred long-term credential model.

This is the cleanest architecture of the group. It makes the boundary between normal OpenAI API-key usage and ChatGPT subscription auth explicit in both auth storage and runtime transport selection.

### Sloppy Direction

- add a separate provider such as `openai-codex` rather than overloading `openai`
- store structured OAuth credentials separately from API keys
- resolve a Codex-specific runtime transport rather than forcing it through the plain OpenAI API-key path
- treat Codex CLI reuse as compatibility and bootstrap convenience, not the
  model/session boundary

The checked-in implementation now follows the Hermes/OpenClaw shape at the
runtime boundary: `openai-codex` is a native provider, separate from normal
OpenAI API-key profiles, and sends Responses requests to the Codex backend with
ChatGPT subscription auth. For the first iteration it reuses the official Codex
CLI auth store created by `codex login` instead of implementing Sloppy-owned
device-code or browser OAuth.

That means Sloppy owns the model/tool loop and SLOP affordance projection while
Codex CLI owns only the current login lifecycle. The old subprocess-backed `cli`
provider path has been removed from the runtime so Codex support goes through
native `openai-codex` or an explicit ACP adapter, not an opaque CLI wrapper.

Likely next steps:

- Hermes-style first-party device auth is the smallest coherent way to remove
  the Codex CLI auth-store dependency
- OpenClaw-style provider-owned auth profiles are the better long-term boundary
  once Sloppy needs account selection, migration, or richer subscription status

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
