All key claims verified against the actual code. The line numbers and mechanisms hold:
- `agentchat-worker.ts:1371-1372` — only SIGINT/SIGTERM, no global crash guard ✓
- `agentchat-worker.ts:1248-1251` — shared `local-state-cursors.json`, `cursorPath` passed to `startUsagePoller` ✓
- `poller.ts:28` — fixed `${cursorPath}.tmp` suffix, `renameSync` at :30 ✓
- supervisor backoff `1s→60s` cap, `STABLE_WORKER_LIFETIME_MS=120_000`, reset only if alive ≥120s ✓
- `chains.ts:90/99` — sole 503 path is `hasActiveWorker` aggregate guard (default 15000ms); `createApproved` at :841 unconditional ✓
- `dispatcher.ts:113-114` — `acquireConvLock` BEFORE `acquireSemaphore`; waiters[] unbounded at :87; `claim` at :133 ✓
- `orphan-handoff-recovery.ts:141` → `handoff.ts:260-263` requeue to `status='approved', worker_id=NULL` ✓
- `acp-server.ts:146` spawn (no `detached`), kills single pid at :175/:192 vs `stdio-acp-server.ts:50/85` detached+group-kill ✓
- `watchdog.ts:22` stale default 90000ms, tick requeues at :62 ✓

Now writing the synthesized plan.

# Synthesized Fix Plan — Daemon Worker-Subsystem Wedge

This plan merges five persona plans (architect, simplifier, test-first, risk, integration) into one ordered, TDD-driven, additive, reversible fix sequence for the recurring daemon wedge that only manifests after hours of sustained long-dispatch load and is cleared only by `launchctl kickstart`.

All five personas converged on the same apex root cause and the same hard ordering invariant; the disagreements were over scope (how far to go on admission control) and naming. Those are resolved explicitly inline.

---

## 1. Ranked root causes

| # | Root cause | Confidence | One-line mechanism |
|---|-----------|-----------|-------------------|
| **RC-1** | Worker exits clean `code:1` / no-signal with **no global `unhandledRejection`/`uncaughtException` guard** | **HIGH** | `agentchat-worker.ts:1371-1372` registers only `SIGINT`/`SIGTERM`; any rejection from the ~15 fire-and-forget async subsystems (SSE pump, usage-poller `setInterval`, heartbeat, notification scheduler, control listener) terminates Bun with exit 1, and the fatal line is never captured because the crash predates pino flush. All 55 crashes are `code:1` with no signal; **zero** OOM/SIGKILL/EMFILE/heap lines in either log → it is an uncaught async error, not a resource kill. |
| **RC-2** | **Shared `local-state-cursors.json` multi-writer rename race** | **MEDIUM** (load-correlated trigger; not yet proven fatal) | All 5 workers run `startUsagePoller` against the *same* `cursorPath` (`agentchat-worker.ts:1251`) and persist via `writeFileSync(\`${cursorPath}.tmp\`)` + `renameSync` with a **process-shared `.tmp` suffix** (`poller.ts:28-30`). Concurrent `renameSync` races to ENOENT → 16,977 `usage-poller: reader failed` lines in penumbra-1.log alone. `runOnce` catches per-reader so it is not *directly* fatal, but it is the strongest load-correlated contention signal and a plausible unguarded-rejection source on the un-`try/catch`'d `persist()` path. Worsens with more workers. |
| **RC-3** | **Watchdog requeue with no backpressure = cascade amplifier** | **MEDIUM/HIGH** | `watchdog.ts:62` tick → `orphanHandoffRecovery.runOnce(workerId)` → `handoff.ts:260-263` `requeueOrphanedDispatch` flips dead worker's `dispatched` rows to `status='approved', worker_id=NULL` (batchSize 100, `orphan-handoff-recovery.ts:46/141`) with **zero survivor-capacity awareness**, dumping a dead worker's in-flight long-dispatches onto already-stretched survivors during the 60s restart window → pushes survivors toward the same crash. This is the mechanism that turns one crash into a 2-worker storm. |
| **RC-4** | **No admission control on `chain_start`; unbounded worker waiter queue** | **HIGH** (real unbounded growth; UNCONFIRMED as the wedge) | `chainStartInternal` calls `createApproved` (`chains.ts:841`) and returns; no max-in-flight bound. The only limit is a worker-side semaphore with an **unbounded `semaphoreWaiters[]`** (`dispatcher.ts:79/87`), and crucially `acquireConvLock` (`:113`) runs **before** `acquireSemaphore` (`:114`) which runs before `claim` (`:133`) — so a saturated worker holds queued handoffs as pending Promises each **pinning a `convLock`**, claiming none. Under the 117-dispatch bench this pileup is unbounded. |
| **RC-5** | **opencode-acp orphans MCP grandchildren on cancel/timeout** | **MEDIUM** (real bug; latent for *this* wedge) | `acp-server.ts:146` spawns opencode **without `detached`** and kills only the direct pid (`:175/:192`), unlike `stdio-acp-server.ts:50/85` (detached + `process.kill(-child.pid)` group kill). On cancel/timeout/worker-death opencode's MCP grandchildren orphan. At concurrency 16 this raises orphan probability — but no fd/proc accumulation was observed on the healthy tree, so it is **not** the observed wedge. |
| **RC-6** | **ha-mcp Python `_enter_buffered_busy` fatal is benign cron teardown noise** | **HIGH (as a NON-cause)** | Traced by 3 of 4 axes to the `home-mgmt` long-lived canary's FastMCP `ha-mcp` server (spawned via `mcp-allowlist-proxy.ts` → `uvx ha-mcp`) hitting its second-signal `sys.exit(1)` branch while its stdin reader thread holds the `BufferedReader` lock. 15 fatals / 212 cron restarts (~7%), `*/10` cadence, **uncorrelated with code dispatches**. There is **zero Python in the ACP dispatch path** (`find` → only `./patch.py`). |

