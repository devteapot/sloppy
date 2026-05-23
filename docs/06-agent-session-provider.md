# Agent Session Provider

## Goal

Define the public SLOP shape for one running Sloppy agent session.

This provider is the boundary that first-party and third-party UIs should consume.

The current first-party consumer is the TypeScript/OpenTUI TUI under
`apps/tui/`.

It is intentionally session-scoped:

- one provider instance represents one agent session
- multiple consumers may attach to that same session
- the runtime stays headless behind this boundary

The agent runtime remains a consumer of workspace and application providers. The agent-session provider is the separate provider surface exposed upward to UIs and other clients.

---

## Non-goals

This provider does not attempt to expose everything the runtime knows.

Explicit non-goals for v1:

- no proxied `filesystem`, `terminal`, or external app subtrees
- no local UI state such as drafts, cursor position, pane focus, scroll offsets, or layout
- no multi-session listing or session creation flow
- no hidden chain-of-thought, private prompt-internal reasoning state, or public opaque provider continuity metadata
- no requirement that UIs understand the runtime's internal implementation details

If richer inspection is needed later, it should be added as an explicit extension rather than by turning the session provider into a mirror of all downstream providers.

Multi-session lifecycle is handled by a separate public session-supervisor
provider. The supervisor exposes launch-scope metadata, a launch-scope resume
session id for `sloppy --continue`, live and dormant session records, configured
workspace/project scopes, and create/select/stop affordances. It does not expose
one global active session; each connected UI keeps its selected session through a
connection-bound supervisor client lease. Its `/sessions` items include runtime
status plus compact live turn, goal, queue, pending approval, running task, and
last-activity summary fields so UIs can compare supervised sessions without
reading runtime internals. Each supervised session still exposes the
single-session contract described in this document.

---

## Session Model

The recommended model is one provider instance per session.

That matches the current SLOP reality that session scoping is an application concern rather than a protocol primitive.

Recommended properties of a session provider instance:

- a unique provider id for the session lifetime
- a stable root state tree while the session is active
- shared state across all connected consumers of that session
- patch-driven updates for transcript, activity, approvals, and async tasks

The provider may expose session metadata in the `hello` payload, but the state tree described below is the primary contract.

---

## Public Paths

The root tree should expose these top-level children:

- `/session`
- `/llm`
- `/usage`
- `/turn`
- `/plugins`
- `/goal`
- `/composer`
- `/queue`
- `/transcript`
- `/activity`
- `/approvals`
- `/tasks`
- `/apps`

These paths are intentionally small and human-meaningful so UIs can subscribe shallowly and deepen only where needed.

---

## Example Shape

```text
[root] agent-session: Agent Session
  [context] session (session_id="sess-123", status="active", model_provider="anthropic", model="claude-sonnet", client_count=2)
  [collection] llm (status="needs_credentials", active_profile_id="openai-main", selected_provider="openai", selected_model="gpt-5.4", secure_store_status="available")  actions: {save_profile, set_default_profile, delete_profile, delete_api_key}
    [item] openai-main (provider="openai", model="gpt-5.4", is_default=true, ready=false, key_source="missing")
  [context] usage (last_model_call_input_tokens=4200, last_model_call_output_tokens=700, last_state_context_tokens=1800, last_state_context_token_source=provider, model_context_window_tokens=1050000, available_context_tokens=1045800, total_tokens=4900)
  [status] turn (state="running", phase="tool_use", iteration=2, message="Reading workspace state")  actions: {cancel_turn}
  [collection] plugins (count=1, ui_manifest_version=1)
    [item] persistent-goal (version="1.0.0", status="active", session_paths=["/goal"])
  [control] goal (exists=true, status="active", objective="Ship the runtime", total_tokens=12000, token_budget=200000, elapsed_ms=900000)  actions: {create_goal, pause_goal, complete_goal, clear_goal}
  [control] composer (accepts_attachments=false, max_attachments=0, ready=false, queued_count=1, disabled_reason="Add an API key for openai gpt-5.4 or set OPENAI_API_KEY.")
  [collection] queue (count=1)
    [item] queued-1 (status="queued", position=1, text="then run the focused test")
  [collection] transcript
    [item] msg-1 (role="user", state="complete", turn_id="turn-1")
      [group] content
        [document] block-1 (mime="text/plain", text="list the files in the current workspace")
    [item] msg-2 (role="assistant", state="streaming", turn_id="turn-1")
      [group] content
        [document] block-1 (mime="text/plain", text="I can see the workspace and will inspect the root files...")
  [collection] activity
    [item] step-1 (kind="tool_call", provider="filesystem", path="/workspace", action="read", status="ok", summary="Read workspace root")
  [collection] approvals
    [item] approval-1 (status="pending", provider="terminal", path="/session", action="execute", reason="Command marked dangerous")  actions: {approve, reject}
  [collection] tasks
    [item] task-1 (status="running", provider="terminal", provider_task_id="task-123", message="Running tests")  actions: {cancel}
  [collection] apps
    [item] native-notes (name="Native Notes", transport="unix:/tmp/slop/native-notes.sock", status="connected", last_error=null)
```

