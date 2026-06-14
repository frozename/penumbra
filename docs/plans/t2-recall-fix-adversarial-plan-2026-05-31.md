# T2 Memory Recall Fix — adversarial-plan

> Generated 2026-05-31 via /adversarial-plan.
> Personas: architect (claude-acp-sonnet), simplifier (codex-acp-fast), test-first (claude-acp-sonnet), risk (codex-acp-deep), integration (gemini-acp-pro). Synthesizer: claude-acp-sonnet.
> Per-persona conversations: architect conv-7475b2a7 · simplifier conv-6ad0a58e · test-first conv-f7eda50f · risk conv-52b4e5b0 · integration conv-c136364a · synthesis conv-1a87f73e.
> Evidence: docs/superpowers/plans/2026-05-31-memory-overhaul-plan.md §A; memories 8d2babcd (resolved lever), cf28770a (title+body refutation), 62d5cdf3 (body-only root cause).
>
> EXECUTION STATUS (2026-06-01): **Phase 1 DONE** — recipe `title_plus_concise` (MiniLM, no model swap); benchmark + synthetic guard landed `620adc89`. **Phase 0+2 DONE** — env flags + `buildT2EmbedText` seam (4 doc-side sites; query path raw) + P7 reembed guard, INERT by default, landed `c38a07b1`. **NEXT: Phase 3** (P1 no-vector insert + P7 false-stamp), then Phase 4 (sanitize gate + XML-bleed source), Phase 5 (backfill + flip recipe), Phase 6 (fusion oversampling). Recipe flag flips to `title_plus_concise` only at Phase 5 (with the backfill).

---

# Penumbra T2 Memory Recall Fix — Merged TDD Plan

**Evidence baseline:** 284 never-retrieved t2 rows = 13 UNEMBEDDED + 116 CROWDED-OUT + 155 WEAK. WEAK root cause: body-only embedding (title excluded). Lift on WEAK rows — body-only: 0, title-only: +46, title+concise: +26, title+full-body: +10. Seam: `buildT2EmbedText` at 4 write sites; `recall.ts:57` query path stays RAW throughout.

---

## Phase 0 — Safety Rails + Config Flags
**Type: operational (prereq, no dispatch)**

### Flags to add — `packages/config/src/env.ts`

```
PENUMBRA_T2_EMBED_RECIPE     = "body_v1"   # body_v1 | title_only | title_plus_concise | <model-id>
PENUMBRA_T2_OVERSAMPLE_FACTOR = 1          # int ≥1; multiplies vector+fts k before RRF cut
PENUMBRA_T2_REEMBED_ENABLED  = false       # guards backfill P7 entirely
```

Do NOT touch `PENUMBRA_PROMOTION_GATE` or `PENUMBRA_NEAR_DUP_GATE`.

### Failing test → file
**`packages/core/src/memory/__tests__/reembed-safety-rails.test.ts`**
- `it("P7 is a no-op when PENUMBRA_T2_REEMBED_ENABLED=false")`
- `it("snapshots t2_vec_history before overwriting any vector")`
- `it("revertDreamAction restores prior vector from history")`

### Impl
Add flags to env schema. No behaviour change yet — tests should pass trivially once flags exist. Wire `PENUMBRA_T2_REEMBED_ENABLED` check into `dreaming/reembed.ts` early-return.

### Verify
```bash
find packages -type f -path '*/src/*.js' -delete
bun test packages/core/src/memory/__tests__/reembed-safety-rails.test.ts
bun run typecheck
```

### Failure modes / rollback
Flag addition is purely additive; rollback = revert `env.ts` change.

---

## Phase 1 — Recipe Selection Spike
**Type: dispatch-sized**

### Failing test → file
**`packages/core/src/memory/__tests__/embed-recipe.bench.test.ts`**
- `it("title-only beats body-only on WEAK rows — lift ≥ 40")` — opens DB read-only, loads 155 WEAK, re-embeds, top-20 cosine vs stored query set
- `it("chosen recipe regresses ≤ 5 historically-retrieved rows")` — cross-checks against a snapshot of rows with non-zero recall events
- `it("bge-small-en-v1.5 is 384-dim — no vec migration required")` — dimension assertion before committing to stronger model

