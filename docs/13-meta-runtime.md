# Meta-Runtime

This document describes the checked-in lean meta-runtime provider. Older drafts
described a layer above the removed orchestration runtime; that design is no
longer current. The v1 direction is:

- keep the agent kernel small
- expose runtime structure as SLOP provider state
- let agents propose and apply topology changes through normal affordances
- enforce safety at the provider and hub boundary, not through a privileged
  orchestrator path

## Purpose

The `meta-runtime` provider is the substrate for evolving internal
agent-to-agent structure. It is not source-code mutation and it is not a built-in
workflow engine. It models a mutable graph:

- agent profiles
- agent nodes
- channels
- route rules
- capability masks
- executor bindings
- active skill versions
- topology experiments
- experiment evaluations
- proposals
- events

The provider is optional. If it is not mounted, the runtime behaves as a bare
SLOP-native agent with the configured built-in and discovered providers.

## State Surfaces

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
/events
/approvals
```

`/session` contains control affordances:

- `propose_change`
- `dispatch_route`
- `create_experiment`
- `record_evaluation`
- `promote_experiment`
- `rollback_experiment`
- `export_state`
- `import_state`

`/proposals/<id>` exposes proposal affordances while a proposal is still
pending:

- `apply_proposal`
- `revert_proposal`

`revert_proposal` rejects a pending proposal. Applied proposals are not
auto-undone by replaying inverse operations; the current recovery model is a new
proposal that writes the desired topology state.

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

`export_state` can return a merged view or the exact persisted global/workspace
file. `import_state` can merge or replace a single target layer. Replacing the
workspace layer removes only workspace-owned records, so any shadowed global
records become visible again.

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

Routes match by exact source or `*`, and by `*` or substring match on the
envelope body. If multiple routes match, higher `priority` wins, then route id
breaks ties. `dispatch_route` can run in single-target mode or `fanout` mode,
which delivers the same envelope to every matching route.

Agent dispatch invokes `delegation.spawn_agent` with:

- the target profile name
- profile instructions plus the routed message
- the agent executor binding
- the resolved capability masks from the profile and agent node

Channel dispatch invokes `messaging.channels/<id>.send`. The source must be a
channel participant.

Dispatch records `route.dispatched` only after the provider call succeeds. A
provider error records `route.failed` and returns an unrouted result.

## Experiments

Topology proposals can be attached to experiments. An experiment records:

- the proposal under test
- the experiment objective
- optional parent experiment lineage
- promotion criteria
- scored evaluations with evidence
- promotion or rollback status

`promote_experiment` applies the linked proposal only after recorded evaluations
meet the criteria. `rollback_experiment` records rollback lineage and can link to
the proposal that restored topology. The provider still does not schedule or
judge the experiment itself; agents and evaluators supply observations through
SLOP affordances.

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

## Skills

The skills provider is adjacent to the meta-runtime. It loads SKILL.md files from
imported, global, workspace, and session scopes. When names collide, precedence
is:

1. session
2. workspace
3. global
4. imported

Skill proposals can activate session skills directly. Workspace and global skill
activation require approval and refuse to overwrite an existing SKILL.md path.
Meta-runtime `activateSkillVersion` operations may reference a skills-provider
proposal id; when the topology proposal applies, the meta-runtime invokes the
skills provider and records activation success or failure on the skill version.

## Non-Goals

The meta-runtime does not reintroduce the old orchestration runtime. In
particular, it does not own:

- task DAGs
- a built-in scheduler loop
- plan lifecycle state
- verification-gated task completion
- privileged orchestrator roles

Those behaviors can be composed through providers, skills, routes, channels, and
agent communication patterns. If a richer workflow system is added later, it
should be another provider or package using this boundary, not special kernel
logic.

## Remaining Work

The implementation is intentionally lean, but these areas are still open:

- typed route message envelopes instead of plain strings
- richer route matchers beyond substring matching
- route fanout when multiple targets should receive a message
- UI treatment for proposals, route events, and capability masks
- evaluation loops for skill/runtime variants before promotion
- packaged export/import of identity, skills, and runtime state as one bundle
