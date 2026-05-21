# Memory dreaming — spec

**Date**: 2026-05-21
**Status**: revised after adversarial-plan + re-run critique pass (2026-05-21 PM)
**Owner**: maestro
**Revision history**:
- v1 draft → user-approved 6 design decisions, then adversarial-plan run.
- v2 (this doc) → absorbs 12 MUST findings + 10 SHOULD findings from `.penumbra/reviews/2026-05-21T16-57-23.164Z/synthesis-rerun.md`; resolves Q4, Q5, Q8; names Firecrawl prompt-injection mitigation.

## Problem statement

Penumbra's memory tiers (t0 events, t1 rollups, t2 memories) grow continuously but are passive — they accumulate, get queried at recall time, and nothing further happens to them. As a result:

- **Stale t1 backlog** — 4,859 unpromoted rollups vs 358 t2 memories (13× backlog) as of 2026-05-21.
- **No relations** — memories are atomic; recall returns N nearest neighbours but cannot graph-walk concept clusters.
- **No active discovery** — contradictions, repeatedly re-derived patterns, and open questions accumulate silently.
- **No deepening** — no mechanism to enrich memory from external sources when internal experience is thin.
- **Embedding drift** — older corpus chunks are stuck at the embedder version they were minted under.
- **No knowledge briefs** — no per-project "what penumbra currently knows" summary maestro can load at session start.

Dreaming is the active counterpart: a daemon-side process that, during idle windows, revisits memories, organizes them, links them, mints new ones, fixes broken ones, and enriches them with external research — subject to confidence-tiered review and crash-safe state management.

## Goals

1. **Consolidate** stale t1 rollups → t2; merge near-duplicates; demote noise.
2. **Link** memories with persisted relations to make recall graph-aware.
3. **Discover** contradictions, repeatedly re-derived patterns, open questions; auto-resolve when high confidence, queue otherwise.
4. **Research** external sources (Firecrawl/web/repo allowlist/MCP) to deepen knowledge on under-documented topics.
5. **Quality rewrite** low-quality memories using a multi-factor signal (not LRU alone).
6. **Re-embed** older corpus when the embedder version changes.
7. **Per-project briefs** — generate, refresh, dual-write to authoritative table + t2 shadow.

## Non-goals

- Real-time learning during active dispatches (covered by existing memory_observe).
- Replacing manual `memory_observe`.
- Self-modifying code.
- Cross-user / cross-machine sync.

## Design decisions (locked)

1. **Idle detection**: cron floor (`*/30 * * * *`) + event-driven opportunistic trigger when dispatch-quiescent + tick-quiet for ≥ N min. Cron guarantees a cycle attempt; event-trigger fires earlier in long idle windows. Event-trigger bursts (multiple events within mutex window) explicitly **DROP** with a log line; second event is not queued (avoids back-to-back cycle exhaustion of daily cap).
2. **Cost cap**: per-cycle hard cap + daily ceiling + subscription-pressure guard. **All three enforced from Phase A** (R9). Dreaming yields immediately if `subscription_pressure_status` returns any provider in `throttled` or `constrained` state.
3. **Output channel**: hybrid by confidence. High-confidence actions auto-apply; low-confidence stage as proposals.
4. **Research sources**: configurable per-project via the project registry. Default is `web: { provider: firecrawl }`.
5. **Judge pool**: dedicated dream judge pool (separate from `memory-efficacy`). Config block `dreaming.judge_pool` in daemon yaml. Clean cost attribution + independent failure isolation. SHOULD share a `createJudgePool(config)` factory with memory-efficacy if/when extracted.
6. **Brief storage**: dual-write. Authoritative versioned copy in `project_briefs` table + synced shadow t2 memory tagged `brief_for:<project_id>`. Shadow is **update-in-place** (Q8 resolved) — never mint duplicate t2 rows. Shadow write goes through `memory_observe` (NOT direct SQL) so normalization + embedding apply (R14).
7. **Cycle interruption** (Q4 resolved): mid-cycle behavior is `complete-current-phase-then-bail`. When a maestro session starts OR `subscription_pressure_status` flips to constrained, the cycle finishes the in-flight phase and bails before the next; resumes from `last_phase_completed + 1` on the next idle window.
8. **Embedder version surface** (Q5 resolved): add `embedding_model_version TEXT` column to `t2_memories`, `t1_rollups`, and any other corpus tables holding vectors. Populated by the writer at mint time. Read by P7 to detect drift.