The `/plugins/persistent-goal` and `/goal` nodes shown above are present only
when the opt-in `persistent-goal` session plugin is enabled.

---

## Node Contracts

### `/session`

Node type: `context`

Required props:

- `session_id`: stable session identifier
- `status`: `active | closing | closed | error`
- `model_provider`: selected LLM provider name
- `model`: selected model identifier
- `started_at`: ISO timestamp
- `updated_at`: ISO timestamp
- `client_count`: current number of attached consumers

Optional props:

- `title`: human-readable label for the session
- `workspace_root`: current workspace root if one exists
- `last_error`: latest session-level error summary
- `config_requires_restart`: true when provider/agent/runtime config changed
  after this session was constructed and the live provider graph has not been
  rebuilt
- `config_restart_reason`: human-readable restart reason when
  `config_requires_restart=true`
- `persistence_path`: durable snapshot path when session snapshot persistence is
  enabled
- `restored_at`: ISO timestamp when this session was restored from a persisted
  snapshot
- `recovered_after_restart`: true when a persisted in-flight turn was recovered
  as non-resumable after process restart

Affordances:

- none in v1

Rationale:

- this node is shared session metadata, not a control surface

### `/turn`

Node type: `status`

Required props:

- `turn_id`: current turn id, or `null` when idle
- `state`: `idle | running | waiting_approval | error`
- `phase`: `none | model | tool_use | awaiting_result | complete`
- `iteration`: current loop iteration count
- `started_at`: ISO timestamp or `null`
- `updated_at`: ISO timestamp
- `message`: short human-readable status summary

Optional props:

- `last_error`: latest turn-level error string
- `waiting_on`: `approval | task | model | tool | null`

Affordances:

- `cancel_turn`

Rules:

- `cancel_turn` should only be present when cancellation is actually possible
- when the session is idle, `turn_id` should be `null` and `phase` should be `none`

### `/llm`

Node type: `collection`

Required props:

- `status`: `ready | needs_credentials`
- `message`: short onboarding or readiness summary
- `active_profile_id`: selected profile id
- `selected_provider`: currently selected provider name
- `selected_model`: currently selected model identifier
- `secure_store_kind`: `keychain | secret-service | none`
- `secure_store_status`: `available | unavailable | unsupported`

Children:

- zero or more profile items

Required profile item props:

- `provider`: provider name
- `model`: selected model identifier
- `origin`: `managed | environment | fallback`
- `is_default`: boolean
- `has_key`: boolean
- `key_source`: `env | secure_store | missing | not_required | external_auth`
- `ready`: boolean
- `managed`: boolean indicating whether the profile is persisted in config or only the fallback active selection
- `can_delete_profile`: boolean
- `can_delete_api_key`: boolean

Optional profile item props:

- `label`: display label
- `reasoning_effort`: optional OpenAI-style reasoning effort for providers that expose it
- `thinking_enabled`: requested Thinking-output policy from effective config
- `thinking_display`: requested default display mode, `visible | hidden`
- `thinking_effective_enabled`: whether the selected provider/model will actually use thinking
- `thinking_effective_reason`: `configured | model_forces_thinking | provider_unsupported | unknown`
- `thinking_effort`: compact provider-neutral effort label when applicable
- `adapter_id`: ACP adapter id when the profile runs through an external session agent
- `api_key_env`: environment variable name that can satisfy the profile for this process
- `base_url`: provider base URL override

Affordances:

- `save_profile(profile_id?, label?, provider, model?, reasoning_effort?, thinking_enabled?, thinking_display?, adapter_id?, base_url?, api_key?, make_default?)`
- `set_default_profile(profile_id)`
- `delete_profile(profile_id)`
- `delete_api_key(profile_id)`

Rules:

- secret values must never be exposed in state, transcript, activity, or logs
- `api_key` is write-only input for secure persistence
- `save_profile` accepts compact Thinking-output controls only; advanced
  provider-specific thinking blocks belong in YAML config
- env-backed profiles should be listed explicitly so users can choose them without silently overriding a selected managed profile
- `openai-codex` profiles use external Codex auth from the Codex CLI auth store; no API key is exposed through session state
- ACP profiles are ready without API keys; `adapter_id` selects the configured external adapter while `model` remains the user-visible model choice
- the session should remain attachable even when `status=needs_credentials`

### `/usage`

Node type: `context`

Purpose:

- expose session-owned token and context accounting separately from LLM profile
  and credential state

Required props:

- `last_model_call_input_source`: `reported | provider | local | unavailable`
- `last_model_call_output_source`: `reported | provider | local | unavailable`
- `current_turn_model_calls`: number of model calls accounted for that turn
- `last_state_context_token_source`: `provider | local | unavailable` source
  for `last_state_context_tokens`

Optional props:

- `last_turn_id`: turn id associated with the latest model-call usage sample
- `last_model_call_input_tokens`: latest model-call input tokens, omitted when
  provider usage is unavailable
- `last_model_call_output_tokens`: latest model-call output tokens, omitted
  when provider usage is unavailable
- `last_model_call_thinking_tokens`: latest model-call Thinking-output or
  provider reasoning tokens, omitted when unavailable
- `current_turn_input_tokens`: aggregate reported input tokens for the current
  or most recent turn, omitted until reported by the provider
- `current_turn_output_tokens`: aggregate reported output tokens for the current
  or most recent turn, omitted until reported by the provider
- `current_turn_thinking_tokens`: aggregate reported thinking tokens for the
  current or most recent turn, omitted until reported by the provider
- `total_input_tokens`: session aggregate reported input tokens
- `total_output_tokens`: session aggregate reported output tokens
- `total_thinking_tokens`: session aggregate reported thinking tokens
- `total_tokens`: input plus output plus separately reported thinking aggregate
  when any aggregate is reported
- `last_state_context_tokens`: token size of the last generated
  `<slop-state>` tail, omitted when no tokenizer is available for the active
  adapter/model
- `model_context_window_tokens`: selected model context window, when the runtime
  can determine it from explicit profile metadata or known provider metadata
- `available_context_tokens`: remaining context for the last model request, only
  when both a reliable context window and provider-reported input usage are known
- `updated_at`: ISO timestamp of the latest usage update

Rules:

- `last_state_context_tokens` is not provider-reported model-call usage; it is
  counted separately through the active adapter's optional tokenizer/count API
  and omitted when unavailable
- model usage should not be guessed; when provider usage is absent, omit the
  token value and set the relevant `*_source` prop to `unavailable`
- thinking tokens count toward session and goal token totals when reported
  separately by the provider; provider inclusion semantics must be documented by
  the adapter to avoid double-counting
- `/usage` is the only public token-accounting surface; `/llm` is reserved for
  profile and credential state

### `/plugins`

Node type: `collection`