### Impl
`scripts/eval-t2-embed-recipe.ts` — compare candidates:
- A: `title_only` (MiniLM, current dims, no migration)
- B: `title_plus_concise` (MiniLM, title + body truncated to 256 chars)
- C: `bge-small-en-v1.5` 384-dim (**preferred** if lift > A and regression ≤ 5 — same dims as MiniLM, so **no vec0 dimension migration**)

**Conflict resolution (c):** Recipe persisted as `PENUMBRA_T2_EMBED_RECIPE` env default (NOT imported from test fixture JSON). Production code must not import test fixtures. If C wins, set default to `bge-small-en-v1.5`; if A/B wins, set `title_only` or `title_plus_concise`.

Emit a `recipe-decision.json` in `scripts/` (test artifact only). Test asserts `weakLift >= 40` and `regressionPct <= 5`; if both pass, record winner in `PENUMBRA_T2_EMBED_RECIPE` default.

### Verify
```bash
find packages -type f -path '*/src/*.js' -delete
bun test packages/core/src/memory/__tests__/embed-recipe.bench.test.ts
bun run typecheck
```

### Failure modes / rollback
If no candidate beats threshold, choose title-only (lift ~+46 on A/B test) and file a note. Rollback = revert env default; no data changed.

---

## Phase 2 — buildT2EmbedText Seam
**Type: dispatch-sized**

### Failing test → file
**`packages/core/src/memory/__tests__/t2-embed-seam.test.ts`**
- `it("t2.ts write path calls buildT2EmbedText with title+body, not body-only")`
- `it("daemon/routes/memory.ts write path calls buildT2EmbedText")`
- `it("dreaming/reembed.ts and deps.ts call buildT2EmbedText")`
- `it("workers/t2-promotion.ts:275 calls buildT2EmbedText")`
- `it("recall.ts:57 query path is NOT routed through buildT2EmbedText")` — query must stay RAW

### Impl
New file: **`packages/core/src/memory/t2-repr.ts`**

```typescript
export type EmbedRecipe = "body_v1" | "title_only" | "title_plus_concise" | string;

export function buildT2EmbedText(
  title: string,
  body: string,
  recipe: EmbedRecipe = process.env.PENUMBRA_T2_EMBED_RECIPE ?? "body_v1"
): string {
  const t = title.slice(0, 200);
  if (recipe === "title_only") return t;
  if (recipe === "title_plus_concise") return `${t}\n${body.slice(0, 256)}`;
  return body; // body_v1 = current behaviour (no regression during rollout)
}
```

Wire into the 4 write sites:
- `packages/core/src/memory/t2.ts:442`
- `packages/daemon/src/routes/memory.ts:186`
- `packages/dreaming/src/reembed.ts:72` and `deps.ts:81`
- `packages/workers/src/t2-promotion.ts:275`

`recall.ts:57` — **no change**.

> NOTE (maestro): the synthesizer's package paths are the persona's best-guess; the live anchors verified this session are `packages/core/src/writers/t2.ts:442`, `packages/daemon/src/routes/memory.ts:186`, `packages/daemon/src/dreaming/reembed.ts:72` + `deps.ts:81`, `packages/daemon/src/workers/t2-promotion.ts:275`, query `packages/core/src/readers/recall.ts:57`. The implementer must confirm exact paths before editing.

### Verify
```bash
find packages -type f -path '*/src/*.js' -delete
bun test packages/core/src/memory/__tests__/t2-embed-seam.test.ts
bun run typecheck
```

### Failure modes / rollback
Default `body_v1` keeps behaviour identical until recipe flag is changed. Rollback = set `PENUMBRA_T2_EMBED_RECIPE=body_v1`.

---

## Phase 3 — Fix P1 (No-Vector Insert) + P7 (False-Stamp)
**Type: dispatch-sized**

