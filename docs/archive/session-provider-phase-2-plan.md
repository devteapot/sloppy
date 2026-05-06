# Archived: Session Provider Phase 2 Plan

This document is retained for historical context only. It captures an older
Phase 2 session-provider sketch and may mention stale counts, paths, or feature
ordering. Use these current docs for active planning:

- `docs/03-mvp-plan.md`
- `docs/06-agent-session-provider.md`
- `docs/16-tui-plan.md`

---

## Overview

This plan covers Phase 2 features for the SLOP-native agent harness based on the MVP plan (`docs/03-mvp-plan.md`), current architecture (`docs/02-architecture.md`), and session-provider spec (`docs/06-agent-session-provider.md`).

All agents must read `AGENTS.md` before starting work. All agents must follow the formatting, naming, and architecture rules from AGENTS.md.

## Archived Baseline At Time Of Draft

- **152 tests passing, 0 failures** — recorded when this draft was written
- **44 source files** across src/ (core, llm, providers, session, config) — recorded when this draft was written
- Session provider layer is fully scaffolded with store, runtime, provider, service, server
- All types are defined in `src/session/types.ts`
- Store supports: beginTurn, appendAssistantText, recordToolStart/Completion, recordApprovalRequested, syncProviderApprovals, syncProviderTasks, syncApps, cancelTurn, close
- Agent callbacks wire up text streaming, tool events, provider snapshots, external provider states
- Approval forwarding, task mirroring, and LLM profile management are operational

## Planned Features

### Feature 1: Enhanced Transcript — Binary/Media Content Blocks

**Goal:** Extend the transcript to support image/audio/video content blocks, not just text documents. This enables the session provider to represent screenshots, generated images, and other multimodal content.

**Scope:**
- Add `TranscriptMediaBlock` type with `id`, `type: "media"`, `mime`, `name`, `uri?`, `summary?`, `preview?`
- Extend `TranscriptContentBlock` union type to include media blocks
- Add `store.appendAssistantMedia()` method to record media blocks in the transcript
- Update `buildContentChildren` in `provider.ts` to handle both document and media node types
- For media nodes: set `type: "media"` and include `content` with URI references
- Add tests

**Files to change:**
- `src/session/types.ts` — add `TranscriptMediaBlock` type, union in `TranscriptContentBlock`
- `src/session/store.ts` — add `appendAssistantMedia()` method, update `cloneSnapshot`
- `src/session/provider.ts` — update `buildContentChildren` to handle media blocks
- `src/session/store.ts` tests — add media block test

**Verification:**
- `bun test src/session/store.test.ts` passes
- Typecheck passes
- `buildContentChildren` renders both document and media correctly

---

### Feature 2: Transcript Retention Policy

**Goal:** Prevent unbounded transcript growth. Implement a configurable retention policy that trims old messages while preserving the most recent N messages or messages within a time window.

**Scope:**
- Add `TranscriptRetentionPolicy` type with `maxMessages` (number, default 100), `maxTurns` (number, default 50)
- Add `TranscriptRetentionPolicy` to `SessionMetadata`
- Add `store.trimTranscript(policy?)` method that removes oldest messages
- Call `trimTranscript` automatically after each turn completes (beginTurn should check and trim first)
- Add `store.getTranscriptSize()` helper for diagnostics
- Keep trimmed messages out of the public store state (no garbage leak in snapshots)
- Add tests for retention policy edge cases

**Files to change:**
- `src/session/types.ts` — add `TranscriptRetentionPolicy` type
- `src/session/store.ts` — add `trimTranscript()`, `getTranscriptSize()`, integrate into `beginTurn`
- Tests — add retention policy tests

**Verification:**
- New messages after exceeding maxMessages cause oldest to be trimmed
- Transcript stays bounded across multiple turns
- All existing tests still pass

---

### Feature 3: Session Activity Retention — Append-Only Growth Control

**Goal:** The activity collection grows unboundedly as tool calls accumulate. Add retention to activity items similar to transcript retention.

