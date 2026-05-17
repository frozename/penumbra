# Tick-event writer for home-mgmt long-lived agent

**Status:** open (ready for dispatch)
**Date:** 2026-05-17
**Repo:** penumbra
**Class:** STANDARD (additive — new writer + column augment; no existing code paths change behavior)

## Why

`long_lived_ticks` stores metadata (handoff, outcome, cost_cents, trigger_payload_json) but
not the model's own I/O: the columns `intent_summary` and `working_memory_diff_json` are
scaffolded in `packages/core/src/db/schema.ts:688,694` but **never written** by any code
path. `long_lived_self_state_set` (`packages/mcp/src/tools/long-lived-self-state-set.ts:37`)
writes only to `long_lived_agents.last_intent_summary`, not to the tick row.

The prior working-memory snapshot is not recorded anywhere — only the posterior survives
in `long_lived_agents.working_memory_json`.

This makes home-mgmt eval impossible:
- **Path A** (production data): no labeled (input, output) pairs to mine — the 4-way
  classify target (`short_circuit_no_change / note_to_thread / escalate_for_diagnosis /
  act_with_approval` per `llamactl/docs/notes/fleet-eval-scoping-2026-05-16-night.md:60`)
  requires the pulse payload + intent decision + working_memory diff per tick.
- **Path B** (synthetic corpus): the synthesizer needs real pulse payloads and
  working_memory snapshots as exemplars; without instrumented production ticks it can
  only hallucinate them.

`trigger_payload_json` already stores the ha_pulse response (the event payload for
`trigger_kind='event'` ticks), so no new capture is needed for that field. The gap
is: intent_summary, prior/posterior working_memory, and which chain_start (if any)
the tick spawned and with what task_type.

## What

### Schema decision — column augment vs new table

**Column augment recommended.** `long_lived_ticks` already has `intent_summary` and
`working_memory_diff_json`; filling them plus adding two columns avoids a JOIN for
the eval harness. The tick row is the natural unit of analysis.

New columns added via `addColumnIfMissing` inside the **second** `db.exec` block in
`packages/core/src/db/schema.ts` (the block that owns `CREATE TABLE long_lived_ticks`,
lines 682–697 — the migration placement rule from prior incident requires this):

```
prior_working_memory_json  TEXT   -- snapshot of working_memory_json at tick-open
chain_start_request_json   TEXT   -- JSON {agent, task_type, prompt_excerpt} if tick spawned a sub-dispatch
```

The existing `intent_summary` and `working_memory_diff_json` columns are filled in by
the new writer; no schema change needed for them.

A separate table would add a JOIN, a new migration, and extra GC complexity for no
benefit at this volume.

### New code path

**Two write sites, one conceptual writer:**

**Site 1 — tick-open** (`packages/daemon/src/long-lived/tick-gate.ts:124`):

At the `INSERT INTO long_lived_ticks` that starts a real (non-terminal) tick, read
`long_lived_agents.working_memory_json` for the same `agent_id` and write it to
`prior_working_memory_json` on the same INSERT. This is a single extra column in the
existing INSERT statement — no async work, no new function call overhead.

Guarded by `PENUMBRA_TICK_EVENT_WRITER_AUTO_FIRE` (see below). When the knob is off,
the column is left NULL.

**Site 2 — tick-teardown** (`packages/daemon/src/routes/handoffs.ts:41`,
`maybeTeardownLongLivedTick`, after the `handleTickTeardown` call at line 78 of that
function returns):

Only fires for `outcome === 'success'` ticks and when `PENUMBRA_TICK_EVENT_WRITER_AUTO_FIRE`
is enabled. Steps:

1. Read `long_lived_agents.last_intent_summary` → write to `long_lived_ticks.intent_summary`
   for the completed tick row.
2. Read `long_lived_ticks.prior_working_memory_json` (captured at tick-open) and
   `long_lived_agents.working_memory_json` (posterior). Compute a shallow diff
   (JSON key-level: added/removed/changed keys at top level). Write JSON diff to
   `long_lived_ticks.working_memory_diff_json`.
3. If `tick.chain_id` is non-null: look up the corresponding handoff row to find
   `to_agent` and `chain_task_type`. Write `{"agent": ..., "task_type": ...}` to
   `chain_start_request_json`. The full prompt is intentionally excluded — too large;
   the task_type + agent is the signal the eval harness needs.

All three writes are a single `UPDATE long_lived_ticks SET ... WHERE id = ?` inside
the same db transaction as or immediately after `handleTickTeardown`. No async path
needed (db is synchronous Bun SQLite).

### Configuration knob

`PENUMBRA_TICK_EVENT_WRITER_AUTO_FIRE` — default `false` (off) until integration-tested
for 24 hours; flip to `true` as the stable default after first production confirmation.

Disabled state: no change to tick-gate INSERT, no additional UPDATE in teardown —
exactly today's behavior.

### Idempotency

Site 2 (`UPDATE long_lived_ticks SET intent_summary=... WHERE id=?`) is inherently
idempotent — re-running overwrites the same columns with the same values (intent_summary
is already set on the agent row; the diff is deterministic from prior+posterior snapshots).
No guard SELECT needed.

