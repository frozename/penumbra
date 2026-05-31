# Penumbra Memory Overhaul — DATA BRIEF

*Three read-only forensic tracks, merged. All figures traceable to source track: **[T1]** t1-promotion-failures, **[R]** recall-efficacy, **[D]** dedup-noise-reality. DB snapshot `/Users/acordeiro/.penumbra/db.sqlite`, window through 2026-05-31.*

---

## The 5 numbers that should drive the plan

1. **3,234 unpromoted t1 rollups (76% of all 4,262 unpromoted) are blocked by ONE policy line — the `n_events >= 5` floor — not by any failure.** All have `failed=0`; 2,528 of them even have a usable ≥40-char body. The headline "~38% don't promote" is really 31.1% (4,262/13,712), and it is dominated by design gates, not breakage. **[T1]**

2. **Recall is feeding back its own greatest hits: one memory ("Cross-project orchestration design") is in 29.2% of every query and supplies 9.66% of all 10,053 result slots.** Top-20 ids (1.6% of the 1,262 distinct ids ever returned) supply 30.5% of all surfaced content. **[R]**

3. **66.6% of live curated memory is write-only dead weight: 279 of 419 live t2 memories have NEVER been recalled.** Only 184 of the full 1,171-row t2 corpus were ever returned at all. **[R]**

4. **Recall surfaces t1 session-rollups, not the curated t2 corpus the system is built to protect: t1 = 68.3% of slots (6,862/10,053), t2 = only 30.3% (3,051).** 10 of the top-20 most-recalled ids are raw t1 rollups. **[R]**

5. **There is essentially NO creation-time gate today, and it shows: the same durable fact re-promotes up to 28 times** (the "agent branches are named agent/<handoff_id>" cluster, spread across 8 distinct dates). A reject-or-merge gate would have addressed ~12.9% of the live corpus (~54 rows) and prevented 89 token-set-dup surplus + 430 P6-brief regenerations from ever needing a sweep. **[D]**

---

## Track 1 — Why t1 rollups don't promote to t2 *(t1-promotion-failures)*

**The real number is 31.1%, and it is bimodal by design.** `t1_rollups` = 13,712; promoted = 9,450; unpromoted = 4,262. `failed_promotion_attempts` is bimodal with **zero rows in between**: 12,716 at exactly 0, 996 at exactly 5 (the retry cap). The bimodality is structural — **two uncoordinated promotion mechanisms write different columns**:
- the **t2-promotion worker** (`workers/t2-promotion.ts` → `T2Promotion.promoteRollup` in `core/writers/t2.ts`) is the only writer of `failed_promotion_attempts` (`recordFailure`, t2.ts:433);
- the **dreaming-cron P1 block** (`daemon/src/dreaming/cycle.ts`, wired `serve.ts:1445`) is the only writer of `claimed_at`/`claimed_by_cycle` (cycle.ts:278).

**Clean partition of the 4,262 unpromoted:**

| Bucket | Count | % of unpromoted | Root cause |
|---|---|---|---|
| (b) Ineligible `n_events < 5` | **3,234** | 76% | Policy floor in `detectEligibleRollups`; all `failed=0`; can never be selected. 2,528 have a usable ≥40-char body. |
| (a) Judge-rejected `f=5` | **996** | 23% | Reaches the LLM judge/extractor and throws 5× → permanently excluded (`detectEligibleRollups` requires `failed<5`). NOT empty input. |
| (c) Never-claimed backlog | 30 | <1% | Fresh-rollup lag, mostly `ended_at` within days — normal. |
| (d) Claimed+eligible stuck | 1 | — | Outlier `d2ea8231`: `n_events=101,124` but 0 agent-prompt/response events of 102,078 → empty-transcript path. |

**On bucket (a), the 996 hard-fails are rich, not lossy:** 968/996 have a usable first_prompt_excerpt (≥40 chars), `n_events` 5..3389 (avg 69.6), rich t0 transcripts (sampled 1211/765/662/584 agent events with non-empty `payload_summary`). They fail inside `promoteRollup`'s try-block — either the judge HTTP-throws or strict schema validation (t2.ts:362-369) throws on any malformed extraction. **There is NO dead-letter, NO repair, NO reset path** — at `f=5` the rollup is dead forever.

**Lease state is a permanent, never-released lock.** `claimed_at` is stored in **milliseconds** (1779394256637..1779774149482 ≈ 2026-05-21..05-26), stamped by P1 on **everything it selects with NO `n_events` filter and NO retry filter**, and is **never reset** (re-claim condition is `claimed_at IS NULL`). Of unpromoted: 3,090 claimed+f0, 996 claimed+f5, only 176 unclaimed. P1 claims 3,234 rows it can never finish (the worker is the only finisher, and the worker never sees `n_events<5`) — a structural deadlock.

