# Context Map

This file lists checked-in domain context files for engineering agents. Read the
smallest context set that matches the area you are changing.

## Active Contexts

- `CONTEXT.md` - core SLOP runtime vocabulary for `src/`, first-party providers,
  session runtime, agent loop, and shared protocol language.
- `apps/tui/CONTEXT.md` - first-party terminal UI vocabulary for transcript
  rendering and scrollback-preserving presentation state.

## Application Areas

Application surfaces under `apps/` may have per-app `CONTEXT.md` files when
their own vocabulary stabilizes.

- `apps/sloppy-voice/` - native voice app project shell.
- `apps/tui/` - TypeScript TUI (pi-tui, inline/scrollback-preserving) consuming public session/supervisor sockets.

## Maintenance

- Keep this map aligned with checked-in `CONTEXT.md` files.
- Do not invent context paths in docs before the files exist.
- If a context file is missing for the area you are changing, use the root
  `CONTEXT.md` plus the relevant architecture docs.
