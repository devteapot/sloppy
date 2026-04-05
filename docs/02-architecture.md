# Architecture

## Design Principles

1. **Everything is a SLOP provider** — built-in tools, external apps, and the agent's own state are all SLOP state trees with affordances. No special-casing.
2. **State-first, not tool-first** — the agent observes state and acts on contextual affordances, never picks from a global tool list.
3. **Push, not pull** — providers stream patches to the agent. The agent doesn't poll.
4. **Token-aware by default** — salience filtering, progressive depth, windowed collections, and summaries are used everywhere to respect context window limits.
5. **Thin core, fat providers** — the agent runtime is small. Capabilities come from providers.

---

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                          Sloppy Agent                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     Agent Loop                             │  │
│  │                                                            │  │
│  │  1. Build context from subscribed state trees              │  │
│  │  2. Call LLM with state context + conversation history     │  │
│  │  3. Parse agent response for actions                       │  │
│  │  4. Execute actions (subscribe, invoke, query, respond)    │  │
│  │  5. Receive patches, update state cache                    │  │
│  │  6. Loop until task complete or max iterations             │  │
│  └──────────┬─────────────────────────────────┬───────────────┘  │
│             │                                 │                  │
│  ┌──────────▼──────────┐   ┌──────────────────▼───────────────┐  │
│  │   LLM Provider      │   │   SLOP Consumer                 │  │
│  │                      │   │                                 │  │
│  │  - Anthropic (Claude)│   │  - Multi-provider connections   │  │
│  │  - OpenAI-compat     │   │  - State tree cache             │  │
│  │  - Streaming         │   │  - Patch application            │  │
│  │  - History mgmt      │   │  - Subscription management      │  │
│  └──────────────────────┘   │  - Affordance discovery         │  │
│                             └──────────┬──────────────────────┘  │
│                                        │                         │
│  ┌─────────────────────────────────────▼──────────────────────┐  │
│  │                  Provider Registry                         │  │
│  │                                                            │  │
│  │  Discovered providers (apps, services)                     │  │
│  │  ├── gmail       (WebSocket, auto-discovered)              │  │
│  │  ├── github      (WebSocket, configured)                   │  │
│  │  └── my-app      (Unix socket, auto-discovered)            │  │
│  │                                                            │  │
│  │  Built-in providers (always available)                     │  │
│  │  ├── terminal    (shell execution, process management)     │  │
│  │  ├── filesystem  (file read/write/search/watch)            │  │
│  │  ├── web         (search, fetch, extract)                  │  │
│  │  └── memory      (persistent agent memory)                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Agent Loop (`src/core/loop.ts`)

The central execution cycle. Responsibilities:

- Maintain conversation history (system prompt, user messages, agent responses, action results)
- Build a **state context** from all active subscriptions (token-budget-aware)
- Call the LLM and parse the response for actions
- Dispatch actions to the SLOP consumer
- Detect task completion or iteration limits
- Handle conversation compaction when approaching context limits

The loop does NOT:
- Know about specific providers or tools
- Manage transport connections
- Parse SLOP protocol messages

### 2. SLOP Consumer (`src/core/consumer.ts`)

Manages connections to SLOP providers and maintains a local state cache. Responsibilities:

- Connect to providers via discovered transports (WebSocket, Unix socket, stdio)
- Send subscribe/unsubscribe/query/invoke messages
- Receive and apply snapshots and patches to local cache
- Track subscription versions and handle gap recovery (re-subscribe)
- Expose a unified view of all connected providers' state trees
- Handle provider connect/disconnect lifecycle

The consumer implements the SLOP consumer protocol as defined in the spec:
- `subscribe(path, depth, filters)` → receive `snapshot` then `patch` stream
- `query(path, depth)` → one-shot `snapshot`
- `invoke(path, action, params)` → `result`

### 3. State Context Builder (`src/core/context.ts`)

Translates the consumer's state cache into LLM-consumable context. Responsibilities:

- Serialize state trees to a compact, readable format for the system prompt
- Apply salience filtering (skip nodes below threshold)
- Respect token budgets (progressive depth reduction, stub summaries)
- Highlight changed nodes and urgent items
- List available affordances per node with parameter schemas
- Build a "what can I do" summary across all providers

This is where SLOP's attention/salience system pays off — the context builder uses salience scores to prioritize what the LLM sees.

### 4. LLM Provider (`src/llm/`)

Abstraction over LLM APIs. Responsibilities:

- Stream chat completions from Claude, OpenAI, or compatible APIs
- Handle response parsing (extract text, action blocks)
- Manage token counting for context budget
- Support reasoning/thinking blocks (Claude extended thinking)

Provider-agnostic — any OpenAI-compatible endpoint works.

### 5. Provider Registry (`src/providers/registry.ts`)

Discovers and manages SLOP provider connections. Responsibilities:

- Auto-discover local providers via `~/.slop/providers/` and `/tmp/slop/providers/`
- Accept manually configured provider endpoints
- Register built-in providers
- Track provider health (connected, disconnected, errored)
- Expose unified provider list to the consumer

### 6. Built-in Providers (`src/providers/builtin/`)