## Cycle anatomy

A single dream cycle executes phases in this order. Each phase advancement is gated by remaining cycle-budget AND remaining daily-budget AND `subscription_pressure_status`. A cycle persists `last_phase_completed` after each phase commit, enabling resumption.

| Phase | Purpose | Confidence model | Output |
|---|---|---|---|
| P0 | Pre-flight: idle check, mutex acquire, budget check (per-cycle + daily), pressure guard, embedder-version snapshot. | n/a | bail-or-continue |
| P1 | Consolidate stale t1 → t2: transactional claim via `t1_rollups.claimed_at`; pick N oldest unclaimed; judge promotion-worthiness; high-confidence promotes, others queue. | judge consensus ≥ threshold → auto; else queued. | t2 mints + queued proposals |
| P2 | Link discovery: nearest-neighbour scan over recently-minted t2 memories; mint `memory_links` edges. | cosine ≥ threshold → auto. | persisted edges |
| P3 | Quality scan: multi-factor signal `f(recall_freq, judge_vagueness, neighbour_density, age)` — NOT LRU alone (R17). High-confidence retire = auto; rewrite always queued. | high-confidence ≥ 0.85 → auto retire; else queued. | retirements + rewrite proposals |
| P4 | Discovery: contradictions + re-derivation patterns. Drains to a bounded queue (max depth configurable; oldest-expired-first eviction). | always queued. | discovery items |
| P5 | Active research: top K from P4 queue; fetch via per-project source allowlist; **sanitize** then draft enrichment memories. | always queued + `untrusted_source: true` payload flag. | research-origin proposals |
| P6 | Brief refresh: regenerate per-project knowledge brief; **update-in-place** to authoritative `project_briefs`; sync shadow via `memory_observe`. | always auto. | brief artifact + updated t2 shadow |
| P7 | Re-embed: corpus chunks whose `embedding_model_version` differs from current; snapshot pre-vectors to `t2_vec_history` BEFORE overwrite (reversibility, R19); separate `embedding_calls_usd` budget bucket (R18). | always auto. | updated vectors + history rows |
| P8 | Audit: commit `dream_cycles` row to `completed`; write phase-level cost breakdown into `metadata_json`. | n/a | audit record |

Cycle stops early at any phase that exhausts remaining budget OR trips the pressure guard mid-flight. `last_phase_completed` is set so the next cycle resumes from the next pending phase.

## Schema additions

### Core dreaming tables

