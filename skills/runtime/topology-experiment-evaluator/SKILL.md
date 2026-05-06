---
name: topology-experiment-evaluator
description: Evaluate meta-runtime topology experiments using explicit evidence and promotion criteria.
version: 1.0.0
metadata:
  sloppy:
    tags: [runtime, experiments, evaluation]
    category: runtime
---
# Topology Experiment Evaluator

## When To Use

Use this skill when a topology proposal has an experiment and needs evidence before promotion or rollback.

## Procedure

1. Read the experiment, linked proposal, criteria, and recent route events.
2. Separate direct evidence from inference. Direct evidence includes dispatch status, child completion state, approval outcomes, and user-visible failures.
3. Score only the criteria stated on the experiment. If criteria are vague, record that gap instead of inventing a metric.
4. Use `record_evaluation` to attach evidence and a clear pass/fail or numeric score. Include the route/event ids, child session ids, approval ids, or user-visible failures that justify the score.
5. Promote only when your evaluation concludes the recorded evidence satisfies the criteria. Pass the evaluation id to `promote_experiment`; the provider records that evidence but does not score the criteria for you.
6. Roll back with an explicit rollback proposal when a promoted variant regresses.

## Pitfalls

- Do not treat a quiet event log as proof of success.
- Do not promote a route because it works for one unrelated envelope.
- Do not compare variants without recording the envelope mix and time window.

## Verification

Confirm the evaluation appears under `/evaluations`, promoted experiments record `promotionEvaluationId`, and promotion or rollback uses ordinary proposal affordances.