**Scope:**
- Add configurable activity retention to session metadata
- Add `store.trimActivity(limit?)` method — keeps most recent N activity items (default 200)
- Integrate into turn completion flow so activity stays bounded
- Add tests

**Files to change:**
- `src/session/types.ts` — add `ActivityRetentionPolicy` type
- `src/session/store.ts` — add `trimActivity()`, call from turn completion
- Tests

**Verification:**
- Activity stays bounded
- Most recent activity items preserved
- All existing tests pass

---

### Feature 4: Approval and Task History Retention

**Goal:** Resolved approvals and completed tasks should be pruned after a configurable time window or count to prevent session state bloat.

**Scope:**
- Add `maxResolvedApprovals` and `maxResolvedTasks` config options
- Add `store.trimResolvedApprovals(limit?)` — removes approved/rejected/expired approvals beyond limit
- Add `store.trimResolvedTasks(limit?)` — removes completed/failed/cancelled tasks beyond limit
- Call from turn completion
- Add tests

**Files to change:**
- `src/session/types.ts` — add retention config fields to `SessionMetadata`
- `src/session/store.ts` — add trim methods, integrate into turn completion
- Tests

**Verification:**
- Resolved items pruned beyond limit
- Pending approvals and running tasks are never trimmed
- All existing tests pass

---

### Feature 5: Session Title Auto-Generation

**Goal:** When a user sends their first message, auto-generate a session title from it instead of leaving it as undefined. This is useful for the session provider's `/session` node title field.

**Scope:**
- Simple heuristic: take first 50 chars of the user message, strip punctuation, title case it
- Call from `beginTurn` in store if `session.title` is undefined
- No LLM call needed — just a deterministic transformation
- Add tests

**Files to change:**
- `src/session/store.ts` — update `beginTurn` to set title if missing
- Tests

**Verification:**
- First user message becomes session title
- Subsequent messages don't overwrite
- Long messages truncated nicely

---

### Feature 6: Session Metadata — Extended Client Tracking

**Goal:** The `/session` node already has `client_count`. Add a `connected_clients` list with timestamps for audit purposes, and add `last_activity_at` to track recent engagement.

**Scope:**
- Add `lastActivityAt` to `SessionMetadata` type
- Add `connectedClients` to `SessionMetadata` type (array of `{clientId, connectedAt}`)
- Add `store.registerClient(clientId)` and `store.unregisterClient(clientId)` methods
- Update `updateTurn` and `beginTurn` to refresh `lastActivityAt`
- Add tests

**Files to change:**
- `src/session/types.ts` — extend `SessionMetadata`
- `src/session/store.ts` — add client tracking methods, update `lastActivityAt`
- Tests

**Verification:**
- Client registration/unregistration works
- Last activity timestamp updates correctly
- All existing tests pass

---

### Feature 7: SessionService — Multi-Session Support

**Goal:** The current `SessionService` creates exactly one session. Enable multiple concurrent sessions with unique socket paths per session.

**Scope:**
- Add `SessionService.createSession(options)` static method that creates and starts a new session, returns `SessionService`
- Add `SessionService.listSessions()` that returns active session IDs and their socket paths
- Add `SessionService.stopSession(sessionId)` to gracefully stop a specific session
- Each session gets its own Unix socket, SlopServer, and store instance
- Socket path: `/tmp/slop/sloppy-session-{sessionId}.sock`
- Add tests

**Files to change:**
- `src/session/service.ts` — add multi-session management methods
- Tests

**Verification:**
- Multiple sessions can coexist on different socket paths
- Stopping one session doesn't affect others
- All existing tests pass

---

### Feature 8: Session Store — Event Emitter Pattern

**Goal:** Instead of a single monolithic `onChange` listener, expose typed granular events for consumers that only care about specific state changes (e.g., a UI only cares about transcript changes, not LLM state changes).