Site 1 (INSERT column addition) runs once per tick-open by construction.

### Size bounds and retention

- `prior_working_memory_json`: home-mgmt working_memory is ~2–8 KB. Negligible.
- `trigger_payload_json` (pulse payload, already captured): ha_pulse responses are
  10–50 KB. This column exists today; no change.
- `chain_start_request_json`: ~200 bytes (agent name + task_type only).
- `working_memory_diff_json`: ~500 bytes (key-level diff).

At 144 ticks/day × 30-day default retention: ~4,320 rows × ~60 KB average = ~260 MB.
Acceptable for SQLite WAL on the WorkSSD volume.

Retention sweep: a nightly cron in the reactor deletes `long_lived_ticks` rows where
`completed_at < (now - PENUMBRA_TICK_EVENT_WRITER_RETENTION_DAYS * 86400 * 1000)`.
Default retention: 30 days. Configurable via env knob. Sweep is a separate change
(can land after the writer; the table is not large enough to matter before then).

If pulse payloads prove to be a storage problem: cap `trigger_payload_json` at 64 KB
at tick-open INSERT (truncate JSON string and append `"...truncated":true`). Out of
scope for this spec unless profiling shows a real issue.

### Observability

Log line at teardown-side write, component `daemon:long-lived:tick-event-writer`:

```json
{
  "component": "daemon:long-lived:tick-event-writer",
  "agent_id": "...",
  "tick_id": "...",
  "intent_summary_len": 42,
  "diff_keys_changed": 2,
  "chain_start_agent": "codex-acp-deep",
  "msg": "tick-event-writer: stamped on teardown"
}
```

### Tests

New test file `packages/daemon/test/long-lived/tick-event-writer.test.ts`:

1. Tick-open with knob enabled → `prior_working_memory_json` column populated on the
   new tick row; knob disabled → column is NULL.
2. Teardown of a success tick → `intent_summary` copied from agent row,
   `working_memory_diff_json` reflects changed keys, `chain_start_request_json` is null
   (no sub-dispatch).
3. Teardown of a success tick with a sub-dispatch chain_id → `chain_start_request_json`
   contains `{agent, task_type}`.
4. Teardown of a `failed` tick → no write (all columns remain NULL).
5. Re-run teardown on same tick → idempotent (no error; values unchanged).

## Acceptance

1. `bun test` green in penumbra.
2. Five test cases above pass in the new test file.
3. After daemon reload, a manual tick on home-mgmt (via `long_lived_tick` MCP tool)
   with knob enabled produces a row where `intent_summary IS NOT NULL` and
   `working_memory_diff_json IS NOT NULL`. Verified via `mcp__penumbra__long_lived_ticks`
   or the `/long-lived/:id` route response.
4. After 24 hours of production ticks, `SELECT count(*), avg(length(trigger_payload_json))`
   from `long_lived_ticks WHERE completed_at > ?` confirms row counts and payload sizes
   are within the 260 MB / 30-day projection.

## Out of scope

- **Eval harness**: `eval-base-only.sh` adaptation for the 4-way classify task — separate
  session; blocked on this writer accumulating ~100 ticks first.
- **Synthetic corpus (Path B)**: codex-acp-spark synthesis from standing_brief; concurrent
  but independent of this spec.
- **Retention sweep cron**: can land in a follow-on commit once writer is confirmed stable.
- **Compression of trigger_payload_json**: deferred; only if storage profiling demands it.
- **Other long-lived agents** (task-refiner-primary, task-refiner-escalation): same
  writer applies structurally; enable by passing `agent_id` filter to the knob or
  making it agent-agnostic from the start. Recommendation: write it agent-agnostic
  (no agent_id filter in the code path); home-mgmt is just the first consumer.
- **Re-rank scoring workload and t2-promotion judge pool** — separate eval tracks per
  `fleet-eval-scoping-2026-05-16-night.md`.

## Risk + rollback

Risk is low: both write sites are guarded behind `PENUMBRA_TICK_EVENT_WRITER_AUTO_FIRE`.
Default off means zero production impact until the flag is flipped. Rollback is setting
the knob to `false` in the daemon plist; no migration rollback needed (added columns
stay NULL).

## Related

- `packages/core/src/db/schema.ts:682` — `long_lived_ticks` table (second db.exec block;
  new column migrations must go here)
- `packages/daemon/src/long-lived/tick-gate.ts:124` — tick-open INSERT (Site 1)
- `packages/daemon/src/routes/handoffs.ts:41` — `maybeTeardownLongLivedTick` (Site 2 hook)
- `packages/daemon/src/long-lived/teardown.ts:18` — `handleTickTeardown` (called before
  Site 2 stamp)
- `packages/mcp/src/tools/long-lived-self-state-set.ts:37` — why `intent_summary` is only
  on `long_lived_agents` today (this writer closes the gap)
- `docs/specs/2026-05-16-memory-verify-auto-fire.md` — canonical pattern this mirrors
- `llamactl/docs/notes/fleet-eval-scoping-2026-05-16-night.md:32–38,60–62,132–134` —
  the eval workload that requires this instrumentation
