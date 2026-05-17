# Auto-fire `tick_event_writer` on long-lived tick close

**Status:** open (ready for dispatch)
**Date:** 2026-05-17
**Repo:** penumbra
**Class:** STANDARD (additive - no existing path changes behavior; only persists currently-unwritten tick telemetry)

## Why

`long_lived_ticks` already stores the tick lifecycle, including `intent_summary`
and `working_memory_diff_json` in `packages/core/src/db/schema.ts:705-717`.
The close path is centralized in `packages/daemon/src/long-lived/teardown.ts:18-51`,
which updates tick outcome, cost, error, and completion time after a long-lived
tick finishes.

Today, the table captures the tick shell but not the full evaluation payload
needed to analyze long-lived agent behavior. The missing row-level audit should
be written at the moment a tick closes successfully so the system can later
answer: what input triggered the tick, what classification the model made, what
working-memory delta it produced, and whether the tick invoked `chain_start`.

This is the instrumentation step for the home-mgmt classify workload. The
evaluation scoping note at `llamactl/docs/notes/fleet-eval-scoping-2026-05-16-night.md:25-50`
explicitly frames "Path A - Instrument now, eval in a week" as the only viable
route because the current ledger captures handoff/outcome/cost but not the LLM
input/output trace on disk.

## What

### New code path

Add a new writer at `packages/core/src/writers/tick-events.ts` and call it from
the long-lived tick close path in `packages/daemon/src/long-lived/teardown.ts:18-51`
after the existing tick update succeeds.

Per successful tick, persist one row with:

- `tick_id` - primary key, the long-lived tick id.
- `agent_id` - the long-lived agent identity, e.g. `home-mgmt`.
- `pulse_payload` - JSON input that triggered the tick, e.g. the
  `ha:ha_pulse` response for `home-mgmt`.
- `intent_summary` - parsed classification or action decision.
- `working_memory_diff_json` - JSON delta from the `long_lived_self_state_get`
  / `_set` pair.
- `chain_start_request` - JSON request body if the tick fired `chain_start`,
  otherwise `NULL`.
- `outcome` - one of `success`, `error`, or `short_circuit`.
- `created_at` - timestamp for the write.

The writer should source `intent_summary` and `working_memory_diff_json` from the
existing columns in `long_lived_ticks` (`packages/core/src/db/schema.ts:705-717`).

### Configuration knob

Gate the auto-fire with `PENUMBRA_TICK_EVENT_WRITER_ENABLED`, default `true`
after the test lands.

Disabled means no new row is written; the rest of tick teardown stays intact.

### Idempotency

Skip inserts when a row already exists for the same `(tick_id, agent_id)`.
Use a single `SELECT 1 FROM tick_events WHERE tick_id = ? AND agent_id = ? LIMIT 1`
before insert, mirroring the memory-verify auto-fire pattern.

The writer should treat the check as the only dedupe guard; do not add extra
keying or upsert behavior.

### Observability

Add a log line from the writer or its call site with:

```json
{
  "component": "tick-event-writer",
  "tick_id": "...",
  "agent_id": "...",
  "rows_written": 1,
  "rows_skipped_idempotent": 0
}
```

Use the same shape for skip cases, with `rows_written: 0` and
`rows_skipped_idempotent: 1`.

## Acceptance

1. `bun test` is green.
2. New unit test `packages/daemon/test/workers/tick-event-writer.test.ts`
   covers three cases:
   - success
   - error
   - short_circuit
3. After daemon reload, the first `home-mgmt` tick produces a sqlite-verified
   row in the new tick-events table.
4. The spec implementation keeps the existing tick teardown flow intact and only
   adds the new persist step when enabled.

## Out of scope

- Eval harness implementation itself.
- Dashboard or UI work for browsing tick-event rows.
- Backfill of historical ticks.
- Changing the long-lived tick lifecycle or close semantics beyond the added
  write.

## Risk + rollback

Risk is low because the writer is additive and sits behind
`PENUMBRA_TICK_EVENT_WRITER_ENABLED`.
Rollback is the env var set to `0` in the daemon plist, which disables the new
persist step without changing any existing tick-close behavior.

## Follow-on (separate session)

Use the tick-event rows to drive the workload-specific eval sections in
`llamactl/docs/notes/fleet-eval-scoping-2026-05-16-night.md:52+`.
That follow-on should define the evaluation slice, scoring, and reporting for
the home-mgmt classify workload once the live rows are flowing.

## Related

- `llamactl/docs/notes/fleet-eval-scoping-2026-05-16-night.md:25-50` - the
  scoping note that makes instrumentation the first step.
- `llamactl/docs/notes/fleet-eval-scoping-2026-05-16-night.md:52+` - the
  per-workload eval follow-on sections.
- `docs/specs/2026-05-16-memory-verify-auto-fire.md` - the reference spec for
  the auto-fire pattern, idempotency guard, and observability shape.
- `packages/daemon/src/long-lived/teardown.ts:18-51` - long-lived tick close
  finalization site.
- `packages/core/src/db/schema.ts:705-717` - existing `intent_summary` and
  `working_memory_diff_json` columns on `long_lived_ticks`.
- `packages/daemon/src/routes/long-lived.ts:162-173` - current read path for
  recent ticks and working-memory diff parsing.
- `packages/core/src/writers/t2.ts:101-123` - example writer pattern for a
  compact DB write path.
