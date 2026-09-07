# penumbra — workflows & dispatch/invocation review

Scope: `packages/workflows`, `packages/daemon` (workflow routes, workflow-run registry, chains, sweepers), `packages/mcp` (workflow_run, chain_*, dispatch_land, daemon client), `packages/agentchat` worker dispatcher, `plugin/workflows`, `.claude/workflows`, `.github/workflows/check.yml`. Read-only; no files changed.

Verification run: `bun test packages/workflows/ plugin/workflows/ packages/daemon/test/workflows` → 531 pass / 0 fail (66 files). `bun test packages/agentchat/test/worker/dispatcher.test.ts` → 45 pass / 0 fail.

Overall verdict: the runtime is in good shape — fail-closed preflights for unsupported gates/outputs (`packages/workflows/src/exec.ts`), duplicate-name rejection in the registry, spill-to-disk for big run payloads, a well-structured worker dispatcher with bounded retry/cancel state, and solid test volume. The problems below are mostly at the seams: things that silently downgrade a failure into a success, unbounded waits/scans, and duplicated orchestration logic that has already started to drift.

---

## 1. Correctness

### 1.1 Aborted dispatch is recorded as `completed` (worker dispatcher)
`packages/agentchat/src/worker/dispatcher.ts:973-1006` — `finalizeDispatch` only routes to `markFailed` when `outcome.status === "error"`. An `"aborted"` outcome (`classifyResult` :890-893, `handleDispatchException` :915) falls through to `deps.complete(handoff_id)`. When the abort originates from the daemon's cancel route the daemon row is already terminal and `complete` gets a 409 — fine. But `shutdown.ts:38-39` calls `dispatcher.stop()` (aborts every active dispatch) then `idle()`, so on a worker restart/kickstart every in-flight hop is marked **completed** on the daemon with no result text. That is exactly the "silent success" class the codebase otherwise fights hard against. The only test on this path (`test/worker/dispatcher.test.ts:492-528`) asserts the `dispatch.end` meta but not which terminal call was made.
Fix: treat `"aborted"` like `"error"` (call `markFailed(id, "aborted: …")`), or add a dedicated cancel endpoint call; add an assertion that `complete` is never called for aborted outcomes.

### 1.2 Retry loop ignores the abort signal
`packages/agentchat/src/cli/dispatch-handoff.ts:192-214` — `runTurnWithRetry` retries up to 3× (200/400/800 ms) on any thrown error without checking `opts.signal?.aborted`. After a cancel, a turn that throws on abort gets re-run (potentially re-spawning the agent) and finally lands in `handleRetryExhaustion` → `markFailed(id, "<abort message>")` with `terminatedReason: "error"`, so a deliberate cancel surfaces as an adapter error. Fix: bail out of the loop when the signal is aborted and return a distinct reason.

### 1.3 Unknown `project_id` is dropped and the request still succeeds
`packages/daemon/src/routes/chains.ts:1026-1034` — logs `unknown_project_id; dropping and continuing`, sets `project_id = undefined`, returns 200. Work then lands in default/no scope while the caller believes it was scoped. Locked in by `test/routes/chains.test.ts:1407-1433`. Given the effort spent on `PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID`, this should be a 4xx `unknown_project`.

### 1.4 Response-schema failure downgraded to HTTP 200
`packages/daemon/src/routes/chains.ts:1350-1360` — `ChainStartResponseSchema.parse` failure is logged and the unparsed body returned as success. Contract violations reach MCP clients as normal responses. Return a structured 5xx instead; no test covers this branch.

### 1.5 Workflow `cwd` defaults to the daemon process cwd
`packages/daemon/src/routes/workflows.ts` `prepareWorkflowRun` → `cwd: body.cwd ?? process.cwd()`; `packages/mcp/src/tools/workflow-run.ts` documents the trap and only hard-fails when `PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID` is set (otherwise emits `workflow_cwd_inferred_from_mcp_cwd`). Without the env flag a cross-repo caller silently runs recall/gates against the daemon's WorkingDirectory. Recommend making the daemon route itself reject a missing `cwd` (400) rather than relying on the MCP shim + env var.