```sql
-- one row per dream cycle (lifecycle: 'running' → 'completed' | 'bailed' | 'failed' | 'crashed')
CREATE TABLE dream_cycles (
  cycle_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,                          -- NULL while running (R1)
  project_id TEXT,                           -- nullable; cross-project cycles set null (R7)
  trigger TEXT NOT NULL,                     -- 'cron' | 'event'
  outcome TEXT NOT NULL DEFAULT 'running',   -- 'running' | 'completed' | 'bailed' | 'failed' | 'crashed' (R1)
  bail_reason TEXT,
  last_phase_completed TEXT,                 -- 'P0'..'P8' (R2; enables resumption)
  budget_usd_cap REAL NOT NULL,
  llm_spent_usd REAL NOT NULL DEFAULT 0,     -- (R18: split from embedding spend)
  embedding_spent_usd REAL NOT NULL DEFAULT 0,
  research_spent_usd REAL NOT NULL DEFAULT 0,
  phases_run TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}'   -- per-phase cost breakdown (R21)
);
CREATE INDEX idx_dream_cycles_running ON dream_cycles(outcome) WHERE outcome = 'running';
CREATE INDEX idx_dream_cycles_started ON dream_cycles(started_at);

-- per-action audit + queueable proposals (R3: status is sole state field)
CREATE TABLE dream_actions (
  action_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  phase TEXT NOT NULL,                       -- 'P1'..'P7'
  action_type TEXT NOT NULL,                 -- 'promote_t1' | 'link' | 'rewrite' | 'retire' | 'mint_research' | 'resolve_contradiction' | 'refresh_brief' | 'reembed'
  confidence REAL NOT NULL,
  status TEXT NOT NULL,                      -- 'auto_applied' | 'queued' | 'approved' | 'rejected' | 'expired' | 'reverted'
  target_ids TEXT NOT NULL,                  -- JSON array
  payload_json TEXT NOT NULL,
  untrusted_source INTEGER NOT NULL DEFAULT 0,  -- 1 if payload includes externally-fetched content (R12, FM-2)
  decided_at INTEGER,
  decided_by TEXT,                           -- 'auto' | 'user' | 'expiry'
  expires_at INTEGER,                        -- auto-expire stale proposals (R26)
  reverted_by TEXT,                          -- action_id of the revert (R16)
  FOREIGN KEY (cycle_id) REFERENCES dream_cycles(cycle_id)
);
CREATE INDEX idx_dream_actions_status ON dream_actions(status);
CREATE INDEX idx_dream_actions_cycle ON dream_actions(cycle_id);
CREATE INDEX idx_dream_actions_expires ON dream_actions(expires_at) WHERE status = 'queued';

-- semantic + causal links (R4: UNIQUE; R5: t2-only at Phase A/B, polymorphic deferred)
CREATE TABLE memory_links (
  link_id TEXT PRIMARY KEY,
  src_id TEXT NOT NULL,                      -- t2_memories.memory_id only at Phase A/B
  dst_id TEXT NOT NULL,
  link_type TEXT NOT NULL,                   -- 'semantic_near' | 'temporal_precedes' | 'shared_entity' | 'contradicts' | 'derived_from'
  weight REAL NOT NULL,
  minted_at INTEGER NOT NULL,
  minted_by_cycle TEXT NOT NULL,
  retired_at INTEGER,                        -- soft-delete; recall walkers ignore (R5)
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (src_id) REFERENCES t2_memories(memory_id),
  FOREIGN KEY (dst_id) REFERENCES t2_memories(memory_id),
  FOREIGN KEY (minted_by_cycle) REFERENCES dream_cycles(cycle_id),
  UNIQUE(src_id, dst_id, link_type)          -- prevents duplicate edges from concurrent cycles (R4)
);
CREATE INDEX idx_memory_links_src ON memory_links(src_id) WHERE retired_at IS NULL;
CREATE INDEX idx_memory_links_dst ON memory_links(dst_id) WHERE retired_at IS NULL;

-- per-project knowledge briefs (R6 brief→t2 link via t2_shadow_memory_id)
CREATE TABLE project_briefs (
  project_id TEXT PRIMARY KEY,
  brief_md TEXT NOT NULL,
  source_memory_ids TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  generated_by_cycle TEXT NOT NULL,
  t2_shadow_memory_id TEXT,                  -- the t2 mint produced by memory_observe (R6)
  FOREIGN KEY (generated_by_cycle) REFERENCES dream_cycles(cycle_id),
  FOREIGN KEY (t2_shadow_memory_id) REFERENCES t2_memories(memory_id)
);

-- t2 vector history for P7 reversibility (R19)
CREATE TABLE t2_vec_history (
  history_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  embedding_model_version TEXT NOT NULL,
  snapshotted_at INTEGER NOT NULL,
  snapshotted_by_cycle TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES t2_memories(memory_id),
  FOREIGN KEY (snapshotted_by_cycle) REFERENCES dream_cycles(cycle_id)
);
CREATE INDEX idx_t2_vec_history_memory ON t2_vec_history(memory_id);

-- Firecrawl/research cache (R6 delimiter, R7 project_id)
CREATE TABLE dream_research_cache (
  cache_key TEXT PRIMARY KEY,                -- sha256(provider + '|' + url + '|' + query_hash) (R6 delimiter)
  provider TEXT NOT NULL,                    -- 'firecrawl' | 'webfetch'
  project_id TEXT NOT NULL,                  -- prevents cross-project leak (R7)
  url TEXT NOT NULL,
  query_hash TEXT,
  title TEXT,
  markdown TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source_billed_usd REAL,                    -- actual provider-reported cost (R20)
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_dream_research_cache_expires ON dream_research_cache(expires_at);
CREATE INDEX idx_dream_research_cache_project ON dream_research_cache(project_id);
```

### Extensions to existing tables

```sql
ALTER TABLE t1_rollups ADD COLUMN claimed_at INTEGER;                  -- R8: transactional claim before promotion
ALTER TABLE t1_rollups ADD COLUMN claimed_by_cycle TEXT;
ALTER TABLE t2_memories ADD COLUMN embedding_model_version TEXT;       -- R22, Q5
ALTER TABLE t1_rollups ADD COLUMN embedding_model_version TEXT;        -- R22, Q5
-- the vector tables (t2_vec, t1_vec) inherit model version via the rowid join to the parent table
```

