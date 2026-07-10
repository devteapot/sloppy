# TUI Projections

Pure projections from `SessionViewSnapshot` / `SupervisorSnapshot` (and composer input) into render-ready data. No I/O, no component state; mutation lives in `AppUi`.

## Modules

**builtin-commands / slash-catalog**:
`builtin-commands` owns built-in command names, aliases, grammar, parsing, and static palette actions. `slash-catalog` projects those definitions for `/help` and composer autocomplete, merges plugin manifest slash presentations, and provides matching/filtering.
_Avoid_: confusing it with the command palette; the catalog describes commands, it does not decide context-aware availability of session actions.

**palette-items**:
Context-aware Ctrl+K action-menu data (`PaletteCommand[]`) built from static built-in actions plus the live snapshot (approvals, tasks, queue, sessions, plugin actions). Rendered by `ui/command-palette.ts`, the SelectList component — the two files are deliberately distinct layers, not duplicates.

**command-parser / command-types / command-options / secret-detection**:
Composer input → `LocalCommand`. Types, option parsing, and inline-secret rejection are split out so the security-relevant secret detection is independently testable. `/profile-secret` intentionally skips inline-secret detection — it is the sanctioned flow for entering secrets.

## Accepted pattern

View components (`ui/route-overlay.ts`, `ui/status-line.ts`) call these pure functions directly with the snapshot instead of receiving precomputed results from `ui/app.ts`. Threading precomputed arrays through component signatures adds coupling for no behavioral gain.
