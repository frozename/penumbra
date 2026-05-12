# Post-routing cleanup plan — 2026-05-12

Status: complete (with deferrals) — 2026-05-12 pm-late-5
Owner: maestro
Predecessor: `2026-05-12-agent-routing-unification-design.md` (complete on main as of `0bc1210`)

## Closeout — 2026-05-12 pm-late-5

Every phase has either landed or been verified not-applicable. Re-scoping at session start showed:

- **Phase 1.1** ✅ `c1a78c8` — reconciler rebuilds core/dist before scoped tests.
- **Phase 1.2** ✅ `7b0ef15` — per-task-class sweeper thresholds.
- **Phase 1.3** ✅ `d6f2359` — silent-failure retry forces use_worktree.
- **Phase 1.4** ✅ Pre-existing — `/land` slash already shipped at `~/.claude/commands/land.md` (user-invocable).
- **Phase 1.5** ✅ Effectively closed by `ca27768` (dispatch_land re-stamp) + `9bbf8c8` (task_type fallback). `agent_recommend(implement_substantial, 7d)` returns codex-acp-fast with 31 samples / 0.35 success_rate — acceptance met without a backfill route.
- **Phase 2.1 + 2.2** ✅ `f8eece2` + follow-ups (memory.verify server-side verifier + append-only audit).
- **Phase 2.3** ✅ Verified not-applicable — `packages/mcp/src/federation/client.ts:60-62` already filters federated tools through `envAllowlist`. No discovery-vs-execution glob mismatch.
- **Phase 2.4** ✅ Verified not-applicable — current regex at `packages/daemon/src/routes/long-lived-mcp.ts:9` already accepts `ha:light.toggle` and similar dotted local-name segments.
- **Phase 2.5** ✅ Verified not-applicable — the only `process.env.PENUMBRA_TOKEN` site in daemon is `maestro/worker-manager-http.ts:14`, which is the outbound daemon→worker Authorization header (correct usage, not route-level re-auth).
- **Phase 2.6** ⏸ Deferred — MCP server spec-drift detection (BOUNDARY). Real but not urgent; no in-flight incidents.
- **Phase 2.7** ✅ `233dc25` — dropped untrusted reviews_dir from efficacy rebuild route.
- **Phase 3.1 + 3.2** ✅ `0e11c5b` + round-1 + round-2 fixes (lease/heartbeat/reclaim + backend gate).
- **Phase 3.3** ⏸ Deferred — no OpenAPI surface in repo; shape change is captured across notes + memories. Re-open if/when a versioned-contract doc is introduced.
- **Phase 4** ✅ `8146a99`, `aaeeae3`, `71306bf` (timestamp validation, classifier key, stub alignment).
- **Phase 5.1 + 5.2** ✅ `a128321`, `f44c66f`, `553e86c`. Acceptance greps (`from '.../core/src` and `as Services & `) both return zero hits.
- **Phase 5.3** ⏸ Deferred — helper consolidation. Low urgency; structural cleanup only.
- **Phase 6.1 + 6.2** ✅ `6fcfbb7` (T2 cost gates + capture usage aggregation reuse).
- **Phase 6.3** ⏸ Deferred chapter — Gemini quota Phase B/C is its own thread; phased plan exists in memory `project_gemini_quota_enforcement_gap_2026-05-08.md`. Open as a fresh spec when picked up.

All acceptance criteria from "Acceptance for the whole plan" except #6 are met. #6 ("Security Highs from 2026-05-12T18-07-47 and 2026-05-11T22-* series marked closed in memory") is half-done — memory.verify Highs were closed; federation review Mediums (the 8 from `.penumbra/reviews/2026-05-12T00-56-56.377Z/`) were re-verified at session-start and found to be already addressed or not-applicable per the entries above.

Deferred items 2.6, 3.3, 5.3, 6.3 should be picked up as independent next chapters rather than as residual cleanup work.

## Premise

The routing-unification chapter landed cleanly across 8 commits (`34e1c89` → `0bc1210` → `ca27768`). Smoke testing the unified `routeAgent` surfaced a deeper set of attribution bugs (now partly fixed in `9bbf8c8`, `ca27768`) and a backlog of unresolved adversarial-review findings, scaling issues, and accumulated boundary violations. This plan structures the work in five phases. Each phase is independently shippable — Phase 1 closes the attribution chapter and is the highest leverage; later phases stack security, async-lifecycle, correctness, and architectural debt.