P1 must use a transactional claim:

```sql
UPDATE t1_rollups
   SET claimed_at = :now, claimed_by_cycle = :cycle_id
 WHERE rollup_id IN (
     SELECT rollup_id FROM t1_rollups
      WHERE promoted_at IS NULL AND claimed_at IS NULL
      ORDER BY started_at ASC
      LIMIT :n
 )
 RETURNING rollup_id;
```

The `RETURNING` set is the cycle's working set. Claims expire on cycle terminal status (cleared by the startup zombie sweep if cycle ended as `'crashed'`).

## Startup zombie sweep (R1)

On daemon start, before scheduling the next cycle:

```sql
UPDATE dream_cycles
   SET outcome = 'crashed', bail_reason = 'daemon_respawn', ended_at = :now
 WHERE outcome = 'running';

UPDATE t1_rollups
   SET claimed_at = NULL, claimed_by_cycle = NULL
 WHERE claimed_by_cycle IN (
     SELECT cycle_id FROM dream_cycles WHERE outcome = 'crashed'
 );
```

## Cost cap stack

```ts
interface DreamBudgetConfig {
  perCycleUsd: number;          // PENUMBRA_DREAMING_PER_CYCLE_USD; default 0.50
  dailyUsd: number;             // PENUMBRA_DREAMING_DAILY_USD; default 5.00
  pressureGuardEnabled: boolean; // PENUMBRA_DREAMING_PRESSURE_GUARD; default true
  perCycleEmbeddingUsd: number; // PENUMBRA_DREAMING_PER_CYCLE_EMBEDDING_USD; default 0.10 (R18)
  perCycleResearchUsd: number;  // PENUMBRA_DREAMING_PER_CYCLE_RESEARCH_USD; default 0.25 (separate Firecrawl bucket)
}
```

P0 checks (in order):
1. Daily cap: `SUM(llm_spent_usd + embedding_spent_usd + research_spent_usd)` for today < `dailyUsd`.
2. Pressure guard (when enabled): `subscription_pressure_status` returns no provider in `throttled` or `constrained`.
3. Cycle mutex acquire.

Cycle advancement check after each phase: 
- LLM bucket: `dream_cycles.llm_spent_usd < perCycleUsd`
- Embedding bucket: `dream_cycles.embedding_spent_usd < perCycleEmbeddingUsd`
- Research bucket: `dream_cycles.research_spent_usd < perCycleResearchUsd`
- Daily cap re-check (running maestro session may have spent quota).
- Pressure guard re-check.

Cost accounting (R20): Firecrawl `source_billed_usd` is captured from the provider response and added to `research_spent_usd`; LLM calls account against `llm_spent_usd` via the existing cost_event pipeline; embedding calls (P7) account against `embedding_spent_usd`.

## Idle detection

Two independent triggers, OR-ed:

1. **Cron** (`startDreamingCron`): fires every `PENUMBRA_DREAMING_CRON_MINUTES` (default 30); checks activity guard before entering P0.
2. **Event-driven** (`subscribeIdleSignals`): subscribes to `dispatch.completed` and `long_lived.tick.completed`. Tracks rolling `lastActivityAt`. When idle ≥ `PENUMBRA_DREAMING_IDLE_MINUTES` (default 15) AND no cycle has started in last `PENUMBRA_DREAMING_TRIGGER_COOLDOWN_MINUTES` (default 5) AND mutex is free, triggers an opportunistic cycle. **If mutex is held, drop the trigger** (log `event: dream.trigger.dropped`); do NOT queue (R24).

Long-lived agent ticks (home-mgmt, task-refiner-*) count as activity for idle-detection purposes.

A single per-process mutex (`dreamingCycleLock`) prevents concurrent cycles within one daemon process. Cross-process safety via the zombie sweep on startup.

## Confidence-tiered output

