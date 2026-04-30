# Executor Routing — Per-Agent Model, Provider, and ACP Selection

This document specifies how an agent in the Sloppy stack — orchestrator, manager, observer, specialist, identity curator — is bound to the *executor* that runs it: which LLM provider/profile, or which ACP-backed external agent. It extends `docs/12-orchestration-design.md`, `docs/13-meta-runtime.md`, and `docs/14-agent-identity.md` additively.

It is a design doc, not a state-of-the-code doc. The current code wires LLM provider selection globally per session (`src/llm/profile-manager.ts`) and dispatches ACP delegation via an `executionMode: "native" | "acp:<adapterId>"` field on the spawn path (`src/runtime/delegation/runner-factory.ts`). Per-agent routing as state does not exist yet.

The guiding principle is unchanged: **everything is a SLOP provider — state tree plus affordances**. Executor binding is not a flag on a function call; it is a typed field on agent and task descriptors, governed by the same overlay/gate/reflection machinery as anything else.

## Motivation

Today an entire session tree shares one LLM provider. That is wrong for several use cases that the orchestration design already takes for granted:

- A **verifier** specialist for a security-tagged slice should be free to run on a stronger or differently-tuned model than the executor that produced the artifact under review. Self-review with the same model is a known weak verifier; the docs/12 verification gate is built on the assumption that verification is structurally distinct.
- A **diagnostician** spawned after a slice failed three times benefits from a model with a longer context window, even if the rest of the session uses something cheaper.
- A **doc-writer** specialist on a routine refactor should not be paying for the same profile as a planner reasoning over a multi-spec goal.
- An **ACP-backed delegation agent** (e.g. a third-party Claude Code or pi instance) is just another executor; binding it to a specific role or task is the same problem as picking an LLM profile, not a separate dispatch.

The static-config equivalent — "edit the YAML, restart the session" — is the same failure mode that motivated the meta-runtime in docs/13: configuration that should be a function of artifacts is instead a function of source.

## What an executor is

An executor is **the thing that turns a prompt into a turn**. Two shapes today:

- **LLM executor.** Anthropic / OpenAI-compatible / Gemini adapter, configured by an `LlmProfile`. The native code path through `SubAgentRunner`.
- **ACP executor.** An external process speaking ACP (`AcpSessionAgent`), configured by an `acp.adapters[id]` entry. The agent loop is delegated; only the bridging happens in-process.

Both are executors in the sense this doc uses the word. The selection mechanism should not care which kind it is at the call site; only the resolver does.

There is no third shape implied here. Multi-LLM ensemble executors, router-models, and "MoE-of-providers" are explicitly out of scope; they would be a different kind of executor that this doc does not define.

---

## 1. The executor binding

An `ExecutorBinding` is a tagged union:

```ts
ExecutorBinding =
  | { kind: "llm";  profileId: string; modelOverride?: string }
  | { kind: "acp";  adapterId: string; timeoutMs?: number }
```

Both kinds reference a *profile* — `LlmProfile` for LLM, `AcpAdapter` for ACP — defined elsewhere in config. `modelOverride` exists for the narrow case of "same provider, different model"; it does not let a binding cross profiles.

Bindings are **values** carried in descriptors and config. They are not function arguments; threading them through spawn signatures as bare strings (`model?: string`, `executionMode?: string`) was the v0 shortcut and is to be removed.

### 1.1 Where bindings live

Three homes, ordered by precedence (highest first):

| Home | Where | Effect |
|---|---|---|
| **Task** | `descriptor-tasks.ts` task artifact | Per-task override. Highest blast radius; gated. |
| **Specialist** | `SpecialistSpec` (docs/13 §2.2) | The instance-level binding. Set at spawn. |
| **Role default** | Role registry (`src/core/role.ts`) | "This kind of agent runs on this engine" default. |
| **Session default** | Session config | Set when the session starts; can be overridden. |
| **Global default** | `config.llm.defaultProfileId` | Process-level fallback. |

Resolution at spawn (or per-turn, for task-level overrides) picks the first set value walking task → specialist → role → session → global. A role with no `defaultExecutor` defers to the session; a specialist with no `executor` field defers to its role.

### 1.2 What gets bound, what does not

Bindings target the *executor*. They do not target:

- **Persona voice and voice constants** — these are loaded into the prompt of every executor (docs/14 §5.3) regardless of binding. An ACP-backed agent receives the same persona injection as a native one; otherwise "one agent across the stack" stops being true.
- **Capability masks** — the executor does not get to choose its own capabilities. Masks are still resolved per docs/13 §2.4.
- **Audit and reflection** — every executor's calls go through the same audit/reflection paths. An ACP-backed specialist is not a black box; its tool calls and budget consumption are observable.

If a binding leaks into any of these, that is a bug, not a feature.

---

## 2. Configuration

Two parallel registries, deliberately shaped the same way so the resolver can treat them uniformly:

```yaml
llm:
  profiles:
    - id: anthropic-opus
      provider: anthropic
      model: claude-opus-4-7
      apiKeyEnv: ANTHROPIC_API_KEY
    - id: openrouter-cheap
      provider: openrouter
      model: openai/gpt-5-mini
      apiKeyEnv: OPENROUTER_API_KEY

providers:
  delegation:
    acp:
      adapters:
        claude-code:
          command: ["claude", "--acp"]
          timeoutMs: 60000
          capabilities:                 # NEW — see §3
            spawn_allowed: false
            shell_allowed: true
            network_allowed: false
        pi-mono:
          command: ["pi", "--acp"]
          capabilities:
            spawn_allowed: false
            shell_allowed: false
            network_allowed: false
```

The current `LlmProfile` and `AcpAdapter` schemas already exist; the additions are:

- `acp.adapters[id].capabilities` — see §3.
- An optional `executor.defaults` block that maps role ids to bindings (the role-default home from §1.1).

```yaml
executor:
  defaults:
    reviewer:      { kind: "llm", profileId: "anthropic-opus" }
    diagnostician: { kind: "llm", profileId: "anthropic-opus" }
    doc-writer:    { kind: "llm", profileId: "openrouter-cheap" }
    security-audit:{ kind: "acp", adapterId: "claude-code" }
```

Role defaults are **config**, not state. They change via release. The state-resident overrides live on specialists and tasks (§1.1).

---

## 3. Capability monotonicity for ACP

Docs/13 §6.1 invariant 2 — **capability monotone**: a child specialist's capability surface is a subset of its parent's, enforced at spawn. ACP makes this load-bearing in a way native LLM execution does not, because an ACP adapter is a black box that may itself shell out, fetch URLs, or spawn subprocesses.

The resolver enforces capability monotonicity by **intersecting** three things at spawn:

1. The parent specialist's capability mask (per docs/13 §2.4).
2. The proposed child mask.
3. The adapter's declared `capabilities` block (for ACP bindings only).

If the adapter declares `network_allowed: false` and the proposed child mask permits a `fetch` affordance, the spawn fails — not the fetch later, the spawn now. Adapters that do not declare a `capabilities` block are treated as unrestricted and **cannot be bound to a specialist** in autonomous mode; only a human resolver can spawn an unbound-capability ACP executor, and the spawn always escalates.

This is asymmetric on purpose, mirroring docs/13 §1.5 loosening asymmetry: switching to a more capable executor (broader provider, ACP that can shell out) is a *loosening* of the trust surface and is gated; switching to a less capable one is auto.

### 3.1 ACP capability declarations

A minimum vocabulary, designed to compose with docs/13 §2.4 affordance effects:

| Capability | Effect class | Default |
|---|---|---|
| `spawn_allowed` | spawn (subprocesses, sub-agents) | `false` |
| `shell_allowed` | exec | `false` |
| `network_allowed` | fetch | `false` |
| `filesystem_writes_allowed` | fs:write | `false` |
| `filesystem_reads_allowed` | fs:read | `true` (safe default) |

The specifics will grow with the ACP spec. The principle stays: **what the adapter can do is data, declared in config, intersected with the child mask**. Trusting the adapter's prompt to honor a mask is the failure mode.

---

## 4. Overlays and gates

### 4.1 Patchable surface (extends docs/13 §1.2)

Add `executor_binding` to the overlay-able surface. Specifically:

- Role defaults — patchable (e.g. "for this goal, route reviewer to opus").
- Per-specialist binding at spawn — patchable through the overlay applied at spawn time, not after.
- Per-task binding — patchable.
- LLM profiles themselves (provider, apiKeyEnv) — **not** patchable. Profiles are config; rotating them is a release.
- ACP adapters (command, capability declarations) — **not** patchable. Same reason.

