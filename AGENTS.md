# AGENTS.md

## Repository Snapshot
- This repository is pre-alpha, but it is no longer docs-only.
- Checked in today: `package.json`, `tsconfig.json`, `biome.json`, `src/`, `apps/`, `tests/`, `README.md`, `CLAUDE.md`, `docs/`.
- There is a Bun lockfile and a working Bun/TypeScript scaffold.
- There is no `.cursor/rules/` directory.
- There is no `.cursorrules` file.
- There is no `.github/copilot-instructions.md` file.
- Existing high-level project guidance still lives in `CLAUDE.md`, but this file is the operational source for coding agents in this repo.

## Primary Sources Of Truth
- `README.md` for the current status and developer workflow.
- `docs/README.md` for the documentation map and active/archive split.
- `docs/02-architecture.md` for the current SLOP-first runtime design.
- `docs/03-mvp-plan.md` for the implementation plan and near-term roadmap.
- `docs/04-slop-protocol-reference.md` for protocol vocabulary and message semantics.
- `docs/05-language-evaluation.md` for stack decisions.
- `docs/06-agent-session-provider.md` for the concrete session-provider state and affordance shape.
- `docs/13-meta-runtime.md` for the optional topology/evaluation provider and skill-led self-evolution boundary.
- `docs/16-tui-plan.md` for the TypeScript/pi-tui TUI architecture and UX plan.
- `docs/17-operator-runbook.md` for production-style runtime checks, audit, recovery, and operational procedures.
- External SLOP spec: `~/dev/slop-slop-slop/spec/`.

## Working Reality
- This project is a SLOP-native agent harness, not an MCP-first tool wrapper.
- State observation is primary; affordance invocation is secondary.
- Provider-native tool calling is only the LLM adapter layer, not the architecture.
- Built-in capabilities are implemented as SLOP providers.
- Stable same-process dependencies are assembled through typed runtime services;
  SLOP is the agent-context projection and dynamic provider integration
  boundary, not the internal dependency-injection or ordinary UI transport.
- Application clients use the typed Session/Supervisor SDK over in-process,
  Unix-socket, or WebSocket transports. The SLOP session provider is a compact
  deliberate agent-context projection.
- Transported clients receive an initial typed snapshot followed by coalesced
  incremental patches; streamed text uses append patches and slow clients keep
  only the latest pending snapshot. The headless CLI uses the typed in-process
  Session binding, and the in-process Supervisor API uses the same camelCase
  contract as remote clients.
