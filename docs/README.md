# Documentation Map

This directory is split by whether a document is current operating guidance, future design work, research, or historical context.

## Current Sources

- `../CONTEXT.md` — canonical glossary for the core-runtime domain language.
- `adr/` — architecture decision records (start at `0001`).
- `02-architecture.md` — current SLOP-first runtime architecture.
- `03-mvp-plan.md` — implementation plan and near-term roadmap.
- `04-slop-protocol-reference.md` — local protocol vocabulary and message semantics.
- `05-language-evaluation.md` — stack and runtime decisions.
- `06-agent-session-provider.md` — typed Session API and compact SLOP projection.
- `08-acp-sub-agents.md` — current ACP session-agent and delegation paths.
- `13-meta-runtime.md` — optional topology/evaluation substrate and skill-led self-evolution boundary.
- `16-tui-plan.md` — TypeScript/pi-tui TUI architecture and UX plan.
- `17-operator-runbook.md` — production-style runtime checks, audit, recovery, and operational procedures.
- `18-voice-plugin.md` — streaming speech pipeline (realtime STT dialects, streaming TTS, protocol registry, conversation loop, privacy boundary).
- `ui-design-system.md` — UI design system for first-party surfaces.

## Future Designs

These documents describe intended directions that should not be treated as implemented runtime behavior.

- `future/agent-identity.md` — identity, persona, and memory-tier direction.
- `future/executor-binding.md` — typed executor-binding and routing direction.
- `future/filesystem-view-edits.md` — snapshot-backed line edit direction and
  its relationship to shared anchors.

## Research

- `research/prior-art.md` — OpenClaw, Hermes Agent, and adjacent runtime/auth notes.
- `research/agent-harnesses-and-tui-audit.md` — May 2026 comparison of Hermes Agent, OpenClaw, pi-mono, Claude Code, Factory Droid, OpenCode, and Sloppy, with a detailed current TUI audit.

## Archive

Archived documents are retained for context only. They describe older runtime shapes that have been superseded by the SLOP-native provider model and the skill-led meta-runtime direction.

- `archive/filesystem-as-orchestration-provider.md`
- `archive/orchestration-state-machine.md`
- `archive/orchestration-design.md`
- `archive/memory-tiers.md`
- `archive/session-provider-phase-2-plan.md`
