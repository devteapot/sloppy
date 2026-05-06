# Meta-Runtime

This document describes the checked-in `meta-runtime` provider and the intended
direction for keeping it lean.

Older drafts described a layer above a removed orchestration runtime. That
design is no longer current. The v1 direction is:

- keep the agent kernel small
- expose runtime structure as SLOP provider state
- let agents propose topology changes through normal affordances
- keep reusable strategy in skills, not hardcoded runtime policy
- enforce safety at the provider and hub boundary

## Purpose

The `meta-runtime` provider is the substrate for evolving internal
agent-to-agent structure. It is not source-code mutation, a workflow engine, or
a task scheduler. It models a mutable graph:

- agent profiles
- agent nodes
- channels
- route rules
- capability masks
- executor bindings
- active skill versions
- topology experiments and evaluations
- topology proposals
- events

The provider is optional. If it is not mounted, Sloppy behaves as a bare
SLOP-native agent with the configured built-in and discovered providers.

## Current Surfaces

The provider exposes:

```text
/session
/agents
/profiles
/channels
/routes
/capabilities
/executor-bindings
/skill-versions
/experiments
/evaluations
/proposals
/patterns
/events
/approvals
```

Stable substrate affordances on `/session`:

- `propose_change`
- `dispatch_route`
- `create_experiment`
- `record_evaluation`
- `promote_experiment`
- `rollback_experiment`
- `archive_topology_pattern`
- `propose_from_pattern`
- `export_state`
- `import_state`

Strategy helpers are intentionally not part of the public `/session` surface.
These older hardcoded affordances were removed and should be expressed as
skills over `/events`, `/routes`, `/proposals`, `/experiments`, and `/patterns`:

- `analyze_runtime_trace`
- `prepare_architect_brief`
- `start_architect_cycle`
- `derive_proposals_from_events`
- `start_evolution_cycle`
- `record_experiment_evidence`

Those helpers encoded diagnosis, prompt construction, repair tactics, and
scoring formulas. The long-term shape is a small meta-runtime substrate plus
skills such as `runtime-architect`, `runtime-route-repair`,
`topology-experiment-evaluator`, and `topology-pattern-author` operating over
that substrate.

`/proposals/<id>` exposes proposal affordances while a proposal is pending:

- `apply_proposal`
- `revert_proposal`

`revert_proposal` rejects a pending proposal. Applied proposals are not
auto-undone by replaying inverse operations; recovery is a new proposal that
writes the desired topology state.

## Storage Model

Meta-runtime state is layered:

```text
global    ~/.sloppy/meta-runtime/state.json
workspace .sloppy/meta-runtime/state.json
session   memory only
```

The effective state is computed in this order:

1. global
2. workspace
3. session

Later layers override earlier layers by id. Persistence is scoped: saving a
workspace proposal writes only workspace-owned topology, workspace proposals, and
workspace events. It does not copy global or session state into the workspace
file.

New state files are written as versioned envelopes:

```json
{
  "kind": "sloppy.meta-runtime.state",
  "schema_version": 1,
  "saved_at": "2026-05-06T00:00:00.000Z",
  "state": {}
}
```

Legacy raw topology-state files are still read for compatibility. Unknown
envelope kinds or schema versions are rejected before state is loaded.

`export_state` can return a merged view or the exact persisted global/workspace
file. `import_state` can merge or replace a single target layer. Replacing the
workspace layer removes only workspace-owned records, so any shadowed global
records become visible again.

`export_bundle` returns a portable bundle with meta-runtime topology state plus
content for active skill versions loaded through the skills provider. API keys,
secure-store values, and other secrets are never included. Exported skill
entries include SHA-256 hashes for `SKILL.md` content and supporting files.
`import_bundle` verifies any bundled hashes before writing skills or topology,
and rejects mismatches as malformed bundle content.

`import_bundle` restores meta-runtime state and can install bundled skills
through `skill_manage`. By default bundled skills install as session skills;
explicit workspace/global skill imports still go through the skills provider's
approval rules. `dry_run=true` parses and validates the bundle, reports which
skills would be created, skipped, or fail preflight, and leaves both topology
and skill state unchanged.

