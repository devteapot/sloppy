# Session-owned Approval mode

## Status

Accepted.

## Context

The TUI originally treated `/approval auto` as local UI behavior: one client could choose to auto-click pending approvals while another client attached to the same Session still saw normal approval handling. The branch adds `--yolo`, headless single-shot support, supervised session creation, and public `/approvals.approval_mode`, which makes that split surprising and inconsistent.

## Decision

Approval mode is Session-owned runtime behavior exposed through the Session provider, not TUI-local behavior. Clients observe `approval_mode`, change it through `/approvals.set_mode`, and render the result; when the mode is `auto`, the runtime approves every pending approval in the Session with `canApprove=true` unless the source marks it `auto_approvable=false` because a person must decide explicitly.

## Consequences

- All attached clients see the same approval mode for a Session.
- Supervisor `/sessions` summaries expose each Session's approval mode, but not `approval_mode_updated_at`, so UIs can show `auto` before switching. Supervisor session items do not set approval mode; mutation stays on the selected Session provider's `/approvals.set_mode`.
- `/approvals` is the Session provider source path for approval mode; `/session` stays lifecycle/status-focused.
- Model visibility comes from ordinary public `/approvals` state when that path is in context; there is no separate hidden prompt field for approval mode.
- Approval mode changes apply immediately as Session control state and are not queued behind active model turns.
- `set_mode(auto)` is idempotent and still triggers an auto-approval pass over current pending approvals.
- `approval_mode_updated_at` tracks mode value changes only; idempotent drain requests do not update it.
- `sloppy --yolo`, headless single-shot runs, supervised sessions, and `/approval auto` share one semantic boundary.
- `--yolo` is a standalone flag accepted in any argument position; it is stripped from prompt text before single-shot submission.
- Public approval mode inputs are strict: only `normal` and `auto` are accepted. `--yolo` is a CLI-level alias, not a provider API value.
- The TUI `/approval` command accepts `normal`, `auto`, and `toggle`; it does not accept `yolo` as an in-app alias.
- `--yolo` on an existing, continued, restored, or direct-socket-attached Session intentionally mutates that Session's public approval mode to `auto` until a client sets it back to `normal`.
- The mode is intentionally Session-wide rather than foreground-turn-only. Runtime auto-approves every eligible pending approval with `canApprove=true`, including background/provider approvals. Sources that require an explicit person keep ordinary approve/reject affordances but mark the item `auto_approvable=false`; remote microphone egress is the reference case.
- Auto-approval processes pending approvals sequentially in current approval snapshot order; it does not prioritize foreground-turn approvals over background/provider approvals.
- Switching from `normal` to `auto` immediately drains already-pending approval-capable items, not only future approvals.
- Approval mode persists in the Session snapshot and is restored with the Session. Plain `sloppy --continue` preserves the persisted mode; restoring an old `auto` Session keeps it in `auto` until a client changes it.
- Durable snapshots keep the policy shape as `approvalPolicy`; the public Session provider projects the mode as `/approvals.approval_mode`.
- Headless single-shot sessions use approval mode for that run only because they do not persist session snapshots.
- Config reload does not change approval mode; approval mode is Session state, not config state.
- Auto-approval failures do not demote the Session to `normal`; the mode remains the operator's declared intent while unresolved approvals stay visible for manual resolution or inspection. The runtime attempts auto-approval once per pending approval item while that item remains pending; if the provider replaces it with a new approval item, that new item may be auto-approved.
- Remembered attempt state is cleared when an approval id is no longer pending; if the same id later becomes pending again, it may be attempted again.
- Switching from `auto` to `normal` stops future auto-approval passes but does not cancel or undo an approval resolution already invoked against a provider.
- Setting `normal` clears remembered auto-approval attempts; switching back to `auto` may retry still-pending approval items.
- Setting `auto` does not clear remembered attempts; `normal` is the explicit reset boundary.
- Auto-approval does not add separate transcript, activity narration, or success audit entries; approval state and provider/tool results are the normal visibility surface, with audit entries reserved for auto-approval errors.
- New supervised Sessions intentionally propagate the operator's current approval mode at creation time when no explicit `approval_mode` is supplied: the supervisor inherits from the caller's selected Session, then from the launch-scope resume Session. This applies to `/session.create_session` and tracked scope-item `/scopes/{id}.create_session`; untracked in-process descriptor actions have no caller-selected Session context and only honor explicit `approval_mode` plus launch-scope fallback. It is not a sticky launch flag; if the operator changes `/approval` before creating a new Session, the new Session follows that current mode.
