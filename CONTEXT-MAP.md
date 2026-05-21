# Context Map

This file lists checked-in domain context files for engineering agents. Read the
smallest context set that matches the area you are changing.

## Active Contexts

- `CONTEXT.md` - core SLOP runtime vocabulary for `src/`, first-party providers,
  session runtime, agent loop, and shared protocol language.

## Application Areas

The repo currently has application surfaces under `apps/`, but no checked-in
per-app `CONTEXT.md` files yet. When an app develops its own stable vocabulary,
add `apps/<app>/CONTEXT.md` and list it here.

- `apps/dashboard/` - canvas/HTML dashboard prototype.
- `apps/sloppy-voice/` - native voice app project shell.
- `apps/tui/` - TypeScript/OpenTUI client over public session/supervisor sockets.

## Maintenance

- Keep this map aligned with checked-in `CONTEXT.md` files.
- Do not invent context paths in docs before the files exist.
- If a context file is missing for the area you are changing, use the root
  `CONTEXT.md` plus the relevant architecture docs.