- The current implementation includes default first-party plugin providers for `apps`, `terminal`, and `filesystem`, opt-in first-party plugin providers for `memory`, `skills`, `meta-runtime`, `spec`, `delegation`, `mcp` compatibility, `workspaces` scope, and `a2a` interoperability, a consumer hub, dynamic affordance tools, fixed observation tools, native Anthropic, Gemini, and OpenAI Responses adapters, an OpenAI-compatible Chat Completions adapter for OpenRouter, Ollama, and custom routers, a native OpenAI Codex subscription adapter that reuses the Codex CLI auth store, ACP-backed `SessionAgent` paths for delegated third-party child agents and first-class main-session LLM profiles, a typed Session API with FIFO queued input, generic extension metadata, client-agnostic plugin commands and contributions, plus a compact SLOP session projection for agent context, plugin-contributed doctor checks and subprocess probes, an opt-in public session `/goal` projection contributed by the `persistent-goal` session plugin over extension-backed `persistent-goal` skill state for long-running objectives, a typed public session supervisor for scoped session create/select/stop/restore over Unix sockets or `/api/*` WebSocket endpoints with launch-scope resume metadata and connection-bound client leases, durable public session snapshots with explicit stale-turn recovery, and a managed LLM-profile layer with secure credential storage for macOS and Linux. Live Sessions lease their effective managed profile through the Supervisor-shared binding registry, move that lease with dynamic route selection, release it after active inner work settles on shutdown, and project removed explicit routes as unavailable. Native adapters share a typed protocol-driver registry, exact-issuer private continuation replay, executable model limits/capabilities, and bounded request resilience. First-party plugin config now lives under top-level `plugins.<plugin-id>`; `providers.*` is reserved for live provider discovery. The model sees provider state as an ephemeral escaped `<slop-state>` tail, not persisted history. The `apps` plugin provider projects discovered external provider descriptors as unloaded-by-default app cards under `/available` and exposes explicit load/unload controls for agent-driven context management. The `mcp` plugin provider projects configured MCP server tools, resources, templates, and prompts into SLOP state under `/servers`; it is compatibility glue, not the core architecture. The `workspaces` plugin provider exposes configured workspaces/projects and their global/workspace/project config layer order as SLOP state; it is a scope foundation, not privileged multi-session orchestration. The Supervisor owns typed session bookkeeping only, not scheduling, provider rewiring, or a SLOP transport. The `a2a` plugin provider projects external Agent Cards, declared skills, selected JSON-RPC interfaces, and remote task lifecycle into SLOP state under `/agents` and `/tasks`; it is an external interoperability bridge, not the internal agent-to-agent architecture. The `skills` plugin provider supports Hermes-style `SKILL.md` discovery, builtin/global/workspace/imported/session scopes, progressive `skill_view`, supporting files, `metadata.sloppy`, startup readiness, lightweight usage telemetry, and approval-gated `skill_manage` writes. ACP delegated adapters declare capabilities in config, default to a minimal subprocess environment, enforce hard prompt timeouts, and routed or allow-masked ACP spawns are rejected when the adapter declaration does not satisfy the child surface. The `meta-runtime` plugin provider supports typed proposals for agent profiles, nodes, channels, typed route envelopes, capability masks, executor bindings, selected skill versions whose content is frozen into routed child goals, topology experiments/evaluations, canary route sampling, scoped global/workspace/session storage, topology pattern records, and capability-mask enforcement in delegated child runtimes. Hermes-style skill-led self-evolution means reusable diagnosis, repair, architect prompts, scoring rubrics, skill curation, extension-specific behavior such as persistent goals, and topology-pattern playbooks live in skills over provider state, not as hardcoded runtime policy.
- Supervised sibling Sessions coordinate profile bindings through a shared registry even though each retains its scoped profile manager; delegated children inherit the parent manager and registry. In-flight inner routes retain leases across profile changes, native approval continuations pin their original adapter, and profile/credential mutations are mutually exclusive and revision-checked against stale sibling managers.
- Async profile config loads and native adapter creation validate a captured registry generation; credential-only mutations also invalidate in-flight adapter reads. Delegated children preserve reduced non-LLM/plugin config and merge only the inherited manager's `llm` section. Deferred Session teardown is exposed as a non-selectable `stopping` state until active work and leases settle.
- The agent loop may execute contiguous same-turn `query_state` calls and explicitly idempotent, non-dangerous affordance calls concurrently with bounded fanout. It keeps result blocks in original model order; focus changes, local/session controls, malformed calls, unknown tools, approvals, and unmarked or mutating affordances remain sequential barriers.
- `session:serve`, `session:serve -- --supervisor`, and managed TUI sessions can load selected workspace/project config layers with `--workspace-id` and `--project-id`; the launcher pins terminal/filesystem roots to the selected scope while keeping provider wiring in normal config. Session and Supervisor Unix sockets speak only the typed client protocol; `sloppy gateway` exposes `/api/supervisor` and `/api/sessions/{id}` without legacy SLOP routes. Managed TUI launch resolves a launch scope from `realpath(process.cwd())`, reuses that scope's supervisor, creates a fresh Session by default, and selects the launch-scope resume Session only for `sloppy --continue`.
- The typed session snapshot exposes generic extension metadata and client-agnostic plugin contributions. Its compact SLOP projection exposes `/extensions`, plugin ownership metadata at `/plugins`, and deliberate feature projections such as opt-in `/goal`. Plugin-owned client actions invoke typed plugin commands; presentation hints may include TUI slash metadata but execution must not branch on the TUI. Keep reusable goal strategy in the `persistent-goal` skill; do not add planner-specific DAG policy to core.
- The current checked-in interfaces are a CLI/REPL, a headless typed `src/session/` API with a compact SLOP agent projection, a typed public session supervisor, and a TypeScript/pi-tui TUI under `apps/tui/` that consumes typed session/supervisor Unix sockets or `/api/*` WebSocket endpoints.

## Package Manager, Runtime, And Commands
- Use `bun` for package management and script execution.
- Do not introduce `npm`, `pnpm`, or `yarn` lockfiles.
- Current checked-in commands:

```sh
bun install
bun run benchmark:filesystem-view-edits
bun run benchmark:headless-view-edits
bun run build
bun run lint
bun run preflight
bun run runtime:doctor
bun run runtime:smoke
bun run session:serve
bun run src/bin/sloppy.ts
bun run tui
bun run tui:typecheck
bun run typecheck
bun run test
```