## Conventions

- **Lane class** per phase indicates `dispatch-quality-gates` classification.
- Each task has explicit **acceptance criteria** — a test, a grep, or an observable state change.
- **Dependencies** annotated where a task's verification depends on a prior task.
- All phases assume the `dispatch_land` workflow per `feedback_use_dispatch_land_not_manual_merge.md`. Do not hand-merge from home checkout.
- Use `bun tsc -b packages/<X> --force` + home-checkout `bun run typecheck` before every push; treat exit 0 + a clean focused test run as the merge gate.

## Phase 1 — Close the agent-attribution chapter (HIGH leverage)

Goal: make `agent_recommend` and `agent_performance.success_rate` reflect reality. Reconciler is currently the dominant source of misattribution despite the 2026-05-11 unpoison commit (`6f02128`) reducing typecheck-failed contamination from ~1,835 rows to ~7. The remaining loss is the **dist-shadow false-fail** and the **codex-non-commit race**.

### 1.1 Reconciler scoped typecheck — dist rebuild step (STANDARD)

The reconciler at `packages/agentchat/src/worker/merge-reconciler.ts:583-602` already runs scoped `bun tsc -b ...affectedPackages` when affectedPackages is non-null. The failure mode is downstream: scoped `bun test packages/X/test/` at line 645 inherits the worktree's stale `packages/core/dist/` (memory `project_core_dist_shadows_types.md`). Add a `bun tsc -b packages/core --force` step before scoped tests when packages/core is in affectedPackages, AND when packages/core is a *transitive* dependency of any affected package.

**Files:** `packages/agentchat/src/worker/merge-reconciler.ts` around line 615 (test phase), `packages/agentchat/test/worker/merge-reconciler-typecheck-scoping.test.ts` (extend coverage).

**Acceptance:** A test fixture that simulates stale `packages/core/dist` in the worktree and asserts the reconciler rebuilds before scoping tests. Verify by removing the rebuild step and watching the test fail.

### 1.2 Reconciler stale-handoff sweeper per-class threshold (STANDARD)

Current sweeper threshold is 15min and kills active codex-acp-deep / claude-acp-sonnet substantive dispatches mid-flight (memory `stale_handoff_sweeper_kills_long_dispatches.md`). Raise to per-task-class:
- TRIVIAL: 5min
- STANDARD: 15min (current)
- BOUNDARY: 45min

**Files:** Find the sweeper (`grep -rln "stale.*handoff\|sweeper" packages/daemon/src/`), add task_class lookup from handoffs table.

**Acceptance:** Smoke a BOUNDARY-class dispatch with a known long-tail agent and verify it survives past 15min.

### 1.3 silent-failure-retry workflow cleanup (STANDARD)

Per memory `silent_failure_retry_orphan_pollutes_ports.md` and `project_silent_failure_retry_commits_to_main.md`: orphan retry processes survive chain_wait failure, hold ports, and occasionally commit to main directly. Two concrete fixes:
- Make silent-failure-retry processes register a PID in a `~/.penumbra/pids/silent-failure-retry/` directory so the daemon can clean them up.
- Force `use_worktree: true` on retries (currently inherits null; commits then land in home checkout).

**Files:** Find the retry spawner (`grep -rln "silent-failure-retry\|silentFailureRetry" packages/agentchat/`), add PID file + worktree default.

**Acceptance:** Trigger a semantic-failure dispatch, observe retry, verify (a) retry uses a worktree, (b) PID file exists, (c) post-completion cleanup leaves no orphan.

### 1.4 Workflow migration: dispatch_land → MCP slash (TRIVIAL)

Today: `dispatch_land` is HTTP only or via MCP tool. The maestro session uses raw `git merge --ff-only` from home checkout, bypassing the agent_performance re-stamp landed in `ca27768`. Add a thin slash command `/land <handoff_id>` that wraps `mcp__penumbra__dispatch_land` and posts the commit_sha + restamp confirmation.

