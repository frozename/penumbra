# Daemon test failure triage — 2026-05-19 pm

Total at HEAD bca8c88: **852 pass / 60 fail / 54 errors** across 912 tests (134 files).

The 54 "errors" are all `RangeError: Cannot use a closed database` unhandled rejections from
background timers that outlive test teardown (see Category C). They don't map 1:1 to failures;
they are counted separately by bun.

## Summary

- A (env-dependent, skip-gateable): **0**
- B (real regressions): **41**
- C (pre-existing flake / bleed): **≥19** (confirmed 13 via isolation runs; 6 inferred)

## Root-cause buckets

### B1 — `PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID=1` set in test runner env (29 tests)

Every test that calls `chainStartInternal` or `chainsStartRoute` without a `project_id` field
fails with `{ error: "project_id_required" }`. The route reads `process.env` directly; the test
helpers pass `env: {}` to `buildServices` but that doesn't affect `process.env`. The env var is
set in the live shell (confirmed: `echo $PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID` = `1`).

**Debug confirmation:**  
Running a minimal debug script inline returned `Status: 400, Body: { error: "project_id_required" }`.

Affected files and counts:
- `routes/chains-task-class.test.ts` — 4 tests (accepts missing + 3 forwards)
- `routes/chain-start-recursion.test.ts` — 6 tests
- `routes/chain-start-pressure-cap.test.ts` — 13 tests (all `startChain` calls pass `project_id: null`)
- `routes/chain-start-budget.test.ts` — 1 test
- `routes/chains-auto-recall.test.ts` — 3 tests
- `routes/worktrees.test.ts` — 2 tests

**Fix:** add `delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID` in each file's
`beforeAll` / `beforeEach`, or add an integration test variant that sets `project_id`.

---

### B2 — Scalar `pressure_caps` format no longer valid in `buildProviderCaps` (5 tests)

`bounds-tracker-pressure.test.ts` seeds pressure quotas as `pressure_caps: { seven_day: 95 }`
(plain scalar). `buildProviderCaps` (via `createBoundsCallbacks`) spreads this directly into
`entry.default`, producing `{ seven_day: 95 }`. Then `checkPressureCap` reads `cap.refuse`
which is `undefined` on a number. `96 >= undefined` is `false`, so the pressure check never
trips; the wall-clock bound wins instead.

- `subscription maestro at 96% on seven_day trips pressure_capped:over_threshold`
  → Expected `pressure_capped:over_threshold`, Received `bounds_exceeded:wall_clock`
- `stale_warm pressure trips terminate with pressure_capped:stale_warm`
  → Expected `pressure_capped:stale_warm`, Received `bounds_exceeded:wall_clock`
- `pressure trip writes t0 event with tracker_tick trigger`
  → Expected `subscription_provider: "anthropic"`, Received `undefined`
- `pressure trip preempts wall-clock termination` — same
- `pressure trip fires every tick even when wall-clock/cost/sub_dispatches are healthy` — same

The `ProviderQuotaWithPressureCaps` type in the test file was updated to `{ warn, refuse }`
objects, but the test *values* still pass scalars (TypeScript missed due to `as any` cast).

**Suspect commit:** `a67acf3 feat(core/daemon): per-model pressure_caps with default fallback`
(last commit to modify `bounds-tracker-pressure.test.ts` and `build-provider-caps.ts`).

**Fix:** change all test data from `pressure_caps: { seven_day: 95 }` to
`pressure_caps: { seven_day: { warn: null, refuse: 95 } }`.

---

### B3 — t2-promotion judge pool fails when agentchat.yaml has zero agents (5 tests)

Tests in `t2-promotion.test.ts` seed a temporary agentchat.yaml with no agents. After
`2802b54 feat(t2-promotion): pool-of-judges sourced from agentchat.yaml`, the worker calls
`createJudgePoolFromAgentchat` which validates the config (zod: `agents: Too small: expected
array to have >=1 items`). The judge pool fails to load; subsequent LLM mock calls are never
reached; `callCount` stays at 0 instead of 1.

Log evidence: `agentchat config invalid: agents: Too small: expected array to have >=1 items`

Affected:
- `t2 promotion worker short-circuits the cycle when judge is unreachable`
- `t2 promotion worker skips on LLM failure but retries next tick`
- `t2 promotion worker promotes eligible rollups`
- `t2 promotion worker fails on malformed LLM response and increments counter`
- `t2 promotion worker re-reads MEMORY_PROMOTION_MIN_EVENTS per tick`

**Suspect commit:** `2802b54 feat(t2-promotion): pool-of-judges sourced from agentchat.yaml`
(changed judge pool from inline mock to agentchat.yaml-driven; test fixtures not updated).

**Fix:** update test fixtures to seed a minimal valid agentchat.yaml with at least one agent,
or provide a mock `createJudgePoolFromAgentchat` that bypasses the yaml validation.

---

### B4 — `serve-on-stop`: `stop()` is now async but test doesn't await it (1 test)