**Scope:**
- Create `SessionStoreEvent` type: `{ type: 'turn' | 'transcript' | 'activity' | 'approvals' | 'tasks' | 'apps' | 'llm' | 'session' }`
- Add granular listeners: `store.onTurnChange(fn)`, `store.onTranscriptChange(fn)`, etc.
- Keep backward-compatible `onChange` listener
- Update `emitChange` to dispatch granular events based on which sections changed
- Add tests

**Files to change:**
- `src/session/types.ts` — add `SessionStoreEventType` type
- `src/session/store.ts` — add granular event system
- Tests

**Verification:**
- Granular listeners fire for correct event types
- Backward-compatible `onChange` still works
- All existing tests pass

---

### Feature 9: Provider Descriptor Validation at Startup

**Goal:** When external providers are discovered, validate their descriptors against the expected schema before connecting. This prevents malformed descriptors from causing cryptic runtime errors.

**Scope:**
- Add zod schema for SLOP provider descriptor validation
- Validate descriptors in `discover.ts` before creating provider connections
- Log warnings for descriptors with missing optional fields
- Skip and log errors for descriptors with missing required fields
- Add tests

**Files to change:**
- `src/providers/discovery.ts` — add validation
- Tests

**Verification:**
- Valid descriptors pass through
- Invalid descriptors are logged and skipped
- All existing tests pass

---

### Feature 10: Core Agent Loop — Streaming Tool Results

**Goal:** Improve the agent loop to handle large tool results more gracefully. When a tool result exceeds a configurable size threshold, truncate it with a summary hint.

**Scope:**
- Add `maxToolResultSize` config option (default 4096 chars)
- In `loop.ts`, check tool result size before adding to context
- If exceeded, truncate and append `"[truncated: X chars removed, use slop_query_state for full details]"`
- Add tests for truncation behavior
- Ensure the truncation message itself doesn't exceed the limit

**Files to change:**
- `src/config/schema.ts` — add `maxToolResultSize` to config
- `src/core/loop.ts` — add truncation logic
- Tests

**Verification:**
- Large results are truncated with informative message
- Small results are untouched
- Typecheck and lint pass

---

## Execution Order

Execute features in this order to maximize efficiency and minimize rework:

1. **Feature 1** — Enhanced Transcript (media blocks) — foundational
2. **Feature 2** — Transcript Retention — builds on store patterns
3. **Feature 3** — Activity Retention — same pattern as #2
4. **Feature 4** — Approval/Task History Retention — same pattern as #2, #3
5. **Feature 5** — Session Title Auto-Generation — simple, low-risk
6. **Feature 6** — Client Tracking — builds on session metadata
7. **Feature 8** — Event Emitter Pattern — refactors store eventing
8. **Feature 7** — Multi-Session Support — depends on store stability
9. **Feature 9** — Provider Descriptor Validation — provider layer
10. **Feature 10** — Tool Result Truncation — core loop, independent

## Testing Discipline

- Run narrowest test first: `bun test <specific-test-file>`
- After targeted tests pass, run full suite: `bun test`
- Run typecheck: `bun run typecheck`
- Run lint: `bun run lint`
- Fix any lint errors before committing
- Never suppress lint warnings casually

## Branch Strategy

- Feature branches: `feature/<name>` (e.g., `feature/media-transcript`)
- Work on each feature in isolation
- Test and lint on each feature branch before submitting
- No merge conflicts between features — each is self-contained

## Notes for Agents

- Read AGENTS.md first
- Read docs/02-architecture.md for architecture context
- Read docs/03-mvp-plan.md for implementation context
- Read docs/06-agent-session-provider.md for session-provider spec
- Use `bun` for all package management
- Use `bun test` for testing
- Use `bun run typecheck` for type checking
- Use `bun run lint` for linting
- Follow all formatting, naming, and architecture rules from AGENTS.md
- Write TypeScript, not JavaScript
- Use `import type` for type-only imports
- Use 2-space indentation, semicolons, trailing commas
- Name functions after behavior (e.g., `trimTranscript`, not `handleTranscript`)
- Add tests for new behavior
- Cover both success and failure paths
- No live-network dependencies in tests
