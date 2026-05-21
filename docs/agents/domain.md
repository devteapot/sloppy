# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context-capable**: the SLOP/agent core under `src/` has a checked-in context file now, and standalone applications under `apps/` (`sloppy-voice`, `tui`) may add their own context files as their vocabulary stabilizes.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root - it lists checked-in `CONTEXT.md` files and known app areas. Read each context relevant to the topic.
- The root **`CONTEXT.md`** — vocabulary for the SLOP/agent core (`src/`).
- A per-app **`CONTEXT.md`** under `apps/<app>/`, when present - vocabulary specific to that application.
- **`docs/adr/`** — system-wide architectural decisions. Read ADRs that touch the area you're about to work in.
- **`apps/<app>/docs/adr/`** — app-scoped decisions, when working inside an application.

If an optional per-app context or ADR folder doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The producer skill (`/grill-with-docs`) creates those files lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT-MAP.md                     ← lists checked-in contexts and app areas
├── CONTEXT.md                         ← SLOP/agent core vocabulary
├── docs/adr/                          ← system-wide decisions
├── src/                               ← core: agent loop, providers, LLM adapters
└── apps/
    ├── sloppy-voice/                  ← optional CONTEXT.md and docs/adr/
    └── tui/                           ← optional CONTEXT.md and docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`: the root one for core concepts, and a per-app one when it exists for the application you're working inside. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
