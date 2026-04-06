# Language Evaluation

## Candidates

We have SLOP SDKs in four languages. Evaluation for the agent harness MVP.

---

### TypeScript — **SELECTED**

**Pros:**
- Most mature SDK: `@slop-ai/core` (engine), `@slop-ai/client` (browser), `@slop-ai/server` (Node), plus React/Vue/Solid/Svelte/Angular adapters, TanStack Start integration
- Best LLM API ecosystem: official Anthropic SDK, OpenAI SDK, Vercel AI SDK
- Native async/await — no bridging hacks
- Bun runtime: fast startup, native file/subprocess/WebSocket APIs, built-in test runner
- Both OpenClaw and Hermes (gateway) validate TypeScript for agent harnesses
- Largest AI developer audience
- Can `import` from `@slop-ai/core` directly — shared types, tree utilities, diffing
- The SLOP SDK is published on npm, so the harness can consume stable packages instead of local workspace links

**Cons:**
- Not a single binary (needs Bun/Node runtime)
- Memory usage higher than Go/Rust for long-running processes

**Verdict:** Best balance of ecosystem maturity, development speed, and SDK reuse. Clear winner for MVP.

---

### Go

**Pros:**
- Solid SDK: server, handler pattern (http.Handler-like), multi-transport, discovery
- Single binary distribution — no runtime dependency
- Excellent concurrency model (goroutines)
- Fast, low memory footprint
- `go-openai` library is solid

**Cons:**
- No official Anthropic Go SDK (community wrappers exist but lag behind)
- Smaller AI tooling ecosystem
- More boilerplate for JSON handling, generics still limited
- SDK doesn't have reactive descriptor functions (Go isn't reactive)

**Verdict:** Best second target. Once the runtime exposes a stable public session boundary, Go is also a strong candidate for a standalone TUI client. Longer term, the core runtime could still be ported to Go for single-binary distribution.

---

### Rust

**Pros:**
- Fastest possible runtime, lowest memory
- Type system catches bugs at compile time
- SDK exists: server, transport adapters (Axum, Unix socket)

**Cons:**
- No official LLM SDKs (would need raw HTTP or community crates)
- Slowest development iteration cycle
- Compile times hurt rapid prototyping
- SDK is earliest stage of the four
- Overkill for an agent harness — the bottleneck is LLM latency, not CPU

**Verdict:** Too much friction for MVP. The performance gain doesn't matter when you're waiting 2-30 seconds for LLM responses. Consider for embedded/edge deployment later.

---

### Python

**Pros:**
- Decorator-based SDK is ergonomic
- Best LLM library ecosystem alongside TypeScript
- Hermes Agent proves Python works for agent harnesses

**Cons:**
- Async is painful (Hermes has 100+ lines of event loop bridging hacks)
- Hermes's `run_agent.py` is 9,171 lines — Python encourages monoliths
- User preference: "don't like it"
- Type checking is opt-in and often ignored
- Dependency management fragmented (pip, poetry, uv, conda)

**Verdict:** Skip. TypeScript has equivalent ecosystem strengths without the async pain.

---

## Decision Matrix

| Factor | TypeScript | Go | Rust | Python |
|---|:---:|:---:|:---:|:---:|
| SDK maturity | 5 | 4 | 2 | 3 |
| LLM ecosystem | 5 | 3 | 1 | 5 |
| Async model | 5 | 5 | 4 | 2 |
| Dev speed | 5 | 3 | 1 | 4 |
| Distribution | 3 | 5 | 5 | 2 |
| User preference | 4 | 4 | 3 | 1 |
| **Total** | **27** | **24** | **16** | **17** |

## Roadmap

1. **MVP core:** TypeScript + Bun, with published npm SLOP SDK packages
2. **Next interface phase:** keep the core in TypeScript, expose a public session bridge or provider, and allow UI clients in other languages
3. **First richer UI:** a Go + Bubble Tea `apps/tui/` client is a good candidate to validate the Go SDK without rewriting the core
4. **v1 core distribution:** still TypeScript, potentially compiled with `bun build --compile`
5. **v2 (if needed):** Go port for lightweight or embedded core-runtime distribution