- The packaged CLI is `sloppy`; in source, use `bun run src/bin/sloppy.ts` for the same router. Headless CLI single-shot mode uses `bun run src/bin/sloppy.ts -p "<prompt>"`; add `--yolo` to start the session with approval mode set to `auto`. The legacy `bun run src/cli.ts -p "<prompt>"` path is still available for focused CLI loops and also accepts `--yolo`.
- Current test runner: Bun's built-in runner.
- Preferred single-test commands:

```sh
bun test
bun test tests/filesystem-provider-*.test.ts
bun test tests/filesystem-provider-*.test.ts --test-name-pattern "writes files"
bun test tests/agent-session-*.test.ts
bun test tests/acp-capabilities.test.ts
bun test tests/delegation-provider.test.ts
bun test tests/meta-runtime-*.test.ts
bun test tests/runtime-doctor.test.ts
bun test tests/runtime-smoke.test.ts
bun test tests/terminal-provider.test.ts
bun test tests/openai-compatible-adapter.test.ts
bun test tests/gemini-adapter.test.ts
bun test tests/tui-manifest-mapping.test.ts tests/tui-node-mappers.test.ts tests/tui-session-clients.test.ts
```

- Opt-in live LLM/runtime e2e:

```sh
SLOPPY_RUN_LIVE_E2E=1 bun test tests/cli-headless-e2e.test.ts
```

- Run the narrowest test slice that proves your change.
- After targeted tests pass, run the broader suite if your change touched shared runtime behavior.

## Current Layout

```text
apps/
  tui/
src/
  agent.ts
  cli.ts
  index.ts
  config/
    environment.ts
    json.ts
    llm-migrations.ts
    persist.ts
  core/
    loop/
  llm/
    anthropic.ts
    catalog.ts
    credential-store.ts
    factory.ts
    gemini.ts
    openai-codex-auth.ts
    openai-codex.ts
    openai-compatible.ts
    openai-responses-protocol.ts
    openai-responses-stream.ts
    openai-responses.ts
    profile-manager.ts
    resilience.ts
    runtime-config.ts
    types.ts
  providers/
  plugins/
    first-party/
      catalog.ts
      doctor-facets.ts
      manifest.ts
      policy-facets.ts
      service-keys.ts
      session-facets.ts
  runtime/
    acp/
    child-session.ts
    delegation/
    services.ts
  sdk/
    core.ts
    plugins.ts
    session.ts
    slop.ts
  session/
    runtime-assembly.ts
    runtime-contracts.ts
tests/
docs/
```

## Architecture Rules
- Everything visible to agents has a deliberate SLOP provider projection.
  Stable same-process dependencies use typed runtime services; ordinary app
  clients use typed Session/Supervisor APIs.
- Prefer state-first design over tool-first design.
- Treat a Default projection as a decision surface, not a serialization dump:
  prefer summaries, counts, previews, and collection children, with verbose
  detail behind focused query or inspect/view/read affordances.
- Keep the core small; push capability-specific logic into providers.
- Keep providers small when behavior can be expressed as instructions plus existing affordances; reusable self-evolution strategy belongs in skills.
- Do not add built-in orchestration DAGs, schedulers, or task-lifecycle hooks to core.
- Model agent-to-agent restructuring through SLOP provider state such as `meta-runtime`, not privileged runtime branches.
- Prefer live subscriptions and patches over repeated polling.
- Use protocol vocabulary consistently: `provider`, `consumer`, `state tree`, `affordance`, `snapshot`, `patch`, `query`, `invoke`, `salience`, `summary`.
- Do not reintroduce MCP-style flat tool catalogs into the core architecture.
- Observation tools such as `query_state`, `focus_state`, and `unfocus_state` are Hub-owned consumer controls, not provider capabilities.
- Prefer the public typed Session/Supervisor SDK for UIs over SLOP path/action
  coupling or privileged in-process UI integrations.
- Treat first-party UIs as consumers of the same boundary that third-party UIs will use.
- Keep provider and runtime entrypoints focused on state ownership and orchestration. Move protocol
  parsing, descriptor assembly, pure state transitions, and reusable contracts into domain-named
  sibling modules when those responsibilities become independently substantial.
- Treat file length as a diagnostic rather than a quota. Split by behavioral ownership; do not
  create generic utility modules or artificial wrappers solely to reduce line counts.

## Import And SDK Guidance
- Use ESM `import`/`export` syntax.
- Prefer named exports for reusable values, functions, and types.
- Use `import type` for type-only imports.
- Group imports in this order: platform/external packages, workspace modules, relative modules.
- Avoid circular dependencies between `core`, `providers`, and `llm`.
- Keep config loading, provider wiring, protocol handling, and model logic separate.
- Use `sloppy/core`, `sloppy/slop`, `sloppy/session`, and `sloppy/plugins` as the
  public embedding boundaries; do not make consumers import implementation files.