**Files:** New `.claude/commands/land.md` (or skill — pick whichever surface integrates better).

**Acceptance:** `/land <id>` in a maestro session merges the agent branch via dispatch_land, prints the new commit_sha, and `agent_performance.outcome` flips from `no_changes` → `merged` (verifiable via sqlite query).

### 1.5 Backfill: this-session's mis-attributed rows (TRIVIAL, one-shot)

7 lanes from 2026-05-12 have wrong outcomes and/or wrong task_type. Run a one-shot maestro SQL through a daemon helper route (NOT direct sqlite write — memory `feedback_use_mcp_not_sqlite.md`). If no such helper exists, add a minimal `POST /agent_performance/backfill` route gated on bearer + explicit handoff_id list. Stamp each as `outcome='merged'`, copy `task_type` from `handoffs.chain_task_type`.

**Acceptance:** `agent_recommend(task_type='implement_substantial', window_days=30)` includes codex-acp-fast with non-zero success_rate.

## Phase 2 — Security Highs from adversarial reviews (BOUNDARY)

Goal: close the H-class findings from `memory.verify` provenance (2026-05-12T18-07-47) and the federation tool surface (2026-05-11T22-* series). Each is a wire-form / contract / authz concern — BOUNDARY class with adversarial-review fan-out.

### 2.1 Server-side verifier identity binding (BOUNDARY) — H1

`memory.verify` accepts client-supplied `verifier_id`. Need server-side derivation from authenticated session bearer token. Add `verified_by_actor` column or replace the existing `verifier_id` field with a server-stamped value.

**Files:** `packages/core/src/writers/memory.ts` (find verify writer), HTTP route auth context plumbing, schema migration if column added.

**Acceptance:** Adversarial round-trip test: client passes `verifier_id="attacker"`, server records actual session bearer's machine_id. Test must fail before fix.

### 2.2 Append-only verification audit events (BOUNDARY) — H2

Today: `memory.verify` overwrites the verification context on each call. Need a `memory_verification_events` table or equivalent, INSERT-only, with one row per verify call.

**Files:** Schema migration (placement matters per `project_schema_migration_placement.md` — add inside the second db.exec block if `long_lived_*` table neighborhood), writer changes, optional read surface.

**Acceptance:** Two verify calls on the same memory produce two audit rows. Existing `t2_memories.last_verified_at` still reflects most-recent.

### 2.3 Federated tool allowlist enforcement (BOUNDARY)

Tools surfaced via federation currently bypass `PENUMBRA_MCP_TOOL_ALLOWLIST`. Allowlist also has a discovery-vs-execution semantic mismatch (exact match for listing, glob for invocation).

**Files:** Federation tool dispatcher, allowlist check site.

**Acceptance:** Test: register a federated tool not in the allowlist, attempt to invoke, expect denial. Discovery + execution use the same matching strategy.

### 2.4 Tool-name regex accepts dotted long-lived IDs (STANDARD)

Current regex rejects `ha:light.toggle`-style names. Adjust regex to allow dots inside the local-name segment.

**Files:** Find via `grep -rn 'tool.*name.*regex\|TOOL_NAME_REGEX' packages/`.

**Acceptance:** `ha:light.toggle` is a valid tool name; legacy colon-only names still pass.

### 2.5 Drop duplicate auth: route-level env PENUMBRA_TOKEN (STANDARD)

A route re-authenticates with env var `PENUMBRA_TOKEN`, conflicting with the centralized daemon bearer auth. Remove the route-level check; rely on the daemon's existing auth middleware.

**Files:** Find via `grep -rn 'PENUMBRA_TOKEN' packages/daemon/src/`.

**Acceptance:** Route still works with the bearer-token auth; env-token path is gone.

### 2.6 MCP server spec drift detection (BOUNDARY)

Same-name MCP server reuse silently keeps stale runtime when `command/args/env` change. Add a spec-hash check at MCP server registration that forces restart on drift.

**Files:** MCP server lifecycle manager (likely `packages/mcp/src/...` or daemon-side).

**Acceptance:** Modify an MCP server's `args` in agentchat config, reload daemon config, verify the server is restarted (not reused).

### 2.7 Untrusted reviews_dir exfiltration risk (STANDARD)

