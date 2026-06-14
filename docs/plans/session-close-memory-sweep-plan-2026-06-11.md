# Phased TDD Plan: Session-Close Memory Sweep + Volatile/Permanent Digest Split

This merges four lenses (architect, simplifier, risk, integration). Where they diverge, the conflict is named and resolved inline. The plan is ordered by leverage: the digest split ships first (immediate value, zero new infrastructure), then the sweep is built up behind a flag.

## Design Decision Table (resolved across lenses)

| Concern | Decision | Why this winner |
|---|---|---|
| **Volatility mechanism** | Reuse existing `is_episodic` + `durability` columns — **no new column, no SCHEMA_VERSION bump.** Digest query computes class via CASE. | Integration lens verified `is_episodic`, `durability`, `obs_type` are already present (SCHEMA_VERSION 31, set by the t2-promotion LLM). Architect's `durability='status'` enum and simplifier's `memory_class` column both require a migration the integration lens proved unnecessary. Reuse wins on additivity + reversibility. |
| **Sweep integration point** | Standalone pre-compact/stop-triggered CC workflow (`session-memory-sweep`); handoff SKILL.md step 3 *calls* it, doesn't execute it. | All four lenses converged here. Decoupled, survives truncation, mirrors `session-first-moves` shape. |
| **Approval UX** | **Inline approval** in the CC workflow (format table → Y/N/all → `memory_write_t2` for approved). | Conflict: simplifier+risk want the `dream_actions` queue (approve next-session); architect+integration want inline. **Inline wins** — the 2-minute window needs synchronous in-band approval; the `dream_actions` path adds a daemon round-trip, a new action kind, an approve tool, and a skip-guard in the dream cycle (risk's Phases 2/5/6) for async machinery that doesn't fit a live close. Cut ~3 phases of surface. |
| **Transcript access** | t0_events via daemon (primary) with `findActiveTranscriptForCwd` JSONL fallback. No new MCP tool. | Integration lens grounded this in the existing `T2Promotion.promoteRollup` pattern. Beats architect's `chain_history`-only (misses Bash/file signal) and risk's `chain_get_messages`-only (MCP-chain-only gap). |
| **Dedup strategy** | Two-pass: (1) slug exact-match + t2 FTS keyword; (2) embedding near-dup via existing `isNearDuplicate` in `core/src/memory/near-dup.ts`. High overlap → propose UPDATE not CREATE. | Reuses shipped near-dup logic. Architect's 3-pass `sirius_embed` and integration's 2-pass collapse to the same thing; threshold 0.85 (architect) for FTS, 0.92 (integration) for embedding cosine. |
| **Extraction model** | haiku-3-5 via agentchat judge pool. Maestro/Fable touches only the approval render. | Hard cost directive; all four lenses agree. |
| **Digest budget** | `PENUMBRA_MEMORY_DIGEST_STATUS_ROWS` (default 20) + `PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS` (default 180). Sum = current 200 default = no-op when unset. | Integration's naming; additive to existing `resolveLimit()`. Beats risk's single `VOLATILE_CAP` (doesn't bound patterns) and architect's fraction math (less legible). |

**Cut from the union:** auto-volatility regex inference on the write path (risk Phase 1) — write-path heuristic is brittle and the t2-promotion LLM already sets `is_episodic`/`durability`; per-row override exists if needed. The `extract_session_concept` dream-action kind + `memory_dream_action_approve` tool + dream-cycle decay/retire integration (risk Phases 2/5/6) — all dropped with the inline-approval decision. Backfill of `memory_class` (architect Phase 7 / simplifier Phase 5) — no new column to backfill; existing rows already carry `is_episodic`/`durability` from promotion, so the digest split benefits them retroactively with zero migration.

---

## Phase 1 — Digest volatility split (per-class row budgets) — **INDEPENDENT**

Ship first: immediate value, no schema change, no new infra, no daemon restart.

**Failing test.** `plugin/workflows/memory-digest/workflow.test.ts` (extend)
- Add `is_episodic` + `durability` columns to the `freshDb()` helper's `CREATE TABLE`.
- Case A: seed 30 rows `is_episodic=1` + 30 rows `is_episodic=0`; set `STATUS_ROWS=5`, `PATTERN_ROWS=10`; assert exactly 5 status-class + 10 pattern-class rows (15 total), summary line `Loaded 15 digest rows`.
- Case B: seed 250 rows (25 episodic / 225 non-episodic), no env vars; assert loaded = 200, status rows ≤ 20.
- Idempotency: double-run returns byte-identical output; sentinel first line unchanged.

**Impl.** `plugin/workflows/memory-digest/workflow.ts`
- Add `resolveStatusRowLimit()` (`PENUMBRA_MEMORY_DIGEST_STATUS_ROWS`, default 20) and `resolvePatternRowLimit()` (`PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS`, default 180).
- Split `DIGEST_QUERY` into `STATUS_DIGEST_QUERY` (existing WHERE `+ AND (is_episodic = 1 OR durability = 'volatile' OR obs_type = 'session')`) and `PATTERN_DIGEST_QUERY` (the negation, with NULL-safe guards), each `ORDER BY updated_at DESC` with its own LIMIT.
- Merge status-first then pattern, re-apply `resolveLimit()` as the outer cap (`PENUMBRA_MEMORY_DIGEST_MAX_LINES` semantics unchanged).
- Append status rows under a `## Recent Status` marker (risk's section header) — but only when status rows exist, so the sentinel/empty case is untouched.

**Verify.**
```
bun test plugin/workflows/memory-digest/workflow.test.ts
```
All existing tests stay green; double-run to confirm no env bleed. The existing "Orders rows by updated_at descending" test seeds no episodic rows, so all rows fall in the pattern bucket and its ordering holds.

**Boundaries / deltas.** Pure workflow-TS function. No package boundary crossed. Env vars only (workflow-side). **No schema delta. No restart.**

---

## Phase 2 — Sweep core extractor + daemon route — **INDEPENDENT** (parallel with Phase 1)

**Failing test.**
- `packages/core/test/writers/session-extract-candidates.test.ts` (new):
  - empty/short transcript → `[]`;
  - slug-matched existing row → candidate `action='update'` + `existing_memory_id` set;
  - missing `why` or bare-fact (no hook) → filtered out (quality floor);
  - body < 80 chars && depth < 2 → filtered.
- `packages/daemon/test/routes/memory-session-extract.test.ts` (new): seed t0_events for a session + one overlapping existing t2 row; `POST /memory/session-extract` returns `candidates[]`, at least one with `update_existing_slug` set, none with body < 80.

**Impl.**
- `packages/core/src/writers/session-extract.ts` (new, ~120 lines): export `SessionExtractCandidate` + `extractSessionCandidates(opts, transcript)`. Logic: short-circuit empty; call `opts.llm` (reuse `T2MemoryExtractionSchema` from `writers/t2.ts`); validate via `validateT2Body` (`t2-embed-text.ts`); per candidate embed + slug-check (same query as `writeDirectT2Memory`) + `isNearDuplicate` against top-10 neighbors (extract `readExistingNearDuplicateCandidates` to a shared fn); cap at `maxCandidates` (default 15, but see Phase 4 cap at 10 for UX). Add `validateExtractQuality()` (reject `why` null/<20 chars; reject `is_episodic===true` — those are t1-layer; backlinks empty = warn not reject) and `resolveBacklinks()` (FTS5 `t2_fts MATCH` on title keywords, ≥2 tokens, cap 3).
- `packages/daemon/src/routes/memory-session-extract.ts` (new, ~60 lines): body `{ session_id, project_id?, max_candidates? }`; fetch transcript from t0_events (same SQL as `T2Promotion.promoteRollup`); LLM judge via `createDefaultLLMJudge` from `workers/t2-promotion.ts` (no new wiring); delegate to `extractSessionCandidates`.
- Wire `POST /memory/session-extract` in `packages/daemon/src/serve.ts` (1 line).

> Note: the quality gate (`validateExtractQuality` + `resolveBacklinks`) is folded in here rather than a separate phase (architect/integration split it out) — it's the same module and tested by the same files; splitting adds a phase for no isolation benefit.

**Verify.**
```
bun test packages/core/test/writers/session-extract-candidates.test.ts
bun test packages/daemon/test/routes/memory-session-extract.test.ts
```

**Boundaries / deltas.** `@penumbra/core` new module (no restart); daemon new route + serve wire. **No schema delta.** **Daemon restart required** to expose the route: `launchctl kickstart -k gui/$UID/dev.penumbra.daemon` (verify pid changes).

---

## Phase 3 — Sweep workflow + inline approval — **SEQUENTIAL** (needs Phase 2 route)

**Failing test.**
- `plugin/workflows/session-memory-sweep/workflow.test.ts` (new): 3 t0_events + mock LLM → 2 candidates → result contains `## Session memory candidates` + both titles, and does NOT call `memory_write_t2` (no approval in test mode); empty db → `""`; trigger registry matches `session-memory-sweep` for pre-compact + stop.
- `packages/workflows/test/integration/session-memory-sweep.test.ts` (new, mirrors `session-handoff.test.ts`): seed t0_events, run with output → `next-session-prompt` sink; assert `outcome === 'success'` and candidate section or "no new candidates".

**Impl.**
- `plugin/workflows/session-memory-sweep/workflow.ts` (~150): `WorkflowSpec` name `session-memory-sweep`, triggers `[lifecycle:pre-compact, lifecycle:stop]`, output `[next-session-prompt]`, `run: ts-function`. `fn`: read `ctx.captureCtx.sessionId`/`project`; fetch transcript from t0_events via `ctx.db()` (fallback `findActiveTranscriptForCwd`); call `/memory/session-extract` over the storageRoot port/token (same pattern as `session-first-moves.ts`); no candidates → `""`; else format a numbered Markdown approval block (`[create]`/`[update]`, slug, hook, body, why, backlinks). **Dedup happens at proposal time** so the user approves "update existing X" not a blind create.
- `.claude/workflows/session-memory-sweep.js` (~80, mirrors `session-first-moves.js`): `meta` + response schema; calls `workflow_run({ name: 'session-memory-sweep' })`; presents candidates inline for Y/N/all; on approval calls `memory_write_t2` per approved candidate (UPDATE candidates pass the upsert/target slug). Extraction agent uses `model: haiku-3-5`; approval is an inline CC turn, no fleet dispatch.
- `plugin/skills/handoff/SKILL.md` step 3: "Run the `session-memory-sweep` workflow first; it extracts and proposes entries. Only hand-file additional entries via `memory_write_t2` that the sweep missed."
- **Flag gate (risk's hazard):** wrap the trigger behind `PENUMBRA_SESSION_SWEEP_ENABLED` (default `"1"` = on, silenceable). Add a min-signal guard: skip when transcript < 200 chars or t0_events below the `minEvents` threshold already in `T2Promotion.detectEligibleRollups`.

**Verify.**
```
bun test plugin/workflows/session-memory-sweep/workflow.test.ts
bun test packages/workflows/test/integration/session-memory-sweep.test.ts
```
Double-run soak: sweep writes no files, only returns reminder text — confirm MEMORY.md sentinel untouched.

**Boundaries / deltas.** Workflow-TS + CC-workflow JS, loaded by registry/harness at session-start. Env var `PENUMBRA_SESSION_SWEEP_ENABLED`. **No schema delta. No restart** (workflow specs picked up on session-start; the `.js` is read by the CC harness directly).

---

## Phase 4 — End-to-end composition + soak — **SEQUENTIAL** (needs Phases 1–3)

Confirms the two features compose and don't fight; no new product code.

**Failing test.**
- `packages/workflows/test/integration/memory-digest-volatility.test.ts` (new): 30 episodic + 50 pattern rows, `STATUS_ROWS=5`/`PATTERN_ROWS=10`, double-run identical (no ordering flap); a no-op `session-memory-sweep` run leaves MEMORY.md byte-identical (sweep writes nothing).
- `packages/cli/test/commands/memory-digest.test.ts` (extend): `durability='volatile'` rows land in the status section (first ≤ STATUS_ROWS positions), `durability='permanent'`/pattern rows after.

**Impl.**
- `scripts/session-memory-sweep-soak.ts` (new, mirrors `session-first-moves.ts`): read storageRoot, call `/memory/session-extract` for the latest t1_rollup session_id, print ONE JSON `{ session_id, candidate_count, has_updates, near_dup_filtered, fts_backlinks_found }`, exit 0/1.

**Verify.**
```
bun test packages/workflows/test/integration/memory-digest-volatility.test.ts
bun test packages/cli/test/commands/memory-digest.test.ts
bun test plugin/workflows/memory-digest/workflow.test.ts   # regression gate
bun run scripts/session-memory-sweep-soak.ts 2>&1 | jq .
```

**Flag-enable procedure (after merge).** Set `PENUMBRA_MEMORY_DIGEST_STATUS_ROWS=20`, `PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS=180`, `PENUMBRA_SESSION_SWEEP_ENABLED=1` in daemon config; one daemon restart (verify pid changes); trigger a test session close; confirm the soak script exercises the live endpoint; spot-check `cost_recent` (haiku sweep input < 15k tokens/session).

**Boundaries / deltas.** Tests + soak script only. **No schema delta. One daemon restart** for flag activation only.

---

## Dispatch sizing & dependency graph

| Phase | Files | ~Diff | Lane | Depends on |
|---|---|---|---|---|
| 1 (digest split) | 2 | ~80 | STANDARD | — (parallel) |
| 2 (extractor + route) | 3 | ~280 | STANDARD | — (parallel) |
| 3 (workflow + approval) | 4 | ~250 | STANDARD | Phase 2 |
| 4 (compose + soak) | 4 | ~150 | TRIVIAL | 1, 2, 3 |

Phases **1 and 2 dispatch concurrently** (disjoint write surfaces). Phase 3 needs Phase 2's route; Phase 4 needs all. All under the ~600-line honest-completion target.

## Restart map

| Phase | Daemon | MCP server | CLI |
|---|---|---|---|
| 1 | No | No | No |
| 2 | YES (new route) | No | No |
| 3 | No | No | No |
| 4 | YES (flag activation only) | No | No |

No MCP-server restart anywhere (no new MCP tool — inline approval reuses `memory_write_t2`). No SCHEMA_VERSION bump anywhere.

## Schema / flag delta summary

- **Schema:** none. `is_episodic`, `durability`, `obs_type` already present (SCHEMA_VERSION 31, `addColumnIfMissing`).
- **New env vars:** `PENUMBRA_MEMORY_DIGEST_STATUS_ROWS` (20), `PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS` (180), `PENUMBRA_SESSION_SWEEP_ENABLED` (`"1"`), and `PENUMBRA_SESSION_SWEEP_MAX_CANDIDATES` (10) — all additive, all in `.env.example`, never `.env`.
- **New files:** `packages/core/src/writers/session-extract.ts`, `packages/daemon/src/routes/memory-session-extract.ts`, `plugin/workflows/session-memory-sweep/{workflow.ts,workflow.test.ts}`, `.claude/workflows/session-memory-sweep.js`, `scripts/session-memory-sweep-soak.ts`, plus the new test files.

---

## Trade-offs (what was cut and why)

- **`dream_actions` approval queue (simplifier/risk) → cut for inline approval.** The queue is built for async background curator work; a live 2-minute close needs synchronous approval. Inline reuses `memory_write_t2` and deletes ~3 phases (new action kind, approve tool, dream-cycle skip-guard + decay/retire). Cost: approval must happen while the session is closing, not deferred — acceptable, since that is exactly the handoff ritual.
- **New schema column (`durability='status'` architect / `memory_class` simplifier) → cut.** Integration lens proved the lifecycle columns already exist and are LLM-populated. Reusing them is additive and reversible; a migration is neither.
- **Write-path volatility regex inference (risk Phase 1) → cut.** Brittle heuristic on a hot path; the promotion LLM already classifies. Per-row `durability` override remains if a human disagrees.
- **`memory_class` backfill (architect/simplifier) → cut.** Nothing to backfill — existing rows carry `is_episodic`/`durability`, so the digest split helps them immediately.
- **Separate quality-gate phase (architect/integration) → folded into Phase 2.** Same module, same test files; isolating it bought no safety.
- **Dream-cycle decay/retire of volatile rows (risk Phase 5) → deferred.** Real future value, but it's a separable follow-up; the digest cap already stops status rows from crowding the digest without touching the decay machinery. Filed as an open question below.

## Open questions for the operator

1. **Volatile retirement.** The digest cap hides old status rows but never retires them from t2. Do you want a follow-up to soft-retire (`archived_at`) volatile rows older than N days (risk's `PENUMBRA_VOLATILE_RETIRE_DAYS`, default 30), or is digest-level capping sufficient for now?
2. **`durability` value vocabulary.** The digest CASE keys on `durability = 'volatile'`. Confirm the t2-promotion LLM actually emits the literal string `'volatile'` (vs a float, or `'session'`/`'permanent'`) — the architect and risk lenses disagreed on whether `durability` is text or a 0–1 float. **This must be verified against `packages/core/src/db/schema.ts` and the promotion prompt before Phase 1 lands**, since the whole split keys on it. If it's a float, the predicate becomes `durability < 0.4` (risk's form) and the env-var defaults stand.
3. **Sweep default-on vs default-off.** `PENUMBRA_SESSION_SWEEP_ENABLED` defaults to `"1"` (integration) so it's live immediately. Prefer default-off for a soak period first (risk's staged rollout)? One-line flip.
4. **Backlink FTS precision.** ≥2-token FTS match caps spurious backlinks but may miss valid single-keyword links. Acceptable, or want embedding-based backlink suggestion instead (heavier)?

One verification is load-bearing before Phase 1: confirm the `durability` column's type and value vocabulary in `packages/core/src/db/schema.ts` — the entire digest split predicate depends on it.
