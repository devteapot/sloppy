# SLOP Protocol Reference (Agent-Relevant Summary)

Quick reference for the parts of the SLOP spec that directly impact the agent harness design. Full spec lives in the [slop repo](https://github.com/agnt-io/slop) under `spec/`.

---

## Core Concepts

### State Tree

The fundamental data structure. Applications expose their state as a tree of **nodes**.

```
root
├── view: inbox
│   ├── props: { unread: 3, total: 142 }
│   ├── affordances: [compose, refresh, search]
│   └── children:
│       ├── item: msg-1  { from: "alice", subject: "Hello", read: false }
│       │   affordances: [open, archive, reply, delete]
│       ├── item: msg-2  { from: "bob", subject: "Meeting", read: true }
│       │   affordances: [open, archive, reply, delete]
│       └── ... (windowed: showing 1-50 of 142)
└── view: settings
    └── (stub: "App preferences and account settings", 12 children)
```

**Node types:** `root`, `view`, `collection`, `item`, `document`, `form`, `field`, `control`, `status`, `notification`, `media`, `group`, `context`

**Key properties:**
- `type` — semantic type (not UI type)
- `props` — key-value pairs (flat or shallow)
- `children` — ordered array of child nodes
- `affordances` — available actions on this node
- `summary` — natural language description (critical for stubs)
- `salience` — 0-1 relevance score
- `changed` — recently modified flag
- `focus` — user is interacting with this
- `urgency` — none/low/medium/high/critical

### Affordances

Actions available on a specific node, at a specific time. They are NOT global tools.

```json
{
  "action": "merge",
  "label": "Merge Pull Request",
  "description": "Merge this PR into the base branch",
  "params": {
    "type": "object",
    "properties": {
      "strategy": { "type": "string", "enum": ["merge", "squash", "rebase"] }
    }
  },
  "dangerous": false,
  "idempotent": false,
  "estimate": "fast"
}
```

**Key:** Many affordances are **parameterless** — the target is implicit from the node context. `toggle` on a todo item doesn't need a todo ID.

**Estimates:** `instant` | `fast` | `slow` | `async` — helps the agent decide whether to wait or subscribe for updates.

### Progressive Disclosure

The consumer controls how much of the tree it sees:

- `depth: 0` — just the target node
- `depth: 1` — target + immediate children
- `depth: N` — N levels deep
- `depth: -1` — unlimited (use with caution)

Nodes beyond the depth limit become **stubs** — lightweight placeholders with `summary` and `total_children`.

---

## Messages

### Consumer → Provider

| Message | Purpose | When to use |
|---|---|---|
| `subscribe` | Start streaming a subtree | Begin observing state |
| `unsubscribe` | Stop streaming | Done with a provider/path |
| `query` | One-shot read | Need state without ongoing updates |
| `invoke` | Execute an affordance | Take an action |

### Provider → Consumer

| Message | Purpose | When received |
|---|---|---|
| `hello` | Handshake (capabilities, info) | On connect |
| `snapshot` | Full state subtree | Once per subscription |
| `patch` | Incremental update (JSON Patch) | After snapshot, ongoing |
| `result` | Response to invoke | After invoke |
| `event` | Out-of-band signal | Informational |
| `error` | Error response | On failure |
| `batch` | Multiple patches | Efficiency optimization |

### Invoke Result Statuses

- `ok` — action completed successfully
- `error` — action failed (with error details)
- `accepted` — action accepted for async execution (returns `taskId`)

### Local Approval Convention

Sloppy currently uses a provider-native approval pattern on top of the base SLOP messages:

1. a provider blocks the original invoke and returns `error.code = "approval_required"`
2. the provider exposes the pending request under `/approvals/{approvalId}`
3. that approval item exposes `approve` and `reject`
4. the session provider mirrors those approval items and forwards approval actions back downstream

This keeps approval ownership with the downstream provider while still surfacing shared approval state to attached UIs.

---

## Async Actions

For long-running operations (deploys, builds, report generation):

1. `invoke` returns `{ status: "accepted", taskId: "task-123" }`
2. A task status node appears in the state tree at a known path
3. The agent monitors patches on the task node:
   ```
   task/task-123
     props: { status: "running", progress: 0.45, message: "Running tests..." }
     affordances: [cancel]
   ```
4. When complete: `{ status: "completed", progress: 1.0 }`
5. If failed: `{ status: "failed", error: "..." }`

---

## Content References

Nodes can reference large/binary content without inlining it:

```json
{
  "type": "document",
  "props": { "title": "Report.pdf" },
  "content": {
    "uri": "slop://provider/path/to/content",
    "type": "binary",
    "mime": "application/pdf",
    "size": 1048576,
    "summary": "Q4 financial report, 42 pages, highlights revenue growth of 23%",
    "preview": "Executive Summary: Revenue increased 23% year-over-year..."
  }
}
```

The agent sees the **summary** and **preview** in the state tree. It can request full content via an affordance if needed.

---

## Discovery

### Local (Desktop/CLI agents)

Providers register descriptor files. A desktop or CLI consumer can watch these directories and reconcile providers live:
- `~/.slop/providers/{name}.json`
- `/tmp/slop/providers/{name}.json`

Descriptor format:
```json
{
  "id": "my-app",
  "name": "My Application",
  "description": "Todo list manager",
  "transport": { "type": "unix", "path": "/tmp/slop/my-app.sock" },
  "capabilities": ["state", "affordances", "async"]
}
```

### Web

- Meta tag: `<meta name="slop" content="ws://localhost:3001/slop">`
- Well-known URL: `/.well-known/slop` returns provider descriptor

---

## Scaling Patterns

For large applications, providers should:

1. **View-scope the tree** — active view in detail, others as stubs with summaries
2. **Use windowed collections** — show visible window + metadata about full set
3. **Set salience scores** — let the consumer filter by relevance
4. **Write good summaries** — stubs with summaries let the agent understand collapsed nodes
5. **Support multiple subscriptions** — overview (shallow) + detail (deep) pattern

For the agent, this means:
- Subscribe with appropriate depth (don't request unlimited on large apps)
- Use `min_salience` to filter noise
- Trust summaries for nodes outside current focus
- Deepen subscriptions selectively when investigating specific areas