`serve.ts` declares `stop(): Promise<void>` (line 178). The `onStop` callback is invoked
inside that async function. The test calls `handle.stop()` synchronously (no await) inside a
non-async test function, so the callback never fires before the assertion runs.

```
expect(callCount).toBe(1);  // callCount is still 0
```

**Suspect commit:** `7c15610 feat(daemon-sweepers): add periodic reconciler sweep for orphan PRs`
(adds more async sweepers to the stop sequence, or was an earlier commit that made stop async).

**Fix:** convert the test to `async` and add `await handle.stop()`.

---

### B5 — `worker-manager-http`: `null ?? readWorkerUrl()` bypasses explicit `null` (1 test)

`createHttpWorkerManager` at line 15 of `worker-manager-http.ts`:
```typescript
const workerUrl = deps.workerUrl ?? process.env.PENUMBRA_WORKER_URL ?? readWorkerUrl();
```
When `deps.workerUrl = null`, `null ?? X` evaluates `X` (null coalescing falls through on null).
`readWorkerUrl()` reads the live port file (`.penumbra/worker.port`). Since the real daemon is
running, the port file exists and returns a URL. `lookupSession` returns a real session object
instead of null.

Expected: `null`. Received: `{ adapter: "remote-worker", inject: [AsyncFunction] }`.