| Action type | Auto threshold | Otherwise |
|---|---|---|
| `link` (semantic_near) | weight ≥ 0.75 (`PENUMBRA_DREAMING_LINK_AUTO_THRESHOLD`) | queued |
| `link` (shared_entity) | weight ≥ 0.80 | queued |
| `link` (contradicts, derived_from, temporal_precedes) | never auto | always queued |
| `promote_t1` | judge consensus ≥ ceil(2/3 of pool) | queued |
| `retire` | multi-factor score ≥ 0.85 (`PENUMBRA_DREAMING_RETIRE_AUTO_THRESHOLD`) | queued |
| `rewrite` | never auto | always queued |
| `mint_research` | never auto | always queued |
| `resolve_contradiction` | never auto | always queued |
| `refresh_brief` | always auto | n/a |
| `reembed` | always auto | n/a (history-snapshot pre-overwrite makes it reversible per R19) |

Queued actions surface via:
- `mcp__penumbra__memory_list_pending_dream_actions` MCP tool (R15 — named per `*_list_pending` convention; namespaced under `memory_*` since dreaming is a memory subsystem).
- Daily digest at `~/.penumbra/dream-digest-YYYY-MM-DD.md`.
- The maestro session-start fast-context hook: reports `{ pending_count, oldest_pending_age_hours }` (R26 surfaces age, not just count).

## Reversibility + revert cascade (R16)

`mcp__penumbra__memory_dream_action_revert(action_id, cascade: 'none' | 'force')`:

- **`cascade: 'none'` (default)**: refuses if any downstream auto-applied action references the target action (`dream_actions WHERE payload_json LIKE %action_id% AND status = 'auto_applied'`). Returns `409 has_dependents` with the dependent action IDs.
- **`cascade: 'force'`**: reverts the target and ALL transitive auto-applied dependents in topological order. Each revert writes a new `dream_actions` row with `action_type: 'revert'`, `status: 'auto_applied'`, `decided_by: 'user'`.