### Is the "chain_start 503 storm" real? — **REFUTED.**

The chain-admission investigation is conclusive: across 50M `out.log` + 2.1M `err.log` there are **0** `no_worker_registered` events, **0** daemon-internal 503s, and only **2** literal `503 Service Unavailable` lines — both weeks-old GitHub GraphQL API 503s from `gh issue view` task-sync (2026-05-22), unrelated to `chain_start`. The handoff note's "503 storm" matched `.503Z` timestamp milliseconds, exactly as the maestro suspected. There is exactly **one** 503 path in the whole chain-admission surface: `workerHeartbeatGuard` (`chains.ts:87-101`), which fires only when `hasActiveWorker(15000)` is false — an aggregate "no worker heartbeated in 15s" check, not per-handoff capacity. During the storm, survivors (omlx-1, shared-1, penumbra-2) kept heartbeating, so it never fired. **Do not build any fix for a 503 storm.** Likewise, **do not** harden ACP stdio transport for the Python fatal (RC-6) as a wedge fix.

---

## 2. Reproducing the wedge (build this FIRST — Phase 0)

Per the test-first lens, no fix is provable until the storm is deterministically reproducible. Build a **two-layer repro harness** before touching production code:

**(a) Supervisor-level characterization harness** — `packages/daemon/test/workers/crash-storm-repro.test.ts`
Reuse the `FakeSubprocess` / `createSupervisor` patterns already in `extra-worker-supervisor.test.ts`. With `vi.useFakeTimers()`, spawn one extra worker, then loop: `proc.exit(1)` (no signal) → `flushPromises` → advance the scheduled restart delay → capture the next spawn delay. Assert the captured `delay_ms` sequence equals `[1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]` (re-crash always within `STABLE_WORKER_LIFETIME_MS=120_000`, so `restartCount` never resets and the delay pins at the `MAX_RESTART_DELAY_MS=60_000` cap). **This PASSES against current code** — it is a characterization baseline that locks in today's storm behavior so later phases can prove they changed it. (Resolves the "flat 60s delay" misframing: the backoff *is* exponential; it pins at the cap because every restart re-crashes inside the stability window.)

**(b) Worker-level unguarded-rejection repro** — `packages/agentchat/test/worker/unguarded-rejection-repro.test.ts` + helper `packages/agentchat/test/helpers/spawn-worker-subprocess.ts`
Spawn a one-shot `bun` subprocess booting a minimal subsystem that floats `Promise.reject(new Error('boom'))`; assert `exit code === 1` and **no captured fatal line on stderr**. This is the RED that documents RC-1 and that Phase 1 must flip. Assert only on single-token outputs (final exit code/signal), never on timing, to avoid CI flakiness (per the anti-fabrication "verify with single-token outputs" rule).

