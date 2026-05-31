# Penumbra Memory Overhaul — Final Phased TDD Plan (WS0–WS4)

> **Audience:** the system's author + the implementing fleet.
> **Verified against HEAD `c5c0b2a1`.** Every file:line below was grep/line-confirmed in this session. Red-team fixes are folded in — the corrections that change a task's *direction* or *target* are called out inline as **[RED-TEAM FIX]**.
> **AMENDED 2026-05-31** with the parallel forensic data brief (`docs/notes/2026-05-31-memory-forensics-data-brief.md`). The empirical findings add four items the original phases missed — a **strategic fork** plus tasks **T1a.4, T1a.5, T3.5, T4.6** — collected in the [**Amendments §**](#amendments--data-brief-reconciliation-2026-05-31) at the end and cross-referenced into the dispatch waves there. Read the Amendments § before dispatching.

## Goal

Make recall **rank on the signals penumbra already computes** (trust, decay, recency, importance, why-freshness) through **one pure `scoreMemory` function** that both recall consumers import, and **stop garbage entering at the creation point** (classification, provenance, density floor, episodic/standing-brief rejection, deterministic dedup) through **one creation gate** on the single t2 write seam. Every signal a workstream writes lands in a column the rank function reads; every memory passes the creation gate that fills those columns. The 1,170-row live corpus is irreplaceable production data — every schema change is additive-nullable with an idempotent, dry-run-first backfill.

## Non-goals

- **No third decay system.** Repair the dead P3 `deps.scorer` lane and demote PC1 to a proposer; do not build a parallel decayer.
- **No new memory platform.** A minimal queued-dream-action *apply* path is in-scope (it is the seam every retire/merge proposal must flow through); no cost-accounting subsystem beyond a single spend accumulator.
- **No synchronous LLM scoring on the recall hot path.** `why`/`source_quote`/`obs_type` ride the promotion LLM call that already runs (`t2.ts:358`); durability/depth run batched in the existing P3 lane under a metered, sized budget.
- **Not re-planned — the retirement-leak fix** (`timeline.ts` / `get-observations.ts` `retired_at IS NULL`): an in-flight prerequisite that lands before any phase auto-retires more aggressively (WS3, plus PC1-if-enabled and the P3 scorer per the red-team fix).
- **No per-memory efficacy join.** `memory_efficacy_cache` is finding-keyed (`schema.ts:823`), used only as an aggregate threshold-tuning input for `min_score`/`w_trust`, never a per-row trust column.

---

## Conflict resolutions (architect full-design vs simplifier MVP — decided)

| Decision point | Resolved | Justification |
|---|---|---|
| **Rank seam** | One exported pure `scoreMemory(row, dist, now)` in `packages/core`, imported by `recall.ts` **and** `workflows/recall.ts`; shared fixture asserts identical ordering. | Two consumers (MCP recall + dispatch auto-recall, which *inherits* recall's order) drift if logic is duplicated. A pure fn is the only deterministic unit-testable seam. (R9) |
| **Spend caps** | **Wire the writes.** Add a `recordSpend` accumulator; size a per-phase budget split. | `cycle.ts:192` already SUMs the columns; nothing writes them. WS3's DecayScorer + WS1b's classify LLM need a *metered, bounded* lane. Deleting forces WS3 to invent its own budget (the competitor we must avoid). |
| **Dead P3 scorer** | **Wire (repair).** `deps.scorer = new DecayScorer`. | `cycle.ts:533` is the existing decay authority; populating it is the reconciliation the brief mandates. |
| **Queued dream actions** | **Minimal apply path** reusing revert's `action_id` resolution. | Stop-billing leaves consolidation outputs as permanent dead weight; the apply route is the seam WS3's retire/merge proposals (and the queued PC1 / P3 actions) flow through. |
| **PC1** | **Anchor (conditionally) + env-gate + demote to proposer.** No LLM judge. | PC1 is the one decay path running in prod that destroys live data today — neutralize first. DecayScorer becomes the only auto-retire authority. |
| **Lossy promotion input** | **Both, staged.** Delete coin-flip + deterministic dedup first; widen transcript source to `payload_json` **with length gates preserved and budget sized**. | The coin-flip makes every downstream test flaky; widening is cheap but must not trigger a backlog promotion storm under the now-real cap. |
| **durability/depth** | **Heuristic default + batched P3 enrichment**, watermarked by `decay_scored_at`. | obs_type→durability prior gives 80% of value at zero inference; LLM depth scoring drains the 1,170 backfill over cycles, never in one storm. |

---

## Phase ordering and why

**The through-line:** nothing that READS a signal lands before the thing that WRITES it, and nothing that scores via LLM lands before the budget that *bounds and sizes* it.

```
WS0 foundations (no schema change)
  ├─ T0.1 PC1 neutralize        ── stops live data loss TODAY (must be first)
  ├─ T0.2 verify-lookup redirect ─┐
  ├─ T0.3 back-door close        ─┴ unblocks WS4 trust
  ├─ T0.4 spend writes + sizing  ── unblocks WS3's metered scorer lane
  └─ T0.5 dream-action apply      ── unblocks WS3 retire/merge + queued PC1/P3
        │
WS1a structural (deterministic, no LLM; may overlap WS0 tail)
  ├─ T1a.1 test-store isolation (FIRST — before any new fixture)
  ├─ T1a.2 fix lossy promotion input (coin-flip + payload_json, gated by sized budget)
  └─ T1a.3 provenance capture (hybrid-branch scoped)
        │
WS1b + WS2 FUSED (one migration, one write-path change)
  ├─ T2.1 additive column block + idempotent backfill
  ├─ T2.2 extraction schema + promote write
  ├─ T2.3 creation gate: classify + density floor + episodic/standing-brief reject
  ├─ T2.4 near-dup BLOCK-before-insert (quality-aware tiebreak)
  ├─ T2.5 direct-write + MCP parity
  └─ T2.6 surface why/source_quote/learned_at in recall
        │
WS3 decay (needs WS0 sized budget + WS2 obs_type)
  ├─ T3.1 pure decay schedule fn
  ├─ T3.2 DecayScorer → deps.scorer (queue, NOT inline retire)
  ├─ T3.3 decay→archive + watermarked batched backfill (dry-run-first)
  └─ T3.4 wire decay into recall input
        │
WS4 ranking (needs WS0 verify + WS3 decay_score)
  ├─ T4.1 t0 bm25 norm + min_score floor (t0 + hybrid branch)   ── EARLY
  ├─ T4.2 eviction by recall score (thread existing score, not scoreMemory) ── EARLY
  ├─ T4.3 scoreMemory signal-blend (recency+decay+importance+why-freshness)
  ├─ T4.4 TRUST term (HARD-GATED, lands LAST, scoped verified_count)
  └─ T4.5 per-turn transient: regression test only (no auto-recall rank code)
```

---

## PHASE 0 — WS0 FOUNDATIONS

**Workstream:** WS0. **Satisfies:** review findings *VERIFICATION NO-OP, UNGATED /verify, SPEND CAPS THEATER, NO CONSOLIDATION APPLY PATH, PC1 OVER-RETIRE*.
**Objective:** Stop live data loss, make verification write real basis-validated data, give the dreaming LLM lanes a real *and sized* budget, and give queued consolidation outputs an apply path. **No schema change.** **T0.1 is strictly first**; T0.2–T0.5 are independent and parallelizable.

### T0.1 — Neutralize PC1 auto-retire (FIRST, data-loss stopper) · dispatch-sized: YES
- **[RED-TEAM FIX #1 — the relabel is a no-op]** `pc1-ephemera.ts:64` calls `retireNonDirectMemory(db, mem.memory_id, now)` **unconditionally** inside the txn; the `status` at line 72 (`retired ? "auto_applied" : "skipped_direct_origin"`) is a *post-facto label on the ledger row*, not the gate. Flipping it to `'queued'` while line 64 still runs **retires the row AND mislabels it queued**. The fix MUST move the retire behind the gate: when `PENUMBRA_PC1_AUTORETIRE` is OFF (default), write the `dream_actions` row with `status='queued'` + `target_ids` and **do NOT call `retireNonDirectMemory`** — let the T0.5 apply path do it. When ON, retire inline as today (back-compat).
- **[RED-TEAM FIX #2 — anchoring direction is conditional, not blanket]** `t2-ephemera-detector.ts:9` does `.replace(/%/g, ".*")` with no anchor, so `"Fix:%"`→`Fix:.*` matches mid-body (the leak), but `"%# Operating rules%"`→`.*# Operating rules.*` is *meant* to match a substring. A blanket `^…$` wrap **breaks the `%…%` brief-stub / operating-rules patterns** (false-negatives). The fix: anchor conditionally — add `^` only when the LIKE pattern does **not** begin with `%`; add `$` only when it does **not** end with `%`. So `Fix:%`→`^Fix:.*`, `%foo%`→`.*foo.*` (unchanged behavior), `Implement %`→`^Implement .*`.
- **Failing test (extend):** `packages/daemon/test/dreaming/pc1-ephemera.test.ts` — assert THREE things: (a) a live durable body containing `"...we will Fix: the bug"` mid-string is **NOT** flagged (anchor fix); (b) a body that *starts* `"Fix: ..."` (an actual dispatch stub) **IS** flagged (no regression); (c) a body matching a `%…%` runtime pattern as a substring **still IS** flagged (no `%…%` regression). Plus: with `PENUMBRA_PC1_AUTORETIRE` OFF, a flagged memory's `retired_at` stays NULL and a `status='queued'` ledger row exists (gate fix).
- **Files:** `t2-ephemera-detector.ts:6-11` (conditional anchor), `pc1-ephemera.ts:61-76` (gate the `retireNonDirectMemory` call behind the env flag; queue otherwise).
- **Back-compat:** behavior change gated OFF by default; queued action is revertible; no schema change.

### T0.2 — Verify-authorize lookup redirect · dispatch-sized: YES
- **[RED-TEAM FIX #3 — `lane_ledger` has no `handoff_id`]** `memory-verify.ts:99` resolves targets from `dispatch_events kind='memory_recall_injected'` (an event never emitted → `events_written:0`). The real recalled ids live in `lane_ledger.recalled_memory_ids`, but `LaneRow` is keyed by **`lane_id`** (confirmed `lane-ledger.ts:7-19`), not `handoff_id`; `getLane` takes `lane_id`. The redirect MUST specify: for a `lane_close` basis, look up by **`basis.lane_id`** via `getLane`, read `recalled_memory_ids`. The request body's `handoff_id` is the *recall* handoff, not the lane key. **The other three basis kinds (`dispatch_land`, `adversarial_review`, `manual_override`) carry no `lane_id`** — the task must explicitly state their resolution source (e.g. they remain `events_written:0` by design, or resolve via a stated alternate key) so they aren't a silent re-occurrence of the same bug.
- **Failing test:** `packages/daemon/test/routes/memory-verify-authorize.test.ts` — seed `lane_ledger` with `lane_id='L1'`, `recalled_memory_ids=['m1','m2']`; POST authorize with a valid `lane_close` basis carrying `lane_id='L1'`; assert `events_written===2` and `last_verified_at` stamped on m1/m2 (currently `0`). Add a case asserting the documented behavior for a non-lane basis kind.
- **Files:** `memory-verify.ts:99` (query via `getLane(basis.lane_id)` from the lane-ledger reader instead of `dispatch_events`); reuse existing `verifyMemory` + `validateBasis` (already at `:86`).
- **Back-compat:** lookup-source swap only; no new emitter, no new table, no schema change.

### T0.3 — Close the ungated `/verify` back door · dispatch-sized: YES
- **Failing test:** `packages/daemon/test/routes/memory-verify-backdoor.test.ts` — POST `/memory/:id/verify` with no valid basis returns 4xx and leaves `last_verified_at` UNCHANGED; with a valid `BasisSchema` basis → 200.
- **Files:** `memory.ts:269` (route `verifyMemory` through the same `validateBasis`/`BasisSchema` the authorize path uses, or delete the route and redirect callers to authorize).
- **[RED-TEAM NOTE]** `validateBasis` is async and hits services; **pre-check** (not just "document") that no live caller depends on the bare form before hard-gating, or it 4xx's a live agent.
- **Back-compat:** any prod caller now needs a basis — pre-checked in the dispatch. No schema change.

### T0.4 — Wire real spend writes + size the budget · dispatch-sized: YES
- **Failing test:** `packages/daemon/test/dreaming/spend-cap.test.ts` — run a cycle incurring LLM+embedding cost; assert `dream_cycles.llm_spent_usd > 0` and the daily-cap SUM at `cycle.ts:192` trips at `config.dailyUsd` (currently always `$0`).
- **[RED-TEAM FIX #8 — wired but never sized]** Three lanes draw the same daily budget: the DecayScorer (T3.2), the durability/depth enrichment (T3.3), and the payload-widening re-promotion (T1a.2). The task MUST (a) add a **per-phase budget split** (e.g. fractions of `dailyUsd` per P-phase), and (b) define **cap-trip-mid-backfill resume semantics** (idempotent resume next cycle via the `decay_scored_at` watermark — see T3.2/T3.3).
- **Files:** `cycle.ts` (add `recordSpend(cycleId, {llm,embedding,research})` accumulator written at each phase end; per-phase split read from config), `deps.ts` (pass a cost meter to the LLM/embed call sites).
- **Back-compat:** columns already exist (`schema.ts:883 DEFAULT 0`); NULL/0 legacy cycles read as no-spend. No schema change.

### T0.5 — Dream-action apply path (minimal) · dispatch-sized: YES
- **Failing test:** `packages/daemon/test/routes/dream-action-apply.test.ts` — a `status='queued'` PC1 `ephemera_retire` / P3 `retire` / P4 `merge` action, when applied, flips `queued→applied`, effects the change, and stays revertible.
- **Files:** `dreaming.ts` (add an apply route beside the existing revert route, reusing revert's `action_id` resolution); `dream_actions` writer.
- **Back-compat:** purely additive route; existing revert untouched. **This is the single apply seam** through which queued PC1 (T0.1), P3 (T3.2), and merge (T2.4) actions are honored.

---

## PHASE 1a — WS1 STRUCTURAL (deterministic, no LLM; may overlap Phase 0 tail)

**Workstream:** WS1. **Satisfies:** review findings *LOSSY PROMOTION INPUT, 53% untraceable provenance*.
**Objective:** Make the promotion front door deterministic and traceable before any LLM gate judges its input. **T1a.1 is strictly first** — it must land and the full existing suite must run green before any new fixture is added.

### T1a.1 — Test-store isolation (FIRST) · dispatch-sized: YES
- **Failing test:** assert the test DB path resolves **outside** `~/.penumbra/db.sqlite` (guard + temp-dir/in-memory fixture); a test that writes t2 must touch an injected store, never the prod DB.
- **Files:** services/db path resolution + test harness injection point.
- **Risk gate:** run the FULL existing suite green after this lands (regression gate) **before** any quality-gate test is added on top. (R8)
- **Back-compat:** test-infra only.

### T1a.2 — Fix lossy promotion input (deterministic) · dispatch-sized: YES
- **Failing test:** `packages/core/test/writers/t2-promote-input.test.ts` — two identical high-frequency shapes both promote deterministically across two same-seed runs (no `Math.random()<0.5` at `t2.ts:353`); a separate assertion pins that a `payload_json`-sourced transcript produces the **same extraction shape** as the prior `payload_summary` source for a fixed fixture (isolates the source-widening from the coin-flip removal).
- **[RED-TEAM FIX #7 — payload widening is unbounded]** Widening `t2.ts:306` from `payload_summary` to `payload_json` changes `transcript.length`, which feeds the `minTranscriptChars`/`maxTranscriptChars` gates (`~:337/:343`) and the head+tail 8K truncation (`~:344`). Unbounded, it re-trips the **4,262-row backlog** into a promotion storm under the now-real cap. The task MUST (a) **keep the existing length gates**, (b) land **after T0.4's budget exists and is sized**, and (c) include the same-shape determinism assertion above.
- **Files:** `t2.ts:353` (replace coin-flip with deterministic content-hash dedup, keep-one), `t2.ts:306` (read `payload_json`, length-gated).
- **Back-compat:** removing the 50% drop can only *increase* retention (corpus under-promotes); pinned by the determinism assertion so the change is observable, not silent.

### T1a.3 — Provenance capture (kills 53% untraceable at source) · dispatch-sized: YES
- **[RED-TEAM FIX #5 — hardcode is hybrid-only]** `recall.ts:43` hardcodes `source_session_ids: []` **only in the `strategy_hint==="hybrid"` branch**; the default RRF t2 branch at `recall.ts:192` already does `JSON.parse(r.source_session_ids)` correctly. The task MUST scope to (a) the t2 promote INSERT setting `[session_id]`, (b) the direct/brief writers (`deps.ts`, `t2.ts:77`) that pass `'[]'`, and (c) the **hybrid branch + its underlying `hybridSearch` reader SELECT** (add the `source_session_ids` column to that query, then parse it at `recall.ts:43`) — **NOT** a blanket "recall.ts" change that would "fix" the already-correct RRF path and miss the hybrid one.
- **Failing test:** `packages/core/test/writers/t2-provenance.test.ts` — promoted rows persist non-empty `source_session_ids`; `packages/core/test/readers/recall-hybrid-provenance.test.ts` — a hybrid-strategy recall returns the row's real `source_session_ids`, not `[]`.
- **Files:** `t2.ts` promote INSERT; `deps.ts` + `t2.ts:77` direct/brief writers; `hybridSearch` SELECT + `recall.ts:43`.
- **Back-compat:** `source_session_ids` already `TEXT NOT NULL DEFAULT '[]'`; legacy rows stay valid.

---

## PHASE 1b + 2 — WS1 CREATION GATE + WS2 STRUCTURED WHY (FUSED: one migration, one write-path change)

**Workstream:** WS1b + WS2. **Satisfies:** Bubblemem *importance/why-freshness signals* + review findings *obs_type NULL on 1170/1170, episodic/standing-brief-as-memory, dedup-by-retirement, schema declares fields the reader never SELECTs*.
**Objective:** Add the full additive column block once, thread the creation gate + why/source_quote through the single t2 write seam, and surface the new fields in recall. Classification is produced by the **promotion LLM call that already runs** (`t2.ts:358`) — no new judge pass.

### T2.1 — Additive column block + idempotent backfill (the migration spine) · dispatch-sized: YES
- **Failing test:** `packages/core/test/db/schema-memory-fields.test.ts` — open an OLD-schema DB (one *before* the new columns; note `obs_type`/`last_verified_*` are **already** migrated in at `schema.ts:690/698-702`, so the fixture asserts those stay stable while the new ones are added), with 3 legacy rows; run migrate+backfill TWICE; assert columns `why, source_quote, learned_at, durability, depth, is_episodic, decay_score, decay_scored_at, archived_at` now exist, defaults applied (`learned_at=created_at`, `durability` NULL, `depth` NULL, `is_episodic` 0), `recall()` returns all 3, second run is a no-op (row count + existing-column values stable).
- **[RED-TEAM FIX #9]** Confirm the new columns don't collide with the existing `addColumnIfMissing` block; confirm the existing `backfill-recall-fields.ts` idempotency contract covers the new columns (re-run no-op), not a fresh file.
- **Files:** `schema.ts:686` `addColumnIfMissing` block (mirror the proven obs_type pattern); extend `backfill-recall-fields.ts`.
- **Migration / back-compat:** every column NULL/sensibly-defaulted; **NULL durability = MOST-durable bucket (never auto-retire)**; the rank seam treats NULL as neutral (no boost, no penalty) so an un-backfilled row ranks exactly as today.

### T2.2 — Extraction schema + promote-path write · dispatch-sized: YES
- **Failing test:** `packages/core/test/writers/t2-why-source-quote.test.ts` — `lnSchema` accepts/ignores optional `obs_type, why, source_quote, learned_at, durability, depth, is_episodic` (legacy extractions without them still parse); the promote INSERT (`t2.ts:380`) persists them.
- **Files:** `t2.ts:9-14` (`T2MemoryExtractionSchema`/`lnSchema`, new fields OPTIONAL), INSERT column list.
- **Back-compat:** optional fields → old extractions and the 1,170 rows degrade gracefully.

### T2.3 — Creation gate: classify + density floor + episodic/standing-brief reject · dispatch-sized: YES
- **Failing test:** `packages/daemon/test/dreaming/promote-discriminator.test.ts` — golden fixture of REAL corpus cases: `"a failing test was written first, then implemented..."` → `is_episodic=true`, dropped; `"recall.ts:172 filters retired_at IS NULL"` → semantic, **kept** with a `why`; `"You are X, a long-lived agent..."` → `obs_type='standing_brief'`, `promote:false`, NOT inserted; body<80 chars & depth<2 → rejected; **must-KEEP** cases (semantic, why-grounded) included so the gate is tuned against ground truth.
- **Files:** the promotion LLM prompt (`t2.ts:358-359` — richer schema, **no new call**) returning `obs_type`/`promote:false`; post-parse `extractions.filter(e => e.promote !== false)` in `promoteRollup`.
- **[RED-TEAM NOTE — cost]** A richer schema = more output tokens × the 4,262-row backlog the first time `PENUMBRA_PROMOTION_GATE` is ON. Sequence after T0.4 and size it (shares the budget concern of #8).
- **Risk gate:** gated behind `PENUMBRA_PROMOTION_GATE`; **rejection is at promotion (reversible — the t1 rollup stays, can re-promote)**, never retiring live rows; `depth>=2` escape hatch on the density floor.

### T2.4 — Near-duplicate BLOCK-before-insert (quality-aware) · dispatch-sized: YES
- **Failing test:** `packages/core/test/t2-near-dup-gate.test.ts` — `fakeEmbedder` (string→fixed unit vector, cosine is arithmetic, no network): body-A then near-dup body-B (cosine>0.95) → second insert handled per tiebreak; cosine 0.5 → both written.
- **[RED-TEAM FIX #12 — keep-first is arbitrary]** Blind keep-first systematically discards the richer ~25% why-grounded body when it arrives second. The task MUST specify a **quality-aware tiebreak**: when blocking a near-dup, keep the one with higher density/why-presence/depth (or queue a merge via T0.5), and ensure the *blocked* candidate's rollup is **NOT** marked permanently promoted, so a better version can still land.
- **Files:** new core `isNearDuplicate(candidate, existingEmbeddings, threshold)`; `promoteRollup` insert loop (`t2.ts:380-417`), reusing existing `cosineSim`/cluster code.
- **Back-compat / risk:** **block-and-flag or queue-merge, never auto-merge two existing bodies** inline. Permanent replacement for dedup-by-retirement.

### T2.5 — Direct-write + MCP parity · dispatch-sized: YES
- **Failing test:** `packages/mcp/test/tools/memory-write-t2-why.test.ts` — `memory_write_t2` accepts optional `why/source_quote/obs_type`, persists via `writeDirectT2Memory`.
- **Files:** `memory-write-t2.ts:5` shape (additive optional), `t2.ts:46` `writeDirectT2Memory` INSERT.
- **Back-compat:** additive-optional; old callers unchanged.

### T2.6 — Surface why/source_quote/learned_at in recall · dispatch-sized: YES
- **Failing test:** `packages/core/test/readers/recall-why-fields.test.ts` — seed a t2 row with `why/source_quote/learned_at/last_verified_at`; assert they round-trip through `recall()` into the hit object; NULL-safe for legacy rows. (`SearchHitSchema` already *declares* `last_verified_at/age_days/stale` but the reader never SELECTs them — this makes the reader honest.)
- **[RED-TEAM NOTE — scope both branches]** The t2 SELECT exists in **two** places: the RRF t2 branch (`recall.ts:165`) and the hybrid `hybridSearch` reader. Add the new columns to **both** SELECTs + payloads, mirroring the source_session_ids split (T1a.3).
- **Files:** `recall.ts:163-199` T2Row SELECT + payload; `hybridSearch` SELECT; `schemas/recall.ts` `RecallResult` (additive fields); envelope shape.
- **Back-compat:** additive-optional envelope fields; `packages/mcp/test/tools/memory-search-envelope.test.ts` golden snapshot asserts new fields surface without breaking existing callers.

---

## PHASE 3 — WS3 DURABILITY × DEPTH + DECAY (needs Phase 0 sized budget + Phase 2 obs_type)

**Workstream:** WS3. **Satisfies:** Bubblemem *decay signal* + review findings *DEAD P3 QUALITY SCORER, PC1 over-retire reconciliation*.
**Objective:** Reconcile decay with the existing machinery — populate the dead `deps.scorer` with one DecayScorer authority, keep PC1 (T0.1) as a demoted pre-filter, backfill durability/depth incrementally under the sized budget, feed decay into recall as a soft de-rank. **Decay is a pure function of (clock, durability, depth, last_event_at)**, unit-testable without the dreaming mutex/cap.

### T3.1 — Pure decay schedule function · dispatch-sized: YES
- **Failing test:** `packages/core/test/memory/decay.test.ts` — `decayState(mem, now)` with an injected clock: `durability='ephemeral'`+now+90d → `'archivable'`; `durability='durable'`+now+90d → `'fresh'`; higher `depth` raises half-life; **NULL durability → never archivable**. Single-token assertions on the phase string.
- **Files:** new `packages/core/src/memory/decay.ts` (pure fn; durability→half-life table is data, clock is a parameter — extends the existing `opts.now`/`clock()` seam, never `Date.now()` inline).

### T3.2 — DecayScorer → `deps.scorer` (repair dead P3 — QUEUE, not inline retire) · dispatch-sized: YES
- **[RED-TEAM FIX #11 — P3 keeps a second live retire authority]** `cycle.ts:546` calls `retireNonDirectMemory` **directly** and labels `auto_applied` at `:554` — the same retire-before-status pattern as PC1, bypassing the queue/apply path and the dry-run guarantee. The fix MUST make the P3 scorer write `status='queued'` and **defer the actual retire to the T0.5 apply path**, exactly as required of PC1. Otherwise a NULL-durability legacy row could be retired before backfill (R1/R2 violation), and "single authority" (R4) is false.
- **[RED-TEAM FIX #8 — watermark the scorer loop]** The P3 loop at `cycle.ts:533` re-scans `ORDER BY created_at ASC LIMIT` every cycle, re-scoring the same head rows and starving the tail. Give the scorer loop the **same `decay_scored_at` watermark** as the backfill (`WHERE decay_scored_at IS NULL OR updated_at > decay_scored_at`) so it advances through the corpus and supports cap-trip resume.
- **Failing test:** `packages/daemon/test/dreaming/p3-runs.test.ts` — with `deps.scorer` set, P3 scores and **queues** retire proposals (today skipped at `cycle.ts:533`); assert the action is `status='queued'` and `retired_at` is still NULL until the apply path runs; DecayScorer returns `{composite, should_auto_retire, verdict}` matching the `cycle.ts:543` contract; low-durability+old → propose retire, high-depth → keep; assert the watermark advances (head rows not re-scored on a second cycle).
- **Files:** new `decay-scorer.ts` (implements the scorer interface, calls pure `decayState`); `deps.ts:67` set `deps.scorer = new DecayScorer(...)`, budget-bounded by the sized cap; `cycle.ts:546-554` (queue, not inline retire; add watermark predicate to the scan).
- **Reconciliation note:** SINGLE decay authority. PC1 (T0.1, demoted) is the cheap deterministic pre-filter; both write the same `dream_actions` ledger and flow through the same T0.5 apply / revert path — no competitor.

### T3.3 — Decay → archive (soft, recoverable) + watermarked batched backfill · dispatch-sized: YES
- **Failing test:** `packages/daemon/test/dreaming/decay-archive.test.ts` — an overdue row gets `archived_at`, NOT `retired_at` (recoverable); a NULL-field legacy row is NEVER scheduled for retire. Backfill is idempotent (re-run writes nothing new), batched (`P3_SCAN_LIMIT`), scores only `decay_scored_at IS NULL OR updated_at > decay_scored_at`; obs_type drives the durability prior (standing_brief short, fact long).
- **Files:** `cycle.ts:545` retire→archive; the P3 scan query + scorer; gated by `PENUMBRA_BACKFILL`.
- **Risk gate:** **dry-run-first** — emits a reviewable manifest (`memory_id`, proposed obs_type/durability/depth, would-retire? y/n) before any retire is honored; mirrors the queued→apply pattern. Sequence the live retire to land **AFTER** the in-flight retirement-leak fix (and after T3.2's queue change, so no inline retire bypasses dry-run).

### T3.4 — Wire decay into recall input · dispatch-sized: YES
- **Failing test:** `packages/core/test/readers/recall-decay-filter.test.ts` — an `'archivable'`/archived row is excluded or down-weighted vs a `'fresh'` row at equal similarity. (Feeds Phase 4.)
- **Files:** `recall.ts` t2 query (decay_score / `archived_at` predicate) — apply to **both** the RRF t2 SELECT and the hybrid reader.

---

## PHASE 4 — WS4 SIGNAL-AWARE RANKING (needs Phase 0 verify + Phase 3 decay_score)

**Workstream:** WS4. **Satisfies:** the Bubblemem convergence — *make recall rank on signals beyond cosine* — + review findings *RANKING IGNORES EVERYTHING BUT SIMILARITY, bm25 top-row normalization, min_score=0 filler, oldest-first eviction*.
**Objective:** Make the ONE rank function consume every signal. Mechanical fixes (4.1–4.2) have no upstream dependency and land early; the signal-blend is terminal; the **trust term is HARD-GATED and lands LAST**.

### T4.1 — bm25 normalization + min_score floor (t0 path + hybrid branch) · dispatch-sized: YES
- **[RED-TEAM FIX #4 — bm25 is t0-only; hybrid skips min_score]** `bm25ToScore` (`recall.ts:346`) is used **only** in `queryT0` (`:331`); the **t2 path uses `toScore(distance)`** (vector L2, `:179`) and never touches bm25. So the "two thin-corpus hits both score 1.0" fix is a **t0-only** fix. Separately, the **hybrid branch (`recall.ts:23-47`) applies NO `min_score` filter** — that `.filter(r.score >= req.min_score)` exists only in the RRF branches (`:68/:149/:199`). The task MUST: (a) scope bm25-normalization to t0; (b) **add an explicit `min_score` filter inside the hybrid branch**; (c) note t2 thin-corpus filler is a *vector-distance* problem (`toScore` floors at 0, never gates) needing its own threshold, not the bm25 fix.
- **Failing test:** `packages/core/test/readers/score-memory.test.ts` — two thin-corpus **t0** hits do NOT both score 1.0 (replace top-row normalization at `recall.ts:346` with absolute sigmoid `1/(1+exp(k*(bm25-b0)))`); `packages/core/test/readers/recall-hybrid-min-score.test.ts` — a hybrid recall with `min_score=0.15` drops a below-floor hit (currently returns it).
- **Files:** new `packages/core/src/readers/score-memory.ts` (pure fn seam); `recall.ts:346` (t0 norm); `recall.ts:34-46` (hybrid `min_score` filter); `schemas/recall.ts` min_score default lifted off 0 (configurable per-call).
- **Back-compat / risk:** `min_score` floor configurable per-call (caller can opt back to 0); ship as a SEPARATE dispatch from T4.3 so a ranking regression bisects cleanly.

### T4.2 — Token-budget eviction by recall score (thread existing score) · dispatch-sized: YES
- **[RED-TEAM FIX #10 — `sized` items have no score]** `workflows/recall.ts:155` builds `sized` items carrying only `{key, ts, tokens, ref}`; `scoreMemory(row, dist, now)` needs `dist`/the raw row, which is gone by `composeRecall`. The task MUST thread the **recall score already on the hit** (`RecallResult.score` / `fusedScore`, available upstream) into `sized`, and re-key the sort (`:176-181`) from `a.ts.localeCompare(b.ts)` to **that score ascending** (ts as tiebreak) — **NOT** a call to `scoreMemory` (which lacks its arguments in this layer).
- **Failing test:** `packages/workflows/test/recall-eviction.test.ts` — over budget, the LOWEST-recall-score item is dropped, not the OLDEST; a high-score OLD hit survives over a low-score NEW one.
- **Files:** `workflows/recall.ts:155` (`sized` gains a `score`), `:176-181` (sort key).

### T4.3 — `scoreMemory` signal-blend: recency + decay + importance + why-freshness (NOT trust yet) · dispatch-sized: YES
- **Failing test:** `packages/core/test/readers/score-memory-blend.test.ts` — per-signal isolation: equal similarity + newer > older (recency, durability-scaled); higher depth > lower (importance); fresher-why > stale-why; archived penalized. Then integration: `recall()` ordering reflects the composite. A **shared fixture asserts identical ordering across `recall.ts` AND `workflows/recall.ts`** (no drift).
- **Files:** `score-memory.ts` (blend `final = sim_norm*w_sim + recency(learned_at, durability) + importance(depth) - decay_penalty(decay_score/archived_at)`); imported by both call sites; applied before `fuseRRF` (`recall.ts:205`).
- **Risk:** shadow-log the new-vs-old order delta for ≥1 cycle before flipping the emitted order. (R9)

### T4.4 — Trust + why-freshness boost (HARD-GATED, lands LAST) · dispatch-sized: YES
- **Failing test:** `packages/core/test/readers/score-trust-boost.test.ts` — a verified + fresh-why memory ranks above an unverified equal-similarity one; with the flag OFF (or `corpus verified_count==0`) the output is IDENTICAL to the T4.3 base. The test is written so it can only pass *after* T0.2/T0.3 populate real verification — hard-sequencing the dependency in the test itself.
- **[RED-TEAM NOTE — scope verified_count]** `verified_count` MUST be computed over the **current project/corpus scope**, not global — a single globally-verified row would un-gate trust for a thin project corpus. Specify the scope in the task.
- **Files:** `score-memory.ts` trust/why terms behind a weight flag; the rank fn coerces `w_trust→0` when scoped `verified_count==0`.
- **Risk gate:** flag-gated to weight 0 until WS0 proves `last_verified_at` is populated and unforgeable — enforced as a merge-order constraint. (R3)

### T4.5 — Per-turn transient replacement (regression test, no auto-recall rank code) · dispatch-sized: YES
- **[RED-TEAM FIX #6 — `auto-recall.ts:69` is not a rank site]** `autoRecallForDispatch` maps `result.hits` **in the order recall returns them** (`auto-recall.ts:69` is `result.hits.map((hit) => hit.id)`); it performs no sort and reads no score. The per-turn replacement behavior is **already structurally true** (auto-recall rebuilds from scratch each call — no accumulator). The task is therefore: **add a regression test asserting no cross-turn accumulator; NO code change in auto-recall.** Blended ordering reaches auto-recall *by inheritance* from `RecallReader.recall` (the seam fixed in T4.3) — not by re-ranking here.
- **Failing test:** `packages/daemon/test/dispatch/auto-recall.test.ts` + `packages/agentchat/test/worker/recall-enricher.test.ts` — set-identity property test: turn-N ids `{A,B}`, turn-N+1 ids `{C,D}`; the injected block for N+1 contains exactly `{C,D}`, NOT `{A,B,C,D}` (`.sort().join(',')`). Same query in the same turn is stable (deterministic composite rank from T4.3).
- **Files:** test files only; `recall-enricher.ts` only if it holds a cross-turn accumulator (assert it does not).
- **Sequence:** lands after T4.3 is deterministic; independent of T4.4.

---

## Cross-cutting risks & mitigations

- **R1 — Backfill corrupts the 1,170 irreplaceable rows (highest).** *Mitigation:* backfill is dry-run-first, idempotent, batched, `PENUMBRA_BACKFILL`-gated, writes ONLY NULL fields, never retires in dry-run, emits a reviewable manifest (T3.3); every new column NULL-defaults; **NULL durability = never-retire bucket**; the rank seam treats NULL as neutral.
- **R2 — Decay or creation-gate drops a load-bearing memory.** *Mitigation:* T0.1 neutralizes PC1 FIRST (env-gate OFF, **conditional** anchor, **gate the retire not just the label**); **T3.2 queues instead of inline-retiring** (no second live authority); all forgetting is `archived_at`/`retired_at` + revertible; the gate REJECTS at promotion (reversible) or queues a merge; `depth>=2` density escape hatch; discriminator fixture includes must-KEEP cases.
- **R3 — Trust boost amplifies an empty/forgeable signal.** 0/418 verified, `/verify` spoofable. *Mitigation:* T4.4 HARD-gated behind T0.2 (lane_ledger lookup **via `lane_id`**) + T0.3 (back door closed); `w_trust→0` while **scoped** `verified_count==0`; trust test can't pass until WS0 lands.
- **R4 — Building a third decay system.** *Mitigation:* T3.2 wires the scorer into the EXISTING `cycle.ts:533` gate; PC1 demoted; **both queue through the one T0.5 apply path** — the red-team fix to T3.2's inline retire is what makes "single authority" true rather than aspirational.
- **R5 — Migration / caller-contract breakage.** *Mitigation:* all columns additive-nullable via idempotent `addColumnIfMissing`; `lnSchema` + `memory_write_t2` fields OPTIONAL; envelope additions additive-optional; migration test runs migrate TWICE on a legacy fixture asserting unchanged row count + existing obs_type/verified columns stable + all MCP callers still return.
- **R6 — Non-deterministic / costly scoring.** *Mitigation:* T1a.2 replaces the coin-flip with deterministic content-hash dedup (same-seed-twice assertion) BEFORE downstream tests depend on stable corpus; **payload widening keeps length gates and lands after a sized budget**; why/source_quote/obs_type ride the existing promotion call; durability/depth batched + watermarked in the metered P3 lane.
- **R7 — Embedder non-determinism in dedup tests.** *Mitigation:* `fakeEmbedder` maps known strings to hand-chosen unit vectors (cosine = arithmetic); reused across T2.4/T2.6/T3.4.
- **R8 — Test-store isolation breaks existing fixtures.** *Mitigation:* T1a.1 lands FIRST, verified by the FULL suite green before any quality-gate test; test DB path asserted outside `~/.penumbra/db.sqlite`.
- **R9 — Two rank-seam consumers drift.** *Mitigation:* single exported `scoreMemory` in core; shared fixture (T4.3) asserts identical ordering across `recall.ts` + `workflows/recall.ts`; auto-recall *inherits* the order (T4.5), never re-ranks.
- **R10 — Retirement-leak interaction.** The leak fix must land before WS3 auto-retires more aggressively, else archived rows rehydrate via timeline. *Mitigation:* treat as in-flight prerequisite; sequence T3.3's live retire AFTER it; **the dependency now covers PC1-if-enabled (T0.1) and the P3 scorer (T3.2)**, not just T3.3, since both can create newly-retired rows; recall/search already filter `retired_at IS NULL` so the user-facing path is safe mid-flight; T2.4's dedup-before-insert permanently replaces dedup-by-retirement.
- **R11 — Efficacy mis-wired as per-memory.** `memory_efficacy_cache` is finding-keyed (`schema.ts:823`). *Mitigation:* WS4 consumes efficacy ONLY as an aggregate tuning input for `min_score`/`w_trust`, never a per-row score.
- **R12 (new, from red-team #8) — Budget wired but never sized; three lanes drain it.** DecayScorer (T3.2), durability/depth enrichment (T3.3), and payload-widening re-promotion (T1a.2) draw the same daily cap. *Mitigation:* T0.4 adds a **per-phase budget split** and **cap-trip-mid-backfill resume semantics**; the P3 scorer and backfill share the `decay_scored_at` watermark so neither re-scans the head every cycle.

---

## Suggested dispatch order & parallelism

| Wave | Dispatches (parallel within a wave) | Gate before next wave |
|---|---|---|
| **W1** | **T0.1** alone (data-loss stopper, strictly first) | T0.1 green + merged |
| **W2** | T0.2 ∥ T0.3 ∥ T0.4 ∥ T0.5 ∥ **T1a.1** | T1a.1 green AND full existing suite green (R8 gate) before any W3 quality-gate test |
| **W3** | T1a.2 (after T0.4 budget sized) ∥ T1a.3 | — |
| **W4** | **T2.1** alone (migration spine — other W4 tasks SELECT/INSERT its columns) | T2.1 migrate-twice test green |
| **W5** | T2.2 → T2.3 ∥ T2.4 ∥ T2.5 ∥ T2.6 (T2.2 first; 2.3/2.4 share the insert loop — serialize those two or coordinate the diff) | obs_type populated end-to-end |
| **W6** | T3.1 → T3.2 (after T0.4 + T0.5 + T2.1) | T3.2 queues (not inline-retires) verified |
| **W7** | T3.3 (dry-run-first; live retire AFTER retirement-leak fix lands) → T3.4 | decay_score readable in recall |
| **W8** | T4.1 ∥ T4.2 (no upstream dep — can run as early as W3) | bisect-clean, separate from W9 |
| **W9** | T4.3 → T4.5 (after T4.3 deterministic) | shadow-log delta ≥1 cycle |
| **W10** | **T4.4** alone, LAST (after T0.2 + T0.3 prove real verification) | trust test passes only post-WS0 |

**Parallelism notes:** T4.1/T4.2 have no upstream dependency and may be pulled forward to W3 to parallelize idle fleet capacity; they are intentionally separate dispatches from T4.3 so a ranking regression bisects to a single change. Anything touching the t2 INSERT loop (T2.3, T2.4) or the t2 SELECT (T2.6, T3.4) must coordinate the diff or serialize to avoid merge churn on `t2.ts` / `recall.ts`.

---

## Phase 1 starting point: what lands first and why it is safe + high-leverage

**Land T0.1 (Neutralize PC1 auto-retire) first, alone.**

- **Why first:** `pc1-ephemera.ts:64` is the only currently-running code path that hard-retires live memories with no judge and no gate — confirmed active data loss against the 418 live rows. Every other task can wait; this one is bleeding now.
- **Why safe:** the behavior change is gated OFF by default (`PENUMBRA_PC1_AUTORETIRE`), and the corrected fix **stops calling `retireNonDirectMemory` in the OFF path** (writing a revertible `status='queued'` ledger row instead) — so the worst case is a memory that *was* being silently retired now survives. The conditional anchor (`^` only when the LIKE pattern lacks a leading `%`, `$` only when it lacks a trailing `%`) tightens the mid-string `Fix:%`/`Implement %` leak **without** breaking the `%…%` substring patterns. No schema change, fully revertible.
- **Why high-leverage:** it converts the most destructive lane into a *proposer* that flows through the same `dream_actions` ledger and the T0.5 apply path the DecayScorer will use — establishing the "queue, then apply" pattern the entire decay reconciliation (WS3) depends on, and removing the single largest source of irreplaceable-data loss before any later phase touches retirement at all.

**Verification anchors (all confirmed against HEAD `c5c0b2a1` this session):** `pc1-ephemera.ts:64` (unconditional `retireNonDirectMemory`), `:72` (post-facto status label), `t2-ephemera-detector.ts:9` (`%`→`.*`, no anchor), `lane-ledger.ts:7-19` (`LaneRow` keyed by `lane_id`, no `handoff_id`), `recall.ts:23-47` (hybrid branch, no `min_score` filter, `source_session_ids:[]` at `:43`), `recall.ts:192` (RRF t2 already parses `source_session_ids`), `recall.ts:346` (`bm25ToScore` t0-only), `recall.ts:179` (t2 `toScore` vector), `auto-recall.ts:69` (`result.hits.map` — no rank), `cycle.ts:192` (spend SUM), `:533` (P3 gated on `deps.scorer`), `:546/:554` (P3 inline retire + `auto_applied` label), `workflows/recall.ts:176-181` (oldest-first eviction sort, `sized` items have no score).

---

# Amendments — data-brief reconciliation (2026-05-31)

The phases above were drafted in parallel with the forensic data brief and did not see its findings. The brief (`docs/notes/2026-05-31-memory-forensics-data-brief.md`, live DB snapshot through 2026-05-31) measured the corpus + logs and surfaced four things the plan misses. New anchors below were grep/line-confirmed against HEAD `c5c0b2a1` this session.

## A. STRATEGIC FORK — decide before WS1 (t1-quality vs t2-curation)

**Finding [R]:** recall actually surfaces **68.3% t1 session-rollups, only 30.3% curated t2** (6,862 vs 3,051 of 10,053 slots); **66.6% of live t2 (279/419) was NEVER recalled once**; one id (`14a03642`, now retired) filled **9.66% of all slots / 29.2% of queries**. The plan is almost entirely t2-centric, yet t2 is mostly dead weight at recall time.

**The fork (author's call):**
- **(i) Stay t2-centric** — the plan as written; justified if you intend t2 to *become* the primary recall surface once ranking (WS4) demotes the t1 chatter and dedup (WS1) makes t2 worth surfacing.
- **(ii) Re-weight toward t1 quality** — invest in what gets promoted and in t1 rollup excerpt quality, since that's what recall reads today.
- **Recommended: (i) + a WS4 per-tier balance (T4.6) so curated t2 isn't crowded out** — i.e. keep the plan, but make ranking stop letting raw t1 rollups occupy ~⅔ of slots. This converts the fork into a ranking knob rather than a rewrite. Decide before W4.

## B. WS1 additions — the promotion pipeline (the single biggest bucket)

**Finding [T1]:** of 4,262 unpromoted t1 rollups, **3,234 (76%) are blocked by one policy line** (`n_events >= ?`), not by failure; the two promotion mechanisms are **uncoordinated and deadlocked** (the dreaming cron *claims* rows the worker is the only one that can finish, and the worker never sees `n_events<5`); the **996 hard-fails are dead forever** (no dead-letter/reset).

### T1a.4 — Reconcile the two promotion mechanisms + release stuck leases · dispatch-sized: YES
- **Problem:** `T2Promotion.detectEligibleRollups` (`t2.ts:444`) selects with `failed_promotion_attempts < ?` (`:453`) `AND n_events >= ?` (`:454`) and is the only finisher (`workers/t2-promotion.ts:112`). The dreaming-cron P1 block *claims* rollups (`cycle.ts:278`) with reclaim guarded by `claimed_at IS NULL` (`cycle.ts:284`, `:312`) and **never releases** them in the running path — so 3,090 `f0`+996 `f5` rows sit claimed forever. A reset statement exists at `schema.ts:1284` (`UPDATE t1_rollups SET claimed_at=NULL, claimed_by_cycle=NULL …`) but evidently is not on the live release path — **reconcile with it, don't add a second**.
- **Decision the task must make:** pick ONE promotion owner. Either (a) the cron P1 must not claim rows the worker can finish (scope its claim to its own promote path), or (b) claims auto-release when the owning `dream_cycle` is terminal / older than a TTL.
- **Failing test:** `packages/daemon/test/dreaming/promotion-lease.test.ts` — a t1 rollup claimed by a now-terminal cycle is re-selectable next pass (claim released); a rollup the worker can promote is never indefinitely held by the cron. **Unit hazard:** `claimed_at` is **milliseconds** (`schema.ts:1010` INTEGER), not ISO — TTL math must not mix units.
- **Files:** `cycle.ts:278/284/312`, `t2.ts:444-454`, reconcile `schema.ts:1284`.
- **Back-compat:** release-only change; no schema change (columns exist).

### T1a.5 — Right-size the `n_events` eligibility floor · dispatch-sized: YES
- **Problem:** 3,234 rows (2,528 with a usable ≥40-char body) can never promote because of `n_events >= ?` (`t2.ts:454`, threshold passed from `t2-promotion.ts:112`). They also hold leases (T1a.4).
- **Decision the task must make:** either **lower/remove the floor** and let the creation gate (T2.3) reject low-value rollups on *content* instead of *event count*, **or** stop *writing* sub-threshold t1 rollups at all (exclude at t1 creation) so they don't accumulate as zombies. Do NOT leave 3,234 ineligible-but-claimed rows.
- **Failing test:** `packages/core/test/writers/t2-eligibility.test.ts` — a 4-event rollup with a substantive body either becomes eligible (floor lowered) or is never persisted as a stuck row; the chosen policy is asserted, not incidental.
- **Files:** `t2.ts:454` (+ the `minEvents` arg at `t2-promotion.ts:112`), or the t1 rollup writer.
- **Sequence:** after T1a.4 (don't reclaim into a floor that still rejects); pairs with T2.3 (content gate replaces the crude count gate). **Back-compat:** policy change behind a config knob; default preserves today's number unless flipped.

> Slots into **Phase 1a**, after T1a.1 (test-store isolation). Both are deterministic, no LLM.

## C. WS3 addition — dead-letter the permanent failures

### T3.5 — Dead-letter + reset path for `f=5` rollups · dispatch-sized: YES
- **Finding [T1]:** 996 rollups at `failed_promotion_attempts = 5` (the cap, `recordFailure` at `t2.ts:433/435`) are **excluded forever** by `detectEligibleRollups`'s `failed < ?` (`t2.ts:453`) with no human-visible queue, repair, or reset. 968/996 have rich input — these are extraction/judge throws, not empty input.
- **Failing test:** `packages/core/test/writers/t2-deadletter.test.ts` — a rollup at the failure cap surfaces in a dead-letter query (operator-visible) and a reset path returns it to eligibility exactly once (bounded re-attempt), not an infinite retry loop.
- **Files:** `t2.ts:433-455` (dead-letter read + bounded reset), a small operator surface (reuse the dreaming pending/health route shape).
- **Sequence:** Phase 3, alongside the lease-TTL work it is conceptually paired with. **Back-compat:** additive read + opt-in reset; no schema change (column exists).

## D. WS4 addition — break recall's runaway concentration

### T4.6 — Anti-popularity / diversity / per-tier balance in fusion · dispatch-sized: YES
- **Finding [R]:** top-1 id = 9.66% of slots / 29.2% of queries; top-20 (1.6% of ids) = 30.5% of slots; **10 of the top-20 are raw t1 rollups**; result-set size is 98.8% pinned at 3. The same dominant rows come back regardless of query — pure similarity with no diversity guard.
- **Three sub-levers (one dispatch, three assertions):**
  1. **Frequency-share penalty** in `scoreMemory` — down-weight ids over-represented in recent `recall_audit` results (consumed as an *aggregate* tuning input, per R11; never a per-row trust column).
  2. **MMR-style diversity** at the fusion seam (`fuseRRF`, `rrf.ts:56`) — penalize a candidate that is a near-dup of an already-selected hit, so one cluster can't fill the top-k.
  3. **Per-tier cap / balance** — bound the t1 share of slots so curated t2 isn't crowded out (this is the concrete knob the Strategic Fork §A resolves to).
- **Failing test:** `packages/core/test/readers/recall-diversity.test.ts` — across a query set, no single id exceeds an N% slot share (frequency penalty); a near-dup of an already-selected hit is dropped (MMR); a t1-heavy candidate pool still yields ≥X% t2 slots (per-tier cap). Use the `fakeEmbedder` from T2.4.
- **Files:** `score-memory.ts` (freq term), `rrf.ts:56` (MMR + per-tier cap), `recall.ts` fuse call site (`:205`).
- **Sequence:** Phase 4, after T4.3 (needs the composite seam); independent of the trust term T4.4. **Back-compat:** all weights/caps configurable; defaults chosen to only *reduce* concentration, shadow-logged like T4.3.

## E. Revised dispatch waves (delta only)

| Wave | Add | Note |
|---|---|---|
| **W3** | **T1a.4**, then **T1a.5** | promotion-pipeline reconciliation; T1a.5 after T1a.4 |
| **W7** | **T3.5** | dead-letter, paired with the lease-TTL thinking from T1a.4 |
| **W9** | **T4.6** | after T4.3; resolves the §A per-tier balance; separate dispatch from T4.4 |

## F. Added risks

- **R13 — Reclaiming/lowering the floor re-trips the backlog.** Releasing 3,234+996 leases or lowering `n_events` can flood promotion under the now-real cap (T0.4). *Mitigation:* land T1a.4/T1a.5 **after** T0.4's sized budget; drain via the watermark, not in one storm; the content gate (T2.3) absorbs the low-value tail instead of the count floor.
- **R14 — Frequency-decay starves a legitimately hot memory.** A genuinely always-relevant fact (e.g. "agent branch naming") could be penalized for being recalled often. *Mitigation:* frequency penalty is a soft down-weight, not exclusion; bounded; pairs with WS1 dedup so "hot" reflects one canonical row, not 28 copies; shadow-log before flip.

## G. Honest corrections the brief forces on the review's framing

- **The retirement leak was a past artifact, not a live recall bug.** All 1,776 historical retired-id recalls happened *while the row was live*; zero after 2026-05-24. `recall.ts:172`/`search.ts:39` already filtered; the shipped `c5c0b2a1` fix closed the remaining *by-id rehydration* hole in timeline/get_observations (real, but lower-urgency than first framed). **Decay (WS3) need only rank/demote, not re-solve exclusion.**
- **"~38% of promotions fail" was wrong** — it's **31.1%**, and 76% of that is the eligibility floor (design), not breakage (§B).