This keeps the docs/13 §6.1 invariant honest: overlays touch *which* executor an agent runs on, not what executors exist or what they can do.

### 4.2 New gate types

Add to the schema migration in docs/13 §3.4.1:

| Gate | Default (HITL) | Default (autonomous) |
|---|---|---|
| `executor_change` (tightening: cheaper / less capable) | auto | auto |
| `executor_change` (loosening: more expensive / more capable / ACP) | escalate | escalate |
| `executor_change` (cross-kind: llm ↔ acp) | escalate | escalate |
| `executor_capability_extend` (ACP adapter capability declaration loosened) | escalate | escalate (always — config change; not autonomous) |

"Cheaper / less capable" is a partial order, not a number. The resolver classifies a binding change as tightening only when (a) it stays within the same `kind`, (b) the target profile's declared capabilities are a subset of the source's, and (c) cost-tier annotations on the profile (`cheap` / `standard` / `premium`) move down or stay equal. Anything ambiguous is a loosening. **The ambiguity defaults to escalation, not auto** — same loosening-asymmetry pattern as overlays.

### 4.3 Cross-kind transitions are special

Switching an agent from `llm` to `acp` (or vice versa) is structurally a different kind of change than swapping LLM profiles. The trust surface, the audit shape, the budget accounting model are all different. Cross-kind changes always escalate, in both directions, regardless of cost-tier.

This is a design choice, not a hard requirement. The reasoning: an autonomous system that can swap one of its agents to an external process without human review has a privilege escalation path that does not exist when the change is profile-to-profile within the same kind.

---

## 5. Reflection

Add per-executor projections to `/reflection` (docs/13 §4.2). Reason-typed counters per executor profile:

```
/reflection
  /executors
    /<profile_or_adapter_id>
      kind                       # llm | acp
      counts                     # invocations, completions, errors, gate-escalations
      latency_p50/p95
      tokens                     # for llm only
      tool_calls
      cost_estimate              # if cost annotation is present on profile
      escalation_reasons         # typed enum, joins gate-type taxonomy
      attributable_outcomes      # heuristic: which slices/specialists used this executor
```

Reflection-derived signals make the manager menu items in §6 actionable. Without per-executor counters, "swap reviewer to opus" is a guess; with them, it is a proposal grounded in observed escalation reasons on the current executor.

Identity remains read-blind to `/reflection/**` (docs/14 §2.6, §4.4). Per-executor counters do not change this — identity does not see them.

---

## 6. Manager menu items

The runtime manager (docs/13 §5) gets two new fixed-menu actions, both in training-wheels mode by default:

| Signal | Manager action |
|---|---|
| Slice failed verification ≥ 3 times AND current executor is in lowest cost-tier AND dominant `escalation_reason` is `evidence_insufficient` or `judgment_uncertain` | propose `executor_change` overlay raising verifier specialist's executor one tier (within `kind`); always escalates per §4.2 |
| Specialist of role R hits per-specialist budget cap repeatedly across goals AND current executor is `llm` AND there is a longer-context profile available | propose `executor_change` overlay routing role R's default to longer-context profile; always escalates |

No menu item proposes cross-kind transitions. The menu cannot suggest "swap to ACP" — that is a human decision, full stop, for the same reason §5.6 of docs/13 keeps menu-item promotion manual: cross-kind is the change with the most rationalization potential.

The manager is still goal-completion-blind (docs/13 §5.3) and reflection-redacted. It sees per-executor escalation reasons; it does not see whether the goal shipped on this executor vs. another. This is what stops the manager from optimizing executor binding for "what gets goals through gates" — a shape of the same DGM-class failure docs/13 §6.2 names.

---

## 7. Identity and persona threading

Persona is a cross-cutting concern (docs/14 §5.3). It is loaded into the system prompt of every agent regardless of executor binding. This means:

- An ACP-backed specialist receives the persona block in the initial ACP `Initialize` payload, the same way a native specialist receives it in its system prompt construction.
- Voice constants (docs/14 §6.4) cross executor kinds. An ACP adapter that strips or rewrites the persona block is a misbehaving adapter and should be treated as untrusted; the `tainted_session` flag (docs/13 §2.4.1) applies.
- Identity is not bound to an executor. There is no `executor` field on the identity curator's role; it runs on the session default. Binding identity to a specific executor would create a path where persona drift could be attributed to a model swap, which we do not want as a confounder for the docs/14 §6.3 drift observer.