Native capabilities exposed as SLOP providers. Each is a full SLOP provider with state tree and affordances:

#### Terminal Provider
```
state tree:
  terminal/
    props: { cwd: "/home/user/project", shell: "zsh" }
    affordances: [execute, cd]
    children:
      processes/
        props: { running: 2 }
        children:
          - pid/1234: { command: "npm run dev", status: "running" }
            affordances: [kill, signal]
```

#### Filesystem Provider
```
state tree:
  filesystem/
    props: { root: "/home/user/project" }
    affordances: [read, write, search, mkdir]
    children:
      watching/
        - src/index.ts: { size: 1240, modified: "2025-01-15T..." }
          affordances: [read, edit, delete]
```

#### Web Provider
```
state tree:
  web/
    affordances: [search, fetch]
    children:
      recent/
        - search/1: { query: "SLOP protocol", results: 10 }
          affordances: [refine]
          children: [result items with open/extract affordances]
```

#### Memory Provider
```
state tree:
  memory/
    props: { entries: 42 }
    affordances: [save, search]
    children:
      - entry/1: { key: "user-preference", value: "..." }
        affordances: [update, delete]
```

---

## Action Format

The agent communicates actions via structured blocks in its response. The exact format is designed for reliable LLM output parsing:

```xml
<slop-action provider="terminal" path="terminal" action="execute">
{"command": "ls -la"}
</slop-action>

<slop-action provider="filesystem" path="filesystem" action="read">
{"path": "src/index.ts"}
</slop-action>

<slop-subscribe provider="github" path="repos/my-repo/pulls/123" depth="2" />

<slop-query provider="gmail" path="inbox" depth="1" min-salience="0.5" />
```

Alternatively, for models that handle JSON better than XML:

```json
{"actions": [
  {"type": "invoke", "provider": "terminal", "path": "terminal", "action": "execute", "params": {"command": "ls -la"}},
  {"type": "subscribe", "provider": "github", "path": "repos/my-repo/pulls/123", "depth": 2}
]}
```

The parser supports both formats. The system prompt instructs the LLM on which to use.

---

## Data Flow

### Happy Path: Agent completes a task

```
User: "Check if there are any open PRs on my-repo and merge the ones with passing checks"

1. Agent loop starts
2. Context builder: no state yet, just the user message
3. LLM response: "I'll subscribe to the GitHub repo's pull requests"
   → <slop-subscribe provider="github" path="repos/my-repo/pulls" depth="2" />

4. Consumer subscribes → receives snapshot:
   pulls/
     children:
       - pr/101: { title: "Fix typo", checks: "passing", mergeable: true }
         affordances: [merge, close, comment]
       - pr/102: { title: "Add feature", checks: "failing", mergeable: false }
         affordances: [close, comment]
       - pr/103: { title: "Update deps", checks: "passing", mergeable: true }
         affordances: [merge, close, comment]

5. Context builder: includes state snapshot in next LLM call
6. LLM response: "PRs 101 and 103 have passing checks. I'll merge them."
   → <slop-action provider="github" path="repos/my-repo/pulls/pr/101" action="merge" />
   → <slop-action provider="github" path="repos/my-repo/pulls/pr/103" action="merge" />

7. Consumer invokes → receives results: { status: "ok" } x2
8. Consumer receives patches: pr/101 and pr/103 state updated to merged
9. LLM response: "Done. Merged PR #101 (Fix typo) and PR #103 (Update deps). PR #102 was skipped — checks are failing."
10. Task complete.
```

### Key Observations

- The agent never needed to know about a `merge_pull_request(owner, repo, number)` tool
- The `merge` affordance only appeared on PRs where it was valid
- PR #102 didn't expose `merge` because checks were failing — the agent didn't need to reason about this
- State patches confirmed the merges succeeded without a separate "get PR status" call

---

## Transport Strategy

The consumer connects to providers using the transport specified in their discovery descriptor:

| Transport | Use case | Discovery |
|---|---|---|
| Unix socket | Local apps, desktop tools | `~/.slop/providers/*.json` |
| WebSocket | Web apps, remote services | Configured endpoints |
| stdio | CLI tools, subprocess providers | Built-in providers, configured commands |
| postMessage | Browser extensions | N/A (browser context only) |

Built-in providers use **in-process** transport — no serialization overhead. They implement the SLOP provider interface directly and the consumer calls them as local objects.

---

## Configuration

```yaml
# ~/.sloppy/config.yaml

llm:
  provider: anthropic       # or openai, openrouter, custom
  model: claude-sonnet-4-20250514
  api_key_env: ANTHROPIC_API_KEY  # read from env var
  max_tokens: 8192

agent:
  max_iterations: 50
  context_budget: 100000    # max tokens for state context
  min_salience: 0.2         # global salience floor
  compaction_threshold: 0.8 # compact history at 80% context usage

providers:
  builtin:
    terminal: true
    filesystem: true
    web: true
    memory: true
  discover: true             # auto-discover local SLOP providers
  endpoints:                 # manually configured providers
    - name: github
      url: ws://localhost:3001/slop
    - name: my-app
      socket: /tmp/slop/providers/my-app.sock

skills:
  directory: ~/.sloppy/skills/
```
