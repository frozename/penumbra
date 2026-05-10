# Long-Lived Agents — Design Spec

**Status:** Drafted 2026-05-10 · **Scope:** V1 long-lived agent runtime + home-management canary · **Depends on:** autonomous-maestro V1 (`docs/superpowers/specs/2026-05-05-autonomous-maestro-design.md`, shipped) for the bounds-tracker / soft-warning infrastructure that this spec generalizes.

## Goal

Introduce a class of agents that persist across activations rather than resolving in a single dispatch. Each long-lived agent has durable identity and state in penumbra. Activations are driven by cron schedules and/or MCP-published events. Each activation spawns a fresh, bounded ACP session that loads working memory, acts, writes back, and terminates. Ship the runtime *and* a home-management canary against ha-mcp (https://github.com/homeassistant-ai/ha-mcp) as the forcing function.

## Non-goals (V1)

- Always-on / warm sessions. Each tick is ephemeral. Warm-keeping is a future question once a domain demands it.
- Webhook ingestion as a first-class trigger (designed as a future thin HTTP-to-event-bus adapter).
- SSE-pull activation.
- Aggregate per-day / per-week budget caps. Per-tick bounds plus a circuit breaker only.
- Recursive long-lived agents (a long-lived agent cannot file or own another long-lived agent).
- Pooled state across long-lived agents (each owns its own working memory).
- Integration install/uninstall for the home-mgmt canary (deferred until the audit + rollback story is trusted).
- Provider-real test coverage. Stub adapters at V1; manual smoke per provider gates promotion.

## Decisions locked during brainstorm

| # | Question | Choice | Rationale |
|---|---|---|---|
| 1 | Spec scope | Framework + home-mgmt canary in one spec | Framework-only specs over-design; domain-only specs leak primitives. Canary keeps runtime honest. |
| 2 | Process model | Ephemeral-per-tick (DB-persistent identity + state, fresh ACP per fire) | Avoids ACP wedge/leak risk seen in long-running sessions; matches autonomous-maestro pattern. |
| 3 | Activation contract | Cron + MCP-event subscriptions | Cron covers periodic ticks; events cover push-from-domain (HA pushes state changes). Webhook = future thin adapter onto same bus. |
| 4 | State location | Penumbra owns identity + generic JSON working memory; domain MCPs own domain truth | Authoritative truth stays in HA / bank APIs; agent gets continuity blob. |
| 5 | Dispatch integration | New long-lived reactor; ticks invoke `chain_start` tagged `dispatch_kind=long_lived_tick`; worktree off by default | Reuses proven spawn path; adds outer reactor for lifecycle/bounds/observability. |
| 6 | Bounds & failure | Per-tick maestro-style bounds + N-consecutive-failure circuit breaker → `degraded` | Per-tick caps each fire; circuit breaker turns loud failure into observable state. |
| 7 | Auth | Per-agent fully-qualified tool allowlist, default-deny, stamped at session start | Tool-level least-privilege; reuses yaml-driven caps pattern. |
| 8 | Observability | Tag existing `t0_events` + cost ledger; new aggregated `/long-lived` route + console panel | Reuses existing surfaces; one new route + one panel. |
| 9 | Declaration | `agentchat.yaml` extension; reactor reconciles yaml ↔ DB on boot + `daemon_reload_config` | One source of truth; long-lived agent IS an agentchat agent with extra metadata. |
| 10 | Pause semantics | Pause/retire skip future ticks, let in-flight finish; `chain_cancel` for hard kill | Working-memory writes happen end-of-tick; letting in-flight finish keeps state consistent. |
| 11 | Canary writes | Devices + automations + dashboards (B + D); HA-snapshot-before-config-write | Integrations admin too risky pre-trust; bricking HA blocks the agent's only sensor surface. |
| 12 | Guardrail mechanism | 3-tier action gate: auto / auto+snapshot+cooldown / approval-required (per-agent globs) | Delivers actual autonomy with brakes on the actions that would haunt the user. |
| 13 | Trigger model | Self-directed by default; standing brief + `chain_send_message` injection override; per-tick `intent_summary` written before any action | Self-direction is what makes this long-lived rather than recurring dispatch. |

## Architecture

### Where it lives

| Piece | Location | New? |
|---|---|---|
| `long_lived: true` + activation/state/bounds/allowlist fields on agent | `packages/agentchat/src/config/types.ts` | extend |
| `long_lived_agents` + `long_lived_ticks` + `long_lived_pending_actions` + `long_lived_action_audit` + `long_lived_cooldowns` tables (schema v11) | `packages/core/src/db/schema.ts` + migration | new |
| **Long-lived reactor** — reconciles yaml↔DB, owns cron schedules, subscribes to MCP-event bus, fires ticks via `chain_start` | `packages/daemon/src/reactors/long-lived-reactor.ts` | new |
| **MCP event bus** — small in-process pub/sub; out-of-process publishers go through a thin HTTP route | `packages/daemon/src/events/mcp-event-bus.ts` | new |
| **Tick prompt-stamper** — composes the per-tick prompt | `packages/daemon/src/long-lived/prompt-stamper.ts` | new |
| **Action gate** — enforces tiered guardrails on agent tool calls | `packages/daemon/src/long-lived/action-gate.ts` | new |
| **Tool allowlist enforcer** — stamps the ACP session tool registry to default-deny + allowlist | extends existing `chain_start` path | small extension |
| **Circuit breaker** — consecutive-failure counter on `long_lived_agents` | inside reactor | inline |
| **HTTP route** `GET /long-lived` and `GET /long-lived/:id` (+ `/stream` SSE), plus `POST /mcp-events/publish` for out-of-process MCP event publishers | `packages/daemon/src/routes/long-lived.ts` + `packages/daemon/src/routes/mcp-events.ts` | new |
| **MCP tools** (see §7.1) | `packages/mcp/src/tools/long-lived-*.ts` | new |
| **CLI** `penumbra long-lived ...` | `packages/cli/src/commands/long-lived.ts` | new |
| **Console panel** | `packages/console/src/panels/long-lived/*` | new |
| **Home-mgmt agent definition** | `~/.config/agentchat/agentchat.yaml` (production fleet — *not* the repo's test skeleton, per memory `project_repo_agentchat_yaml_is_skeleton`) | new entry |

**No new long-running process.** The reactor runs inside the existing daemon process as a sibling subscriber to `task_events` and the MCP event bus. Cron uses an embedded node-cron-style scheduler.

**Worktree handling.** Long-lived ticks default to `worktree: false`. The home-mgmt agent does HA writes via ha-mcp tools, not file edits.

**Action gate placement.** The gate sits at the `chain_start` tool-registry stamping layer (same place the allowlist lives). When the agent calls `ha:automation.set` (Tier 2), the gate intercepts → snapshots via `ha:snapshot.create` → checks cooldown → proxies. When it calls `ha:integration.install` (Tier 3 by per-agent glob), the gate files a `pending_action` row and returns a structured "queued for approval" response the agent stores in working memory.

**HA snapshot lifecycle.** Snapshots have a TTL (default 7 days). The reactor purges expired ones via ha-mcp on a low-frequency tick.

## Schema (migration v10 → v11)

### `long_lived_agents`

One row per declared agent. Reconciled from agentchat.yaml on boot + reload.

| col | type | notes |
|---|---|---|
| `id` | TEXT PK | matches the agentchat.yaml agent name |
| `display_name` | TEXT NOT NULL | from yaml |
| `status` | TEXT NOT NULL | `active` \| `paused` \| `degraded` \| `retired`; default `active` |
| `degraded_reason` | TEXT NULL | populated when circuit breaker trips |
| `consecutive_failures` | INTEGER NOT NULL DEFAULT 0 | reset on first success |
| `circuit_breaker_threshold` | INTEGER NOT NULL DEFAULT 3 | from yaml; per-agent override |
| `schedule_cron` | TEXT NULL | from yaml; null = event-triggered only |
| `subscriptions_json` | TEXT NULL | JSON array of `{server, event}` subscriptions |
| `mcp_allowlist_json` | TEXT NOT NULL | JSON array of fully-qualified tool names; default `[]` |
| `approval_required_globs_json` | TEXT NOT NULL | JSON array of globs; default `[]` |
| `cooldown_overrides_json` | TEXT NOT NULL | JSON map of tool-glob → ms; default `{}` |
| `bounds_wall_clock_ms` | INTEGER NULL | per-tick; null = daemon default |
| `bounds_cost_cents` | INTEGER NULL | per-tick |
| `bounds_max_sub_dispatches` | INTEGER NULL | per-tick (typically 0) |
| `working_memory_json` | TEXT NOT NULL | `{version, updated_at, pending_goals, open_threads, watches, recent_decisions, ...}` |
| `standing_brief` | TEXT NOT NULL | from yaml; durable instructions seed |
| `last_tick_started_at` | INTEGER NULL | epoch ms |
| `last_tick_completed_at` | INTEGER NULL | |
| `last_tick_outcome` | TEXT NULL | `success` \| `failed` \| `bound_exceeded` |
| `last_intent_summary` | TEXT NULL | latest tick's intent line |
| `created_at` / `updated_at` / `retired_at` | INTEGER | bookkeeping |

### `long_lived_ticks`

Append-only history of tick attempts.

| col | type | notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `agent_id` | TEXT NOT NULL FK → `long_lived_agents.id` | |
| `chain_id` | TEXT NULL | null if spawn failed/skipped |
| `trigger_kind` | TEXT NOT NULL | `cron` \| `event` \| `injected_goal` \| `manual` |
| `trigger_payload_json` | TEXT NULL | event payload, injected goal text, etc. |
| `intent_summary` | TEXT NULL | populated by agent at tick start |
| `started_at` / `completed_at` | INTEGER | |
| `outcome` | TEXT NULL | `success` \| `failed` \| `bound_exceeded` \| `circuit_open` (skipped) |
| `cost_cents` | INTEGER NULL | rolled up from cost ledger via chain_id |
| `error_summary` | TEXT NULL | on failure |
| `working_memory_diff_json` | TEXT NULL | optional; agent-claimed delta for forensics |

Index: `(agent_id, started_at DESC)`.

### `long_lived_pending_actions`

Tier-3 approval queue.

| col | type | notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `agent_id` | TEXT NOT NULL FK | |
| `tick_id` | TEXT NOT NULL FK | the tick that proposed it |
| `action_kind` | TEXT NOT NULL | the gated tool name |
| `action_target` | TEXT NOT NULL | path/glob the gate matched |
| `payload_json` | TEXT NOT NULL | full tool call args |
| `rationale` | TEXT NULL | agent's stated reason |
| `status` | TEXT NOT NULL | `pending` \| `approved` \| `rejected` \| `expired`; default `pending` |
| `expires_at` | INTEGER NOT NULL | default tick start + 7 days |
| `decided_by` | TEXT NULL | `user` or `auto-expired` |
| `decided_at` | INTEGER NULL | |
| `executed_in_tick_id` | TEXT NULL | filled when re-executed post-approval |
| `created_at` | INTEGER | |

Index: `(agent_id, status, expires_at)`.

### `long_lived_action_audit`

Forensics for every Tier 1 / Tier 2 action.

| col | type | notes |
|---|---|---|
| `id` | INTEGER PK AUTO | |
| `agent_id` | TEXT NOT NULL FK | |
| `tick_id` | TEXT NOT NULL FK | |
| `action_kind` | TEXT NOT NULL | |
| `action_target` | TEXT NOT NULL | |
| `tier` | INTEGER NOT NULL | 1 or 2 |
| `payload_json` | TEXT NOT NULL | |
| `snapshot_id` | TEXT NULL | HA snapshot id when tier 2 |
| `cooldown_until` | INTEGER NULL | when tier 2 |
| `outcome` | TEXT NOT NULL | `executed` \| `gate_failed` \| `tool_failed` |
| `error` | TEXT NULL | |
| `executed_at` | INTEGER NOT NULL | |

Index: `(agent_id, action_target, executed_at DESC)` for cooldown lookups.

### `long_lived_cooldowns`

Bookkeeping for active Tier-2 cooldowns. Could be derived from audit, but a dedicated table makes the gate's hot path a single indexed read.

| col | type | notes |
|---|---|---|
| `agent_id` | TEXT NOT NULL | |
| `target_glob` | TEXT NOT NULL | |
| `cooldown_until` | INTEGER NOT NULL | |
| PRIMARY KEY | `(agent_id, target_glob)` | |

### Existing-table extensions

- **`t0_events`**: no schema change; tag long-lived ticks via existing `dispatch_kind` field with new value `long_lived_tick`. Ride existing `agent_id` / `correlation_id`.
- **`cost_ledger`**: no change; picks up tick costs through `chain_id` joining.

### Migration notes

- Forward-only.
- Reconciler runs once at the end of the migration to import any agentchat.yaml entries already flagged `long_lived: true`.
- Daemon must restart to pick up the new schema (per memory `feedback_daemon_restart_on_schema_change`).

## Activation: cron + MCP event bus

### Cron half

Each long-lived agent's yaml entry can declare `schedule_cron: '*/15 * * * *'`. On boot/reload, the reactor:

1. Reads all `long_lived: true` agents from agentchat.yaml.
2. For each with `schedule_cron`, registers a node-cron-style job. The job's only behavior is to enqueue a tick attempt (it does NOT spawn directly).
3. On reload (`daemon_reload_config`), diffs current schedules against new ones, cancels stale jobs, registers new ones. Removed agents get `status=retired`.

### Event-bus half

A small in-process pub/sub.

```ts
interface McpEvent {
  server: string;          // e.g. 'ha'
  event: string;           // e.g. 'state_changed'
  payload: unknown;        // typed by (server,event) — opaque to bus
  published_at: number;    // epoch ms
}
```

- **Publishers.** In-process MCP servers call `mcpEventBus.publish(...)`. Out-of-process MCP servers publish via daemon route `POST /mcp-events/publish`. Webhook ingestion (V2) lands as another route on the same bus.
- **Subscribers.** Reactor reads each long-lived agent's `subscriptions: [{server, event}, ...]` and maintains an in-memory `{server, event} → Set<agent_id>` map. Rebuilt on reload.
- **No persistence.** Bus is in-memory. If the daemon restarts mid-burst, in-flight events are lost — accepted because the agent will pick up reality on its next cron tick. Persistent ingestion is a V2 question.

### Tick gate

Single funnel before any actual `chain_start`. Both cron and event paths land here.

1. Agent status must be `active`. If `paused`/`degraded`/`retired`, log a `circuit_open` row in `long_lived_ticks`, no spawn.
2. No in-flight tick (look up by `last_tick_started_at` + check chain status). If in-flight, log `circuit_open` with `outcome=concurrency_skip`.
3. Per-trigger debouncing for events: 50 events in a 1-second burst coalesce to a single tick (key by `(agent_id, server, event)`), preserving the first payload + a count of suppressed events. Cron triggers do NOT debounce.
4. Pass → spawn `chain_start` with the prompt-stamped session.

### Injected-goal trigger

When a user calls `chain_send_message` to a long-lived agent (or the sugar tool `long_lived_inject_goal`), the goal lands in `working_memory.pending_goals[]`. The next tick from any trigger pulls and processes them. If the agent has no schedule, injecting a goal also enqueues an immediate ad-hoc tick with `trigger_kind=injected_goal`.

## Tick execution lifecycle

### Prompt stamping

The tick prompt-stamper composes a single prompt the ACP session receives:

```
[SYSTEM-LIKE FRAMING — long-lived agent role]
You are <agent.display_name>, a long-lived agent with persistent state.

Standing brief:
<agent.standing_brief>     # from yaml, durable

Current working memory:
<agent.working_memory_json, pretty-printed>

Pending goals from user (process these first if relevant):
<working_memory.pending_goals[]>     # flushed inline; cleared after tick

Tick context:
- Trigger: <trigger_kind> (cron|event|injected_goal|manual)
- Triggering event payload (if any): <trigger_payload_json>
- Tick id: <tick_id>
- Now: <iso_timestamp>

Tools available to you:
<filtered tool list — only those in mcp_allowlist>

Action policy (binding):
- You operate under a 3-tier action gate. Tier 1 actions execute immediately.
- Tier 2 actions take an HA snapshot first and observe a cooldown — the gate handles this.
- Tier 3 actions are queued for user approval — do not retry them in the same tick;
  do not hallucinate that they succeeded.
- If a tool call returns "queued for approval", record it in working memory and move on.

Required protocol:
1. As your FIRST action, call long_lived_self_state_set with {"intent_summary": "<one line>"}.
   This is what the user sees on the live console panel for the duration of this tick.
2. Do your work. Use tools. Read state. Decide what's worth doing.
3. As your LAST action, call long_lived_self_state_set with the full updated working memory
   (excluding pending_goals — those are flushed by the runtime). Include any new
   open_threads, watches, observations.
4. End the session.

Tick budget: <bounds_wall_clock_ms>ms wall clock, <bounds_cost_cents>¢, <bounds_max_sub_dispatches> sub-dispatches.
```

**Three new MCP tools the agent always has** (force-added to its allowlist regardless of yaml). These are the **agent-side / self-scoped** variants — distinct names from the operator-facing tools so authorization can't be confused:

- `long_lived_self_state_set({intent_summary?: string, working_memory?: object})` — partial, atomic; updates `working_memory_json` + `last_intent_summary` for the agent owning the running tick. Identity inferred from the chain context.
- `long_lived_self_state_get()` — returns current working memory for the agent owning the running tick.
- `long_lived_self_pending_actions()` — read-only listing of the agent's own pending actions.

The `*_self_*` variants only succeed when invoked from inside an active long-lived tick. Operator-facing tools (with explicit `id` arg) are documented in §"MCP tools" below.

### Bounds enforcement

Bounds tracker (existing maestro infra, generalized) ticks every 5s during a long-lived tick:

- Wall clock: `started_at + bounds_wall_clock_ms`.
- Cost: rolled up via cost ledger by chain_id.
- Sub-dispatches: counter on chain_start invocations whose parent_chain_id matches.

On 80% of any axis: soft warning user-message injected ("approaching <axis> limit, finalize and call long_lived_self_state_set"). Reuses existing soft-warning path.

On 100%: hard kill via `chain_cancel`. Tick row gets `outcome=bound_exceeded`. Working memory NOT updated past the agent's last in-tick `long_lived_self_state_set` call.

### Action-gate flow per tool call

For every tool call from the agent:

1. **Allowlist check.** Reject if not in `mcp_allowlist` with `{error: 'not_in_allowlist', tool}`. Audit row `outcome=gate_failed`.
2. **Tier classification.** Hard-coded per-tool tier table for V1 (see §"Tier table" below) overlaid with the agent's `approval_required_globs[]` — any match bumps to Tier 3. The string the globs match against is `<fully_qualified_tool_name>:<action_target>`, where `action_target` is extracted by per-tool target-extractor functions (e.g. for `ha:automation.set`, target is the automation entity_id; for `ha:dashboard.set`, target is the dashboard path; for `ha:integration.install`, target is the integration domain). The extractor table is part of the action-gate package and shipped with sensible defaults; new tools added to the allowlist without an extractor default to using the empty string (so any glob ending `:*` matches).
3. **Tier 1.** Execute. Audit row.
4. **Tier 2.** Lookup cooldown by `(agent_id, target_glob)`. If active, reject `{error: 'cooldown_active', expires}`. Else: snapshot via `ha:snapshot.create`, store snapshot id, execute, audit row, set `cooldown_until = now + cooldown_ms` (default 600_000; per-tool overridable via yaml).
5. **Tier 3.** File `pending_action`, return `{queued: true, pending_action_id}`. Audit row written only post-execution (during approval re-entry).

#### Tier table (V1, baseline)

| tool | tier | notes |
|---|---|---|
| `ha:state.*` | n/a (read) | not gated |
| `ha:light.*`, `ha:switch.*`, `ha:climate.*` | 1 | direct device commands |
| `ha:script.run` | 1 | run defined script |
| `ha:dashboard.*` | 2 (cooldown 60_000) | per home-mgmt yaml override |
| `ha:automation.set` | 2 | default cooldown 600_000 |
| `ha:automation.delete` | 2 → bumped to 3 by canary's globs | safety: deletes always need approval |
| `ha:integration.install` / `ha:integration.uninstall` | 3 | always approval-required (V2 will revisit) |
| `ha:snapshot.create / list / restore` | 1 | runtime needs to call create freely; restore is rare and approval-gated by canary glob |

### Tick teardown

On normal end-of-session:

1. Roll up cost from cost ledger; write `long_lived_ticks` row with `outcome=success` and `cost_cents`.
2. If working memory was updated mid-session, already persisted.
3. Reset `consecutive_failures = 0`.
4. Update `last_tick_*` columns.

On failure (ACP error / exception / `bound_exceeded`):

1. Write `long_lived_ticks` row with `outcome=failed|bound_exceeded` + `error_summary`.
2. Increment `consecutive_failures`.
3. If `consecutive_failures >= circuit_breaker_threshold`, set `status=degraded`, write `degraded_reason`, emit `long_lived_circuit_opened` t0_event.
4. Do NOT auto-resume.

### Approval re-entry

When a user approves a Tier-3 pending action via `long_lived_approve_action`:

1. Action row → `status=approved`, `decided_by=user`, `decided_at=now`.
2. Runtime injects a goal into `pending_goals[]`: `{kind: 'approved_action', pending_action_id, original_payload}`.
3. Next tick's prompt inlines this goal with the reminder "this action was previously approved; execute it now."
4. Agent re-issues the same tool call. The action gate sees the `pending_action_id` flag (tooling adds it automatically when an approved-goal injection is in scope) and bypasses the Tier-3 queue. If the call also matches Tier 2 (e.g. an approved automation edit), snapshot still taken.
5. On execute, fill `executed_in_tick_id` on the pending_action row + write the audit row.

Rejection: `decided_by=user`, no goal injected. Agent surfaces the latest decisions next tick via `recent_decisions[]` in the prompt.

## agentchat.yaml extensions + reconciliation

### Yaml shape

A long-lived agent entry in `~/.config/agentchat/agentchat.yaml`:

```yaml
agents:
  - name: home-mgmt
    display_name: "Home Management"
    long_lived: true                          # new top-level marker
    provider: claude-acp
    model: sonnet-4.6
    long_lived_config:                         # new nested block
      schedule_cron: "*/15 * * * *"
      subscriptions:
        - { server: ha, event: state_changed }
        - { server: ha, event: automation_failed }
      mcp_allowlist:
        - "ha:state.*"
        - "ha:script.run"
        - "ha:automation.*"
        - "ha:dashboard.*"
        - "ha:snapshot.create"
        - "ha:snapshot.list"
        - "penumbra:long_lived_self_state_get"      # auto-added by runtime if missing
        - "penumbra:long_lived_self_state_set"      # auto-added by runtime if missing
        - "penumbra:long_lived_self_pending_actions"  # auto-added by runtime if missing
        - "penumbra:memory_search"
      bounds:
        wall_clock_ms: 180000                  # 3 min per tick
        cost_cents: 50                         # 50¢ per tick max
        max_sub_dispatches: 0
      circuit_breaker_threshold: 3
      action_tiers:
        approval_required_globs:
          - "ha:integration.*"
          - "ha:automation.*:safety/*"
          - "ha:automation.delete:*"
        cooldown_overrides:
          "ha:dashboard.*": 60000
      standing_brief: |
        You are the home-management agent. You manage a Home Assistant install on
        behalf of the user. Your goals, in priority order:
          1. Detect and surface anomalies (failed automations, offline devices,
             sensors stuck or noisy beyond thresholds).
          2. Refactor noisy or redundant automations during quiet hours
             (00:30–05:00 local).
          3. Propose dashboard improvements when you see them.
        Conventions:
          - Write a single-line intent_summary FIRST every tick.
          - Don't act on ambiguity — record an open_thread instead.
          - Quiet hours: aggressive refactors OK. Daytime: prefer non-disruptive work.
          - Respect cooldowns silently; if blocked, pick something else.
```

### Reconciliation

Reactor reads agentchat.yaml on daemon boot and `daemon_reload_config`. For each `long_lived: true` entry, diffs against `long_lived_agents`:

| diff | action |
|---|---|
| Yaml has, DB doesn't | INSERT row. status=`active`. working_memory seeded with `{version:1, updated_at, pending_goals:[], open_threads:[], watches:[], recent_decisions:[]}`. standing_brief copied. |
| Yaml has, DB has, fields changed | UPDATE non-runtime fields (display_name, schedule_cron, subscriptions, mcp_allowlist, bounds, threshold, approval_required_globs, cooldown_overrides, standing_brief). DO NOT clobber working_memory, status, consecutive_failures, last_tick_*. |
| Yaml missing OR `long_lived: false`, DB has, status != retired | UPDATE `status=retired`, `retired_at=now`. Cron job cancelled. History preserved. |

**Cron jobs.** For each active agent with non-null schedule, register/replace.

**Subscriptions.** Rebuilt from scratch in-memory each reload.

**Forced allowlist additions.** `penumbra:long_lived_self_state_get`, `long_lived_self_state_set`, and `long_lived_self_pending_actions` are added to every long-lived agent's effective allowlist regardless of yaml. Debug log if yaml omits them. The operator-facing variants (`long_lived_state_get(id)`, etc.) are NEVER added — agents cannot read or mutate other agents' state.

### Standing-brief edits

`standing_brief` flows yaml → DB on reconcile. The agent never edits its own brief (working_memory is the agent-mutable surface). To change the brief, the user edits yaml + reloads. CLI sugar: `penumbra long-lived edit-brief <agent>` opens `$EDITOR`, writes back to yaml on save, calls `daemon_reload_config`.

### Production vs repo yaml

Per memory `project_repo_agentchat_yaml_is_skeleton`: the home-mgmt agent definition lives in production yaml only. Sample yaml in this spec is documentation. Implementation plan must explicitly avoid editing the repo skeleton.

## Lifecycle commands, MCP surface, console panel

### MCP tools

| tool | purpose |
|---|---|
| `long_lived_list` | list all agents with `{id, display_name, status, last_tick_*, last_intent_summary, consecutive_failures, schedule_cron}` |
| `long_lived_get(id)` | full row + recent N ticks + open pending actions |
| `long_lived_pause(id)` | status `active|degraded → paused`. Cron cancelled. In-flight tick allowed to finish. |
| `long_lived_resume(id)` | status `paused|degraded → active`. Reset `consecutive_failures=0` if coming from `degraded`. Re-register cron. |
| `long_lived_retire(id)` | status `* → retired`. Terminal. Cron cancelled, subscriptions removed. |
| `long_lived_state_get(id)` | read working memory (operator/console use) |
| `long_lived_state_set(id, partial)` | operator/console use. Operator-only — the agent uses `long_lived_self_state_set` (different tool name, identity inferred from running tick). |
| `long_lived_pending_actions(id?, status='pending')` | list pending actions |
| `long_lived_approve_action(action_id)` | mark approved + inject approved-goal record |
| `long_lived_reject_action(action_id, reason?)` | mark rejected, surface to agent next tick |
| `long_lived_inject_goal(id, goal_text)` | append free-form goal to `pending_goals[]`. If no schedule, ALSO enqueue immediate ad-hoc tick. |
| `long_lived_audit(id, since?, limit?)` | read action audit rows |
| `long_lived_ticks(id, since?, limit?)` | read tick history |

Auth: existing penumbra MCP auth surface. Every write tool emits a `t0_event` for forensics.

### CLI

`packages/cli/src/commands/long-lived.ts` — direct mappings of the tools above:

```
penumbra long-lived list
penumbra long-lived get <id>
penumbra long-lived pause|resume|retire <id>
penumbra long-lived state get <id>
penumbra long-lived state set <id> <json>
penumbra long-lived pending [<id>]
penumbra long-lived approve <action_id>
penumbra long-lived reject <action_id> [--reason ...]
penumbra long-lived inject <id> "<goal>"
penumbra long-lived audit <id> [--since 24h] [--limit 100]
penumbra long-lived ticks <id> [--since 24h] [--limit 50]
penumbra long-lived edit-brief <id>
```

### HTTP route

`GET /long-lived` (list) and `GET /long-lived/:id` (detail):

```ts
interface LongLivedDetail {
  agent: { id, display_name, status, schedule_cron, subscriptions, standing_brief, working_memory, consecutive_failures, circuit_breaker_threshold, last_intent_summary, last_tick_outcome, last_tick_started_at, last_tick_completed_at, degraded_reason, retired_at };
  recent_ticks: Array<{ id, trigger_kind, intent_summary, started_at, completed_at, outcome, cost_cents, error_summary }>;
  pending_actions: Array<{ id, action_kind, action_target, payload_json, rationale, expires_at, created_at }>;
  recent_audit: Array<{ id, action_kind, action_target, tier, snapshot_id, outcome, executed_at }>;
}
```

`GET /long-lived/:id/stream` — SSE bridge over the daemon's existing SSE bus, filtered to long-lived events for that agent. Emits `tick_started`, `tick_completed`, `intent_updated`, `action_executed`, `pending_action_filed`, `circuit_opened`.

### Console panel

Inside the existing console, one new panel `LongLivedAgentsPanel`:

- **Top: agent list.** One row per agent with name, status badge, last-tick relative time + outcome, current intent line (live SSE updates), pending-action count badge.
- **Detail drawer (on row click):** standing brief (collapsible), working memory (pretty-printed JSON, collapsible), schedule + subscriptions, recent ticks (last 20, with inline cost), pending actions (with Approve / Reject / Reject-with-reason buttons that call MCP tools), recent audit (last 50).
- **Manual controls.** Pause / Resume / Retire / Inject Goal (modal with a textarea).
- **Empty state.** "No long-lived agents declared. Add one in `~/.config/agentchat/agentchat.yaml` and run `penumbra config reload`."

Visual snapshot harness (per memory `project_console_visual_snapshot_pattern`): one Storybook story per state — active, paused, degraded, retired, with-pending-actions, empty.

## Observability: telemetry tagging

Reuses existing telemetry infrastructure; the work is tagging discipline.

### `t0_events` tagging

Every tick emits standard `chain_start` events plus:

| field | value |
|---|---|
| `dispatch_kind` | `long_lived_tick` |
| `agent_id` | the long-lived agent id |
| `correlation_id` | `long_lived_ticks.id` |
| `parent_chain_id` | null |

### New runtime event types (not from chain_start)

| type | when |
|---|---|
| `long_lived_tick_gated` | gate dropped a fire (paused/degraded/concurrency_skip/event_debounced) |
| `long_lived_action_executed` | tier 1 or 2 action completed (success or tool_failed) |
| `long_lived_action_queued` | tier 3 pending_action filed |
| `long_lived_action_decided` | user approved/rejected a pending action |
| `long_lived_intent_updated` | agent called `long_lived_state_set` with a new intent_summary |
| `long_lived_circuit_opened` | circuit breaker tripped (status → degraded) |
| `long_lived_circuit_reset` | operator resumed a degraded agent |
| `long_lived_snapshot_taken` | tier 2 took an HA snapshot (with snapshot_id) |
| `long_lived_state_changed` | agent_id status transition (paused/active/retired) |

These bridge through the daemon SSE bus to the console panel + are queryable retrospectively.

### Cost ledger

No code change. Costs flow through chain_id; queries roll up by `agent_id` via `long_lived_ticks` joining on `chain_id`.

### Agent-performance ledger

Long-lived agents land as a separate `agent_kind=long_lived` series. Success rate = `successful_ticks / (successful + failed + bound_exceeded)`. Ledger writer change: add an `agent_kind` discriminator so a coding-agent's ranking history stays separate from the same agent name being used long-lived (defensive — same name unlikely both ways, but the discriminator makes bleed impossible).

## Home-management canary specifics

Yaml shape: see §"agentchat.yaml extensions" above.

### Required ha-mcp surface

This spec assumes ha-mcp exposes:

- `ha:state.list / ha:state.get` — read entity state.
- `ha:script.run` — run a defined HA script (Tier 1).
- `ha:light.* / ha:switch.* / ha:climate.*` — direct device commands (Tier 1).
- `ha:automation.list / ha:automation.get` — read automations.
- `ha:automation.set / ha:automation.delete` — write/delete automations (Tier 2; deletes bumped to Tier 3 by canary's globs).
- `ha:dashboard.*` — Lovelace edits (Tier 2 with short cooldown).
- `ha:snapshot.create / ha:snapshot.list / ha:snapshot.restore` — backup/restore.
- Server-side eventing that publishes `state_changed` and `automation_failed` to our bus via `POST /mcp-events/publish`.

If the live ha-mcp doesn't expose all of these, the implementation plan includes a **ha-mcp capabilities probe** task: a one-shot script that introspects ha-mcp's tool list and produces a missing-tools diff. Anything missing becomes either (a) a yaml allowlist removal + a working-memory open_thread, (b) an upstream issue against ha-mcp, or (c) a thin local shim. The runtime spec is not blocked on the probe.

### Cold-start data

Working memory seeds with:

```json
{
  "version": 1,
  "updated_at": "<created>",
  "pending_goals": [],
  "open_threads": [],
  "watches": [],
  "recent_decisions": [],
  "known_automations_snapshot": null,
  "known_scripts_snapshot": null
}
```

The agent populates the `*_snapshot` fields on its first tick (a self-directed "learn the lay of the land" tick).

### Quiet-hours convention

Encoded in the standing brief only (no runtime enforcement). Agent decides what counts as disruptive based on time-of-day and entity (e.g. don't refactor an automation that's actively firing).

## Testing strategy

### Unit

- Reactor: cron registration on reload diff, subscription-map rebuild, gate predicates (paused/degraded/concurrency).
- Action gate: tier classification matrix, allowlist rejection, cooldown lookup, snapshot-then-execute path, pending_action filing, approved-goal re-entry.
- Prompt stamper: every section composed correctly, allowlist-only tool list, pending_goals flushed.
- Bounds tracker integration: 80% / 100% paths producing expected tick row outcomes.
- Reconciler: each diff case (insert/update/retire), forced-allowlist injection.
- Circuit breaker: N-failure → degraded, resume reset.

### Integration

A fake-ha-mcp test harness (in-process MCP server with fixture state). Exercises:

- Cron-triggered tick: agent reads state, writes intent_summary, no actions.
- Event-triggered tick (`state_changed`) with debouncing burst.
- Tier-2 tool call → snapshot taken → cooldown enforced on second call.
- Tier-3 tool call → pending_action filed → approval → re-execution.
- Bound exceeded → tick outcome + working_memory NOT clobbered.
- Circuit breaker opens after 3 failures.
- HTTP route shape (golden file).
- SSE event ordering for the console panel.

### E2E

`packages/e2e/long-lived-canary`:

- Boot daemon with example yaml + fake-ha-mcp.
- Full lifecycle: declare → tick → approve a pending action → re-tick → retire.
- Assert audit log + tick history + cost ledger rows match expectations.

### Visual snapshots

One Storybook story per panel state (active / paused / degraded / retired / with-pending-actions / empty).

### Provider-real coverage

Deferred (matches autonomous-maestro V1 stance). Promotion to "real ha-mcp + real Anthropic" is gated on a manual smoke described in the implementation plan.

### Out of scope for V1 tests

- Load testing the event bus (single-digit events/sec from one HA instance is fine).
- Real HA snapshot restore (we only assert snapshot id is captured).

## Open questions for implementation phase

These are NOT blocking the spec but will be resolved during plan-writing:

1. **ha-mcp capabilities probe.** Run before locking the canary's allowlist. Output drives any spec patch.
2. **Cron library choice.** node-cron, cron, or hand-rolled around setTimeout/setInterval. The reactor's needs are minimal; whichever fits the existing daemon dependency tree wins.
3. **Per-agent default bounds in daemon config.** Spec says "null = daemon default" — the plan picks the actual defaults (proposed: wall_clock_ms=180_000, cost_cents=50, max_sub_dispatches=0).
4. **Pending-action expiry sweeper.** Daily cron job that flips `status=expired` on `expires_at < now` rows. Probably lives in the reactor itself.
5. **Snapshot purge cadence.** Default 7-day TTL — probe ha-mcp for actual snapshot listing/deletion APIs before committing.

## References

- `docs/superpowers/specs/2026-05-05-autonomous-maestro-design.md` — bounds-tracker + soft-warning infrastructure being generalized.
- `docs/superpowers/specs/2026-04-26-agentchat-auto-dispatch-design.md` — yaml-driven agent registry.
- `docs/superpowers/specs/2026-05-08-penumbra-console-design.md` — console panel composition pattern.
- `docs/superpowers/specs/2026-04-28-phase-3b-cost-ledger-design.md` — cost ledger / `chain_id` joining.
- Memory `project_repo_agentchat_yaml_is_skeleton` — production agentchat.yaml lives at `~/.config/agentchat/agentchat.yaml`, not in the repo.
- Memory `project_console_visual_snapshot_pattern` — Storybook story walker for visual-diff baselines.
- Memory `feedback_daemon_restart_on_schema_change` — schema migrations require daemon restart.
- Memory `feedback_stdio_acp_caps_yaml_driven` — yaml-driven per-agent tool gates is the established pattern.
- Memory `project_long_lived_agents_feature_planned` — original brainstorm queue note.
- ha-mcp upstream — https://github.com/homeassistant-ai/ha-mcp.