The persona-drift observer (docs/14 §6.3) reads recent agent outputs across executors. If the observer sees drift correlated with executor change, that is a signal worth surfacing as part of the digest; it does not auto-revert the binding.

---

## 8. Storage

Bindings live wherever their host descriptor lives:

- Task bindings → `descriptor-tasks.ts` task artifact (under the existing CAS task storage).
- Specialist bindings → `SpecialistSpec` under `/specialists/<id>/spec`.
- Role defaults → config (`.sloppy/config.yaml` or `~/.sloppy/config.yaml`).
- LLM profiles and ACP adapters → config; secrets via OS keychain (already present in `LlmProfileManager`).

No new storage tier. No separate "executor profile store." The point of treating LLM profiles and ACP adapters symmetrically is that they share a config home and a resolver, not that they need parallel infrastructure.

---

## 9. Risks and invariants

Extends docs/13 §6.1 and docs/14 §9.1.

### 9.1 Invariants

13. **Bindings target executors, not capabilities.** Capability masks are resolved independently of executor binding. A binding cannot grant capability the mask denies, and vice versa.
14. **ACP capability declarations are config, not data.** Adapters declare what they can do in config; the runtime intersects with the child mask at spawn. Loosening adapter capabilities is a release.
15. **Cross-kind transitions always escalate.** llm ↔ acp is never auto, in either direction, regardless of engagement level or cost tier.
16. **Persona crosses executor kinds.** Voice constants are injected into every executor; an executor that drops them is treated as tainted.
17. **Identity is unbound.** The identity curator runs on the session default and has no per-role executor binding.

### 9.2 Failure modes worth naming

- **Provider lock-in via overlay accretion.** Overlays slowly route every role to one premium profile; cost balloons. Mitigated by the manager being goal-completion-blind (cannot optimize for "shipped on premium") and by manual review of overlay history per §4.2 escalation defaults. Honest assessment: the mitigation is auditable cost, not a mechanical guard against accretion. Operators must watch.
- **ACP adapter misdeclaration.** Adapter config claims `shell_allowed: false`; adapter implementation shells out anyway. The runtime cannot detect this from inside; mitigation is treating adapter authors as a trust boundary equivalent to a native dependency, not as runtime-checkable. Tainted-session on adapter outputs (§7) is the soft guard.
- **Persona stripping by ACP adapter.** Adapter ignores or drops the persona block; agent on that adapter has no voice constants. Mitigated by §7 tainted-session treatment plus the persona drift observer (docs/14 §6.3) which catches the symptom.
- **Cross-kind rationalization.** Manager learns "verifier escalates less when run on ACP X" and pushes binding toward ACP. Mitigated by §6: menu cannot propose cross-kind. Cross-kind is human-only.
- **Cost-tier rationalization at the same kind.** Manager pushes everything to premium because premium escalates less. Mitigated by `executor_change (loosening)` always escalating (§4.2) — premium is "loosening" in cost terms.
- **Capability creep via adapter version bump.** A new adapter release adds `shell_allowed: true` silently. Mitigated by §4.1 — capability declarations are not overlay-able; bumping requires a release with explicit review.
- **Provider outage cascade.** Premium provider fails; every role bound to it stalls. No mechanical mitigation in this design. Fallback chains are explicitly out of scope for v1; they are a different design with their own rationalization risk (auto-degrading on transient failures is a path to "the cheap model is fine, actually").

---

## 10. Phased rollout

Independent phases, each useful on its own. None of these depend on the meta-runtime being fully landed; phases A and B are usable today on top of the existing orchestration runtime.

### Phase A — Binding as a typed value, single resolver

- Define `ExecutorBinding` and the `ExecutorResolver` (peer to / extension of `LlmProfileManager`).
- Plumb a single `executor?: ExecutorBinding` field through `SubAgentRunner` and `runner-factory.ts`. Remove the parallel `model?: string` and `executionMode?: string` shortcuts.
- Resolution order: explicit binding → session → global. Specialists / tasks / role defaults are added in later phases.

**Demo:** spawn a sub-agent with `{ kind: "llm", profileId: "anthropic-opus" }` from one site and `{ kind: "acp", adapterId: "claude-code" }` from another, with no other code paths involved.

