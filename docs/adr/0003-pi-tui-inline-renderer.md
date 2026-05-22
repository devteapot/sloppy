# TUI built on pi-tui's inline renderer

The first-party terminal UI (`apps/tui`) is a TypeScript/Bun SLOP consumer that renders through `@earendil-works/pi-tui`, used directly via its `TUI` class. pi-tui renders inline — it does not take the alternate screen — so the agent transcript scrolls into native terminal scrollback and survives session exit, and the append-only transcript needs no virtual-DOM diff. We consume pi-tui as a dependency and customise by subclassing its components (e.g. `CustomEditor extends Editor`); we do not fork it.

## Considered Options

- **Rust + ratatui/crossterm (the Codex model)** — rejected. The SLOP consumer SDK (`@slop-ai/consumer`) is TypeScript-only and the session-provider contract is still evolving; a non-TS UI would mean reimplementing and perpetually re-syncing the consumer. Codex can afford Rust only because its entire runtime is Rust.
- **OpenTUI/Solid (the original `apps/tui`)** — rejected and deleted. OpenTUI's retained full-screen renderer takes the alternate screen, destroying scrollback on exit, and diffs the whole viewport including the append-only transcript. Wrong shape for an agent harness.
- **Forking pi-tui** — rejected. Its components are customisable by subclassing and its themes are callback-based; forking would cut us off from upstream terminal-correctness fixes (Kitty keyboard protocol, image encoders, width handling).

## Consequences

`@opentui/*` and `solid-js` are dropped from the TUI. The TUI depends on pi-tui's release cadence for terminal correctness. pi-tui's inline-rendering claim was spike-verified before adoption (no alternate-screen escape in its source).