## Proposal Rules

Changes are proposed as typed topology operations:

- `upsertAgentProfile`
- `spawnAgent`
- `retireAgent`
- `upsertChannel`
- `rewireChannel`
- `upsertRoute`
- `setCapabilityMask`
- `setExecutorBinding`
- `activateSkillVersion`
- `deactivateSkillVersion`

Persistent scopes always require approval. Session-scoped changes apply without
approval only when they are non-privileged. Session allow-masks, spawned agents,
executor bindings, and skill activation require approval.

Proposals can carry `ttl_ms`. Expired proposals are marked `expired` and cannot
apply. Before mutation, the provider validates references against a simulated
topology so an invalid proposal cannot partially mutate runtime state.

## Routing

Routes map a source and message match to a target:

```text
agent:<agent-id>
channel:<channel-id>
```

Routes dispatch typed envelopes:

```json
{
  "id": "msg-1",
  "source": "root",
  "body": "please review this change",
  "topic": "audit",
  "inReplyTo": "msg-0",
  "causationId": "proposal-1",
  "metadata": {}
}
```

Routes match by exact source or `*`. The existing `match` field remains the
route's match value and defaults to case-sensitive substring matching against
the envelope body, preserving older route records. New route records can also
set:

- `matchField`: `body`, `topic`, `channelId`, or `metadata.<path>`
- `matchMode`: `substring`, `exact`, `prefix`, `regex`, or `exists`
- `caseSensitive`: `false` for case-insensitive string matching

`match="*"` matches any value on the selected field. `matchMode="exists"`
matches when the selected field is present, ignoring the `match` value. Invalid
regex matchers are rejected before a proposal is stored. If multiple routes
match, higher `priority` wins, then route id breaks ties. `dispatch_route` can
run in single-target mode or `fanout` mode, which delivers the same envelope to
every matching route.

Routes may include `traffic.sampleRate` between `0` and `1`. The matcher uses a
deterministic bucket from route id and envelope id, so agents can propose
session canary routes without adding a scheduler or privileged runtime branch.
`traffic.experimentId` is optional metadata linking a canary route to the
experiment it is intended to evaluate.

Agent dispatch invokes `delegation.spawn_agent` with:

- the target profile name
- profile instructions plus the routed message
- the original typed route envelope as `routeEnvelope`
- the agent executor binding
- the resolved capability masks from the profile and agent node
- the selected active skill versions from the profile and agent node

Agent targets must resolve at least one explicit capability mask. A routed
sub-agent without a mask records `route.failed` with
`missing_capability_mask` instead of inheriting the parent's full provider
surface.

Channel dispatch invokes `messaging.channels/<id>.send` with both the envelope
body and typed envelope. The source must be a channel participant.

Dispatch records `route.dispatched` only after the provider call succeeds. A
provider error or invalid target records `route.failed` and returns an unrouted
result. Unmatched traffic records `route.unmatched`.

## Experiments

Topology proposals can be attached to experiments. An experiment records:

- the proposal under test
- the experiment objective
- optional parent experiment lineage
- promotion criteria metadata for evaluator skills
- scored evaluations with evidence
- promotion or rollback status

The provider does not decide whether an experiment's scores satisfy the
objective. Evaluator skills read the criteria, events, proposal, and evidence,
then record an explicit evaluation. `promote_experiment` requires at least one
recorded evaluation, stores the evaluation used for promotion, applies the
linked proposal if needed, and requests approval before applying privileged or
persistent changes. `rollback_experiment` records rollback lineage and applies a
provided rollback proposal when it is still pending.

The runtime should store evaluations, not decide domain-specific truth. Route
event scoring and pattern promotion heuristics are useful skills or diagnostic
scripts over `/events`, `/routes`, `/proposals`, and `/experiments`; they should
not keep expanding as hardcoded provider policy.

Topology pattern records follow the same boundary. `archive_topology_pattern`
and `propose_from_pattern` require explicit typed operations supplied by a
pattern-authoring skill. The provider stores pattern lineage and creates normal
proposals; it does not infer reusable operations by copying the source proposal.

