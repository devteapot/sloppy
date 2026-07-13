# MVP Plan

The MVP is a lean SLOP-native runtime plus an optional meta-runtime provider.
The goal is extensibility through provider state and agent communication, not a
built-in orchestrator.

## Current Baseline

Checked in now:

- Bun/TypeScript runtime scaffold
- native Anthropic, Gemini, OpenAI-compatible, and OpenAI Codex subscription
  adapters
- endpoint/protocol-based LLM config with built-in endpoint catalog,
  config-defined custom OpenAI-compatible endpoints, env/secure-store/no-auth
  auth modes, and `session-agent` profiles for adapter-backed main sessions
- `ConsumerHub` with query, invoke, subscriptions, approvals, and dynamic tools
- bounded same-turn parallel execution for `query_state` and explicitly
  idempotent, non-dangerous affordance calls, preserving original result order
- explicit runtime ownership seams for model-turn orchestration, tool
  execution/scheduling, provider connection lifecycle, session assembly, and
  child-session construction, with no runtime import cycles
- typed runtime-service bindings for stable same-process dependencies, with
  SLOP providers reserved for agent context and dynamic provider integration
- public SDK entrypoints for core embedding, SLOP consumption, sessions, and
  first-party plugin composition
- default first-party plugins: `apps`, `terminal`, `filesystem`
- optional first-party plugin providers: `persistent-goal`, `memory`, `skills`, `web`,
  `browser`, `cron`, `messaging`, `delegation`, `spec`, `vision`, `mcp`, `workspaces`,
  `a2a`, `meta-runtime`
- typed Session and Supervisor APIs on one Unix socket each, with the standalone
  WS gateway (`sloppy gateway`) exposing only typed `/api/*` routes
- typed public session supervisor for scoped session creation, per-client session
  selection, launch-scope resume metadata, stopping/restoring sessions, and
  keeping each session on its own provider socket
- first-party session runtime plugin manager, surfaced through typed client
  contributions and a compact agent-facing `/plugins` projection, for
  contributed session nodes, extension event projections, runtime-local turn
  tools, queued or automatic plugin turns, snapshot migration/recovery hooks,
  lifecycle hooks, policy rules, audit metadata, supervisor summary fields, and
  client-agnostic action, indicator, and notification manifests
- generic public session extension metadata, with opt-in `/goal` projected from
  the extension-backed `persistent-goal` skill state by the `persistent-goal`
  session plugin for persistent objective controls, usage accounting, cleanup
  retention, and automatic continuation while active
- TypeScript/pi-tui TUI under `apps/tui` that consumes the typed Session and
  Supervisor APIs, starts or reuses a launch-scope managed
  supervisor by default, can attach through an explicit session supervisor, and
  exposes a runtime route for meta-runtime proposal review/apply/revert
- ACP-backed delegated child sessions behind the same session-provider boundary,
  with explicit `slop_wait_for_delegation_event` joins plus child follow-up,
  result retrieval, approval forwarding, and close controls
- ACP adapters selectable as first-class main-session LLM profiles behind the
  same session-provider boundary
- native `openai-codex` profiles for ChatGPT/Codex subscription models, backed
  by the Codex CLI auth store created by `codex login`; auth-file discovery and
  OAuth refresh are isolated from the model protocol adapter
- runtime smoke harness (`bun run runtime:smoke`) covering provider-level
  meta-runtime routing plus native and ACP delegated-child modes
- opt-in live headless CLI e2e (`SLOPPY_RUN_LIVE_E2E=1 bun test
  tests/cli-headless-e2e.test.ts`) covering `-p`, the configured LLM, and the
  filesystem provider in one run
- filesystem snapshot-backed `edit_range`, where reads cache provider-owned
  source views and line-range edits validate against the remembered old text
  before writing
- filesystem File views, where text reads load provider-owned `/views`
  state and return compact references instead of file bodies in Tool-result
  history
- runtime doctor (`bun run runtime:doctor`) with core checks plus first-party
  plugin contributions for live OpenAI-compatible routers, configured ACP
  adapters, startup subprocess commands, persistence, audit, socket, and
  workspace-path readiness before a smoke run

The previous orchestration provider, scheduler, task DAG, and orchestrator role
were removed from v1. Planning and delegation are expected to emerge from
providers, skills, routes, and agent-to-agent channels.

## MVP Capabilities

1. Keep the kernel small.
   - No workflow-specific policy in core.
   - No task context or delegation lifecycle coupling.
   - No built-in task scheduler.
   - Delegation joins are explicit runtime-local waits owned by the active
     parent turn, not autonomous parent continuations.

