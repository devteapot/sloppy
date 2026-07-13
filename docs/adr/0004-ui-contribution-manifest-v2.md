# UI-agnostic plugin UI contribution manifest

Status: superseded by ADR 0005. This document records the former SLOP-bound
client manifest design.

A Session plugin extends a UI through a declarative manifest (`UiContributionManifest`, field `plugin.ui`, published at `/plugins` with `ui_manifest_version: 2`). The manifest names no rendering technology: it is consumed by any UI (the TUI today, a web UI later), each of which projects the contributions onto its own surfaces. This replaces the earlier TUI-specific `plugin.tui` manifest. A plugin contributes declarative bindings to SLOP state and affordances — never rendering code.

The manifest has four kinds:

- **`subscriptions`** — state paths the UI should subscribe to while the plugin is active.
- **`actions`** — named, discoverable invocations. `invoke` (a SLOP path + affordance) is **mandatory**: an action is always exactly one affordance invocation, optionally carrying a single free-text `argument`.
- **`notifications`** — alerts fired on a state-prop transition; the message is a template interpolated over the matched node.
- **`indicators`** — ambient status segments, declared as a template bound to a path plus a closed set of field formats; the UI interpolates props, with no plugin-specific rendering code and no hardcoded plugin paths.

## Considered Options

- **Keep the TUI-specific v1 manifest** — rejected. `apps/sloppy-voice` already exists as a second surface and a web UI is anticipated; `plugin.tui` and a renderer-name string (`status.renderer`) cannot cross surfaces.
- **Allow unbound commands (an escape hatch for non-affordance actions)** — rejected. Strict mandatory `invoke` keeps `actions` honest. UI navigation (opening overlays) is the UI's own built-in concern, not a plugin contribution — so `/runtime` becomes a TUI built-in and `meta-runtime`'s manifest is empty.
- **Typed atomic indicators (`text`/`badge`/`progress`/`timer`)** — rejected. They cannot express a composite like the goal status segment without forcing the plugin to fragment it. Template-based indicators are composite-capable, fully declarative, and require no hardcoded plugin logic in the UI — satisfying the constraint that the UI carries no plugin-specific rendering.
- **A `views` kind** for rich plugin surfaces — deferred. It had zero genuine producers; it can be added additively later without a version bump.

## Consequences

Only one consumer exists (the TUI, being rewritten), so v1→v2 is a hard cut with no dual-version support. The `ui_manifest_version` field is retained for future additive evolution. UIs must implement a small shared template-interpolation engine and the closed `format` enum.