### Phase B — Role defaults

- Add `executor.defaults` to config schema.
- Extend `RoleProfile` with `defaultExecutor?: ExecutorBinding`; `RoleRegistry.resolve` reads from config when constructing.
- Resolution order extends: explicit → role default → session → global.

**Demo:** the `reviewer` role runs on `anthropic-opus` everywhere it is spawned; the `doc-writer` role runs on a cheaper profile. No spawn-site changes.

### Phase C — Specialist bindings

- Add `executor?: ExecutorBinding` to `SpecialistSpec` (docs/13 §2.2).
- ACP capability intersection per §3 (requires the docs/13 §2.4 capability mask plumbing to exist).
- Spawn-time resolver enforces §3 intersection.

**Demo:** an executor spawns a `reviewer` specialist with `executor: { kind: "acp", adapterId: "claude-code" }`; spawn fails if the adapter's declared capabilities do not satisfy the proposed child mask.

### Phase D — Task bindings + overlays + gates

- Add `executor?: ExecutorBinding` to task artifact (`descriptor-tasks.ts`).
- Add `executor_binding` overlay patch type (extends docs/13 §1.2).
- Add gate types `executor_change` and `executor_capability_extend` to the schema migration (docs/13 §3.4.1).
- Loosening / cross-kind escalation per §4.

**Demo:** an overlay routes the verifier specialist for spec `S-12` to a longer-context profile for the duration of that spec; revoked at goal completion; every change in `/audit`.

### Phase E — Reflection projections + manager menu

- Add `/reflection/executors` projections per §5.
- Add the two menu items in §6.
- Both menu items start in training-wheels per docs/13 §5.6.

**Demo:** a slice that escalates verification 80% of the time on a low-tier executor with `evidence_insufficient` as the dominant reason triggers the manager to propose an executor change; gate escalates to the user; user reviews; manager moves the menu item out of training-wheels after N clean cycles.

### Beyond Phase E

Out of scope for this doc, listed so future contributors don't reinvent them ad hoc:

- **Fallback chains** (provider A → provider B on transient failure). Different design. Rationalization risk noted in §9.2.
- **Ensemble / router executors** (one prompt → multiple executors → aggregator). Different shape of executor; would require this doc to be re-written, not extended.
- **Per-turn binding rebinding** (mid-session swap based on turn-level signals). Would break the "binding is resolved at spawn / per-task and frozen" property that makes audit and capability intersection tractable. Not on the roadmap.

---

## 11. Cross-references

### Internal

- `docs/12-orchestration-design.md` — roles, tasks, gates as policy tree. Task artifact is where task-level bindings land.
- `docs/13-meta-runtime.md` — overlays, `SpecialistSpec`, capability masks, gate schema migration, reflection, manager menu. This doc adds one patch type, one schema entry, two gate types, one reflection projection, two menu items.
- `docs/14-agent-identity.md` — persona threading across the stack (§5.3, §6.4) and identity-curator unboundness (§7 here).
- `src/llm/profile-manager.ts` — current `LlmProfileManager`; becomes the LLM half of `ExecutorResolver`.
- `src/runtime/delegation/runner-factory.ts` — current ACP dispatch; becomes the ACP half of `ExecutorResolver`.
- `src/core/role.ts` — `RoleProfile` gains `defaultExecutor`.
- `src/providers/builtin/orchestration/descriptor-tasks.ts` — task artifact gains `executor`.
- `src/config/schema.ts` — `executor.defaults` block; `acp.adapters[id].capabilities` block.

### External — load-bearing references

- **MCP / ACP / A2A protocol survey** (arxiv 2505.02279) — context for treating ACP adapters as one executor kind among others, not a special "remote agent" tier.
- **Darwin Gödel Machine** (arxiv 2505.22954) and **Gödel Agent** (arxiv 2410.04444) — symmetric self-modification failure mode; cited at the executor-routing layer as the rationale for §4.2 loosening asymmetry, §4.3 cross-kind escalation, §6 manager menu restrictions, and the no-fallback-chain stance in §10-Beyond.
- **GEPA optimizer in DSPy** (arxiv 2507.19457) — diagnostic side information beats scalar reward; motivates §5 reason-typed per-executor counters over raw success/failure rates.
