---
name: skill-curator
description: Review skill usage, failures, and repeated procedures, then propose minimal skill changes through the skills provider.
version: 1.0.0
metadata:
  sloppy:
    tags: [runtime, skills, curation]
    category: runtime
---
# Skill Curator

## When To Use

Use this skill when repeated session failures, duplicated procedures, stale skills, low-value skill usage, or newly learned workflows suggest that Sloppy's procedural memory should change.

## Procedure

1. Inspect the skills provider `/skills` index first. Use `view_count`, `last_viewed_at`, tags, category, scope, and `supporting_files` to identify unused, duplicated, stale, or frequently used skills.
2. Read only the relevant skills with `skill_view(name)` and load supporting files only when the index shows they matter.
3. Inspect session evidence before proposing edits: recent transcript, activity, approvals, tasks, route events, and user-visible failures. Separate direct evidence from inference.
4. Classify the curation action:
   - create a new skill for a repeated procedure that can be expressed as instructions plus existing affordances
   - patch or edit an existing skill when the procedure is mostly right but missing a guardrail, verification step, or trigger condition
   - write or remove a supporting file when a reusable script, template, or reference is the durable artifact
   - delete or retire a workspace/session skill only when there is clear duplication, wrong guidance, or persistent disuse
5. Use `skill_manage` for the smallest change. Prefer session scope for experiments; use workspace/global scope only when the evidence justifies durable procedural memory and the user approves the write.
6. When a skill should become part of routed meta-runtime behavior, propose or update the related `activateSkillVersion` topology state instead of making the skill ambient prompt text.

## Pitfalls

- Do not create a skill for one-off project facts, credentials, or private UI draft state.
- Do not hide a runtime bug by documenting a workaround as a skill.
- Do not merge unrelated procedures into one broad skill.
- Do not infer that low `view_count` means useless when the skill is new or specialized.
- Do not write persistent skills without approval.

## Verification

Confirm the proposed or applied skill change appears under `/proposals` or `/skills`, that persistent changes requested approval, and that the updated skill has a clear trigger, procedure, pitfalls, and verification section.