**Suspect commit:** `3239518 feat(maestro): honor worker URL env override`
(added the env var + file fallback chain but didn't distinguish `null` from `undefined`).

**Fix:** use `deps.workerUrl !== undefined ? deps.workerUrl : (process.env.PENUMBRA_WORKER_URL ?? readWorkerUrl())`
so explicit `null` short-circuits the lookup.

---

### C — Closed-DB bleed from background timers (≥19 tests)

`createBoundsTracker` schedules a `setInterval`. The in-process supervisor
(`packages/core/src/supervisor/in-process.ts`) also runs `handoff-sweeper` and `t0-retention`
workers on intervals. When a test completes and closes its `:memory:` database, these background
intervals keep firing, throwing `RangeError: Cannot use a closed database`. Bun reports these as
`# Unhandled error between tests` and attributes them to the next test that runs.

This causes tests that are **completely correct in isolation** to appear as failures in the full
`bun test packages/daemon/test/` run.

**Confirmed passing in isolation:**
- `services/shell-session-pool.test.ts` — 6 tests (13 pass / 0 fail alone)
- `routes/shell.test.ts` — 2 tests (11 pass / 0 fail alone)
- `routes/dispatch-land.test.ts` — 3 tests (12 pass / 0 fail alone)
- `reactors/orchestrate-reactor.test.ts` + `maestro/bounds-tracker-long-lived.test.ts` — 2 tests (11 pass / 0 fail alone)

**Inferred passing in isolation (same bleed pattern; not individually verified):**
- `routes/plans.test.ts` — 1 test
- `routes/maestro.test.ts` — 1 test (adhoc session)
- `sweepers/gh-task-sync.test.ts` — 1 test
- `maestro/bounds-callbacks.test.ts` — 1 test
- `maestro/bounds-callbacks-pressure.test.ts` — 1 test

**Source of the bleed:** The test in `handoff-sweeper.test.ts` starts a daemon (which registers
in-process sweeper intervals). After the test teardown closes the DB, the sweepers keep running
and fail every tick. The `bounds-tracker` in many tests does the same.

**Fix:** `createBoundsTracker` and the in-process supervisor need a `stop()` / cleanup path
that tests can call in `afterEach`. A simpler guard: add `try/catch` in the sweeper tick to
suppress closed-DB errors silently (the sweeper is shutting down anyway).

---

## Per-test triage

| Test | File:Line | Cat | Root cause / suspect commit | Next step |
|---|---|---|---|---|
| POST /chains/start accepts missing task_class | chains-task-class.test.ts:32 | B1 | `PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID=1` | delete env var in beforeAll |
| POST /chains/start forwards task_class=BOUNDARY/STANDARD/TRIVIAL | chains-task-class.test.ts:42 | B1 | same | same |
| chain.start without parent_handoff_id passes recursion guard | chain-start-recursion.test.ts:54 | B1 | same | same |
| chain.start with parent at depth 6/7, PENUMBRA_RECURSION_DEPTH_CAP, unknown parent, persists parent | chain-start-recursion.test.ts:60–114 | B1 | same | same |
| no parent_handoff_id skips pressure gate / maestro trips / sub-agent trips / fallbacks / stale_warm (×13) | chain-start-pressure-cap.test.ts:246–934 | B1 | same | same |
| POST /chains/start returns 429 BudgetExceeded | chain-start-budget.test.ts:? | B1 | same | same |
| POST /chains/start with TRIVIAL / skips auto recall / legacy mode (×3) | chains-auto-recall.test.ts:87–215 | B1 | same | same |
| chain.start respects use_worktree: false/true | routes/worktrees.test.ts:138/162 | B1 | same | same |
| subscription maestro at 96% trips over_threshold | bounds-tracker-pressure.test.ts:244 | B2 | scalar cap, `a67acf3` | fix test data to `{ warn: null, refuse: 95 }` |
| stale_warm pressure trips | bounds-tracker-pressure.test.ts:321 | B2 | same | same |
| pressure trip writes t0 event with tracker_tick trigger | bounds-tracker-pressure.test.ts:346 | B2 | same | same |
| pressure trip preempts wall-clock termination | bounds-tracker-pressure.test.ts:403 | B2 | same | same |
| pressure trip fires every tick | bounds-tracker-pressure.test.ts:431 | B2 | same | same |
| t2 promotion worker short-circuits when judge unreachable | t2-promotion.test.ts:427 | B3 | empty agentchat.yaml, `2802b54` | seed valid agentchat.yaml in fixtures |
| t2 promotion worker skips on LLM failure | t2-promotion.test.ts:465 | B3 | same | same |
| t2 promotion worker promotes eligible rollups | t2-promotion.test.ts:511 | B3 | same | same |
| t2 promotion worker fails on malformed LLM response | t2-promotion.test.ts:588 | B3 | same | same |
| t2 promotion worker re-reads MEMORY_PROMOTION_MIN_EVENTS | t2-promotion.test.ts:665 | B3 | same | same |
| onStop callback is invoked exactly once | serve-on-stop.test.ts:12 | B4 | stop() is async, not awaited, `7c15610` | make test async + await stop() |
| HTTP worker manager returns null when no URL configured | worker-manager-http.test.ts:62 | B5 | `null ?? readWorkerUrl()`, `3239518` | guard null vs undefined in impl |
| ShellSessionPool > serializes concurrent / timeout / truncates / redacts / closeSession / reapHandoff | services/shell-session-pool.test.ts | C | closed-DB bleed from prior test | passes in isolation; fix sweeper teardown |
| shell routes > POST /shell/run creates / reuses session | routes/shell.test.ts | C | same bleed | passes in isolation |
| dispatchLandRoute > ff-only merge / merge_conflict / teardownWorktree | routes/dispatch-land.test.ts | C | same bleed | passes in isolation |
| unknown agent in allow_agents / non-orchestrate task is ignored | reactors/orchestrate-reactor.test.ts | C | same bleed | passes in isolation |
| GET /plans/:plan_id hydrates bound task_id_in_board | routes/plans.test.ts | C | same bleed (inferred) | run in isolation to confirm |
| POST /maestro/sessions/adhoc falls back when project_id omitted | routes/maestro.test.ts | C | same bleed (inferred) | run in isolation to confirm |
| syncLinkedTask uses per-task in-memory lock | sweepers/gh-task-sync.test.ts | C | same bleed (inferred) | run in isolation to confirm |
| async liveness predicate is awaited | maestro/bounds-callbacks.test.ts | C | same bleed (inferred) | run in isolation to confirm |
| scheduled sweeper skips overlapping ticks | maestro/bounds-callbacks-pressure.test.ts | C | same bleed (inferred) | run in isolation to confirm |

## Highest-leverage next actions

1. **B1 — env var cleanup (29 tests, 1 commit)**  
   Add `beforeAll(() => { delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID; })`
   to the 6 route test files that call `chainsStartRoute`/`chainStartInternal` without
   `project_id`. Zero source changes needed; all 29 tests should recover.

2. **C — sweeper teardown (≥13 tests, 1 architectural fix)**  
   `createBoundsTracker` and the in-process supervisor need a `stop()` that tests can call in
   `afterEach` to cancel intervals before DB teardown. Alternatively, add a check in each
   sweeper tick to detect a closed DB and abort silently. Fixing this recovers ≥13 tests that
   currently require isolation to pass.

3. **B2 — pressure_caps test data (5 tests, 1 commit)**  
   Update all `pressure_caps: { window: <number> }` literals in
   `bounds-tracker-pressure.test.ts` to `{ window: { warn: null, refuse: <number> } }`.

4. **B3 — t2-promotion fixture (5 tests, test setup update)**  
   Provide a minimal valid agentchat.yaml (with ≥1 agent) in the t2-promotion test setup,
   or inject a pre-built judge pool mock to bypass yaml validation.

5. **B4+B5 — targeted fixes (2 tests)**  
   - `serve-on-stop.test.ts`: `async` test + `await handle.stop()`  
   - `worker-manager-http.ts`: distinguish explicit `null` from `undefined` in `workerUrl` lookup

## Sampling caveats

- The inferred Category C tests (plans, maestro-adhoc, gh-task-sync, bounds-callbacks, bounds-callbacks-pressure) were NOT run in isolation to confirm; classification is based on the identical closed-DB stack trace pattern. Run each individually to verify.
- The `routes/maestro.test.ts` adhoc test might also be B1 (project_id_required), not C — it mentions "explicit project_id is omitted" in its name. This warrants manual inspection.
- The 54 unhandled errors count may not be reproducible exactly (timer-driven race); exact count can vary between runs.
