# Typed session client protocol

Status: accepted.

## Context

The first session UI treated the session's SLOP provider as its application
API. That made the TUI subscribe to protocol paths, infer action availability
from affordances, and invoke path/action pairs. SLOP was designed to inject
state and actions into an agent context and to integrate dynamic providers; it
does not need to be the internal dependency mechanism or the ordinary UI
transport.

## Decision

Sloppy exposes a typed, client-agnostic Session API and Supervisor API. They are
available in process and through a versioned JSON request/snapshot protocol over
the configured Session and Supervisor Unix sockets. The WebSocket gateway exposes the typed
protocol at `/api/supervisor` and `/api/sessions/{id}`.

No SLOP compatibility socket or legacy gateway route is retained. The Session
runtime may still project deliberate provider state into agent context, and a
generic provider inspector may query or invoke a connected SLOP provider through
an explicit typed Session API command. The Supervisor is application state and
has no SLOP transport projection.

Session plugins contribute typed commands plus declarative, client-agnostic
actions, indicators, and notifications. The server computes command
availability. A contribution may include optional presentation hints such as a
TUI slash name, but execution is always `{pluginId, command, params}` and never
a SLOP path/action pair.

## Consequences

- TUI, web, IDE, voice, and automation clients share one SDK without depending
  on runtime internals or SLOP tree layout.
- SLOP projections can be optimized for agent decisions instead of UI data
  completeness.
- Runtime services, client APIs, and agent projections may evolve at their own
  boundaries.
- The migration is intentionally breaking: `.client`, `/supervisor`,
  `/sessions/{id}`, and `/.well-known/slop` are not aliases.
