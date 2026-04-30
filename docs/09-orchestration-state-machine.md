# Orchestration Task State Machine

This document is the single source of truth for how an orchestration task moves between statuses. It freezes current behavior so future refactors can verify they preserve it.

The implementation lives in:

- `src/providers/builtin/orchestration/types.ts` — status enum
- `src/providers/builtin/orchestration/lifecycle.ts` — `TaskLifecycle` (CAS, schedule, start, fail, cancel, complete, retry/supersede)
- `src/providers/builtin/orchestration/verification.ts` — `VerificationCoordinator` (start_verification, attach_result, record_verification, completion gate)
- `src/runtime/orchestration/scheduler.ts` — claim flow, in-flight dedupe, version-conflict handling
- `src/runtime/delegation/sub-agent.ts` + `src/runtime/orchestration/task-context.ts` — child-result handoff

## Statuses

`TaskStatus` is one of:

| Status | Meaning |
|---|---|
| `pending` | Created, not yet claimed by the scheduler. |
| `scheduled` | Claimed by the scheduler; awaiting sub-agent spawn. |
| `running` | Sub-agent is executing. |
| `verifying` | Result attached; awaiting verification records to satisfy acceptance criteria. |
| `completed` | Verification passed; result is durable on disk. |
| `failed` | Execution or verification reported a failure. Terminal unless retried. |
| `cancelled` | Explicitly stopped. Terminal unless retried. |
| `superseded` | Replaced by a newer task created via `retry_of`. Terminal. |

## Allowed transitions

```
pending ──► scheduled ──► running ──► verifying ──► completed
   │            │            │            │
   └────────────┴────────────┴────────────┴──► failed
   │            │            │            │
   └────────────┴────────────┴────────────┴──► cancelled
   │            │            │            │
   └────────────┴────────────┴────────────┴──► superseded
```

Specifically:

| From → To | Function | Guard |
|---|---|---|
| `pending` → `scheduled` | `TaskLifecycle.scheduleTask` | unmet deps must be empty; `expected_version` must match; referenced spec version must be fresh when present |
| `pending` → `running` | `TaskLifecycle.startTask` | unmet deps empty; current status in {pending, scheduled}; referenced spec version must be fresh when present |
| `scheduled` → `running` | `TaskLifecycle.startTask` | same as above |
| `running` → `verifying` | `VerificationCoordinator.startVerification` or `attachResult` | current status in {running, verifying} |
| `running` → `verifying` | `VerificationCoordinator.recordVerification` (auto-promote) | current status is `running`; promotes to `verifying` before recording |
| `verifying` → `completed` | `TaskLifecycle.completeTask` | current status is exactly `verifying`; **`hasCompletionVerification(taskId)` must return true**; docs/12 slices must also have an accepted `slice_gate` |
| any active → `failed` | `TaskLifecycle.failTask` | no status guard (sets error + completed_at) |
| any active → `cancelled` | `TaskLifecycle.cancelTask` | no status guard (sets completed_at) |
| `failed` / `cancelled` / `superseded` → `superseded` | `TaskLifecycle.createTask` with `retry_of` | source state is read; new task's id is written to `superseded_by` |

Disallowed transitions throw a coded error `invalid_state` with a message describing the current and required statuses. Notably:

- `pending` → `completed` directly: rejected (`completeTask` requires `verifying`).
- `completed` → anything: terminal (no descriptor affordances offered, and lifecycle methods reject).
- `verifying` → `completed` without verification coverage: rejected with `verification_required`.

## Concurrency: optimistic CAS

All status mutations go through `TaskLifecycle.updateTaskState`, which:

1. Loads the current state and reads `repo.taskVersion(taskId)`.
2. If the caller passed `expected_version` and it does not match, returns `{ error: "version_conflict", currentVersion }` **without bumping the version**.
3. Otherwise, calls `repo.bumpTaskVersion`, writes the new state, and returns `{ version, state }`.

The runtime scheduler (`OrchestrationScheduler.evaluateOnce` → `schedule` action) supplies `expected_version` so that two concurrent claim attempts for the same task race on the version bump and only one wins.

The scheduler also tracks `inFlightTasks: Set<string>` to dedupe in-process claim attempts before the CAS even runs (`scheduler.ts`).

## Verification and slice gates

`TaskLifecycle.completeTask` requires `hasCompletionVerification(taskId)` to return true, defined in `VerificationCoordinator.hasCompletionVerification`:

- If the task has acceptance criteria: every criterion must be covered by a verification record with status `passed` or `not_required`, or by a typed `EvidenceClaim` criterion satisfaction entry backed by replayable/observed evidence.
- If the task has **no** acceptance criteria: at least one verification record with status `passed` or `not_required` must exist.

Tasks created from accepted docs/12 plan revisions set `requires_slice_gate: true`. Those tasks cannot complete until a `slice_gate` for `slice:<taskId>` is accepted. `submit_evidence_claim` opens that gate only after all acceptance criteria are covered by replayable or observed evidence. Self-attested evidence is stored but cannot satisfy criteria.

`recordVerification` enforces additional rules:

- A `passed` record covering acceptance criteria must include `evidence_refs` (existing files, commands, URLs, screenshots, or state paths).
- `evidence_refs` must point to extant workspace artifacts (`repo.invalidEvidenceRefs`).
- Calling `recordVerification` while in `running` auto-promotes the task to `verifying` before writing the record.
- Calling `recordVerification` while `failed`, `cancelled`, or `superseded` is rejected with `invalid_state`.
- Calling `recordVerification` while `pending` is rejected (must be running first).
- `recordVerification` remains a compatibility affordance and writes a minimal legacy `EvidenceClaim` alongside the verification record.

## Retry / supersede

`TaskLifecycle.createTask({ retry_of })`:

1. Creates a new task in `pending` (independent id, fresh version).
2. Calls `updateTaskState` on the source task with `{ status: "superseded", superseded_by: <new id>, completed_at }`. This bumps the source's version.
3. The new task inherits dependencies from the source unless overridden.
4. If the active plan has `budget.retries_per_slice`, the replacement's `attempt_count` is the source retry count plus one. A replacement that would exceed the cap is rejected with `retry_budget_exceeded` and opens a `budget_exceeded` gate for the logical slice.

`TaskLifecycle.isDependencySatisfied` follows supersede chains: a dependency is satisfied if it is `completed` **or** if it is `superseded` and its `superseded_by` task is `completed`.

## Child-result handoff

When a sub-agent finishes its turn idle, the path is:

1. `SubAgentRunner.syncFromStore` (`src/runtime/delegation/sub-agent.ts`) detects the idle turn, extracts the last assistant text as `resultText`, and calls `taskContext.recordCompletion(resultText)`.
2. `OrchestrationTaskContext.recordCompletion` (`src/runtime/orchestration/task-context.ts`) invokes `attach_result` on `/tasks/<taskId>`.
3. `VerificationCoordinator.attachResult` writes `result.md` and, if the task is `running`, transitions it to `verifying`.
4. The sub-agent or operator then calls `record_verification` to satisfy acceptance criteria, after which `complete` is offered.

On failure the parallel path is `recordFailure → fail` (`TaskLifecycle.failTask`), bypassing verification.

## Affordance filtering

The descriptor builder in `src/providers/builtin/orchestration/descriptor-tasks.ts` only offers an affordance when the current status admits the transition. This is a UX guardrail; the lifecycle methods still enforce the same invariants because invocations can race or arrive from non-UI callers (e.g. the scheduler).