**P1's own promote path almost never fires:** `dream_actions` P1 `promote_t1` = **5,357 'queued' vs 128 'auto_applied' (97.7% never auto-promote)** — the gate needs ≥2 judges AND yes ≥ ceil(2/3·total), which the StubJudgePool default never satisfies. `dream_cycles`: 5,489 completed, 69 bailed, 2 crashed.

**Promotion is lossy even when it "succeeds":** `promoteRollup` rebuilds the transcript only from `t0_events.payload_summary` (agent-prompt/response only), discarding tool calls, thoughts, and the curated excerpt columns. A 50% random sampler (t2.ts:353) and a <200-char min-transcript skip (t2.ts:337) silently `markPromoted` **without writing any memory** — consistent with only **1,171 t2_memories total from 9,450 "promoted" rollups**. P1's separate 40-char body gate (cycle.ts:332) silently skips short/boilerplate prompts while still holding their claim; 1,606 unpromoted rows are claude-mem observer boilerplate, 967 are the `<recent-relevant-context>` recall-injection wrapper.

---

## Track 2 — What recall actually surfaces *(recall-efficacy)*

**Volume:** 3,327 recall queries logged (2026-05-03 → 2026-05-31), 1 user, 3 projects, 10,053 result slots.

**The 99.94% "hit-rate" is misleading.** 3,325/3,327 returned something; result-set size is **98.8% pinned at exactly 3** (TRIVIAL top_k=3 dominating dispatch traffic). It measures "returned something," not "returned something relevant" — with RRF, a low/absent min_score, and an empty-to-cross-project fallback, recall almost always returns its dominant rollups regardless of query.

**Tier mix of 10,053 slots:** t1 = 6,862 (68.3%), t2 = 3,051 (30.3%), orphan 122, t0 18. **Recall is overwhelmingly t1 session-rollups, not the t2 corpus the system curates and protects.**

**Concentration is severe.** 1,262 distinct ids ever returned. Top-1 (`14a03642`, "Cross-project orchestration design", now RETIRED) = 971 slots = 9.66% of all slots, present in 29.2% of queries. Top-10 = 2,238 slots (22.3%); top-20 = 3,068 (30.5%). Long tail: 523 ids recalled exactly once, 730 ≤2 times, only 36 ids ≥50 times. **10 of the top-20 are raw t1 rollups.**

**Dead weight:** of 419 live t2 memories, only 140 were ever recalled; **279 (66.6%) never surfaced once.** Of the full 1,171-row corpus, only 184 distinct were ever returned.

