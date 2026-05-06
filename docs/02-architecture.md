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
- session provider and session supervisor providers for UI and API consumers
- durable public session snapshots with explicit stale-turn recovery
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
`spec`, `mcp`, `workspaces`, `a2a`, and `meta-runtime`.

## MCP Compatibility

MCP support is an optional provider, not a second runtime architecture. The
`mcp` provider connects to configured MCP servers through the official
TypeScript SDK and projects their tools, resources, resource templates, and
prompts into SLOP state under `/servers`.

The model observes MCP servers the same way it observes every other capability:
status, inventory, errors, and server metadata appear first, while affordances
such as `refresh`, `call_tool`, `read_resource`, prompt retrieval, and
per-tool `call` remain secondary. Dangerous MCP tool annotations are preserved
on the projected SLOP affordance so the hub-level approval policy can see them.

This keeps MCP useful as ecosystem compatibility while preserving the
SLOP-native provider/state boundary for first-party runtime design.

## A2A Interoperability

A2A support is also an optional provider, not the internal agent-to-agent
architecture. The `a2a` provider fetches configured Agent Cards, selects the
first supported JSON-RPC interface, and projects remote agent capabilities into
SLOP state:

- `/agents` lists configured external agents, selected interface URLs,
  capability flags, default input/output modes, and declared skills.
- `/agents/<id>/skills` exposes Agent Card skills as state before the model
  sends work to that agent.
- `/tasks` tracks remote A2A tasks observed through `SendMessage`, `GetTask`,
  `ListTasks`, and `CancelTask`.

The provider sends `A2A-Version` headers, supports env-backed bearer/API-key
credentials, and keeps remote protocol errors visible as provider state. It
does not replace `meta-runtime`, `delegation`, or `messaging`; those remain the
SLOP-native substrate for internal topology, capability masks, child sessions,
and state-rich routing.

## Workspace And Project Scopes

The optional `workspaces` provider exposes a registry of folder-bound
workspaces and projects. It is state, not a privileged session manager:

- `/workspaces` lists configured workspace roots and workspace config paths.
- `/projects` lists projects for the active workspace.
- `/config` reports the active config layer order: global, workspace, project.

Selecting a workspace or project changes the provider's active scope and returns
the config layers a scoped session should load. This gives UIs and future
session orchestration a public SLOP boundary for project selection without
adding multi-session scheduling or provider rewiring to core.

The session launcher uses the same layer model. A scoped launch merges home,
workspace, and project config files in that order, then pins terminal and
filesystem roots to the selected workspace/project folder before provider
normalization. Workspace/project-scoped MCP servers, A2A agents, skills, and
meta-runtime storage therefore remain ordinary provider config rather than
special runtime branches.

## Session Supervisor

The session supervisor is a public SLOP provider for managing multiple ordinary
agent sessions. It is separate from the per-session provider:

- `/session` reports the active session id/socket and exposes `create_session`
  and `set_active_session`.
- `/sessions` lists running session-provider sockets and exposes per-session
  `set_active` and `stop` affordances.
- `/scopes` lists configured workspace/project scopes that can launch new
  scoped sessions.

Managed TUI mode starts a supervisor first, then attaches to the active
session's public provider socket. Switching sessions changes the TUI's socket;
it does not collapse multiple sessions into one provider tree. Each child
session still loads config through the normal scoped launcher and still exposes
the standard `/session`, `/llm`, `/turn`, `/goal`, `/composer`, `/queue`,
`/transcript`, `/activity`, `/approvals`, `/tasks`, and `/apps` surface.

The supervisor owns lifecycle bookkeeping only. It does not schedule work,
route tasks, mutate provider wiring, or become a privileged orchestrator.

## LLM Context Tail

The model sees current provider state as an ephemeral `<slop-state>` tail,
rebuilt on every model request and never persisted into conversation history.
The tail uses the canonical text tree projection with salience/view filtering,
preserves provider boundaries, and escapes forged SLOP context tags inside
provider-controlled text. This follows the SLOP integration pattern in
`~/dev/slop-slop-slop/spec/integrations/llm-context.md`: stable conversation
history remains before the volatile state tail so prompt-cache prefixes stay
usable while the model still reasons over fresh state.

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
  profile instructions, executor binding, resolved capability masks, and
  selected skill versions.
- `channel:<id>` targets invoke `messaging.channels/{id}.send`.

Dispatch can run in single-target mode or fanout mode. Routes can carry
`matchField`, `matchMode`, and `caseSensitive` metadata for typed envelope
matching over body, topic, channel id, or metadata paths. They can also carry
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
`metadata.sloppy`, category, platform, tag, and supporting-file metadata. The
index also exposes lightweight usage telemetry (`view_count`,
`last_viewed_at`, and aggregate `skill_views_count`) so curator skills can
review which procedural memories are actually being used. The built-in
`skill-curator` skill uses this state plus transcript/activity evidence to
propose minimal `skill_manage` changes without adding a scheduler or repair
policy to the runtime.

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
proposals. Session skill proposals may activate during meta-runtime proposal
apply; workspace/global skill proposals must be activated through the skills
provider first. When routed child agents are spawned through meta-runtime
routes, selected active skill versions from `profile.defaultSkillVersionIds` and
`agent.skillVersionIds` are resolved through `skill_view` and frozen into the
child goal. A route fails visibly if a selected skill cannot be loaded or if the
agent has no explicit capability mask.

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
- session supervisor for multi-session listing, scoped creation, switching, and
  stopping
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
