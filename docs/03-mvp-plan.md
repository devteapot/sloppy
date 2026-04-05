# MVP Plan

## Goal

A working agent that can:
1. Accept a task from the user via CLI
2. Discover and connect to local SLOP providers
3. Use built-in providers (terminal, filesystem) to accomplish the task
4. Stream responses and show state changes in real-time

## Language

**TypeScript** with **Bun** runtime.

### Rationale

- Most mature SLOP SDK is TypeScript (`@slop-ai/core`, `@slop-ai/client`, `@slop-ai/server` + 5 framework adapters)
- Native async/await — no bridging hacks needed (unlike Python)
- Bun provides fast startup, native file I/O, WebSocket, subprocess APIs
- Both reference projects (OpenClaw, Hermes) validate TypeScript for agent harnesses at scale
- Largest developer audience for AI tooling
- Can reuse `@slop-ai/core` types and tree utilities directly

### Future

Go port for single-binary distribution once architecture is proven. The Go SDK is already solid enough.

---

## Phases

### Phase 1: Core Runtime

**Deliverable:** Agent can execute tasks using built-in terminal and filesystem providers via CLI.

```
src/
├── core/
│   ├── loop.ts              # Agent execution loop
│   ├── consumer.ts          # SLOP consumer (multi-provider)
│   ├── context.ts           # State tree → LLM context builder
│   ├── history.ts           # Conversation history + compaction
│   └── parser.ts            # Parse agent response for actions
├── providers/
│   ├── registry.ts          # Provider discovery + management
│   └── builtin/
│       ├── terminal.ts      # Shell execution provider
│       └── filesystem.ts    # File I/O provider
├── llm/
│   ├── types.ts             # Provider-agnostic types
│   ├── anthropic.ts         # Claude adapter
│   └── openai.ts            # OpenAI-compatible adapter
├── config.ts                # Configuration loading
├── cli.ts                   # REPL entry point
└── index.ts                 # Library entry point
```

#### Tasks

1. **Agent loop** — the core while-loop that calls LLM and dispatches actions
2. **SLOP consumer** — manages connections, applies patches, maintains state cache
3. **Context builder** — serializes state trees for LLM consumption with token budgets
4. **Action parser** — extracts structured actions from LLM responses
5. **Terminal provider** — SLOP provider wrapping shell execution
6. **Filesystem provider** — SLOP provider wrapping file operations
7. **LLM adapters** — Anthropic and OpenAI-compatible streaming
8. **CLI** — simple REPL for interactive use
9. **History management** — conversation persistence and compaction

#### Success Criteria

- `sloppy "list all TypeScript files in this directory"` works
- `sloppy "read package.json and tell me the dependencies"` works
- `sloppy "create a hello world Express server"` works
- Agent uses state observation (sees file listing) rather than blind tool calls
- Context budget is respected — large directories use summaries

---

### Phase 2: External Provider Support

**Deliverable:** Agent can connect to external SLOP-enabled applications.

#### Tasks

1. **Auto-discovery** — scan `~/.slop/providers/` and `/tmp/slop/providers/` for provider descriptors
2. **WebSocket transport** — connect to remote SLOP providers
3. **Unix socket transport** — connect to local SLOP providers
4. **Multi-provider state merge** — unified view across all connected providers
5. **Provider lifecycle** — handle connect/disconnect/reconnect

#### Success Criteria

- Agent discovers a running SLOP-enabled app and subscribes to its state
- Agent can invoke affordances on external providers
- Provider going offline doesn't crash the agent

---

### Phase 3: Intelligence Layer

**Deliverable:** Smarter agent behavior beyond basic loop.

#### Tasks

1. **Web provider** — built-in web search and fetch
2. **Memory provider** — persistent knowledge store with search
3. **Skill system** — markdown-based skill injection (Hermes pattern)
4. **Session persistence** — SQLite conversation history with search
5. **Sub-agent delegation** — spawn child agents for parallel work
6. **Async action tracking** — monitor long-running SLOP tasks

#### Success Criteria

- Agent remembers context across sessions
- Agent can load skills dynamically
- Long-running operations (deploys, builds) are tracked without blocking

---

### Phase 4: Distribution & Polish

**Deliverable:** Installable, documented, usable by others.

#### Tasks

1. **npm package** — `npx sloppy` just works
2. **Configuration wizard** — interactive first-run setup
3. **TUI improvements** — Rich-style output, progress indicators
4. **Documentation** — usage guide, provider authoring guide
5. **Example providers** — reference implementations for common apps

---

## Non-Goals (for MVP)

- Multi-platform messaging (Discord, Telegram, etc.) — that's OpenClaw's domain
- MCP compatibility layer — we're SLOP-native, not a bridge
- Browser extension — future, not MVP
- GUI — CLI-first
- Plugin marketplace — built-in providers + SLOP discovery is sufficient
- RL training environments — future consideration

---

## Dependencies

### Runtime
- `bun` — runtime and package manager
- `@slop-ai/core` — SLOP types, tree utilities, diffing
- `@anthropic-ai/sdk` — Claude API (primary LLM)
- `openai` — OpenAI-compatible fallback

### Development
- `typescript` — type checking
- `vitest` — testing

### Built-in Provider Dependencies
- None for terminal (Bun subprocess APIs)
- None for filesystem (Bun file APIs)
- TBD for web search (likely a search API)

Intentionally minimal. The agent should be installable with a single `bun install`.

---

## Open Questions

1. **Action format:** XML tags vs JSON blocks vs native tool_use? XML is more reliable for parsing from LLM output, but tool_use is natively supported by Claude. Could map affordances → tool_use schemas dynamically.

2. **In-process vs subprocess built-in providers:** In-process is faster (no serialization), but subprocess gives isolation. MVP uses in-process; can add subprocess mode later.

3. **State context format:** How exactly to serialize SLOP state trees for the LLM. Needs experimentation. Options: indented text, YAML-like, JSON, custom compact format.

4. **Provider auth:** How does the agent authenticate with external SLOP providers? The SLOP spec doesn't cover auth. Likely provider-specific (API keys, OAuth tokens in config).

5. **Affordance → tool_use mapping:** Should we map SLOP affordances to Claude's native tool_use format? Pro: better structured output. Con: dynamic tool list changes on every turn (affordances change with state). Need to benchmark reliability.
