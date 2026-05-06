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
- `docs/16-tui-plan.md` for the TypeScript/OpenTUI TUI architecture and UX plan.
- External SLOP spec: `~/dev/slop-slop-slop/spec/`.

## Working Reality
- This project is a SLOP-native agent harness, not an MCP-first tool wrapper.
- State observation is primary; affordance invocation is secondary.
- Provider-native tool calling is only the LLM adapter layer, not the architecture.
- Built-in capabilities are implemented as SLOP providers.
- The current implementation includes built-in `terminal`, `filesystem`, `memory`, `skills`, `meta-runtime`, `spec`, and `delegation` providers, a consumer hub, dynamic affordance tools, fixed observation tools, a native Anthropic adapter, a native Gemini adapter, an OpenAI-compatible adapter for OpenAI, OpenRouter, and Ollama, optional ACP/CLI-backed `SessionAgent` paths for delegated third-party child agents, and a managed LLM-profile layer with secure credential storage for macOS and Linux. The `skills` provider supports Hermes-style `SKILL.md` discovery, builtin/global/workspace/imported/session scopes, progressive `skill_view`, supporting files, `metadata.sloppy`, and approval-gated `skill_manage` writes. ACP delegated adapters declare capabilities in config, and routed or allow-masked ACP spawns are rejected when the adapter declaration does not satisfy the child surface. The `meta-runtime` provider supports typed proposals for agent profiles, nodes, channels, typed route envelopes, capability masks, executor bindings, skill versions whose content is frozen into routed child goals, topology experiments/evaluations, canary route sampling, scoped global/workspace/session storage, topology pattern records, and capability-mask enforcement in delegated child runtimes. Hermes-style skill-led self-evolution means reusable diagnosis, repair, architect prompts, scoring rubrics, and topology-pattern playbooks live in skills over provider state, not as hardcoded runtime policy.
- The current checked-in interfaces are a CLI/REPL, a headless `src/session/` agent-session surface with `/llm` onboarding state and `/apps` external-provider attachment visibility, a TypeScript/OpenTUI TUI under `apps/tui/` that consumes the public session-provider socket, and a canvas/HTML dashboard prototype under `apps/dashboard/`.

## Package Manager, Runtime, And Commands
- Use `bun` for package management and script execution.
- Do not introduce `npm`, `pnpm`, or `yarn` lockfiles.
- Current checked-in commands:

```sh
bun install
bun run build
bun run dashboard:serve
bun run lint
bun run runtime:doctor
bun run runtime:smoke
bun run session:serve
bun run tui
bun run tui:typecheck
bun run typecheck
bun run test
```

- Current test runner: Bun's built-in runner.
- Preferred single-test commands:

```sh
bun test
bun test tests/filesystem-provider.test.ts
bun test tests/filesystem-provider.test.ts --test-name-pattern "writes files"
bun test tests/agent-session-provider.test.ts
bun test tests/acp-capabilities.test.ts
bun test tests/cli-session-agent.test.ts
bun test tests/delegation-provider.test.ts
bun test tests/meta-runtime-provider.test.ts
bun test tests/runtime-doctor.test.ts
bun test tests/runtime-smoke.test.ts
bun test tests/terminal-provider.test.ts
bun test tests/openai-compatible-adapter.test.ts
bun test tests/gemini-adapter.test.ts
bun test tests/tui-session-client.test.ts
```

- Run the narrowest test slice that proves your change.
- After targeted tests pass, run the broader suite if your change touched shared runtime behavior.

## Current Layout

```text
apps/
  dashboard/
  tui/
src/
  cli.ts
  index.ts
  config/
    persist.ts
  core/
  llm/
    anthropic.ts
    credential-store.ts
    factory.ts
    gemini.ts
    openai-compatible.ts
    profile-manager.ts
    provider-defaults.ts
    types.ts
  providers/
  runtime/
    acp/
    delegation/
  session/
tests/
docs/
```

## Architecture Rules
- Everything is a SLOP provider.
- Prefer state-first design over tool-first design.
- Keep the core small; push capability-specific logic into providers.
- Keep providers small when behavior can be expressed as instructions plus existing affordances; reusable self-evolution strategy belongs in skills.
- Do not add built-in orchestration DAGs, schedulers, or task-lifecycle hooks to core.
- Model agent-to-agent restructuring through SLOP provider state such as `meta-runtime`, not privileged runtime branches.
- Prefer live subscriptions and patches over repeated polling.
- Use protocol vocabulary consistently: `provider`, `consumer`, `state tree`, `affordance`, `snapshot`, `patch`, `query`, `invoke`, `salience`, `summary`.
- Do not reintroduce MCP-style flat tool catalogs into the core architecture.
- Observation tools such as `slop_query_state` and `slop_focus_state` are consumer controls, not provider capabilities.
- Prefer a public session provider or bridge for UIs over privileged in-process UI integrations.
- Treat first-party UIs as consumers of the same boundary that third-party UIs will use.

## Import And SDK Guidance
- Use ESM `import`/`export` syntax.
- Prefer named exports for reusable values, functions, and types.
- Use `import type` for type-only imports.
- Group imports in this order: platform/external packages, workspace modules, relative modules.
- Avoid circular dependencies between `core`, `providers`, and `llm`.
- Keep config loading, provider wiring, protocol handling, and model logic separate.
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