- Prefer the browser-safe consumer entrypoint: `@slop-ai/consumer/browser` for browser-safe code.
- Use the top-level `@slop-ai/consumer` entrypoint only for Node/Bun-only consumers such as `apps/tui`, where `NodeSocketClientTransport` is required.
- Use the npm-installed SLOP SDK packages for TypeScript code, not local workspace links to the sibling SLOP repo.

## Formatting
- Use 2-space indentation.
- Use semicolons.
- Use trailing commas in multiline arrays, objects, and parameter lists.
- Match existing formatting when editing nearby code.
- Keep comments rare and useful; explain invariants or non-obvious protocol behavior.
- Run `bun run lint` after meaningful edits and fix issues rather than suppressing them casually.

## Types
- Write TypeScript, not loose JavaScript.
- Prefer explicit types at module boundaries.
- Use `unknown` instead of `any` for untrusted input.
- Narrow unknown values before use.
- Prefer discriminated unions for runtime tool resolution and message content blocks.
- Add runtime validation at external boundaries such as config, provider descriptors, and model inputs.

## Naming
- Use `camelCase` for variables, parameters, and functions.
- Use `PascalCase` for classes and type aliases.
- Use `UPPER_SNAKE_CASE` for true constants and environment variables.
- Prefer literal filenames such as `consumer.ts`, `registry.ts`, `terminal.ts`, `anthropic.ts`.
- If a filename needs multiple words, prefer `kebab-case`.
- Name functions after behavior: `buildStateContext`, `focusState`, `discoverProviderDescriptors`, `buildRuntimeToolSet`.

## Async And Concurrency
- Prefer `async`/`await` over raw promise chains.
- Model long-running work with async task state when the provider supports it.
- Follow the SLOP result model: `ok`, `error`, or `accepted` with a `taskId`.
- When an action is async, prefer exposing progress in provider state rather than blocking the loop.
- Handle partial provider failure gracefully; one broken provider should not crash the whole agent.

## Error Handling
- Do not swallow errors silently.
- Include enough context to identify the provider, path, action, or config source involved.
- Distinguish programmer errors from operational failures.
- Treat provider data and model output as fallible.
- Prefer structured results and clear tool-result errors over opaque thrown strings.
- Keep the runtime alive when graceful degradation is possible.

## Provider Guidelines

### Terminal
- Keep terminal state visible through `session`, `history`, and `tasks`.
- Dangerous commands should require explicit confirmation.
- Prefer async task exposure for long-running commands over blocking forever.

### Filesystem
- Filesystem behavior should remain stateful, not just a bag of file actions.
- Keep the focused directory, search results, and recent operations visible in provider state.
- Enforce workspace-root containment for all file operations.

## Testing Guidance
- Add tests with new behavior.
- Prefer small integration tests around the provider and consumer boundary.
- Cover both success and failure paths where practical.
- For protocol-heavy code, test `snapshot`, `query`, `invoke`, and state refresh behavior.
- Avoid live-network dependencies in the default test suite.

## Config And Secrets
- Primary config locations:
  - `~/.sloppy/config.yaml`
  - `.sloppy/config.yaml` in the workspace
- Treat `~/.sloppy/config.yaml` as the trusted LLM endpoint-routing layer.
  Workspace/project layers may select profiles and models, but must not define
  `llm.endpoints` or legacy `baseUrl`/`apiKeyEnv` fields.
- Credential-bearing LLM endpoints must use HTTPS; HTTP is only for explicit
  no-auth endpoints. Native transports reject redirects before credentials can
  be forwarded to another origin.
- Managed LLM-profile metadata is persisted in `~/.sloppy/config.yaml`.
- Persisted API keys are stored in the OS secure store, not in YAML:
  - macOS: Keychain
  - Linux: Secret Service via `secret-tool`
- Environment variables referenced by config are exposed as selectable env-backed LLM profiles instead of silently overriding the currently selected managed profile.
- Never hardcode API keys or credentials.
- Do not commit `.env` files.

## Documentation Rules For Agents
- Read the relevant design docs before changing architecture-sensitive code.
- Keep implementation, docs, and naming aligned.
- If you change commands, file layout, or architecture, update `README.md`, this file, and the matching docs.
- If you materially change the runtime design, update `docs/02-architecture.md` and `docs/03-mvp-plan.md` in the same change.
- If interface work introduces `apps/` clients or a session-provider layer, document whether it is checked in now or only planned next.
