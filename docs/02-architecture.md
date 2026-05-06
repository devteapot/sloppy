# Architecture

Sloppy is a SLOP-native agent runtime. The kernel observes provider state,
projects affordances into model-native tools, invokes selected affordances, and
keeps the session alive across approvals, async tasks, and external provider
changes.

The runtime does not own planning, delegation strategy, review loops, or task
graphs. Those are compositions over SLOP providers.

## Lean Kernel

The default runtime includes:

- `Agent` loop and LLM adapters
- `ConsumerHub` for state subscriptions, query, invoke, and policy checks
- session provider for UI and API consumers
- provider discovery
- approval queue and generic dangerous-action policy
- default built-ins: `terminal`, `filesystem`, `memory`, and `skills`

The kernel has no hard-coded orchestrator role, scheduler, task DAG, or
workflow-specific lifecycle hooks. Roles remain generic prompt/policy profiles.

## Provider Model

Everything visible to the agent is a provider state tree with affordances:

- state is primary
- affordances are secondary
- subscriptions and patches are preferred over repeated polling
- provider-native affordances are converted into model-native tool definitions
- fixed observation tools (`slop_query_state`, `slop_focus_state`) are consumer
  controls, not provider capabilities

Built-in capabilities are providers, not privileged runtime branches. Optional
providers include `web`, `browser`, `cron`, `messaging`, `vision`, `delegation`,
`spec`, and `meta-runtime`.

## Delegation

Delegation is a provider that spawns and observes child agent sessions. It does
not understand tasks or plans. Child agents expose the same session-provider
surface as the parent, so parent agents and UIs observe child transcript,
approvals, activity, and lifecycle state through SLOP.

The deprecated `task_id` spawn field is ignored for compatibility. Completed
children expose `get_result` directly on their agent item.

## Meta-Runtime

The `meta-runtime` provider is the first-class substrate for evolving internal
agent-to-agent structure. It exposes:

- `/agents`
- `/profiles`
- `/channels`
- `/routes`
- `/capabilities`
- `/executor-bindings`
- `/skill-versions`
- `/experiments`
- `/evaluations`
- `/proposals`
- `/patterns`
- `/events`
- `/approvals`

The agent changes its internal runtime by proposing typed topology operations:

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

This is a meta-runtime, not arbitrary source-code mutation. The provider schema
is stable; the graph, routes, capabilities, executor bindings, active skill
versions, and topology experiment records are state.

Enabled routes dispatch typed message envelopes through the provider hub:

- `agent:<id>` targets invoke `delegation.spawn_agent` using the target agent's
  profile instructions, executor binding, and resolved capability masks.
- `channel:<id>` targets invoke `messaging.channels/{id}.send`.

Dispatch can run in single-target mode or fanout mode. Routes can carry
`traffic.sampleRate` metadata for deterministic canary delivery without adding a
core scheduler.

The checked-in provider keeps the public surface to substrate operations:
topology mutation proposals, route dispatch, experiments/evaluations, rollback,
pattern records, import/export, approvals, and capability masks. Reusable
diagnosis, repair playbooks, architect prompts, and evaluation rubrics live in
skills over that state. Experiment promotion requires recorded evaluation
evidence, but evaluator skills own the scoring rubric. Pattern archive/reuse
requires explicit topology operations from a pattern-authoring skill rather than
copying source proposals automatically.

The meta-runtime provider can also export merged/global/workspace state and
import session/workspace/global state. Persistent imports are approval-gated.

## Storage And Approval

Meta-runtime state is layered:

- global: `~/.sloppy/meta-runtime`
- workspace: `.sloppy/meta-runtime`
- session: memory only

Workspace state wins over global state for the same id, and session state wins
over both. Persistence is scoped: saving a workspace change writes only
workspace-owned state, proposals, and events rather than copying the merged
runtime view into the workspace file. Replacing a layer removes only that layer,
so shadowed outer-layer state becomes visible again. Session proposals are
ephemeral unless explicitly re-proposed with a persistent scope.

Temporary non-privileged changes can apply without approval. Session-scoped deny
capability masks are treated as tightening and can auto-apply. Persistent changes
and privileged changes require approval, including global/workspace writes,
allow capability masks, executor bindings, agent spawns, and
skill activation.

## Skills

The `skills` provider remains compatible with Hermes/agentskills.io-style
`SKILL.md` directories and uses progressive disclosure. `/skills` exposes a
compact index; `skill_view(name)` loads `SKILL.md`; `skill_view(name,
file_path)` loads a supporting file under the skill directory. It reads nested
`metadata.sloppy`, category, platform, tag, and supporting-file metadata.

Agents can create and maintain procedural memory through `skill_manage`:
`create`, `patch`, `edit`, `delete`, `write_file`, and `remove_file`.
Session-scoped changes apply in memory. Workspace and global writes route
through approvals before touching persistent skill artifacts. Persistent
activation refuses to overwrite an existing skill path. If skill names collide,
precedence is session, workspace, global, builtin, then imported.

The registry mounts global/workspace skill layers beneath the configured
meta-runtime roots:

- `~/.sloppy/meta-runtime/skills`
- `.sloppy/meta-runtime/skills`

It also scans the configured builtin skill root, defaulting to `skills/`.

Meta-runtime `activateSkillVersion` records can link to skills-provider
proposals. When routed child agents are spawned through meta-runtime routes,
active skill versions are resolved through `skill_view` and frozen into the
child goal. A route fails visibly if an active skill cannot be loaded.

Self-extensibility should primarily grow through skills. If a recurring
procedure can be expressed as instructions plus existing SLOP affordances, it
belongs in a skill or skill script rather than provider code. Provider code is
reserved for deterministic state mutation, exact integrations, approvals, and
safety enforcement.

## Public Consumers

First-party UIs and external clients should use the same provider/session
boundary:

- session provider for transcript, turn state, approvals, activity, tasks, and
  app/provider attachment state
- direct provider query/invoke for deeper capability-specific surfaces
- no privileged in-process UI integration

## Design Boundaries

The runtime intentionally does not include:

- built-in orchestration DAGs
- central schedulers for coding plans
- gate/digest/precedent infrastructure
- MCP-style flat tool catalogs
- special task lifecycle hooks in the kernel
- hardcoded self-repair or topology-optimization playbooks

Those features can be rebuilt as optional SLOP providers or skills if they
prove useful, but they are not part of the lean runtime.