P7 reverts: restore the snapshotted vector from `t2_vec_history` (the most recent snapshot for that `memory_id` before the target action's `decided_at`).

`refresh_brief` reverts: restore the prior `project_briefs` row from the audit trail; re-sync the t2 shadow via `memory_observe` with the prior content.

Link reverts: set `memory_links.retired_at = now`. Hard-delete is never used (audit preservation).

## Per-project research config

```yaml
# projects.yaml
penumbra:
  remote: { kind: github, repo: frozename/penumbra }
  root_path: /Volumes/WorkSSD/repos/personal/penumbra
  dreaming:
    sources:
      web:
        provider: firecrawl       # 'firecrawl' (default) | 'webfetch' (fallback) | 'off'
        max_pages_per_topic: 5
        crawl_depth: 1
        allowed_domains: null     # null = open web; list = strict allowlist
        max_markdown_tokens: 4000 # truncation cap before judge ingestion (R12, FM-2)
      repos:
        - /Volumes/WorkSSD/repos/personal/some-related-repo
      mcp:
        - llamactl
        - embersynth
    research_budget_per_cycle_usd: 0.25
```

Default if `dreaming:` is absent: `{ sources: { web: { provider: firecrawl, max_pages_per_topic: 3, crawl_depth: 1, max_markdown_tokens: 4000 } } }`.

**Reload semantics**: `daemon_reload_config` re-reads `projects.yaml` and the new allowlist applies to the next cycle (NOT mid-cycle). A cycle started under an old allowlist completes its P5 with the cached snapshot. The reload writes a `cycle_will_apply_at: <next_cycle_start>` log line.

## Firecrawl integration + prompt-injection mitigation (R12, FM-2)

Adapter interface in `packages/core/src/research/` (interface only; declarations + types):

```ts
interface WebResearchAdapter {
  search(args: { query: string; max_pages?: number; allowed_domains?: string[] | null }): Promise<WebResearchResult[]>;
  scrape(args: { url: string; depth?: number }): Promise<WebResearchResult>;
}

interface WebResearchResult {
  url: string;
  title: string;
  markdown: string;
  fetched_at: string;
  source_provider: 'firecrawl' | 'webfetch';
  source_billed_usd?: number;            // (R20)
  metadata?: { author?: string; published_at?: string; word_count?: number };
}
```

Implementations live in `packages/daemon/src/research/` (R13 — moved out of core because impls need daemon's DB cache + secrets):
- `FirecrawlAdapter`
- `WebFetchAdapter` (fallback)
- `OffAdapter` (no-op)

**Sanitization pipeline** before markdown reaches any LLM (R12):

1. **Token truncation**: hard-cap each page's markdown at `max_markdown_tokens` (default 4000). Excess discarded.
2. **XML-tag wrap**: when constructing judge prompts, wrap markdown as `<untrusted-source url="${url}" provider="${provider}"><![CDATA[${markdown}]]></untrusted-source>`. Prompt prefix explicitly tells the judge to treat anything inside `<untrusted-source>` as data, not instructions.
3. **Payload flag**: any `dream_actions` row derived (directly or indirectly) from research carries `untrusted_source = 1`.
4. **Review-time hint**: `memory_list_pending_dream_actions` returns `untrusted_source` per row; the daily digest visually flags untrusted-source rows.
5. **Domain re-verification at write**: even if `allowed_domains` is set, the adapter re-checks the resolved URL's domain against the allowlist at scrape time (handles redirects).

## Quality scan signal (R17)

P3 retire decision uses a multi-factor score:

```
retire_score = w_recall * recall_freq_penalty
             + w_vagueness * judge_vagueness_score
             + w_density * neighbour_density_penalty
             + w_age * age_factor
```

- `recall_freq_penalty`: high when memory has been recall-hit rarely (NOT zero — zero matches a never-needed memory which is fine; only severe under-utilization triggers).
- `judge_vagueness_score`: from a one-shot judge call rating the memory's specificity.
- `neighbour_density_penalty`: high when the memory has many near-duplicates within the same project (indicates redundancy).
- `age_factor`: mild bias toward older memories, but bounded.

Auto-retire only at composite ≥ 0.85 AND at least 3 of 4 factors agree. This prevents LRU-only retirement of rare-but-critical edge-case memories (e.g. dispatch_land 409 lore).

## Observability + health (R21)

New MCP tool `mcp__penumbra__dreaming_health`:

```ts
interface DreamingHealthResponse {
  last_cycle_at: string | null;
  cycles_in_last_24h: number;
  cycles_completed_24h: number;
  cycles_bailed_24h: number;
  cycles_crashed_24h: number;
  current_running_cycle: { cycle_id: string; phase: string | null; started_at: string } | null;
  queue_depth: number;
  oldest_pending_action_age_hours: number | null;
  total_spent_today_usd: { llm: number; embedding: number; research: number };
  daily_cap_remaining_usd: number;
}
```

Alerts (logged at `warn` so they surface in `~/.penumbra/launchd.daemon.err.log`):
- `dream.health.no_cycles_24h` if `cycles_in_last_24h === 0` AND daemon has been up > 24h.
- `dream.health.crashed_high` if `cycles_crashed_24h ≥ 3`.
- `dream.health.queue_stale` if `oldest_pending_action_age_hours > 168` (1 week).

## Phasing

### Phase A — MVP cycle spine + safety

Phase A SCOPE expanded vs original draft (R5, R9, R12 require pulling these into MVP):

- **Schema**: `dream_cycles`, `dream_actions`, `memory_links` (yes, in Phase A so P2 can auto-mint), `t2_vec_history` (so P7 can be added later without backfill), `dream_research_cache` (deferred wiring but schema present). Extensions: `t1_rollups.claimed_at/claimed_by_cycle`, `t2_memories.embedding_model_version`, `t1_rollups.embedding_model_version`.
- **Scheduler**: cron only; event-trigger stubbed but not wired (lands in Phase D).
- **Phases enabled**: P0 (with full cap stack + pressure guard), P1 (queued-only; no auto-promote yet), P2 (auto for `semantic_near` only), P3 SKIPPED (defer until multi-factor signal is ready), P8.
- **Cost cap**: per-cycle LLM + daily + pressure guard ALL enforced from day 1. Embedding + research buckets defined but unused.
- **Crash recovery**: startup zombie sweep wired.
- **Output surface**: queue only; no MCP review tool yet (lands in Phase B).
- **Tests**: schema migration, scheduler unit, P0 bail conditions (each cap, pressure flap), P1 transactional claim race (two concurrent cycles get disjoint working sets), P2 link UNIQUE constraint, audit roundtrip, startup zombie sweep marks orphans correctly. **Real-judge integration test** for P1 (per [[feedback_stubbed_recallReader_hid_zod_parse_bug]]).

### Phase B — Quality + discovery + review surface

- **Phases enabled**: P3 (with multi-factor signal), P4 (with bounded queue + oldest-expired-first eviction).
- **MCP tool**: `memory_list_pending_dream_actions`.
- **Daily digest writer**.
- **Dream judge pool** wired (dedicated; new config block).
- **Tests**: multi-factor retire score, contradiction detection, P4 queue cap enforcement, dedup of pending-action rows by `(action_type, target_ids)`.

### Phase C — Research + briefs

- **Phases enabled**: P5 (Firecrawl primary, WebFetch fallback, OffAdapter no-op), P6 (brief refresh via `memory_observe`).
- **Schema wiring**: `project_briefs`; `dream_research_cache` table is now actively populated.
- **Project registry `dreaming:` block**.
- **Sanitization pipeline live** (R12 / FM-2): truncation, XML-tag wrap, payload flag, review-time hint.
- **Firecrawl actual-billing capture** (R20).
- **Tests**: per-project source allowlist enforcement (including redirect re-check), cache hit/miss, Firecrawl-401 → WebFetch fallback, prompt-injection regression (seed adversarial markdown, assert untrusted_source flag persists end-to-end), brief regeneration update-in-place, brief shadow memory_observe roundtrip.

### Phase D — Re-embed + event trigger + revert

- **Phases enabled**: P7 (re-embed with `t2_vec_history` snapshot before overwrite).
- **Event-driven trigger** wired (replaces stub); drop-on-burst policy.
- **MCP tool**: `memory_dream_action_revert` (with cascade option).
- **Tests**: embedder-version drift detection, P7 snapshot-before-overwrite, revert restores from history, cascade-revert topological order, event-burst drop counts.

## Open questions

All Phase-A-blocking questions are RESOLVED. Remaining items:

3. **Research provenance**: distinct tier `t2_research` vs tag-on-t2? **Suggest: tag** (`research_origin: true` payload + the `untrusted_source` flag on dream_actions). Decided before Phase C ships.
4. ~~Cycle interruption~~ **RESOLVED**: complete-current-phase-then-bail, resume from `last_phase_completed + 1`.
5. ~~Embedder version surface~~ **RESOLVED**: `embedding_model_version` column on `t2_memories` and `t1_rollups`.
6. **Brief refresh trigger**: time-based only, OR "N new memories minted since last refresh"? **Suggest: both, OR'd** — refresh if (age > X) OR (delta_memories > Y). Decided before Phase C ships.
7. **Per-cycle phase ordering**: configurable (e.g., dry-run mode with only P0+P8), OR hardcoded? **Suggest: hardcoded sequence + env-var skip-list** (`PENUMBRA_DREAMING_SKIP_PHASES=P5,P7` for testing).
8. ~~Brief→t2 sync~~ **RESOLVED**: update-in-place via `memory_observe`.

## Acceptance criteria

After Phase A lands and runs for 24h on the live daemon:
- ≥ 1 cycle completed per 30-minute idle window (verified via `mcp__penumbra__dreaming_health.cycles_in_last_24h ≥ 12`).
- ≥ 1 `semantic_near` link minted per cycle on average, conditional on ≥ 10 t2 memories existing at cycle start (otherwise N/A).
- 0 cycles exceed per-cycle, daily, OR embedding caps.
- Startup zombie sweep marks 100% of `outcome='running'` rows from prior runs as `'crashed'`.
- All `dream_cycles` rows have non-NULL `ended_at` after terminal status.
- `t1_rollups.claimed_at` race test: two simultaneous P1 invocations produce disjoint working sets.

After Phase C lands and runs for 7d:
- ≥ 1 active project has a fresh brief (`project_briefs.generated_at < 24h` AND matching t2 shadow row).
- ≥ 5 research-origin proposals queued for review.
- 0 proposals derived from research have `untrusted_source = 0` (i.e. flag propagation is 100%).
- Prompt-injection regression test passes: seeded adversarial markdown does NOT cause auto-application of any action.

After Phase D lands:
- Embedder version drift detected within 1 cycle of `embedding_model_version` change.
- Revert restores the exact pre-action vector for P7-touched memories.
- Event-trigger burst test: 10 concurrent triggers produce exactly 1 cycle (9 dropped).

## Migration considerations

The 4,859 unpromoted t1_rollups today are the initial P1 backlog. Phase A's queued-only P1 will drain them gradually under per-cycle batch size (default 10 per cycle). At ~12 cycles/day and 10 rollups/cycle → ~120/day → ~40-day full drain. If faster drain is needed, raise batch size via env. P3 retire and P4 contradiction discovery operate only on POST-Phase-A t2 memories until Phase B explicitly opt-in for historical sweep.