### Failing tests → file
**`packages/core/src/memory/__tests__/p1-vec-insert.test.ts`**
- `it("dreaming auto-promote inserts t2_vec in the same transaction as t2_memories")`
- `it("if embed fails, both t2_memories and t2_vec rows are rolled back")`

**`packages/core/src/memory/__tests__/p7-reembed-correctness.test.ts`**
- `it("re-embed does INSERT OR REPLACE, not UPDATE-only")`
- `it("embedding_model_version is NOT stamped if the t2_vec write fails")`
- `it("re-embed is a no-op for rows that already have current version")`

### Impl

**P1 — `packages/dreaming/src/cycle.ts:482-509`:**
```typescript
// In the same DB transaction that inserts into t2_memories:
const vector = await embed(buildT2EmbedText(title, body));
db.run("INSERT INTO t2_vec(rowid, embedding) VALUES (?, ?)", [rowid, vector]);
// wrap both in try/catch; log+continue on embed failure (don't abort the cycle)
```

**P7 — `packages/dreaming/src/reembed.ts`:**
- Change `UPDATE t2_memories SET embedding_model_version = ?` to `INSERT OR REPLACE INTO t2_vec(rowid, embedding) VALUES (?, ?)` first
- Stamp `embedding_model_version` only if the upsert succeeded
- Wrap embed + upsert in try/catch; log error + skip row on failure

> NOTE (maestro): live path is `packages/daemon/src/dreaming/cycle.ts:482-509` and `packages/daemon/src/dreaming/reembed.ts` (not `packages/dreaming/`). Confirm before editing.

### Verify
```bash
find packages -type f -path '*/src/*.js' -delete
bun test packages/core/src/memory/__tests__/p1-vec-insert.test.ts packages/core/src/memory/__tests__/p7-reembed-correctness.test.ts
bun run typecheck
```

### Observability hooks
Add gauge: `t2_memories_missing_vec_count` = `SELECT count(*) FROM t2_memories LEFT JOIN t2_vec USING(rowid) WHERE t2_vec.rowid IS NULL AND retired_at IS NULL`. Alert if > 0 after Phase 3 lands.