### 1.6 Deferred-orchestration resume is not atomic
`packages/daemon/src/sweepers/orchestrate-deferral.ts:35-84` — selects eligible `orchestrate_deferred` rows, then later inserts `orchestrate_resumed`, with no claim/unique guard. Overlapping ticks or two daemons can double-resume/double-publish a task. Needs a conditional insert (e.g. `INSERT … WHERE NOT EXISTS` in the same transaction) plus a two-overlapping-sweeps test.

### 1.7 Smaller ones
- `.claude/workflows/penumbra-token-opt-migrate.js:180-185` instructs `dispatch_land(..., rebase=true)`; `packages/mcp/src/tools/dispatch-land.ts:5-43` has no `rebase` field (the batch script at `penumbra-token-opt-batch.js:213-218` already says so). Stale script → invalid tool input at land time.
- `plugin/workflows/session-memory-sweep/workflow.ts:433-437` — `approvedCandidate` is prepended *after* slicing, so output can hold `max_candidates + 1`.
- `packages/workflows/src/poller.ts` `defaultGitLogSinceCounter` returns `Number.MAX_SAFE_INTEGER` when `git log` fails, which makes every `commits_since_last_handoff >` threshold fire on a non-git cwd / git error. Returning `null` and skipping the metric would be safer.

## 2. Reliability / performance

- **No request deadlines in the MCP daemon client.** `packages/mcp/src/daemon-client.ts:1138-1164` (`get`/`post`) call `fetch` with no `AbortSignal`. `chain-wait.ts:69-99` and `dispatch_land` polling (`daemon-client.ts:567-601`) measure elapsed time only *between* awaits, so one hung connection blocks past `timeout_ms` indefinitely. `dispatch_land` also polls at a fixed 200 ms with no backoff. Pass `AbortSignal.timeout(remaining)` per request; back off with jitter.
- **Workflow-wait polling.** `packages/daemon/src/services/workflow-runs-registry.ts` — every `waitForResult` waiter runs its own ≤100 ms SQLite poll; N concurrent `workflow_wait` callers = 10·N queries/s. An in-process resolver map (resolve waiters directly when `persist` completes, keep the DB poll only as a fallback) would remove almost all of it. Orphan spill cleanup also does one `SELECT id FROM workflow_runs WHERE id = ?` per spill file; a single `IN (...)` or a JOIN against `readdir` output is enough.
- **Auto-recall timeout doesn't cancel.** `chains.ts:1124-1165` races `autoRecallForDispatch` against a timer but never aborts it; timed-out recall keeps consuming vector/DB work.
- **Unbounded sweeper scans.** `sweepers/stale-handoff.ts:125-172` selects all old dispatched handoffs (no `LIMIT`), does one `handoffReader.get()` per row, then loads all `dispatch_events` for all candidates with no time bound. `workers/handoff-sweeper.ts:55-107` similarly processes the whole result set in one transaction. Bound per-tick batches and the event window.
- **Two sweepers compete for the same rows with different verdicts.** `stale-handoff` → `failed` (`:199-233`) vs `handoff-sweeper` → `expired` (`:88-107`), both started from `serve.ts:1691-1694` / `:1875-1885`; final status depends on which conditional UPDATE wins. Pick one owner or one shared transition.
- **State-threshold trigger sweeper.** `sweepers/workflow-trigger.ts` — cooldown is in-memory only (`lastFired` Map), so a daemon restart re-fires every matched workflow immediately; the 60 s timer has no overlap guard, so a slow `runWorkflow` (which awaits recall + execution inline) can overlap the next tick. `poller.ts` `computeStateMetrics` also shells out to `git log` synchronously and reads the transcript every tick. Persist `lastFired` (a `workflow.outcome` T0 lookup is enough) and skip a tick while one is running.
- **Lifecycle triggers run serially and are lexicographically ordered.** `routes/workflows.ts` `workflowsTriggerRoute` sorts matched specs by name and awaits each; the `session-handoff` → `session-handoff-draft` dependency is only guaranteed by alphabetical accident (comment in the file). A `session_end` with several matched workflows pays the sum of their latencies on the hook path. Make the ordering explicit (`after:` in the spec or a fixed priority list) and run independent specs concurrently.
- **`workflow.history` full-scans JSON.** `json_extract(payload_json,'$.workflow_name') = ?` over `t0_events` with only `t0_by_type_ts` to narrow — fine today, linear in `workflow.outcome` volume. Add a generated column/index or write `workflow_name` to a column.
- **Plugin workflow timeouts are per-dispatch, not per-run.** `adversarial-plan/workflow.ts:44-53,423-431,517-526` and `adversarial-review/workflow.ts:54-64,936-945,1086-1128` reuse the same 30 min for every persona wait, synthesis wait, and up to 3 synthesis retries — a run can run several multiples of its advertised timeout. Thread a run-level deadline.
- **CI.** `.github/workflows/check.yml:18-30` — no Bun/`node_modules` cache and a fresh `apt-get` every run under a 25 min job timeout.

