# Cycle-5 adversarial review — lane-close + verification findings

Synthesis: `.penumbra/reviews/2026-05-16T23-35-00.736Z/synthesis.md`
Range reviewed: `250bb39..79c3eb3`

These findings target the concurrent commits that landed during today's session — they belong to the author of `b462bcb` + `f74f9bd` (lane-close memory-verify, meta_json truncation, sqlite pragma loading). Workflow_run_id-line findings handled separately in the followup hardening commit.

| # | Sev | Finding | File pointer |
|---|-----|---------|--------------|
| 4 | M | Lane-close implicitly authorizes memory-verification writes without explicit verify authz/provenance gate | `packages/daemon/src/routes/lanes.ts` |
| 5 | M | `gate_status` mapping collapses `skipped`/`review_debt` into `failed`, mislabeling verification outcomes | search `gate_status` in lanes/verification path |
| 6 | M | Lane-close executes unbounded per-memory DB work inline (amplification/latency risk under HTTP request budget) | `packages/daemon/src/routes/lanes.ts:119`; `handoff-sweeper.ts:35` |
| 7 | M | Verification idempotency is race-prone (`SELECT` then `INSERT` without unique constraint), allowing duplicate rows | memory_verifications writer |
| 8 | M | `events_written` counter increments even when `verifyMemory` returns `null` (no row written), corrupting metrics | same writer |
| 9 | M | Global `meta_json` truncation (b462bcb) is kind-blind — can silently break downstream event-contract expectations | `packages/core/src/services/dispatch-event-log.ts` |
| 10 | L | `loadSqliteVec` now also sets runtime pragmas (f74f9bd WAL+busy_timeout) — couples extension loading with operational policy | `packages/core/src/db/load-sqlite-vec.ts` or equivalent |

Suggested triage order: #4 first (security boundary), #7+#8 together (verification correctness), #6 (perf budget), #5 (telemetry accuracy), #9 (data integrity), #10 (low-priority refactor).
