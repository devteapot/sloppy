# Session-owned Approval mode

## Status

Accepted.

## Context

The TUI originally treated `/approval auto` as local UI behavior: one client could choose to auto-click pending approvals while another client attached to the same Session still saw normal approval handling. The branch adds `--yolo`, headless single-shot support, supervised session creation, and public `/approvals.approval_mode`, which makes that split surprising and inconsistent.

## Decision

Approval mode is Session-owned runtime behavior exposed through the Session provider, not TUI-local behavior. Clients observe `approval_mode`, change it through `/approvals.set_mode`, and render the result; when the mode is `auto`, the runtime approves every pending approval in the Session that exposes an `approve` affordance.

## Consequences

- All attached clients see the same approval mode for a Session.
- `sloppy --yolo`, headless single-shot runs, supervised sessions, and `/approval auto` share one semantic boundary.
- `--yolo` on an existing, continued, or restored Session intentionally mutates that Session's public approval mode to `auto` until a client sets it back to `normal`.
- The mode is intentionally Session-wide rather than foreground-turn-only. Approval sources that must not be auto-approved need to avoid exposing an ordinary auto-approvable `approve` affordance under this policy.
- Approval mode persists in the Session snapshot and is restored with the Session; restoring an old `auto` Session keeps it in `auto` until a client changes it.
- Auto-approval failures do not demote the Session to `normal`; the mode remains the operator's declared intent while unresolved approvals stay visible for manual resolution or inspection.
- New supervised Sessions intentionally propagate the operator's current approval mode when no explicit `approval_mode` is supplied: the supervisor inherits from the caller's selected Session, then from the launch-scope resume Session. This keeps New Session aligned with the operator's current working mode instead of silently resetting safety behavior.