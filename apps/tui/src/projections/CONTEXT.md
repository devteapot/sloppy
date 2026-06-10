# TUI Projections

Pure projections from `SessionViewSnapshot` / `SupervisorSnapshot` (and composer input) into render-ready data. No I/O, no component state; mutation lives in `AppUi`.

## Modules

**slash-catalog**:
Slash-command discovery for `/help` and composer autocomplete — merges built-in entries with plugin manifest slash presentations and provides matching/filtering.
_Avoid_: confusing it with the command palette; the catalog describes commands, it does not decide context-aware availability of session actions.

**palette-items**:
Context-aware Ctrl+K action-menu data (`PaletteCommand[]`) built from the live snapshot (approvals, tasks, queue, sessions, plugin actions). Rendered by `ui/command-palette.ts`, the SelectList component — the two files are deliberately distinct layers, not duplicates.

**command-parser / command-types / command-options / secret-detection**:
Composer input → `LocalCommand`. Types, option parsing, and inline-secret rejection are split out so the security-relevant secret detection is independently testable. `/profile-secret` intentionally skips inline-secret detection — it is the sanctioned flow for entering secrets.

## Accepted pattern

View components (`ui/route-overlay.ts`, `ui/status-line.ts`) call these pure functions directly with the snapshot instead of receiving precomputed results from `ui/app.ts`. Threading precomputed arrays through component signatures adds coupling for no behavioral gain.