## Capability Masks

Capability masks are enforced by hub policy in child runtimes created through
meta-runtime delegation routes.

Mask shape:

```json
{
  "id": "filesystem-read-only",
  "provider": "filesystem",
  "path": "/files",
  "actions": ["read"],
  "mode": "allow"
}
```

Rules:

- `deny` masks block matching invocations.
- if any `allow` mask exists, invocations must match at least one allow mask.
- provider, path, and actions are optional match constraints.
- path masks cover the exact path and descendants.

This keeps capability control at the consumer hub boundary, where provider
invocations actually happen.

## Skills And Self-Evolution

The skills provider is adjacent to the meta-runtime. It loads `SKILL.md` files
from builtin, imported, global, workspace, and session scopes. When names collide,
precedence is:

1. session
2. workspace
3. global
4. builtin
5. imported

Skill proposals can activate session skills directly. Workspace and global skill
activation require approval and refuse to overwrite an existing `SKILL.md` path.
`skill_manage` gives agents Hermes-style procedural-memory maintenance for
creating, patching, editing, deleting, and adding supporting files; persistent
workspace/global writes are approval-gated.

Built-in runtime skills live under `skills/runtime/`:

- `runtime-architect`
- `runtime-route-repair`
- `topology-experiment-evaluator`
- `topology-pattern-author`
- `skill-curator`

Meta-runtime `activateSkillVersion` operations may reference a skills-provider
proposal id. Session skill proposals can be activated as part of applying the
topology proposal. Workspace and global skill proposals must be activated
through the skills provider first, because those writes have their own approval
queue and should not be hidden inside meta-runtime approval.

Skill versions are not global ambient prompt state. Profiles can list
`defaultSkillVersionIds`; agent nodes can list `skillVersionIds`. During route
dispatch, only those selected active skill versions are resolved through
`skill_view`, loaded, and frozen into the routed child-agent goal. If a selected
skill cannot be loaded, the route records `route.failed` instead of spawning a
child without the declared procedural context.

The important boundary:

- meta-runtime owns topology state, validation, dispatch, persistence, approval,
  and experiment records
- skills own reusable strategy, diagnosis, repair recipes, evaluation rubrics,
  architect prompts, pattern authoring, and procedural-memory curation

This follows the Hermes-style lesson: if behavior can be expressed as
instructions plus existing affordances, make it a skill. Reserve provider code
for deterministic state mutation, safety enforcement, and exact integrations.

## Non-Goals

The meta-runtime does not reintroduce the old orchestration runtime. In
particular, it does not own:

- task DAGs
- a built-in scheduler loop
- plan lifecycle state
- verification-gated task completion
- privileged orchestrator roles
- hardcoded repair playbooks
- hardcoded runtime architect prompts
- hardcoded promotion heuristics for topology patterns

Those behaviors can be composed through providers, skills, routes, channels, and
agent communication patterns. If a richer workflow system is added later, it
should be another provider or package using this boundary, not special kernel
logic.

## Migration Notes

The trace-derived repair, architect-brief, automatic evidence-scoring, and
evolution-cycle helper affordances have been removed from the public
meta-runtime surface. Their reusable strategy now belongs in built-in skills.

Preferred migration order:

1. Add built-in skills for runtime architecture, route repair, experiment
   evaluation, and topology pattern authoring. Done in `skills/runtime/`.
2. Keep only substrate affordances in the long-term `/session` surface. Done for
   the removed trace/architect/evidence helpers.
3. Teach child-agent spawning to resolve selected active skill versions at spawn
   time and freeze them into the child prompt. Done for meta-runtime routed
   children.
4. Add usage telemetry and curator/review workflows before broad autonomous
   skill growth. Done for the built-in `skill-curator` workflow; autonomous
   scheduling remains out of scope for the runtime.

## Remaining Work

- optional first-class `/identity` provider for persona/preferences/role memory
  beyond the checked-in meta-runtime bundle substrate
