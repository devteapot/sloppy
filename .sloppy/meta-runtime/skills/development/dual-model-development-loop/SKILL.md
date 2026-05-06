---
name: dual-model-development-loop
description: Use GPT-5.5 and Claude Opus 4.7 ACP sub-agents in an iterative planner/auditor/implementer loop for development tasks.
version: 0.1.0
metadata:
  sloppy:
    tags: [development, planning, audit, delegation, gpt-5.5, opus-4.7]
    category: development
---
# Dual-Model Development Loop

## When To Use

Use this skill for non-trivial development tasks where a plan, implementation, and audit loop are valuable, especially when the user asks for cross-model planning/review or when the change has architecture, correctness, or UI risk.

Do not use for tiny one-line edits, purely informational questions, or emergency fixes where delegation overhead would slow the user down unnecessarily.

## Model Roles

- **Planner:** GPT-5.5 / current native session model.
- **Plan Auditor:** Claude Opus 4.7 via Claude ACP delegation.
- **Implementer:**
  - GPT-5.5 / current native session model for non-UI tasks.
  - Claude Opus 4.7 via Claude ACP delegation for UI-heavy tasks.
- **Implementation Auditor:** GPT-5.5 / current native session model, unless the parent is already the implementer; keep the audit role separate from the implementer when possible.

Claude ACP executor binding:

```json
{
  "kind": "acp",
  "adapterId": "claude",
  "timeoutMs": 600000
}
```

## Procedure

### 1. Classify the task

Determine whether the task is UI-heavy.

Treat a task as **UI-heavy** when the core change is in UI/client code, visual interaction, layouts, terminal UI behavior, React/Solid/OpenTUI components, design systems, UX flow, or screenshots.

Otherwise treat it as **non-UI**.

### 2. Create an initial plan with GPT-5.5

As the parent/native GPT-5.5 session, inspect relevant project state and produce a concise implementation plan with:

- goal and non-goals
- files likely to change
- proposed steps
- verification commands
- risks/open questions
- explicit UI/non-UI classification

Do not implement yet.

### 3. Audit the plan with Opus 4.7

Spawn a Claude ACP sub-agent to audit the plan. The child must be read-only.

Prompt the auditor to check:

- missing requirements
- incorrect assumptions
- architecture fit
- simpler alternatives
- security/safety implications
- test/verification gaps
- UI/UX concerns when applicable
- whether the plan is ready, conditionally ready, or not ready

### 4. Iterate planner/auditor until ready

Feed the Opus audit back into the GPT-5.5 planner. Revise the plan.

If substantial concerns remain, send the revised plan back to the Opus auditor or spawn a fresh Opus audit sub-agent. Iterate until one of these is true:

- the auditor says the plan is ready or only has minor non-blocking notes
- the user explicitly accepts remaining risk
- further iteration is unlikely to improve the plan materially

Keep the loop bounded. Default maximum: 3 plan-audit rounds unless the user asks for more.

### 5. Implement with the selected implementer

- For **non-UI tasks**, implement with GPT-5.5 in the parent/native session.
- For **UI-heavy tasks**, delegate implementation to Claude Opus 4.7 via Claude ACP when practical.

Implementation rules:

- Make the smallest sufficient change.
- Respect existing project patterns.
- Do not broaden scope without user approval.
- For delegated implementation, clearly define write boundaries and require a final summary of changed files and verification run.

### 6. Verify locally

When runnable code changes, run the narrowest suitable check before audit:

- targeted tests if available
- typecheck/lint for touched areas
- UI typecheck for TUI/UI changes
- broader test/build only when necessary or requested

Surface failures honestly. Do not mark the task complete while checks are failing unless the user accepts that state.

### 7. Audit the implementation with GPT-5.5

Use GPT-5.5 as implementation auditor. Review:

- diff against final plan
- correctness and edge cases
- style and maintainability
- tests/checks and their output
- regressions or missed cleanup
- whether implementation matches UI/non-UI classification and chosen implementer

If the parent implemented the change, perform a deliberate separate self-audit pass after reading the changed files/diff and command output. If a sub-agent implemented the change, audit the child result plus actual workspace state.

### 8. Evaluate fixes with the implementer and iterate

If the implementation auditor finds issues:

- send concrete fix requests to the implementer
- have the implementer apply fixes
- rerun relevant checks
- audit again

Default maximum: 3 implementation-audit rounds unless the user asks for more.

Stop when:

- the auditor is satisfied, and
- required checks pass, or
- remaining issues are explicitly documented and accepted by the user.

### 9. Final response

Report:

- final plan status
- implementer used and why
- files changed
- checks run and results
- audit iterations performed
- remaining risks or follow-ups

Close any completed delegated child sessions after retrieving their final results.

## Pitfalls

- Do not let the planner implement before the plan audit is ready.
- Do not let the same delegated child silently act as both auditor and implementer.
- Do not use Claude ACP write access for non-UI tasks unless the user asks or GPT-5.5 cannot proceed.
- Do not skip verification after code changes.
- Do not treat an auditor's vague approval as sufficient when concrete blockers remain unresolved.
- Do not leave child sessions open after retrieving final results.

## Verification

Before completing the user task, confirm:

- plan audit completed or was explicitly waived
- implementation used the correct model for UI/non-UI classification
- implementation audit completed
- relevant tests/typechecks/lints were run or a reason was given
- all delegated child results were retrieved and completed children were closed