`/plugins` lists active first-party session runtime plugins. It is a discovery
surface for generic consumers and a declarative manifest surface for first-party
TUI features. It is not an external plugin loader.

Per-plugin item props:

- `id`: stable unique plugin id; must be non-empty and cannot contain whitespace or `:` so it can be used as the raw TUI slash namespace
- `version`: plugin implementation version
- `status`: currently `active`
- `description`: optional human-readable summary
- `session_paths`: public session paths contributed by the plugin
- `ui`: declarative UI contribution manifest

The current UI manifest version is declared by `/plugins.ui_manifest_version`.
Manifest fields are intentionally data-only:

- `subscriptions`: `{path, depth}` entries the UI may subscribe to
- `actions`: discoverable invocations with `id`, `label`, `description`,
  mandatory `invoke.path` plus `invoke.action`, optional `invoke.params`,
  optional `whenAvailable`, optional single free-text `argument`, and optional
  presentation metadata such as `presentation.tui.slash` with `name`, `aliases`,
  and `signature`. TUI slash completion projects plugin action names under the
  raw plugin id namespace as `/<plugin-id>:<name>` when their required live
  affordance is present; built-in TUI slash names remain unqualified, and
  invocations still go through the public session provider affordance.
- `notifications`: declarative state transitions with `id`, source `path`/`prop`,
  `to`, and `message`; the TUI watches subscribed snapshots and emits notices
  when the transition occurs.
- `indicators`: compact status segments declared as templates over public state
  paths, with optional formatting and visibility metadata.

### `/goal`

Node type: `control`

When the opt-in `persistent-goal` session plugin is enabled, `/goal` is the
stable public projection for persistent objectives. Its source of truth is the
generic extension record at `/extensions/goal`, owned by the bundled
`persistent-goal` skill. Consumers should keep using `/goal` unless they need
generic extension inspection or cleanup.

Required props:

- `exists`: boolean
- `status`: `none | active | paused | budget_limited | complete`
- `message`: short status note

When `exists=true`, additional props:

- `goal_id`: stable goal id
- `objective`: user-provided objective
- `created_at`: ISO timestamp
- `updated_at`: ISO timestamp
- `completed_at`: ISO timestamp when complete
- `token_budget`: optional total token budget
- `input_tokens`: accounted model input tokens
- `output_tokens`: accounted model output tokens
- `thinking_tokens`: accounted provider-reported thinking tokens
- `total_tokens`: input plus output plus separately reported thinking tokens
- `elapsed_ms`: accounted wall-clock time across goal turns
- `continuation_count`: number of automatic continuation turns
- `last_turn_id`: latest turn accounted to the goal
- `evidence`: latest concrete evidence strings reported by the model or UI
- `update_source`: `user | model | runtime`
- `completion_source`: `user | model | runtime` when complete

Affordances:

- `create_goal(objective, token_budget?)`
- `pause_goal(message?)`
- `resume_goal(message?)`
- `complete_goal(message?)`
- `clear_goal`

Rules:

- `create_goal` is implemented by the `persistent-goal` session plugin and
  loads the `persistent-goal` skill before creating extension metadata; if the
  skill cannot be resolved, no goal state is created
- creating a goal starts the first goal turn immediately when idle, otherwise
  queues it behind the active turn
- queued user input takes priority over automatic goal continuation
- goal continuation is session-runtime behavior, not provider-specific planning
  policy
- continuation stops when the goal is paused, complete, budget-limited, or when
  a continuation turn completes without tool activity
- native model-driven goal turns expose a local `slop_goal_update` tool while a
  goal is active. It is not a provider affordance and does not appear in the
  public session tree; it lets the model report `progress`, `blocked`, or
  `complete` with evidence. `blocked` pauses the goal, and `complete` records
  `completion_source=model`.
- stale model-owned updates are rejected when the backing extension instance or
  revision no longer matches the active goal turn

### `/extensions`

Node type: `collection`

Required props:

- `count`: number of extension records
- `namespaces`: active extension namespaces