## 3. Maintainability / duplication

- Threshold policy duplicated in `sweepers/stale-handoff-thresholds.ts` and `workers/handoff-sweeper-thresholds.ts` and already diverging (`implement_substantial` 90 vs 60; `implement_small` 60 vs 30 — AGENTS.md calls the latter intentional, nothing enforces the former). Centralize with named variants + a test that pins intentional differences.
- `adversarial-plan` and `adversarial-review` each implement the full persona fan-out / result persistence / worker-unavailable retry / synthesis loop (`plan:407-468,510-537`; `review:915-1000,1048-1130`; review is 1226 lines). Extract a shared fan-out primitive in `plugin/workflows/_shared`.
- `.claude/workflows/penumbra-fanout.js:270-294`, `penumbra-token-opt-migrate.js:90-115`, `penumbra-token-opt-batch.js:144-151` still hand-roll `chain_start → chain_wait → chain_get_response`, which AGENTS.md itself says to avoid; `adversarial-review.js` and `penumbra-review-sweep.js` already delegate to `workflow_run` and are the model to follow. The stale `rebase=true` (1.7) is the concrete cost of this duplication.
- `packages/daemon/src/routes/workflows.ts` (1538 lines) and `routes/chains.ts` (~2700 lines) are on the legacy allowlist; the trigger route, run/wait routes, and suggest logic are natural split points.
- `exec.ts` schema allows `commit`/`dispatch` output kinds that the executor then rejects at preflight. Either implement them or drop them from `OutputSinkKind` so the schema is the source of truth.

## 4. Test gaps (highest value first)

1. Dispatcher: aborted outcome must not call `complete` (1.1); retry loop stops on abort (1.2).
2. `chain_wait` / `dispatch_land`: a `fetch` that never resolves still returns within `timeout_ms`.
3. `buildChainStartResponse` schema-failure branch returns a non-2xx.
4. Two overlapping `orchestrate-deferral` sweeps → exactly one `orchestrate_resumed`.
5. Stale-handoff / handoff-sweeper bounded batch size with a large backlog.
6. Trigger sweeper: no re-fire after simulated restart; no overlapping ticks.
7. `workflow.run` with omitted `cwd` from a foreign repo (asserting rejection once 1.5 is fixed).

## Suggested order of attack
1.1 + 1.2 (one small PR in `agentchat`, high impact on reliability data), then 1.3/1.4 (chains fail-closed), then MCP client request deadlines, then trigger-sweeper persistence/overlap guard, then the sweeper/threshold consolidation and the plugin fan-out extraction as a refactor pass.