2. Make state the contract.
   - Providers expose observable state first.
   - Affordances mutate provider-owned state.
   - Default projections are decision surfaces, not complete serialization:
     prefer counts, summaries, bounded previews, and collection children;
     expose large or diagnostic detail through focused query or inspect/view/read.
   - Do not add `list_*` affordances when the same inventory is already provider
     state, and do not expose storage paths or raw configuration without a
     concrete agent decision that requires them.
   - Providers own their Default projection; after that, the Agent drives
     detail explicitly with Observation tools and Provider affordances.
   - The Hub owns State projection for the Agent-facing state tail. Sloppy does
     not use salience filtering or node-count compaction in that projection.
   - Session `/apps.query_provider` returns provider-owned SLOP nodes as-is;
     Sloppy does not strip external App metadata such as `salience` or `focus`.
   - External app discovery lists descriptor-backed apps as unloaded app cards
     by default. Agents explicitly load and unload apps from the first-party
     `apps` provider's `/available` node so they can shrink or restore provider
     context per task.
   - Observation tools use unbranded verb-first names: `query_state`,
     `focus_state`, and `unfocus_state`.
   - The filesystem provider keeps source-view validation local to the
     provider; the model can reference lines and source versions without
     carrying hashes or old text through the prompt.
   - Filesystem text reads create provider-owned File views under
     `/views` and return compact references. Loaded File views are included in
     the filesystem Default projection until explicitly closed; stale views are
     marked instead of silently refreshed.
   - UIs consume the same provider/session boundary as agents.
   - Parallel model-emitted tool calls are a scheduling optimization only:
     read-only state queries and explicit idempotent affordances can overlap,
     while mutating, approval-gated, local, or unknown calls remain ordered.

3. Ship the meta-runtime as an optional provider.
   - Model agent profiles, nodes, channels, routes, capabilities, executor
     bindings, skill versions, topology experiments, evaluations, reusable
     topology patterns, proposals, and events.
   - Apply safe session changes directly.
   - Require approval for persistent or privileged changes.
   - Dispatch typed route envelopes to delegated agents or messaging channels
     through typed runtime services, while their SLOP providers remain the
     agent-facing projection. Forward capability masks into delegated child
     runtime policy and support fanout or sampled canary routes when requested.
   - Match routes against envelope body, topic, channel id, or metadata paths
     with explicit substring/exact/prefix/regex/exists modes while preserving
     the older body-substring default.
   - Export and import portable runtime bundles that include meta-runtime state
     and active skill-version contents while excluding secrets.
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
     route repair, topology experiment evaluation, topology pattern authoring,
     and skill curation should be skill playbooks over provider state, not
     hardcoded runtime policy.
   - Add enough skill authoring surface for agent-maintained procedural memory:
     linked-file reads and patch/edit/write support are implemented through
     `skill_view` and `skill_manage`; usage telemetry and a built-in
     `skill-curator` workflow are in place before broad autonomous skill growth.

5. Keep session routing lightweight.
   - Represent channels and routes as SLOP state.
   - Do not add a daemon, external chat bridge, or sandbox worker fleet in MVP.

6. Keep MCP as compatibility.
   - Expose configured MCP servers through an optional SLOP provider.
   - Preserve MCP tool/resource/prompt inventories as provider state before
     exposing invocation affordances.
   - Do not let MCP reintroduce a flat tool-catalog architecture into core.

7. Keep A2A as external interoperability.
   - Expose configured Agent Cards, declared skills, selected JSON-RPC
     interfaces, and remote task lifecycle through an optional SLOP provider.
   - Use A2A for collaboration with opaque external agents.
   - Keep internal agent-to-agent topology in `meta-runtime`, `delegation`, and
     `messaging` so state observation, capability masks, and skill-led
     self-evolution remain first-class.

8. Make workspace/project scope observable.
   - Expose configured workspace and project roots as optional provider state.
   - Show global/workspace/project config layer order before a scoped session
     is launched.
   - Load scoped session config layers for `session:serve` and managed TUI
     launches, pinning terminal/filesystem roots to the selected scope.
   - Expose a public session supervisor for scoped session creation, per-client
     selection, launch-scope resume metadata, and stop/restore without adding
     scheduling or provider rewiring to core.

## Remaining Non-MVP Work

- Add a first-class identity provider if persona/preferences/role memory need a
  durable home beyond the current meta-runtime bundle substrate.
- Add autonomous scheduling or identity-level review around the existing
  `skill-curator` workflow before enabling broad autonomous skill growth.
- Add richer side-by-side session detail views if supervised workflows need
  transcript comparison beyond the current supervisor-published turn/goal
  summary state.

## Verification

Required checks for architecture-sensitive changes:

```sh
bun run preflight
```

For targeted runtime work, use the narrower checks that match the touched
surface:

```sh
bunx tsc --noEmit
bun test tests/meta-runtime-*.test.ts
bun test tests/skills-provider.test.ts
bun test tests/delegation-provider.test.ts
bun test tests/kernel-boundary.test.ts
bun test tests/runtime-doctor.test.ts
bun test tests/runtime-smoke.test.ts
```

Run `bun run test` after touching shared runtime, provider registry, session, or
approval behavior.