Each item exposes generic extension metadata:

- `namespace`
- `instance_id`
- `schema_version`
- `revision`
- `owner`
- `state`
- `lifecycle`: `active | completed | orphaned`
- `cleanup_policy`
- `retain_until`
- `created_at`
- `updated_at`
- `last_used_at`

Affordances:

- `sweep_extensions`
- item-level `clear_extension`

Rules:

- extension records are durable metadata for skill-backed session features
- dedicated public projections such as `/goal` remain the preferred consumer API
- cleanup is manual plus TTL: explicit clears delete live state immediately,
  while completed or orphaned records may remain until their retention window
  expires
- missing or unloaded skills do not delete metadata automatically

### `/composer`

Node type: `control`

Required props:

- `accepts_attachments`: boolean
- `max_attachments`: number

Optional props:

- `ready`: boolean indicating whether submitted input can be accepted
- `disabled_reason`: short onboarding message when `send_message` is unavailable
- `queued_count`: number of submitted messages waiting for the active turn to finish
- `active_turn_id`: current turn id when a submitted message would queue

Affordances:

- `send_message(text, attachments?)`

Recommended `send_message` params:

```json
{
  "text": "please summarize the failing tests",
  "attachments": [
    {
      "kind": "document",
      "name": "failing-test.log",
      "mime": "text/plain",
      "text": "...optional inline content..."
    },
    {
      "kind": "image",
      "name": "screenshot.png",
      "mime": "image/png",
      "uri": "file:///tmp/screenshot.png"
    }
  ]
}
```

Rules:

- callers should provide non-empty `text`, at least one attachment, or both
- `send_message` may be absent while no ready LLM profile is configured
- `send_message` starts a turn immediately when idle
- `send_message` appends to `/queue` when a turn is already active; queued messages drain FIFO after the current turn reaches a terminal state
- `attachments` are session input content, not persistent local UI drafts

### `/queue`

Node type: `collection`

Purpose:

- expose submitted user messages that are waiting for the single active turn to finish
- let all attached clients see and cancel queued input
- keep local UI drafts out of shared session state

Each item:

- path shape: `/queue/{queuedMessageId}`
- type: `item`
- `status`: currently `queued`
- `text`: submitted message text
- `created_at`: ISO timestamp
- `author`: currently `user`
- `position`: one-based FIFO position

Affordances:

- `cancel`

Rules:

- queued messages are session input, not transcript messages, until their turn starts
- the runtime removes the head of `/queue` immediately before starting the next turn
- cancelling a queued message removes only that pending input and does not affect the active turn

### `/apps`

Node type: `collection`

Children:

- zero or more external provider attachment items

Each item:

- node type: `item`
- path shape: `/apps/{providerId}`

Required item props:

- `provider_id`: external provider id
- `name`: human-readable provider name
- `transport`: transport summary such as `unix:/tmp/demo.sock` or `ws:wss://example.test/slop`
- `status`: `connected | disconnected | error | unloaded`

Optional item props:

- `last_error`: latest connection or transport error summary

Affordances:

- `query_provider(provider_id, path, depth?, max_nodes?, window?)`
- `invoke_provider(provider_id, path, action, params?)`
- `unload_provider(provider_id)`
- `load_provider(provider_id)`
- `reload_provider(provider_id)`

Rules:

- this path is a shallow attachment/debugging summary, not a proxied subtree of downstream provider state
- the agent-visible source of truth for app lifecycle is the first-party `apps` provider under `/available`; this public Session path mirrors the same catalog and controls for UIs and API consumers
- app lifecycle controls apply only to descriptor-backed external Apps, not first-party Plugins or Providers
- item ids should match the external provider ids used by the runtime consumer hub
- descriptor discovery lists apps as `unloaded` by default; it does not connect them to the agent Hub until `load_provider` is invoked
- loaded state is live Session attachment state, not a durable preference restored into new Sessions
- disconnected or failed attachments may remain visible with `last_error` while their descriptor is still present
- unloaded attachments stay visible as lightweight app cards so an agent can reload them later without rediscovering the descriptor
- unloaded app cards identify the app and lifecycle status only; they must not proxy downstream provider state or affordance catalogs
- connected-provider affordance metadata, including dangerous-action markers, is cleared on unload or reload and rebuilt from the freshly connected provider state
- `unload_provider` disconnects the provider from the agent Hub, drops its state/tools, clears live provider mirrors such as `/approvals` and `/tasks`, removes any Hub State focus for that provider from the agent-facing projection, and does not stop the external process
- `load_provider` connects a registered unloaded, disconnected, or errored app and restores its state/tools; loading an already connected app is a no-op
- `load_provider` does not query or focus the app after connection; the loaded provider appears through its Default projection until the Agent explicitly focuses more detail
- `reload_provider` disconnects a connected app and then connects it again; it rejects unloaded, disconnected, or errored apps instead of acting as `load_provider`
- lifecycle affordance results use snake_case SLOP-facing JSON: `load_provider` returns `{ provider_id, status: "connected", was_connected }`, `unload_provider` returns `{ provider_id, status: "unloaded", was_connected }`, and `reload_provider` returns `{ provider_id, status: "connected" }`
- lifecycle controls accept only `provider_id`; app names are display text and are not stable identifiers
- `query_provider` returns provider-owned SLOP nodes as-is; metadata such as `salience` or `focus` belongs to the queried provider and may be part of an external App's discovery contract

### `/transcript`

Node type: `collection`

Children:

- ordered message items, oldest to newest

Each message item:

- node type: `item`
- path shape: `/transcript/{messageId}`

Required message props:

- `role`: `user | assistant | system`
- `state`: `complete | streaming | error`
- `turn_id`: turn identifier that produced the message, or `null`
- `created_at`: ISO timestamp

Optional message props:

- `author`: display label for the speaker or source
- `error`: error summary when `state=error`

Children under each message:

- `/transcript/{messageId}/content`

`content` node:

- node type: `group`
- children preserve content-block order

Allowed content block nodes in v1:

- `document` for text and file-like content
- `media` for image, audio, and video content

Recommended content block patterns:

- short text blocks: inline `props.text`
- large text or binary content: use a SLOP content reference
- previews and summaries: expose in node props or `summary`
- Thinking output: expose as a `document` block with
  `kind="thinking_output"`, `format="raw | summary"`,
  `display="visible | hidden"`, provider/model metadata, observed timing
  fields, and token counts only when provider-reported

Example text block:

```json
{
  "type": "document",
  "props": {
    "mime": "text/markdown",
    "text": "Here is the current status..."
  }
}
```

Example binary block:

```json
{
  "type": "media",
  "props": {
    "mime": "image/png",
    "name": "screenshot.png"
  },
  "content": {
    "uri": "slop://agent-session/transcript/msg-7/content/block-2",
    "type": "binary",
    "mime": "image/png",
    "summary": "Screenshot of failing test output",
    "preview": "Terminal screenshot with 3 failing assertions"
  }
}
```

Rules:

- `transcript` contains human-visible conversation state only
- provider-returned Thinking output may appear as assistant transcript content when it is intended to be user-visible
- Thinking output is display state; it must not be replayed into later model calls as conversation history
- Thinking output must not be summarized back into tool results, activity
  summaries, state tails, goal evidence, or continuation prompts
- a hidden Thinking-output display preference means hidden from default UI rendering, not private session state; captured Thinking output in `/transcript` remains public to attached consumers
- opaque provider continuity metadata is not Thinking output and must not be exposed in `/transcript`
- Thinking-output `elapsed_ms` is observed wall-clock time from first thinking
  delta to completion or answer start; `token_count` is set only when the
  provider reports reliable raw-thinking token counts for that block or phase
- tool calls and tool results should not be stored as transcript messages unless they are intentionally user-visible assistant output
- assistant streaming should patch the newest assistant message in place until it becomes `complete`

### `/activity`

Node type: `collection`

Purpose:

- expose session-visible operational state separate from the user conversation transcript

Each activity item:

- node type: `item`
- path shape: `/activity/{activityId}`

Required props:

- `kind`: `model_call | tool_call | tool_result | approval | task | error`
- `status`: `running | ok | error | accepted | cancelled`
- `summary`: short human-readable description
- `started_at`: ISO timestamp
- `updated_at`: ISO timestamp

Optional props:

- `provider`: downstream provider id
- `label`: invocation-time snapshot of the invoked affordance label when known
- `path`: downstream SLOP path
- `action`: affordance name
- `completed_at`: ISO timestamp
- `turn_id`: related turn id
- `approval_id`: related approval id
- `task_id`: related task id

Rules:

- this is an operational timeline, not a hidden debug trace
- private prompt internals and chain-of-thought do not belong here
- Thinking output text belongs in `/transcript`, not `/activity`
- Sloppy-owned affordances must provide a `label`; external providers may omit one
- `label`, when present on a tool activity item, is copied from the observed affordance at invocation time and should not be recomputed from later provider state
- consumers may visually group activity items only after respecting monotonic `seq`; grouping must not erase individual item status or result evidence
- the collection should be append-oriented so multiple UIs can follow progress via patches

### `/approvals`

Node type: `collection`

Purpose:

- expose actions blocked on explicit user approval
- mirror provider-native approval state rather than owning the downstream approval policy itself
- expose the session-owned approval posture so all clients can observe and
  update whether pending approvals are handled normally or automatically

Collection props:

- `count`: total pending and retained resolved approval items
- `approval_mode`: `normal | auto`
- `approval_mode_updated_at`: ISO timestamp for the latest mode change

Each approval item:

- node type: `item`
- path shape: `/approvals/{approvalId}`

Required props:

- `status`: `pending | approved | rejected | expired`
- `provider`: downstream provider id
- `path`: target downstream path
- `action`: target affordance name
- `reason`: human-readable explanation of why approval is required
- `created_at`: ISO timestamp

Optional props:

- `resolved_at`: ISO timestamp
- `params_preview`: short string summary of the blocked parameters
- `dangerous`: boolean

Affordances while pending:

- `approve`
- `reject(reason?)`

Collection affordances:

- `set_mode(mode)` where `mode` is `normal | auto`

Rules:

- when at least one approval is pending, `/turn.state` should become `waiting_approval`
- approving or rejecting should patch both the approval item and `/turn`
- approval items are expected to correspond to real downstream provider approval nodes and should forward resolution back to that provider
- when `approval_mode=auto`, the session runtime should approve pending
  approvals with available `approve` affordances; clients only set and render
  the policy
- resolved approvals may remain visible for session history unless trimmed by retention policy

### `/tasks`

Node type: `collection`

Purpose:

- surface async downstream work that outlives one immediate invoke result

Each task item:

- node type: `item`
- path shape: `/tasks/{taskId}`

Required props:

- `status`: `running | completed | failed | cancelled`
- `provider`: downstream provider id
- `provider_task_id`: original downstream task identifier
- `started_at`: ISO timestamp
- `updated_at`: ISO timestamp
- `message`: short human-readable progress summary

Optional props:

- `progress`: number from `0` to `1`
- `linked_activity_id`: activity item id related to the task
- `error`: error summary for failed tasks

Affordances:

- `cancel` when the downstream task is cancelable and still active

Rules:

- session task ids may differ from downstream provider task ids
- if the downstream invoke returned `accepted`, a task node should appear promptly so UIs can subscribe and render progress

## Affordance Contracts

### `send_message`

Target path:

- `/composer`

Behavior:

1. if no turn is active, append a new user message to `/transcript`
2. create or update `/turn` to the running state
3. begin streaming assistant output and activity updates through patches
4. if a turn is already active, append a queued item to `/queue` instead; the queued item becomes a transcript user message only when its turn starts

### `cancel_turn`

Target path:

- `/turn`

Behavior:

1. request cancellation of the active model turn and any locally managed waiting state
2. update `/turn` to reflect cancellation or the resulting terminal state
3. preserve already emitted transcript and activity items

### `approve` and `reject`

Target path:

- `/approvals/{approvalId}`

Behavior:

1. resolve the pending approval item
2. resume or terminate the blocked action
3. patch `/turn`, `/activity`, and `/tasks` as needed

### `cancel`

Target path:

- `/tasks/{taskId}`

Behavior:

1. forward cancellation to the downstream provider task when supported
2. patch the task item as the downstream provider reports progress

## Lifecycle Rules

### Turn lifecycle

Expected progression:

1. `/turn.state = idle`
2. `send_message` moves the turn to `running`
3. streaming assistant content and activity patches arrive
4. the turn may temporarily move to `waiting_approval`
5. the turn eventually returns to `idle` or `error`

### Approval lifecycle

Expected progression:

1. a blocked action creates `/approvals/{approvalId}` with `status=pending`
2. `/turn.state` becomes `waiting_approval`
3. a consumer invokes `approve` or `reject`
4. the approval item resolves and the turn continues or stops accordingly

### Async task lifecycle

Expected progression:

1. a downstream invoke returns `accepted`
2. the session provider creates `/tasks/{taskId}`
3. task patches update `status`, `progress`, and `message`
4. the task ends in `completed`, `failed`, or `cancelled`

---

## Multi-Client Semantics

This provider is intentionally shared across all consumers attached to the same session.

That means:

- all consumers see the same transcript, turn state, queued input, approvals, activity, and tasks
- actions invoked by one consumer are reflected to all others through patches
- no client gets a private draft or pane state inside the session tree

Concurrency rules for v1:

- only one active turn at a time per session
- `send_message` during an active turn queues shared submitted input under `/queue`
- if two clients race to approve or reject the same approval, only the first successful resolution should win

Authentication and authorization policy are intentionally left outside this document. The provider shape should work whether all attached clients are trusted or an outer layer enforces access control.

---

## Persistence

When session snapshot persistence is enabled, the runtime writes the public
session snapshot after each state mutation. Restoring a snapshot is intentionally
state-first rather than a hidden replay engine:

- completed transcript, queued input, activity, approvals, tasks, apps, and LLM state are
  restored for inspection
- client connections are never restored
- in-flight model turns cannot be replayed safely, so they are marked `error`
  with `recovered_after_restart=true`
- pending approvals are marked `expired` because the in-memory approval queue is
  gone
- running mirrored tasks are marked `superseded`

This keeps restarts explicit and inspectable without adding a privileged task
orchestration layer to the session provider.

Provider-specific reasoning continuity metadata may be persisted alongside the
snapshot as internal adapter state when Thinking output is enabled. It is keyed
to the originating turn, profile, provider, and model, is dropped on provider or
model switches, and is never exposed through public session nodes or logs.

On disk, new snapshots are written as a versioned envelope:

```json
{
  "kind": "sloppy.session.snapshot",
  "schema_version": 2,
  "saved_at": "2026-05-06T00:00:00.000Z",
  "snapshot": {}
}
```

Only the current envelope kind and schema version are accepted. Unsupported
envelope kinds or schema versions fail closed instead of being treated as
session state.

---

## Multimodal Content Rules

The transcript model should support more than plain text from the start.

Rules:

- preserve content-block order within each message
- use `document` and `media` nodes rather than UI-specific rendering concepts
- inline short text when practical
- use content references for large or binary artifacts
- expose enough metadata for a UI to render or defer loading safely

This keeps the provider useful across TUI, web, IDE, voice, and future agent consumers without forcing one presentation model.

---

## Future Extensions

Likely future extensions include:

- richer resumable turn replay beyond the persisted public session snapshot
- participant attribution when multiple humans or agents act on one session
- optional richer inspection subtrees, if explicitly justified
- separate delegation-oriented affordances for agent-to-agent workflows

Those should extend this provider deliberately rather than collapsing it into a generic mirror of the runtime internals.