`agent.route_for` or adversarial-review code path accepts a `reviews_dir` from the caller and passes it to an external LLM. Sandbox to a known subtree or drop entirely.

**Files:** Trace via `grep -rn 'reviews_dir' packages/`.

**Acceptance:** Caller can no longer specify an arbitrary path; only paths under the project's `.penumbra/reviews/` are accepted.

## Phase 3 — Async job lifecycle (STANDARD)

Goal: make `memory.efficacy_rebuild` and similar async surfaces production-grade. Today they return 202 without leases or backend checks (per 2026-05-12T15-10-22 review).

### 3.1 Lease/heartbeat/reclaim for async jobs

Add lease lifecycle to async jobs:
- Pre-claim: `claimed_at`, `claimed_by` (worker id)
- Heartbeat: periodic `heartbeat_at` update; daemon sweeps stale leases after TTL
- Reclaim: orphaned jobs (heartbeat_at older than TTL) auto-requeue

**Files:** Async job table schema + queue runner + sweeper.

**Acceptance:** Kill the worker mid-job; the daemon's sweeper marks the lease stale and requeues. Verify with a deliberate worker SIGKILL during a long efficacy_rebuild.

### 3.2 Backend availability check before 202 (STANDARD)

Currently routes return 202 even if no worker is alive to process the queue. Add a quick backend-health check (e.g., recently-heartbeated worker exists) before accepting the job. If no backend, return 503.

**Files:** Async job enqueue routes.

**Acceptance:** Stop the worker, POST to `memory.efficacy_rebuild`, expect 503; restart worker, expect 202.

### 3.3 Versioned async contract (TRIVIAL)

The `memory.efficacy_rebuild` route changed from sync to async (`89fbd51`) without API versioning. Document the new contract in the OpenAPI spec or equivalent; mark response shape as `v2`.

**Acceptance:** Spec updated; existing callers continue to work (only the response shape changed in a backwards-compatible way per the original commit).

## Phase 4 — Correctness sweep on routing + quality.status (STANDARD)

Goal: address the 5 Medium correctness findings from adversarial-review across `quality.status` and routing.

### 4.1 Numeric query param hardening

`min_samples=abc` currently → `NaN` → 500. Use `z.coerce.number().int().positive()` consistently across query-param parsers.

**Files:** Routes under `packages/daemon/src/routes/` that accept numeric query params (agents.ts, others).

**Acceptance:** `curl ".../agents/route_for?min_samples=abc"` returns 400 with a field_errors payload.

### 4.2 Findings parser regex non-JS `\Z`

`packages/workflows/...` adversarial-review findings parser uses Java/PCRE-style `\Z` anchor. JS regex doesn't support it; findings are silently dropped at the file end.

**Files:** Find via `grep -rn '\\\\Z' packages/workflows/`.

**Acceptance:** A finding at the very end of a persona output is captured (test fixture).

### 4.3 Timestamp normalization for non-ISO inputs

Lexical comparison against malformed timestamps breaks the SQL cutoff. Validate input timestamps as ISO-8601 before SQL bind; reject malformed inputs at the boundary.

**Files:** `packages/core/src/readers/quality-status.ts` and related.

**Acceptance:** Pass a malformed `since="2026/05/01"`, get 400; pass valid `since="2026-05-01T00:00:00Z"`, succeed.

### 4.4 Classification key collision (per-file uniqueness)

Findings classification map keyed by local file `index` collides across files. Use `(file, index)` tuple or compose a stable global key.

**Files:** Adversarial-review classification code.

**Acceptance:** Two personas with overlapping local indices keep their findings separate.

### 4.5 quality.status JSON predicate hardening

Currently `LIKE '%task_type%'` on a `payload_json` text column. Use `json_extract` for type-safe access. Partially addressed in `e4c21dd` (workflow_name); apply same pattern to remaining LIKE-on-json sites.

**Files:** `packages/core/src/readers/quality-status.ts` + tests.

**Acceptance:** Grep `LIKE '%` in `packages/core/src/readers/quality-status.ts` returns zero matches against JSON-typed columns.

## Phase 5 — Boundary cleanup (STANDARD)

Goal: tighten the daemon → core boundary that's accumulated leaks during the rapid-feature months. Multiple adversarial reviews flagged this.

