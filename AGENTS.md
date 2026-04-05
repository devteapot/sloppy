# AGENTS.md

## Repository Snapshot
- This repository is pre-alpha, but it is no longer docs-only.
- Checked in today: `package.json`, `tsconfig.json`, `biome.json`, `src/`, `tests/`, `README.md`, `CLAUDE.md`, `docs/`.
- There is a Bun lockfile and a working Bun/TypeScript scaffold.
- There is no `.cursor/rules/` directory.
- There is no `.cursorrules` file.
- There is no `.github/copilot-instructions.md` file.
- Existing high-level project guidance still lives in `CLAUDE.md`, but this file is the operational source for coding agents in this repo.

## Primary Sources Of Truth
- `README.md` for the current status and developer workflow.
- `docs/02-architecture.md` for the current SLOP-first runtime design.
- `docs/03-mvp-plan.md` for the implementation plan and near-term roadmap.
- `docs/04-slop-protocol-reference.md` for protocol vocabulary and message semantics.
- `docs/05-language-evaluation.md` for stack decisions.
- External SLOP spec: `~/dev/slop-slop-slop/spec/`.

## Working Reality
- This project is a SLOP-native agent harness, not an MCP-first tool wrapper.
- State observation is primary; affordance invocation is secondary.
- Claude `tool_use` is only the LLM adapter layer, not the architecture.
- Built-in capabilities are implemented as SLOP providers.
- The current implementation includes built-in `terminal` and `filesystem` providers, a consumer hub, dynamic affordance tools, and fixed observation tools.

## Package Manager, Runtime, And Commands
- Use `bun` for package management and script execution.
- Do not introduce `npm`, `pnpm`, or `yarn` lockfiles.
- Current checked-in commands:

```sh
bun install
bun run build
bun run lint
bun run typecheck
bun run test
```

- Current test runner: Bun's built-in runner.
- Preferred single-test commands:

```sh
bun test
bun test tests/filesystem-provider.test.ts
bun test tests/filesystem-provider.test.ts --test-name-pattern "writes files"
bun test tests/terminal-provider.test.ts
```

- Run the narrowest test slice that proves your change.
- After targeted tests pass, run the broader suite if your change touched shared runtime behavior.

## Current Layout

```text
src/
  cli.ts
  index.ts
  config/
  core/
  llm/
  providers/
tests/
docs/
```

## Architecture Rules
- Everything is a SLOP provider.
- Prefer state-first design over tool-first design.
- Keep the core small; push capability-specific logic into providers.
- Prefer live subscriptions and patches over repeated polling.
- Use protocol vocabulary consistently: `provider`, `consumer`, `state tree`, `affordance`, `snapshot`, `patch`, `query`, `invoke`, `salience`, `summary`.
- Do not reintroduce MCP-style flat tool catalogs into the core architecture.
- Observation tools such as `slop_query_state` and `slop_focus_state` are consumer controls, not provider capabilities.

## Import And SDK Guidance
- Use ESM `import`/`export` syntax.
- Prefer named exports for reusable values, functions, and types.
- Use `import type` for type-only imports.
- Group imports in this order: platform/external packages, workspace modules, relative modules.
- Avoid circular dependencies between `core`, `providers`, and `llm`.
- Keep config loading, provider wiring, protocol handling, and model logic separate.
- Prefer the browser-safe consumer entrypoint: `@slop-ai/consumer/browser`.
- Do not switch back to the top-level `@slop-ai/consumer` entrypoint unless the published package export issue is fixed.
- Use the npm-installed SLOP SDK packages, not local workspace links to the sibling SLOP repo.

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
- Read secrets from environment variables referenced by config.
- Never hardcode API keys or credentials.
- Do not commit `.env` files.

## Documentation Rules For Agents
- Read the relevant design docs before changing architecture-sensitive code.
- Keep implementation, docs, and naming aligned.
- If you change commands, file layout, or architecture, update `README.md`, this file, and the matching docs.
- If you materially change the runtime design, update `docs/02-architecture.md` and `docs/03-mvp-plan.md` in the same change.
