# Auto-fire `memory_verify` on dispatch close

**Status:** open (ready for dispatch)
**Date:** 2026-05-16
**Repo:** penumbra
**Class:** STANDARD (additive — no existing code paths change behavior; only fills currently-empty audit trail)

## Why

`t2_memory_verification_events` is the audit trail meant to ground-truth-label
memory utility. The writer at `packages/core/src/writers/t2.ts:21` (`verifyMemory`)
inserts a row each time a memory is verified, with `verifier_actor`, `claimed_by`,
`reason`, `session_id`, and `verified_at`. The MCP tool `mcp__penumbra__memory_verify`
and the daemon route `/memory/verify` both wire to this writer.

Today: **the table has zero rows.** The infrastructure is fully scaffolded but
no production code path triggers it. Operators don't call `memory_verify` in
normal workflows because there is no natural moment when it would happen.

This blocks the M-track lift verification in production: without labeled data,
there is no way to compute precision/recall of the memory-efficacy classifier
on real findings. Today's session (2026-05-16) tried to verify the
`+20.6 pp macro-F1` lift landed at `2a57160` and found that the production
corpus (`<repo>/.penumbra/reviews/`) is adversarial code-review findings rather
than memory-failure findings — 51 of 51 minority-class predictions were false
positives (full diagnosis in `llamactl/docs/notes/m-track-fewshot-production-verify-2026-05-16.md`).

The shortest path to labeled production data is to make verification fire
automatically when a dispatch closes. Every closed lane already knows:

1. What memories were recalled into the dispatch prompt (`dispatch_events` /
   prompt-injection trace).
2. What the dispatch's outcome was (`lane_ledger` verdict, reviewer findings).

From those two streams the daemon can derive, per recalled memory:

- **Verdict `kept_as_relevant`** — the dispatch succeeded with this memory in
  context. The memory is positive evidence of correct recall.
- **Verdict `overruled_in_prompt`** — the memory was injected but the reviewer
  flagged a finding that contradicts it. Candidate `memory_ignored` signal.
- **Verdict `not_applicable`** — the memory was injected but unrelated to the
  failure mode the reviewer flagged. Neutral data; useful for negative samples.

The classifier-shaped class `recall_miss` requires a different join (memories
that *should have been* recalled but weren't), which is a separate signal source
covered briefly under "follow-on" below — not in this spec's scope.

## What

### New code path

In `packages/daemon/src/workers/handoff-sweeper.ts` (or wherever `lane_close`
finalizes lane state — verify the exact location during implementation), after
the existing lane finalization, dispatch an `enqueueMemoryVerifyJob` operation
that:

1. Reads `dispatch_events` for the just-closed handoff, filtered to
   `event_type == 'memory_recall_injected'` (or whatever the actual injection-trace
   event_type is — confirm during implementation).
2. For each injected memory_id, calls `verifyMemory(db, memory_id, opts)` with
   opts derived from the lane verdict:
   - If lane verdict was `accepted`/`landed`: `verifier_actor = 'auto-lane-close'`,
     `reason = 'lane closed accepted: <verdict_summary>'`.
   - If lane verdict was `rejected`/`overruled`: `verifier_actor = 'auto-lane-close'`,
     `reason = 'lane closed rejected: <verdict_summary>'`.
3. The `claimed_by` field stores the lane's primary author actor
   (e.g. `codex-acp-fast`).
4. The `session_id` field stores the dispatch's `handoff_id`.

The writer's existing schema is already sufficient — no migration needed.

### Configuration knob

New env var `PENUMBRA_MEMORY_VERIFY_AUTO_FIRE` (default `true` once tested).
Disabled state: existing behavior preserved (manual `/memory/verify` only).

### Idempotency

The writer uses `INSERT` (not `INSERT OR IGNORE`) and writes a fresh `event_id`
per call, so re-running on the same lane would duplicate rows. The auto-fire
path should check if a verification event already exists for
`(memory_id, session_id == handoff_id)` and skip if so. Implementation:
single `SELECT 1 FROM t2_memory_verification_events WHERE memory_id = ? AND
session_id = ? LIMIT 1` before each call.

### Observability

Add a daemon log line at lane-close auto-verify entry:

```
{
  "component": "memory-verify-auto-fire",
  "handoff_id": "...",
  "memories_in_prompt": 3,
  "events_written": 3,
  "events_skipped_idempotent": 0,
  "msg": "memory-verify: auto-fired on lane close"
}
```

## Acceptance

1. `bun test` is green in penumbra.
2. New unit test `packages/daemon/test/workers/memory-verify-auto-fire.test.ts`
   covers:
   - Lane close with 0 injected memories → no events written.
   - Lane close with N injected memories → N events written, each with the
     correct `verifier_actor` derived from lane verdict.
   - Lane close re-run on the same handoff → events_written=0, events_skipped=N.
3. After daemon reload, a closed lane (any new test dispatch) produces non-zero
   rows in `t2_memory_verification_events`. Verified via direct sqlite query.
4. `mcp__penumbra__memory_status` returns updated counts (currently
   `last_recall_ts` is the only timestamp; ideally also expose
   `last_verification_ts` and a verification-event count).

## Out of scope

- **`recall_miss` detection** — requires a different join: t2 state at dispatch
  time × dispatch prompt content × reviewer findings. Bigger build; deferred.
- **Operator-driven verification UX** — the MCP tool already exists; this spec
  just adds auto-fire alongside the manual path.
- **Memory efficacy classifier retraining** — the few-shot prompt landed at
  `2a57160` is unchanged. Once auto-verify has been flowing for a week and
  the events table has ~100+ rows, that becomes a separate validation step.
- **Backfill of old dispatches** — only forward-looking. Backfilling would
  require replaying `dispatch_events` against historical prompts; not worth
  the complexity for this spec.

## Risk + rollback

Risk is low: the writer is already battle-tested (full unit coverage via
`memory-verify-audit.test.ts` and `memory-verify-provenance.test.ts`); we're
just calling it from a new site. Rollback is `PENUMBRA_MEMORY_VERIFY_AUTO_FIRE=0`
in the daemon plist.

## Follow-on (separate session)

Once auto-verify is flowing and the events table has labeled data:

1. **Build `memory_efficacy_corpus_build` to consume verification events** as
   training/eval data for the classifier — a properly labeled minority-class
   stream, supplementing or replacing the LLM-labeled corpus at
   `packages/core/src/services/memory-efficacy-classifier.ts`.
2. **Re-eval the few-shot prompt's +20.6 pp lift** on the new corpus. If the
   lift transfers, the M-track decision contract's validation slice part C is
   verified in production. If not, the contract triggers retire criteria.
3. **`recall_miss` detection** — write the "what should have been recalled
   but wasn't" extractor as its own spec. Requires t2-state-at-timestamp queries
   and a similarity threshold for "should have matched."

## Related

- `packages/core/src/writers/t2.ts:21` — `verifyMemory` writer
- `packages/daemon/src/routes/memory.ts:79` — `/memory/verify` route (existing
  manual path)
- `packages/core/src/readers/memory-verification-events.ts` — read side
- `llamactl/docs/notes/m-track-fewshot-production-verify-2026-05-16.md` — the
  full session diagnosis that surfaced this gap
- `llamactl/docs/specs/m-track-decision-contract-2026-05-16.md` — the
  decision contract whose validation slice this would unblock