### 5.1 Deep `core/src` imports in daemon

Replace deep relative imports in daemon code with `@penumbra/core` re-exports. If something isn't re-exported, add the export in `packages/core/src/index.ts`.

**Files:** `grep -rn "from '\\.\\./.*core/src" packages/daemon/src/ --include='*.ts'`.

**Acceptance:** Zero deep imports remain; `packages/core/src/index.ts` covers the public surface.

### 5.2 Unsafe service casts

Several routes cast `Services` to `Services & { foo?: ... }` to access optional members not yet on the canonical type. Add the optional members to the canonical type or use proper composition.

**Files:** `grep -rn 'as Services & ' packages/daemon/src/`.

**Acceptance:** Zero `Services & {` casts; `Services` type covers all daemon-side optionals.

### 5.3 Daemon-side helper consolidation

Several daemon-only helpers (e.g., `computeRouteForRole`, `resolveSingleRoute`) live in separate files. Audit if a consolidated `packages/daemon/src/routes/_helpers/` directory makes sense.

**Acceptance:** Helpers organized; no duplication across routes.

## Phase 6 (optional) — Source TODOs + cost observability

### 6.1 T2 writer cost sampling

`packages/core/src/writers/t2.ts:156` TODO for LLM cost heuristics. Add a sampler that estimates cost-per-observation before queuing for promotion; downsample expensive paths.

### 6.2 Capture-service usage aggregation API

`packages/core/src/services/agent-performance-operator.ts:35` TODO. Export the shared aggregation helper from `agent-performance-capture.ts` so the operator can reuse it.

### 6.3 Gemini quota enforcement Phase B/C

Per memory `project_gemini_quota_enforcement_gap_2026-05-08.md`: schema + reader landed but yaml + agent annotation deferred. Annotate gemini agents in agentchat.yaml with `subscription_model` and populate per-model quotas. Phased plan exists in memory; pick it up.

## Sequencing & dependencies

- **Phase 1 first** (highest leverage; closes the attribution chapter that contaminates every downstream decision).
- **Phase 2 is independent** of Phase 1; can be parallel if a second session is available, but each task within Phase 2 is independently shippable.
- **Phases 3, 4 depend on nothing**.
- **Phase 5 should come after Phase 1 and Phase 2** — the boundary cleanup is easier when no churn is happening in core/daemon.
- **Phase 6 is opportunistic** — pick up when other phases are between gates.

## Out of scope

- Codex / Gemini upstream agent behaviors (non-commit, narrate-and-quit, prompt-injection refusals). Track in memory; can't fix in-repo.
- Console design implementation (`2026-05-08-penumbra-console-design.md` greenfield). Separate spec session.
- Long-lived federation Phase 5+. Separate plan.
- Plan-validator UX polish (memory `plan_validate_format_gotchas.md`) — small enough to ad-hoc.

## Acceptance for the whole plan

After all phases land:
1. `mcp__penumbra__agent_recommend({task_type:'implement_substantial', window_days:7})` returns at least 3 agents with non-zero `success_rate` AND at least one with `samples ≥ 10`.
2. `grep -rn "from '\\.\\./.*core/src" packages/daemon/src/ --include='*.ts'` returns empty.
3. Adversarial-review against `origin/main` shows zero High findings on the touched surface.
4. `bun run typecheck` from the home checkout exits 0; no dist-shadow regressions.
5. Async job lifecycle survives a worker SIGKILL mid-job.
6. Security Highs from `2026-05-12T18-07-47` and `2026-05-11T22-*` series marked closed in memory.

## Pre-flight checklist (per session)

Before starting any phase task:
1. Verify daemon + worker are up: `launchctl list | grep penumbra`.
2. `mcp__penumbra__handoff_list_pending` → empty.
3. `pgrep -fl 'silent-failure-retry|retry_of='` → empty.
4. Home checkout: `git status`, `git pull origin main`, `bun run typecheck` exit 0.
5. Pick one task, classify per `dispatch-quality-gates`, dispatch via `chain_start` with explicit `task_class`.
6. On chain-end, use `/land <handoff_id>` (or `dispatch_land` MCP tool) — DO NOT hand-merge.