### Failure modes / rollback
P1 fix: if embed fails in dreaming cycle, log + continue (don't crash cycle). P7: idempotent upsert; rollback = revert `reembed.ts`. Safety rails from Phase 0 guard the flag.

---

## Phase 4 — Body Quality Gate + XML Bleed Investigation
**Type: dispatch-sized (before backfill — avoid re-embedding junk)**

**Conflict resolution (b):** MAX_BODY_CHARS = **4096**. Justification: 2048 is too aggressive for legitimate long memories; 4096 still catches the known 9301-char reasoning-leak row. Skip-not-throw throughout.

### Failing tests → file
**`packages/core/src/memory/__tests__/t2-sanitize.test.ts`**
- `it("body > 4096 chars is skipped with a warn, extraction continues")`
- `it("body matching XML bleed pattern is skipped with a warn")`
- `it("extraction_skipped_sanitize counter increments on skip")`
- `it("a mixed rollup with one junk row completes with good rows extracted")`

### Impl

**Sanitize helper — `packages/core/src/memory/t2-repr.ts`** (extend existing file):
```typescript
const XML_BLEED_RE = /<(?:tool_call|function_calls|tool_use|thinking)[^>]*>/;
export const MAX_BODY_CHARS = 4096;

export function validateBody(body: string): { ok: boolean; reason?: string } {
  if (body.length > MAX_BODY_CHARS) return { ok: false, reason: "length" };
  if (XML_BLEED_RE.test(body)) return { ok: false, reason: "xml_bleed" };
  return { ok: true };
}
```

Wire `validateBody` into `t2.ts` write path (skip-not-throw; increment counter; log warn with first 120 chars for forensics).

**XML bleed root-cause investigation — t0_events capture site:**
Grep for where `t0_events` payload is captured and whether tool-call XML escapes. Document finding in `docs/notes/t2-xml-bleed-root-cause.md`. If the ingress boundary is broken (raw XML stored in t0 body), patch the parser/serializer at the source — do not rely solely on the defensive strip at the t2 write path.

> NOTE (maestro): the sanitize/length gate belongs in the refiner between `safeParse` (~`packages/core/src/writers/t2.ts:415`) and `embed` (~`:442`), per the session diagnosis. The XML bleed was observed in RECALL snippets (capture/recall rendering ingesting tool-call markup) — confirm whether the bleed is in t0 capture, the t1/t2 promotion text, or the recall snippet renderer before patching.

**One-time junk retire:**
`scripts/queue-t2-retire-junk.ts` — scan `t2_memories` for `length(body) > 4096 OR body REGEXP xml_pattern`, enqueue dream-action retire for each. Support `--dry-run`. Do NOT run during this phase — emit script only.

### Verify
```bash
find packages -type f -path '*/src/*.js' -delete
bun test packages/core/src/memory/__tests__/t2-sanitize.test.ts
bun run typecheck
```

### Failure modes / rollback
Skip-not-throw means the worst outcome is fewer t2 rows extracted (not a crash). Counter + warn log provides visibility. Rollback = raise MAX_BODY_CHARS or disable XML check.

---

## Phase 5 — Backfill via P7
**Type: dispatch-sized (requires Phase 3 + Phase 4 complete)**

**Conflict resolution (a):** Backfill comes AFTER P1/P7 fix (Phase 3) and sanitize (Phase 4). Ordering rationale: P7 must correctly INSERT-vs-UPDATE before mass re-embed; junk should be sanitized before re-embedding.

### Failing tests → file
**`packages/core/src/memory/__tests__/p7-backfill.test.ts`**
- `it("re-embeds only rows with embedding_model_version < CURRENT")`
- `it("snapshots t2_vec_history before overwriting")`
- `it("backfill is idempotent — second run re-embeds 0 rows")`
- `it("title is threaded into SELECT query for embed input")`
- `it("PENUMBRA_T2_REEMBED_ENABLED=false → 0 rows touched")`

### Impl

In `dreaming/reembed.ts` batch path:
```sql
SELECT m.rowid, m.title, m.body, m.embedding_model_version
FROM t2_memories m
LEFT JOIN t2_vec v USING(rowid)
WHERE m.retired_at IS NULL
  AND (m.embedding_model_version < ? OR v.rowid IS NULL)
ORDER BY m.rowid
LIMIT ?
```

Thread `title` into `buildT2EmbedText(title, body)`. Snapshot to `t2_vec_history` before any overwrite. Process in bounded batches (default 100). Bump `PENUMBRA_EMBEDDING_MODEL_VERSION` after successful run.

If Phase 1 chose `bge-small-en-v1.5` (384-dim): **no vec0 dimension migration required** — same dim as MiniLM. Update model load path in fastembed init. If a >384-dim model were ever chosen (not the case here), a full `t2_vec` recreate would be required — out of scope.

Guard: entire path behind `PENUMBRA_T2_REEMBED_ENABLED=true`.

### Verify
```bash
find packages -type f -path '*/src/*.js' -delete
bun test packages/core/src/memory/__tests__/p7-backfill.test.ts
bun run typecheck
# After manual enable: PENUMBRA_T2_REEMBED_ENABLED=true bun run scripts/run-backfill.ts --dry-run
```

### Observability
- `stale_version_count` gauge: `SELECT count(*) FROM t2_memories WHERE embedding_model_version < CURRENT AND retired_at IS NULL`
- orphan-delta alert: `SELECT count(*) FROM t2_memories LEFT JOIN t2_vec USING(rowid) WHERE t2_vec.rowid IS NULL AND retired_at IS NULL` → target 0

### Failure modes / rollback
Flag-gated; `revertDreamAction` restores any row via `t2_vec_history`. Cost gate: cap batch count per run.

---

## Phase 6 — Fusion Oversampling for Crowded-Out
**Type: dispatch-sized, fully independent**

### Failing test → file
**`packages/core/src/memory/__tests__/rrf-oversample.test.ts`**
- `it("oversampleFactor=3 surfaces a row ranked 22nd in raw cosine")`
- `it("default factor=1 produces identical output to current behaviour")`
- `it("PENUMBRA_T2_OVERSAMPLE_FACTOR not set → factor=1")`

### Impl
In `recall.ts` RRF path:
```typescript
const factor = parseInt(process.env.PENUMBRA_T2_OVERSAMPLE_FACTOR ?? "1", 10);
const vectorK = limit * factor;
const ftsK = limit * factor;
// ... fetch oversized candidate sets ...
// RRF fusion → sort → truncate to `limit`
```

> NOTE (maestro): live fusion seam is `packages/core/src/readers/recall.ts` (~:205 fuse call site / :218 fuseRRF) and `packages/core/src/readers/rrf.ts:56`. Confirm before editing.

### Verify
```bash
find packages -type f -path '*/src/*.js' -delete
bun test packages/core/src/memory/__tests__/rrf-oversample.test.ts
bun run typecheck
```

### Failure modes / rollback
Factor=1 = no-op. Higher factors increase latency and CPU linearly. Default 1 = zero regression risk.

---

## Cross-Cutting Observability (wire across phases)

| Metric | Query / Hook | Alert |
|--------|-------------|-------|
| `missing_vec_row_count` | `t2_memories LEFT JOIN t2_vec MISSING` | > 0 |
| `stale_version_count` | `embedding_model_version < CURRENT` | > 10% of corpus |
| `extraction_skipped_sanitize` | in-process counter | any sustained increase |
| `orphan_delta` | missing_vec_row_count post-backfill | > 0 after Phase 5 |

---

## Final Gate (after all phases)

```bash
find packages -type f -path '*/src/*.js' -delete
bun test packages/core packages/daemon packages/workers
bun run typecheck
# restart daemon, verify t2_vec orphan count = 0
```

---

## Trade-offs

**Cut / deferred:**
- **Stronger model option C (bge-small-en-v1.5)** is benchmarked in Phase 1 but not pre-committed. If lift is sufficient with `title_only` on MiniLM (A), model swap is skipped entirely — zero migration cost.
- **`queue-t2-retire-junk.ts`** is emitted in Phase 4 but not executed as part of the plan — junk retirement is a one-time operational step after sanitize gate is validated.
- **Fusion balance floor** (`PENUMBRA_T2_BALANCE_MIN` from risk plan) — deferred; oversampling alone addresses crowded-out without requiring balance accounting.
- **Full vec0 dimension migration** — out of scope; 384-dim model preference eliminates this hazard.

**Why simplifier scope wins:** Phases 1-5 cover all three root causes (WEAK via recipe+seam+backfill; UNEMBEDDED via P1 fix; CROWDED-OUT via Phase 6). No premature abstractions added.

---

## Open Questions

1. **Recipe benchmark result**: Does `bge-small-en-v1.5` clear the lift ≥ 40 / regression ≤ 5 bar in Phase 1? If yes, switch `PENUMBRA_T2_EMBED_RECIPE` default to `bge-small-en-v1.5`. If no, `title_only` is the fallback (lift ~+46 on A/B evidence).
2. **XML bleed source**: Is the bleed occurring at t0 ingestion (raw model output stored verbatim) or at the t2 extraction/refiner boundary? Root-cause investigation in Phase 4 should answer this; if it's the refiner, a parser fix there is the real fix and the t2-writer strip is secondary.
3. **Backfill cost budget**: What is the acceptable wall-clock and token budget for the Phase 5 backfill run? Affects batch size and whether to gate behind a one-time script vs. daemon backfill scheduler.
4. **PENUMBRA_EMBEDDING_MODEL_VERSION bump**: What is the current value, and who owns bumping it after Phase 5 completes? Confirm before enabling `PENUMBRA_T2_REEMBED_ENABLED`.
