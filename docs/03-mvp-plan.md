# MVP Plan

The MVP is a lean SLOP-native runtime plus an optional meta-runtime provider.
The goal is extensibility through provider state and agent communication, not a
built-in orchestrator.

## Current Baseline

Checked in now:

- Bun/TypeScript runtime scaffold
- native Anthropic, Gemini, and OpenAI-compatible adapters
- `ConsumerHub` with query, invoke, subscriptions, approvals, and dynamic tools
- default built-ins: `terminal`, `filesystem`, `memory`, `skills`
- optional built-ins: `web`, `browser`, `cron`, `messaging`, `delegation`,
  `spec`, `vision`, `meta-runtime`
- session provider and headless session server
- TypeScript/OpenTUI TUI under `apps/tui` that consumes the public
  agent-session provider socket
- ACP-backed delegated child sessions behind the same session-provider boundary
- CLI-backed delegated child sessions for Codex CLI or custom one-shot agents
- ACP and CLI adapters selectable as first-class main-session LLM profiles
  behind the same session-provider boundary
- runtime smoke harness (`bun run runtime:smoke`) covering provider-level
  meta-runtime routing plus native, ACP, and CLI delegated-child modes
- runtime doctor (`bun run runtime:doctor`) for checking live OpenAI-compatible
  routers and configured ACP/CLI adapters before a smoke run

The previous orchestration provider, scheduler, task DAG, and orchestrator role
were removed from v1. Planning and delegation are expected to emerge from
providers, skills, routes, and agent-to-agent channels.

## MVP Capabilities

1. Keep the kernel small.
   - No workflow-specific policy in core.
   - No task context or delegation lifecycle coupling.
   - No built-in task scheduler.

2. Make state the contract.
   - Providers expose observable state first.
   - Affordances mutate provider-owned state.
   - UIs consume the same provider/session boundary as agents.

3. Ship the meta-runtime as an optional provider.
   - Model agent profiles, nodes, channels, routes, capabilities, executor
     bindings, skill versions, topology experiments, evaluations, reusable
     topology patterns, proposals, and events.
   - Apply safe session changes directly.
   - Require approval for persistent or privileged changes.
   - Dispatch typed route envelopes to delegated agents or messaging channels
     through the provider hub, forwarding capability masks into delegated child
     runtime policy and supporting fanout or sampled canary routes when
     requested.
   - Require routed agent targets to have explicit capability masks rather than
     inheriting the parent's whole provider surface.
   - Keep trace analysis, repair tactics, runtime architect prompts, automatic
     evidence scoring, and topology pattern reuse out of the provider contract.
     The hardcoded trace/architect/evidence helpers have been removed from the
     public meta-runtime surface; reusable strategy lives in skills.
   - Keep topology experiment scoring skill-owned: the provider stores criteria
     metadata and evaluations, while `promote_experiment` only requires
     recorded evaluation evidence and records rollback lineage instead of
     hiding it in ad hoc proposals.
   - Export merged/global/workspace state and import session/workspace/global
     state with approvals for persistent scopes while preserving storage layer
     boundaries.

4. Let skills evolve.
   - Keep installed `SKILL.md` compatibility.
   - Add skill proposals and activation.
   - Support session, workspace, and global scopes.
   - Refuse persistent skill overwrites and resolve duplicate names by scope
     precedence.
   - Link meta-runtime `activateSkillVersion` records to skills-provider
     proposal activation when a topology proposal applies. Persistent skill
     proposals are activated through the skills provider first.
   - Freeze selected active skill versions into meta-runtime routed child-agent
     goals so skill activation changes the spawned runtime context instead of
     remaining inert metadata.
   - Support Hermes-style progressive disclosure: compact skill list,
     `skill_view(name)`, `skill_view(name, file_path)`, supporting files, nested
     `metadata.sloppy`, builtin/imported roots, and external skill directories.
   - Treat reusable self-evolution behavior as skills: runtime architecture,
     route repair, topology experiment evaluation, and topology pattern
     authoring should be skill playbooks over provider state, not hardcoded
     runtime policy.
   - Add enough skill authoring surface for agent-maintained procedural memory:
     linked-file reads and patch/edit/write support are implemented through
     `skill_view` and `skill_manage`; usage telemetry and a curator/review path
     remain before enabling broad autonomous skill growth.

5. Keep session routing lightweight.
   - Represent channels and routes as SLOP state.
   - Do not add a daemon, external chat bridge, or sandbox worker fleet in MVP.

## Remaining Non-MVP Work

- Build richer UI treatment for meta-runtime proposals and approvals.
- Add import/export packaging for whole identity/runtime bundles, not just
  provider state JSON.
- Evolve route matching beyond substring matches when real usage needs richer
  predicates over typed message envelopes.
- Add usage telemetry and curator/review workflows before enabling broad
  autonomous skill growth.

## Verification

Required checks for architecture-sensitive changes:

```sh
bunx tsc --noEmit
bun test tests/meta-runtime-provider.test.ts
bun test tests/skills-provider.test.ts
bun test tests/delegation-provider.test.ts
bun test tests/kernel-boundary.test.ts
bun test tests/runtime-doctor.test.ts
bun test tests/runtime-smoke.test.ts
```

Run `bun run test` after touching shared runtime, provider registry, session, or
approval behavior.