**(c) End-to-end load repro (validation gate, used in Phases 7+)** — the real `bench-acp.ts` 117-dispatch run under sustained load (must pass `project_id` per the prior bench-acp incident), with `err.log` capture of the now-instrumented crash stack and `out.log` capture of `extra_worker_crashed` counts and `restartCount` resets.

---

## 3. Phased fix plan

**Hard ordering invariant (from the integration lens — non-negotiable):** (1) Make the crash *survivable AND observable* first. (2) Remove the multi-writer race, gate the requeue cascade, and add admission control. (3) ONLY THEN touch any capacity/concurrency lever — `penumbra-2` removal is reserved as the final A/B arm so it cannot confound attribution. Landing `penumbra-2` removal or the per-worker cursor fix *before* Phase 1 would drop the crash rate and cause us to credit the wrong fix, leaving the true trigger latent to re-wedge once capacity is restored.

All flags default to **today's behavior** (off / exit-after-log) unless stated. Every phase is additive and reverts by unsetting one env var or a single-commit revert.

---

### Phase 0 — Repro harness (no fix, RED + characterization scaffolding)
- **Goal:** Make every later fix provable. Build harnesses (a) and (b) from §2.
- **Failing/characterization test:** As in §2(a) (passes today, baseline) and §2(b) (RED today).
- **Change:** Test files + `spawn-worker-subprocess.ts` helper only. No production code.
- **Files:** `packages/daemon/test/workers/crash-storm-repro.test.ts`, `packages/agentchat/test/worker/unguarded-rejection-repro.test.ts`, `packages/agentchat/test/helpers/spawn-worker-subprocess.ts`
- **Reversible:** yes — `git rm` the three files.
- **Rollback:** delete test files; no production code touched.
- **Risk:** Low (test-only). Subprocess repro could be timing-flaky → assert only on single-token exit code.

---

