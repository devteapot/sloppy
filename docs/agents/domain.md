# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: a SLOP/agent core under `src/`, plus standalone applications built on top of it under `apps/` (`dashboard`, `sloppy-voice`, `tui`).

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- The root **`CONTEXT.md`** — vocabulary for the SLOP/agent core (`src/`).
- The per-app **`CONTEXT.md`** under `apps/<app>/` — vocabulary specific to that application.
- **`docs/adr/`** — system-wide architectural decisions. Read ADRs that touch the area you're about to work in.
- **`apps/<app>/docs/adr/`** — app-scoped decisions, when working inside an application.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT-MAP.md                     ← points at every CONTEXT.md
├── CONTEXT.md                         ← SLOP/agent core vocabulary
├── docs/adr/                          ← system-wide decisions
├── src/                               ← core: agent loop, providers, LLM adapters
└── apps/
    ├── dashboard/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← app-specific decisions
    ├── sloppy-voice/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    └── tui/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md` — the root one for core concepts, the per-app one when working inside an application. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
