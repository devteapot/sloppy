# Sloppy — SLOP-native Agent Harness

## What is this

Sloppy is an AI agent runtime built on the SLOP protocol. The agent observes application state via SLOP state trees and invokes contextual affordances — no flat tool registries, no MCP.

Named after the SLOP protocol's owl mascot.

## Tech stack

- **Language:** TypeScript
- **Runtime:** Bun
- **Package manager:** Bun
- **LLM:** Anthropic, OpenAI-compatible, and Gemini adapters
- **Protocol:** SLOP — spec lives in `~/dev/slop-slop-slop/spec/`

## Project structure

```
docs/           — Current architecture docs plus archive/future/research folders
src/            — Source code (TypeScript)
  core/         — Agent loop, SLOP consumer, context builder
  providers/    — Provider registry + built-in providers
  llm/          — LLM provider adapters
```

## Conventions

- Use `bun` for all package management and scripts, not npm/yarn
- Built-in tools are implemented as SLOP providers (state tree + affordances), not special-cased
- Keep the core small — capabilities come from providers
- Files in `src/core/` over 400 lines need a top-of-file comment explaining why they aren't split. Capability-specific logic belongs in `src/providers/` or `src/runtime/`.
- The SLOP SDK packages live in `~/dev/slop-slop-slop/packages/typescript/`

## Key docs

- `docs/README.md` — Documentation map and current/archive split
- `docs/research/prior-art.md` — Analysis of OpenClaw and Hermes Agent
- `docs/02-architecture.md` — System design and component breakdown
- `docs/03-mvp-plan.md` — Phased implementation plan
- `docs/04-slop-protocol-reference.md` — Agent-relevant protocol summary
- `docs/05-language-evaluation.md` — Why TypeScript
- `docs/13-meta-runtime.md` — Optional meta-runtime provider and skill-led self-evolution boundary
- `docs/16-tui-plan.md` — TypeScript/OpenTUI TUI plan
- `docs/archive/session-provider-phase-2-plan.md` — Archived Phase 2 session-provider sketch
- `docs/ui-design-system.md` — UI design system ("Nocturnal Observer")