### Phase 1 — Capture-and-survive: global crash guard on the worker *(addresses RC-1; the keystone)*
- **Goal:** Stop the worker dying silently on unhandled rejections **and** capture the real fatal stack the per-worker log currently loses. Every later phase needs this captured stack to confirm its trigger; without it we tune against an unobserved crash.
- **Failing test:** Extend `unguarded-rejection-repro.test.ts`: (i) with the guard's default mode, firing `unhandledRejection`/`uncaughtException` writes a structured line matching `/worker[._]unhandled_rejection|worker_fatal/` to stderr **synchronously before exit** (assert the line is literally present); (ii) with `PENUMBRA_WORKER_CRASH_GUARD=survive`, an `unhandledRejection` is logged and the process stays alive (still alive after 200ms); (iii) `uncaughtException` **always** exits 1 (a corrupted stack is unsafe to continue past) — only stray rejected Promises are survivable. Fails today (no handler exists).
- **Change:** New `packages/agentchat/src/worker/crash-guard.ts` exporting `installGlobalCrashHandlers({log, flush})`, called once near the top of `agentchat-worker.ts` boot (next to lines 1371-1372), **before** the fire-and-forget subsystems start. Handlers log `{event:'worker_fatal', kind, err, stack}` and **synchronously flush** (pino sync transport, or `fs.writeSync`/`appendFileSync` fallback to the per-worker log fd so the line survives an abrupt exit). Default mode = `exit1-after-log` (preserves today's restart semantics but now *with* a captured stack); `PENUMBRA_WORKER_CRASH_GUARD=survive` opts into log-and-continue for `unhandledRejection` only.
  - **Resolved disagreement:** architect/test-first lean toward defaulting `survive` ON; risk/integration insist default OFF. **Resolution: default `exit1-after-log` (i.e. survive OFF).** Surviving a rejection can mask a genuinely broken worker; keep default fail-fast until Phase 1's logs *prove* the rejections are benign background noise (e.g. poller ENOENT). The daemon watchdog (90s) and any future supervisor liveness still recycle a zombie if `survive` is later enabled.
- **Files:** `packages/agentchat/bin/agentchat-worker.ts`, `packages/agentchat/src/worker/crash-guard.ts` (new), `packages/agentchat/test/worker/unguarded-rejection-repro.test.ts`
- **Reversible:** yes.
- **Rollback:** unset `PENUMBRA_WORKER_CRASH_GUARD` (reverts to exit-after-log) or remove the two `process.on` registrations; supervisor untouched → pure no-op.
- **Risk:** Lowest. Only nuance: the synchronous flush must not itself throw (guard in `try/catch`) and must actually flush before exit — the test asserts the line is literally on stderr, so a "hopeful" async-only flush fails the test.

---

### Phase 2 — Per-worker usage-poller cursor path *(addresses RC-2)*
- **Goal:** Eliminate the cross-process `renameSync` ENOENT race (16,977 lines), the leading load-correlated crash-trigger candidate, and confirm via Phase 1's now-captured stack whether the ENOENT path is the actual exit-1 trigger or a red herring.
- **Failing test:** `packages/agentchat/test/usage-readers/poller-concurrent-persist.test.ts`: start two pollers at the same `storageRoot` and race many interleaved `persist()`/`runOnce()` calls; assert at least one rename throws ENOENT **on current code** (reproduces the spam), then assert ZERO ENOENT once each writes a per-worker path. Add a no-double-emit assertion (see risk below).
- **Change:** Two minimal edits:
  1. `poller.ts:28` — make the tmp suffix unique per process: `` `${opts.cursorPath}.${process.pid}.tmp` `` (or `randomUUID()`), so concurrent renames can never consume each other's tmp even on a shared path. **Unconditional** (pure correctness, behavior-preserving for a single writer).
  2. `agentchat-worker.ts:1251` — `cursorPath: join(storageRoot, \`local-state-cursors.${workerId}.json\`)`, gated by `PENUMBRA_PER_WORKER_USAGE_CURSOR` (default ON; OFF restores shared path). `loadCursors` returns `{}` on missing file (`poller.ts:69`) so first run cold-starts harmlessly; optionally fall back to reading the legacy shared file once.
- **Files:** `packages/agentchat/src/usage-readers/poller.ts`, `packages/agentchat/bin/agentchat-worker.ts`, `packages/agentchat/test/usage-readers/poller-concurrent-persist.test.ts`
- **Reversible:** yes.
- **Rollback:** `PENUMBRA_PER_WORKER_USAGE_CURSOR=0` → shared path; legacy file still read so no cursor state lost. Edit (1) is strictly safer and needs no rollback.
- **Risk:** Low. **Double-count hazard** (risk lens): per-worker cursors mean two workers running the same reader could each emit a usage delta for the same upstream window. Mitigate by keying the cursor on `(workerId, reader.id)` and ensuring each `reader.id` is owned by exactly one worker, and dedupe downstream on `event_id`/`request_id` — the test must include the no-double-emit assertion. One-time cursor reset on rollout is acceptable (usage events are cosmetic for cost accounting, zero dispatch impact).

---

### Phase 3 — Load-aware / rate-limited watchdog requeue *(addresses RC-3, the cascade amplifier)*
- **Goal:** Stop the watchdog dumping a dead worker's in-flight long-dispatches onto saturated survivors. **Must land before any concurrency increase or backoff change** — more capacity without this just feeds a faster cascade.
- **Failing test:** `packages/daemon/test/services/orphan-recovery-backpressure.test.ts`: stage a stale worker with K dispatched orphans while survivors are near capacity (mock `hasActiveWorker` + a free-slot capacity probe = 0). With the flag ON, assert the requeue is **deferred / rate-limited to a bounded batch per tick** (rows left for the next 15s tick) rather than all K flipped to `approved` at once. With the flag OFF, assert today's unconditional requeue (all K) is unchanged. Fails today (`recoverForWorkerIds`, `orphan-handoff-recovery.ts:141`, requeues unconditionally up to batchSize 100).
- **Change:** In `recoverForWorkerIds`, before `requeueOrphanedDispatch`, consult a survivor-capacity signal (watchdog active-worker count + free-slot estimate, else a small constant like 5 per tick), gated by `PENUMBRA_ORPHAN_REQUEUE_BACKPRESSURE` (default OFF = byte-identical to today). Cap requeues per tick / skip-and-retry-next-tick when survivors are saturated. **Leave `requeueOrphanedDispatch` SQL (`handoff.ts:260-263`) and the exhaustion/`max_dispatch_attempts` path unchanged** — only timing/rate around it changes.
- **Files:** `packages/daemon/src/services/orphan-handoff-recovery.ts`, `packages/daemon/src/services/watchdog.ts`, `packages/daemon/test/services/orphan-recovery-backpressure.test.ts`
- **Reversible:** yes.
- **Rollback:** `PENUMBRA_ORPHAN_REQUEUE_BACKPRESSURE=0` → unconditional requeue restored. No schema change.
- **Risk:** **Highest blast radius of the code fixes** — mutates dispatch-lifecycle timing. A deferred requeue that never flushes would STRAND a handoff forever (worse than today's cascade), and it can race the stale-handoff sweeper (`stale-handoff.ts:76` sweeps only `status='dispatched'` — a deferred `dispatched` row could be double-handled). **Must** enforce an eventual-flush invariant (bound the deferral: after N ticks, requeue anyway or exhaust) and share its "free slots" notion with Phase 4 (see cross-cutting risks). Default OFF; enable only after Phases 1-2 cut crash frequency.

---

### Phase 4 — Bounded in-flight admission gate on `chain_start` *(addresses RC-4; precondition for any concurrency raise)*
- **Goal:** Cap simultaneously in-flight/approved handoffs so the 117-dispatch bench cannot grow the unbounded `semaphoreWaiters[]` (each pinning a `convLock`) without limit. Raising concurrency without this merely relocates the pileup.
- **Failing test:** `packages/daemon/test/routes/chain-start-admission.test.ts`: with `PENUMBRA_CHAIN_MAX_IN_FLIGHT=2` and 2 approved/dispatched handoffs present, a 3rd `chainStartInternal` returns a **distinct retryable backpressure response** (e.g. `{error:{code:'max_in_flight'}}` / 429 with retry hint — explicitly NOT the unrelated `no_worker_registered` 503) **without** writing an approved row, in-flight count unchanged. With the flag unset, assert unconditional admission (today). Fails today (`createApproved`, `chains.ts:841`, is unconditional).
- **Change:** Before `createApproved` (`chains.ts:841`), add a flag-gated (`PENUMBRA_CHAIN_MAX_IN_FLIGHT`, unset/0 = unlimited = today) admission check: a cheap indexed `COUNT` of non-terminal handoffs (`approved`+`dispatched`) **younger than a TTL** vs the bound; over the bound → return the distinct backpressure code. Wrap read+write in the existing transaction to avoid racing concurrent `createApproved`. Defense-in-depth (optional, same flag): cap `dispatcher.ts` `semaphoreWaiters[]` length — but check it at the right point so an overflow handoff is **not** claimed and does **not** hold a `convLock` (the `acquireConvLock` at `:113` precedes `acquireSemaphore` at `:114`), returning it unclaimed so first-writer-wins lets another worker pick it up.
  - **Resolved disagreement:** simplifier omits this phase as gold-plating; architect/test-first/integration include it. **Resolution: include it, but default OFF and ship Phases 0-3 first.** It is an amplifier, not an initiator — confirmed-real unbounded growth but UNCONFIRMED as the wedge. Land it as flag-gated insurance; do not enable in production until a wedged-run heap/Promise snapshot shows the pileup.
- **Files:** `packages/daemon/src/routes/chains.ts`, `packages/agentchat/src/worker/dispatcher.ts`, `packages/daemon/test/routes/chain-start-admission.test.ts`
- **Reversible:** yes.
- **Rollback:** unset `PENUMBRA_CHAIN_MAX_IN_FLIGHT` → unlimited admission.
- **Risk:** Medium. A too-low bound starves legitimate bursts (the bench itself); a bound counting `approved` rows stranded behind a crashed worker (no sweeper for `approved` — see open questions) could wedge admission permanently → mitigate with the TTL on the count. Return a **retryable** status (429) so the bench/`penumbra-client` backs off rather than fails; confirm `isTerminalHttpStatus` (`penumbra-client.ts`) treats it retryable.

---

### Phase 5 — opencode-acp process-group reaping parity *(addresses RC-5; orthogonal, low coupling)*
- **Goal:** Bring `acp-server.ts` to parity with `stdio-acp-server.ts` so cancelled/timed-out opencode dispatches reap their MCP grandchildren instead of orphaning them. Independent of the crash/cascade chain — can land any time after Phase 1.
- **Failing test:** `packages/agentchat/test/adapters/acp-server-process-group.test.ts`: spawn a fake `opencode` shim that itself spawns a long-lived grandchild (prints both pids); call `kill()`; assert **both** child and grandchild are dead (`process.kill(gpid, 0)` throws ESRCH) within a grace window. Fails today (`acp-server.ts:146` no `detached`, kills single pid at `:175/:192`, grandchild survives). Mirror the existing `stdio-acp-server` group-kill test as the template.
- **Change:** In `acp-server.ts`: add `detached: process.platform !== 'win32'` to the spawn options (`:146`) and replace `child.kill(SIGTERM/SIGKILL)` with a process-**group** kill `process.kill(-child.pid, signal)` (with the existing SIGTERM→SIGKILL escalation), mirroring `stdio-acp-server.ts:50/85` and guarding `if (!child.pid) return` exactly as the proven path does. Gated by `PENUMBRA_OPENCODE_GROUP_KILL` (default ON; OFF reverts to single-pid kill).
- **Files:** `packages/agentchat/src/adapters/acp-server.ts`, `packages/agentchat/test/adapters/acp-server-process-group.test.ts`
- **Reversible:** yes.
- **Rollback:** `PENUMBRA_OPENCODE_GROUP_KILL=0` → single-pid kill.
- **Risk:** Low-medium. Negative-pid kill could over-kill if pid handling is wrong → the test asserts the *grandchild* (not an unrelated proc) dies; only the freshly-spawned tree is targeted, identical to the proven stdio path. **Open question gating value:** confirm penumbra-1/-2 actually route to opencode-acp — if rarely used, impact is small (but the bug is still closed).

---

### Phase 6 — De-noise the benign ha-mcp double-signal fatal *(addresses RC-6; log hygiene, last)*
- **Goal:** Stop the cosmetic `_enter_buffered_busy` fatal polluting `err.log` on every ~10-min ha-mcp cron teardown so it stops looking like a smoking gun and real fatals stand out. **Lowest priority; do last or skip if out of scope.**
- **Failing test:** `packages/agentchat/test/mcp-allowlist-proxy-shutdown.test.ts`: drive the proxy SIGTERM handler against a fake child; assert it closes/ends the child's stdin **before** sending **exactly one** SIGTERM and does not double-forward. Fails today (`mcp-allowlist-proxy.ts:205` forwards SIGTERM unconditionally → group-delivered + forwarded double signal hits ha-mcp's force-exit branch).
- **Change:** In `mcp-allowlist-proxy.ts` SIGTERM/SIGINT handlers (`:205-206`): `child.stdin?.end()` first (so FastMCP's stdin reader thread unblocks cleanly), then a single SIGTERM with a short grace before SIGKILL, debounced so a second signal within the grace window is not re-forwarded. Gated by `PENUMBRA_PROXY_CLEAN_SHUTDOWN` (default ON; OFF = bare `child.kill`). **No change to ha-mcp itself** (separate `../ha-mcp` repo). Fallback if even this is out of scope: a log-filter, and drop the phase.
- **Files:** `packages/agentchat/src/mcp-allowlist-proxy.ts`, `packages/agentchat/test/mcp-allowlist-proxy-shutdown.test.ts`
- **Reversible:** yes.
- **Rollback:** `PENUMBRA_PROXY_CLEAN_SHUTDOWN=0` → bare `child.kill('SIGTERM')`.
- **Risk:** Very low. Draining stdin could hang if the child never closes → the short grace timeout escalates to SIGKILL. Zero coupling to Phases 1-5 (different subprocess, not in the dispatch path).

---

### Phase 7 — Validation A/B: remove penumbra-2 as the final lever
- **Goal:** Only AFTER the crash is survivable+captured (P1), the cursor race is gone (P2), the cascade is gated (P3), and admission is bounded (P4): run `bench-acp.ts` with penumbra-2 IN vs OUT to confirm any crash-rate drop is attributable to the code fixes, not just fewer processes — and verify the supervisor backoff now actually **resets** (delay returns to 1000ms after >120s stable life) because workers survive past the `STABLE_WORKER_LIFETIME_MS` window.
- **Failing/reference test:** End-to-end read-only assertion: under sustained load, assert (a) `extra_worker_crashed` count below threshold AND (b) at least one worker logs a `restartCount` reset (delay back to 1000ms). The pre-fix baseline (36/55 crashes at `delay_ms:60000`, pinned at cap) is the "failing" reference.
- **Change:** No code. Config only — remove penumbra-2 from `workers.yaml` as the **second** A/B arm, after the first arm (all fixes in, penumbra-2 still present) is measured.
- **Files:** `~/.config/penumbra/workers.yaml`, plus read-only inspection of `supervisor.ts`.
- **Reversible:** yes.
- **Rollback:** re-add penumbra-2 + `daemon_reload_config`.
- **Risk:** If penumbra-2 removal is applied before P2/P3, the fewer-processes effect is wrongly credited to the code fixes → ordering rule is the whole point.

---

## 4. Zero-code mitigation (apply immediately as a stop-gap)

These are the only changes safe to apply **before** the code fixes, with one caveat noted:

1. **Remove `penumbra-2` from `~/.config/penumbra/workers.yaml`** (16→8 penumbra concurrency, one fewer process racing the shared cursor file and host fds), then `mcp__penumbra__daemon_reload_config` (worker config hot-reloads after one kickstart — per memory). Trivially reversible.
   - **Caveat / resolved disagreement:** risk/integration warn this **masks the crash signal** and confounds the eventual A/B (Phase 7). The simplifier/risk lenses still want it as the cheapest immediate stop-gap. **Resolution:** It is legitimate as an *operational stop-gap to reduce wedge frequency right now*, but you must **re-introduce penumbra-2 for the Phase 7 A/B** so attribution is clean — otherwise you will never know whether the code fixes actually worked or whether you were just running at half capacity. It changes live fleet capacity (a service the user is actively using), so **confirm with the user before applying** (this carries user-visible blast radius per the session rules). No correctness risk: `chain_start` has no max-in-flight bound, so handoffs just wait longer in `approved`.
2. **(Optional) Add a log filter / `grep -v` on the cosmetic ha-mcp `_enter_buffered_busy` line** when scanning `err.log`, so the benign cron noise stops masquerading as the wedge until Phase 6 lands. Pure observability hygiene, no behavior change.

No other config lever is warranted — there is no real 503 storm to mitigate, and the Python fatal is benign.

---

## 5. Cross-cutting risks & what could break

- **Fixing a misdiagnosed cause (the dominant meta-risk).** The handoff bundle's two loudest symptoms — the Python `_enter_buffered_busy` fatal and the "chain_start 503 storm" — are **both refuted** (RC-6 is the ha-mcp cron sibling, zero Python in dispatch; the 503 storm has 0 occurrences in 52MB of logs). A planner who takes them at face value spends the whole budget hardening ACP stdio transport and chain_start admission while the real wedge (worker `code:1` storm + requeue cascade) recurs untouched. **Phase 1 is the structural guard:** capture the ACTUAL fatal line before treating any downstream phase as confirmed. Today RC-1's exact trigger is **inferred, not observed** — every Phase 2-6 TDD assertion is only as trustworthy as Phase 1's captured stack. **Do not flip Phase 1 `survive` mode, Phase 3, or Phase 4 ON in production until Phase 1's logs confirm what is actually dying.**
- **Fixes masking each other (ordering hazard).** Removing penumbra-2 OR the per-worker cursor each independently drops the crash rate. If either lands before Phase 1 captures the real fatal, we credit the wrong fix and leave the true trigger latent. Conversely, raising concurrency or relaxing the 60s cap **before** Phase 3 (requeue backpressure) + Phase 4 (admission) is in place actively **feeds** the cascade. The ordering invariant in §3 is the entire defense.
- **Phase 3 ↔ Phase 4 must share one "free survivor slots" notion.** If the requeue gate and the admission gate compute capacity independently and disagree, requeue can push work that admission would reject, re-creating the pileup both try to prevent. Land a single shared free-slot counter (or keep both independently conservative).
- **Phase 3 strand-forever risk.** Deferred requeue must enforce an eventual-flush invariant (bounded deferral ticks) or an orphan stalls forever — worse than today's cascade. Also must not race the stale-handoff sweeper, which only targets `status='dispatched'`.
- **Phase 1 flush correctness.** A pino async-only transport can lose the final line on immediate exit — the whole keystone fails silently. The repro test asserts the line is **literally present on stderr**; use a sync transport or `fs.writeSync` fallback.
- **Phase 2 double-count.** Per-worker cursors can double-emit usage for a shared upstream window → key on `(workerId, reader.id)` + downstream dedupe.
- **Surviving rejections can mask a zombie worker** (Phase 1 `survive` mode) → kept OFF by default; the daemon watchdog (90s) still recycles a non-heartbeating worker.

---

## 6. Verification plan (confirm the wedge is gone, not just "tests pass")

1. **Unit/characterization (CI):** Phase 0 harnesses go green for each fix — Phase 1 captures a structured fatal line; Phase 2 shows zero ENOENT under concurrent persist; Phase 3 defers under saturation; Phase 4 returns the distinct backpressure code without writing a row; Phase 5 reaps the grandchild; Phase 6 sends exactly one SIGTERM after stdin drain.
2. **Captured-fatal evidence (the key gate):** After Phase 1 ships, run the `bench-acp.ts` 117-dispatch load and confirm the next `code:1` crash now leaves a `worker_fatal`/`worker_unhandled_rejection` line **with a real stack** in the per-worker log. This converts the wedge from inferred to observed and **re-ranks Phases 2-6 against real evidence** (e.g. if the captured stack is the poller ENOENT, Phase 2 is confirmed; if not, re-prioritize).
3. **Crash-rate + backoff-reset under load:** Re-run the bench and assert (a) `extra_worker_crashed` count drops materially vs the 55-crash baseline, and (b) at least one worker logs a `restartCount` reset (`delay_ms` back to 1000ms after >120s stable life) — proving the storm no longer pins at the 60s cap.
4. **Cascade broken:** Under a forced single-worker crash during load (Phase 3 ON), confirm survivors are **not** flooded with requeued orphans in one tick (rate-limited / deferred) and that every deferred orphan **eventually** flushes (no stranded `dispatched` rows after the run — query `dispatch_events` / the handoffs table).
5. **No new admission regressions:** With Phase 4 enabled at a generous bound, confirm the bench completes (429s are retried and back off, not failed) and the `approved` queue stays bounded.
6. **Sustained-soak (the real acceptance criterion):** Leave the fixed daemon under realistic long-dispatch load for **>4-6 hours** (the window over which the wedge historically recurs) and confirm **no kickstart is needed** — short Q&A *and* long code dispatches both survive. This is the only test that proves the wedge itself (not a proxy) is gone, since the wedge is defined by recurrence after hours of load.
7. **A/B attribution (Phase 7):** Compare crash counts with penumbra-2 IN vs OUT *after* all code fixes are live, to separate "fixes worked" from "ran at half capacity."

---

## 7. Open questions / what still needs a live repro

1. **What is the ACTUAL `code:1` fatal line?** Unanswerable today (crash predates pino flush). **Phase 1 is built specifically to answer this** — until its captured stack lands, RC-1's exact trigger (and whether RC-2's poller ENOENT is the trigger or a red herring) is inferred. This is the single highest-value unknown.
2. **Is the shared cursor the load-correlated trigger or a red herring?** Phase 2 is the A/B: per-worker cursor path, then check whether the captured fatal (Phase 1) still recurs.
3. **Wedged-state snapshot.** Every investigator could only inspect a *healthy* tree (fd/mem/proc all nominal). A `lsof -p` + `ps` tree + `vmmap`/RSS snapshot **at wedge time, BEFORE kickstart** is required to confirm whether any accumulator (JS heap creep, event-listener leak, per-handoff maps, `semaphoreWaiters[]` Promise pileup) exists outside the host-resource axis — and whether RSS grows across the daemon's multi-hour life. This directly gates whether Phase 4 needs to be *enabled* (vs. shipped-as-insurance).
4. **Does penumbra-1/-2 actually route to opencode-acp?** If opencode-acp is rarely used under those workers, Phase 5's orphan gap is low-impact for *this* wedge (the bug is still real and worth closing).
5. **Liveness blind spot (architect RC3).** Why did penumbra-1 go silent (only poller ENOENT) for 73 min (11:04→12:18) *before* the supervisor storm? The supervisor only reacts to `proc.exited`, never to a missing heartbeat (`supervisor.ts:386/389`), so an alive-but-wedged worker is invisible to the process that owns its lifecycle (only the daemon watchdog notices at 90s). If confirmed, a **flag-gated supervisor liveness recycle** (consume the watchdog's `lastHeartbeats`, recycle a worker silent >120s) is a worthwhile additive Phase 3.5 — but only after Phase 1 confirms whether the silence is a separate liveness gap or just the lead-up to the same crash. Deferred pending evidence.
6. **No sweeper for stranded `approved` rows.** `stale-handoff.ts:76` sweeps only `status='dispatched'`; a handoff never claimed because all matching workers crashed sits in `approved` indefinitely with no caller-visible error. Relevant to Phase 4's TTL'd count (so a stranded row doesn't permanently inflate the in-flight bound). Confirm whether this needs its own sweeper or just the TTL.
