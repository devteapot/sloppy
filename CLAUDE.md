# Sloppy — SLOP-native Agent Harness

## What is this

Sloppy is an AI agent runtime built on the SLOP protocol. The agent observes application state via SLOP state trees and invokes contextual affordances — no flat tool registries, no MCP.

Named after the SLOP protocol's owl mascot.

## Tech stack

- **Language:** TypeScript
- **Runtime:** Bun
- **Package manager:** Bun
- **LLM:** Claude (primary), OpenAI-compatible (fallback)
- **Protocol:** SLOP — spec lives in `~/dev/slop-slop-slop/spec/`

## Project structure

```
docs/           — Architecture docs, evaluation, MVP plan
src/            — Source code (TypeScript)
  core/         — Agent loop, SLOP consumer, context builder
  providers/    — Provider registry + built-in providers
  llm/          — LLM provider adapters
```

## Conventions

- Use `bun` for all package management and scripts, not npm/yarn
- Built-in tools are implemented as SLOP providers (state tree + affordances), not special-cased
- Keep the core small — capabilities come from providers
- The SLOP SDK packages live in `~/dev/slop-slop-slop/packages/typescript/`

## Key docs

- `docs/01-prior-art.md` — Analysis of OpenClaw and Hermes Agent
- `docs/02-architecture.md` — System design and component breakdown
- `docs/03-mvp-plan.md` — Phased implementation plan
- `docs/04-slop-protocol-reference.md` — Agent-relevant protocol summary
- `docs/05-language-evaluation.md` — Why TypeScript