**The "retired leak" is a past artifact, not a live bug.** 44 retired t2 memories appear across 1,776 historical occurrences (incl. the #1 id), **but all 1,776 occurred while the memory was still live** (`recalled_after_retirement=0`). Zero retired-id occurrences after 2026-05-24 across 601 queries — the `AND m.retired_at IS NULL` filter (recall.ts:172) demonstrably works going forward. **Decay does NOT need to re-solve exclusion, only ranking/demotion.**

**Lane ledger (downstream priming):** 951 lanes, 414 (43.5%) carry recalled ids; feature is ~9 days old (first non-empty 2026-05-21). Top referenced ids are all t1 rollups (`5ca0dc02`×39, `14da9116`×37, `56323536`×35). Only 5 retired t2 ids appear. By gate_status: skipped 869 lanes / 46.7% with-recall, passed 80 / 10.0%. Downstream dispatches are primed mostly by t1 rollups.

---

## Track 3 — True duplication + noise a creation gate must catch *(dedup-noise-reality)*

**Corpus:** 1,171 t2_memories; **419 live, 752 retired.** Live kinds: direct 208, knowledge 70, decision 47, preference 34, fact 31, brief 13, rule 11.

**Two distinct noise regimes in two places:**

**RETIRED is mass-regenerated boilerplate (the sweep already handles it).** Body-prefix clustering: 430 retired rows (57% of retired) are the single `"# project brief: penumbra generated by p6."` brief; another 128 are `"P1 auto-promote"` agent-config dumps (the entire 'promoted' kind, all retired). ~74% of retired = machine-regenerated config/brief correctly swept out.

**LIVE is cleaner but carries the noise the sweep does NOT catch:**

| Live noise type | Magnitude | Notes |
|---|---|---|
| Exact-title dup | 6 groups / 9 surplus = 2.1% | — |
| Token-set-normalized title dup | 6 groups / 9 surplus | merges plural/word-order |
| Semantic near-dup (Jaccard ≥0.6) | 13 pairs / 20 rows = 4.8% | ≥0.8: 8 pairs / 16 rows = 3.8% |
| Episodic process-diary | 28 rows = 6.7% | Task N.N narration, `origin='direct'` |
| Tiny bodies (≤60 chars) | 15 rows | incl. 'second', 'in proj_a', 'hotfix smoke' |
| **Combined deduped noisy union** | **~54 rows = ~12.9%** | reject-or-merge addressable |

**Re-promotion of durable facts is the dominant live-dup mechanism.** Same canonical fact re-extracted nearly every session: "agent branch naming" **28 rows** (L3/R25, across 8 dates 05-06..05-27, origin mostly 'maestro'); "dispatches must use trust=all" **19 across 3 phrasings**; "Postgres for audit log" 10. Surviving as 2-3 live copies each.

**Episodic diaries are NOT durable facts** — `origin='direct'` (agents/maestro writing via the direct path): "Task 4.1 was developed using TDD…", "Schema Version Bump from 11 to 12…", "Four new tests were added to…". Half-life of one session.

**Watch for false positives in a naive gate:** bare `[[...]]` is mostly legit (107 of 111 are feedback-* prose, only 4 synthetic); body-substring "smoke" is mostly legit (39 of 45 prose). **Real synthetic signal = tiny placeholder bodies (≤60 chars) + the `refs [[...]] inline` pattern**, ~8-12 rows.

**Density is bimodal (live, n=419):** min 11, max 9,301, avg 1,378; p10=125, p25=191, p50=807, p75=2,086, p90=3,324. **40 rows (9.5%) ≤120 chars (thin one-liner facts that should MERGE), 205 (48.9%) >1,000 chars (heavy tail, many episodic diaries).**

**Code finding — no creation gate exists.** Three write paths in `core/writers/t2.ts`: (a) `writeDirectT2Memory` dedups ONLY on exact `slug`, only when supplied; (b) `writeT2Memory` raw INSERT, no dedup, no quality gate; (c) `T2Promotion.promoteRollup` has input-size throttles only (minTranscript 200, maxTranscript 20000, highFreq 5 + 50% random skip) — no output dedup; `T2MemoryExtractionSchema` only requires `title.min(1)/body.min(1)`. That is exactly why the same fact re-promotes 28× and why 'second'/'in proj_a' are durable.

---

## What this changes about the plan

### WS1 — Creation gate: **PRIORITY RAISED. This is the missing layer; all three tracks converge on it.**

Three independent lines of evidence demand it: **[T1]** 76% of non-promotion is a creation/eligibility decision (the `n_events≥5` floor), not a judge problem; **[R]** 66.6% of live memories are never recalled (write-only dead weight) and surfaced value is concentrated in <40 ids; **[D]** no creation gate exists today, so the same fact re-promotes up to 28×. The gate must do three things at INSERT time, wired into **all three** writers in `core/writers/t2.ts`:

1. **Semantic dedup-on-write.** Embed the candidate, check cosine vs existing live memories *in the same project*; on near-hit, **MERGE/UPDATE + bump a recency/verification counter** instead of inserting a copy. This kills the dominant live-dup mechanism (the 28× / 19× re-promotion clusters). **[D]**
2. **Episodic-vs-semantic classifier.** Reject (or route to T1/ephemeral) past-tense process narration. Cheap lexical prefilter — `Task N.N` regex + "was developed/written/added/rewritten", "During testing", "This included", "the commit includes" — flags 6.7% of live at high precision; pair with an LLM "durable reusable fact?" check on borderline. Must cover the **direct/observe path** (these are `origin='direct'`), not just promotion. **[D]**
3. **Thin-body / synthetic floor.** Reject bodies ≤60 chars (15 live rows) and the `refs [[...]] inline` pattern. **Do NOT** key on bare `[[` or substring "smoke" — 107/111 and 39/45 are false positives. **[D]**

**Concrete thresholds the data supports:**
- **Near-dup merge:** cosine corresponding to **Jaccard ≈0.6** (catches 4.8% of live) standard, **≈0.8** conservative (3.8%). **[D]**
- **Body length floor: ~120 chars** would gate the 9.5% thin head — but **pair with merge, not drop**, since many thin rows are valuable canonical facts that should consolidate (the 40 rows ≤120 chars overlap the durable one-liners). Hard-reject only ≤60 chars (synthetic placeholders). **[D]**
- **Eligibility floor for promotion: lower or remove `n_events≥5`**, or have the t1→t2 worker pull from the **curated excerpt columns** instead of requiring ≥5 t0 agent events — this reclaims the single largest bucket (3,234 rows) cheaply. If 4-event observer/dispatch rollups *should* be excluded, **exclude them at t1 CREATION (don't write them)** rather than leaving 3,234 zombie rows with stuck claims. **[T1]**
- **Backstop:** reject pure agent-config bodies (`You are …long-lived agent with persistent state. Standing brief:` — 16 rows, almost all already retired). **[D]**
- **De-duplicate the two promotion mechanisms** — pick ONE owner of promotion. Today P1 claims rows only the worker can finish, and the worker never sees `n_events<5`. **[T1]**

**Open question for the author [R]:** since recall actually runs on t1 (68% of slots) and t2 is two-thirds dead weight, WS1 should question whether curating t2 at all is the right lever vs. improving t1 rollup quality.

### WS3 — Decay: **PRIORITY RAISED on two specific axes; exclusion is already solved.**

- **Lease decay / TTL (new requirement from [T1]).** `claimed_at` is a permanent lease with no expiry and no release — 3,090 f0 + 996 f5 rows are claimed and never reconsidered. Add release when a claim is stale (>24h) or when `claimed_by_cycle`'s `dream_cycle` is terminal. **Unit hazard:** `claimed_at` is in **milliseconds** while cutoffs elsewhere use ISO/seconds — decay logic must not mix units. **[T1]**
- **Dead-letter for the 996 f=5 rows [T1].** `failed=5` is terminal forever with no human-visible queue — decay needs a reset-to-dead-letter policy.
- **Anti-popularity / frequency-decay (from [R]).** Concentration is the core problem decay should attack: one id at 9.66% of slots / 29% of queries is a runaway, and the #1/#2/#5/#9 most-recalled were retired correctly but only after dominating for weeks (manually and late). Decay should penalize **recall-frequency share**, not just age. **[R]**
- **Episodic age dimension (from [D]).** Live episodic diaries (26-28 rows) and live synthetic placeholders (test-artifacts: live 135 vs retired 1 — the sweep ignores them) need a fast-decay age dimension. Without WS1 catching them at birth, WS3 re-sweeps the same re-promoted facts forever (branch-naming reappears across 8 dates). **[D]**
- **Scope relief [R]:** the `retired_at` filter already works post-fix (0 leaks after 2026-05-24) — **decay does NOT need to re-solve exclusion, only ranking/demotion.**

### WS4 — Ranking: **PRIORITY RAISED — this is where the largest leverage on surfaced quality sits.** Promotion today does not rank.

- **There is no real ranking anywhere [T1].** Promotion *judges* (binary) and, when it promotes, drops high-frequency shapes via a 50% coin flip and silently skips <200-char transcripts — "promoted" is a lossy, partly-random filter (1,171 memories from 9,450 "promoted"). The 5,357-queued-vs-128-auto_applied split means the real approval bottleneck is the ≥2-judge / 2/3-majority vote gate that almost never fires with the stub pool. Replace the random sampler + binary judge with an **actual relevance score** and feed the 5,357 queued P1 actions through it. **[T1]**
- **RRF has no diversity or query-specificity guard [R].** The 98.8%-at-3 + 68%-t1 + top-20-supply-30% pattern means the same dominant rollups come back for nearly every query. Add: **(a)** a min_score floor that actually filters (the current near-zero floor passes everything); **(b)** MMR-style diversity so one id can't occupy a slot in 29% of queries; **(c)** a t1/t2 balance or per-tier cap so curated memories aren't crowded out by session-rollup chatter. Because the lane_ledger join confirms downstream dispatches are primed mostly by t1, ranking changes directly change what every future dispatch sees. **[R]**
- **Duplication inflates ranking [D].** A fact stored as N copies floods the top-N (28× branch-naming, 19× trust=all) — copy-count acts as a popularity proxy. Once WS1 merges-on-write, ranking should fold residual near-dups into a single entry ranked by a consolidated verification/recency signal. **Normalize for length** so the 49% >1000-char episodic diaries don't out-rank dense one-line facts. **[D]**

### Net priority call

All three workstreams move **up**, but in a specific order dictated by the data: **WS1 is the keystone** — it is the only layer that addresses the largest single bucket ([T1] 3,234 rows), the dead-weight root cause ([R] 66.6%), and the re-promotion mechanism ([D] 28×) simultaneously, and without it WS3 re-sweeps the same facts forever. **WS4 delivers the largest immediate change to what users/dispatches actually see** (recall surfaced quality), since today nothing ranks. **WS3's exclusion job is already done** (retired_at filter works) — its remaining, newly-evidenced work is lease-TTL + dead-letter ([T1]) and frequency/episodic decay ([R]/[D]).