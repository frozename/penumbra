# Maestro continuation prompt — 2026-05-21 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

Execute the **First moves** checklist below immediately. Don't pause to ask permission per item — batch independent tool calls in parallel.

## What this session shipped

End-to-end execution of the worker token binding plan (the defer-1 follow-up from GH #122 pass-3 adversarial review). 20 commits, 2 adversarial rounds, live rollout, and 11/11 deployment-validation probes green.

### Plan execution (12 tasks across 8 phases, all landed)

| Phase | Commit | Substance |
|-------|--------|-----------|
| 1.1 schema | `0ff97bd` | `worker_tokens` table (`token_hash` PK, `worker_id`, `issued_at`, `last_seen_at`, `revoked_at`, `metadata_json`) + partial index `idx_worker_tokens_worker WHERE revoked_at IS NULL`. Idempotent CREATE-IF-NOT-EXISTS in the main `db.exec` block; no SCHEMA_VERSION bump. |
| 2.1 + 2.2 (parallel) | `cf8d46c`, `c6ca32e` | `WorkerTokenStore` (`issue`/`lookup`/`touch`/`revoke`) at `packages/core/src/auth/worker-token-store.ts`. Principal-extracting middleware augments `createBearerAuth` with an optional `workerTokenStore`; `getPrincipal(req): Principal \| null` accessor via per-request WeakMap. |
| 3.1 registration | `04112ea` | `POST /worker/register` mints a token under shared bearer; rejects worker-bearer callers with `403 shared_bearer_required_for_registration`. `serve.ts` constructs one `WorkerTokenStore` at boot and threads it into both auth middleware and the route. |
| 5.1 + 5.2 (parallel, reordered before Phase 4) | `89e38d2`, `c7be676` | `registerWorkerForTest` helper in `@penumbra/daemon/test-utils`. `runWorkerBoot` in `packages/agentchat/src/worker-boot.ts` registers + switches `PenumbraClient` to the bound token for worker-scoped methods. Failure to register → exit non-zero → launchd respawn. |
| 4.1 → 4.2 → 4.3 → 4.4 (serial) | `7791d20`, `edcddbf`, `e01fefe`, `7ec86ef` | Enforcement chain. `requireWorkerPrincipalMatch(req, body_worker_id)` helper in `packages/daemon/src/auth.ts`. Applied to `/worker/heartbeat`, `/worker/reconcile-orphans`, `/handoffs/:id/claim-dispatch`. Terminal CAS `/handoffs/:id/complete` + `:id/fail` is dual-mode: worker principal derives `expected_worker_id` from credential (mismatch is 403, no silent override); shared principal keeps the existing optional body `worker_id` admin override. |
| 6.1 stale-token sweep | `a92930c` | `startStaleWorkerTokensSweeper` revokes tokens with `last_seen_at` older than `DEFAULT_STALE_WINDOW_MS = 24h`, periodic floor 30 min. Soft-revoke (row retained). |
| 7.1 integration acceptance | `b5139e6` | One file, 8 `test()` blocks for the spec's seven-scenario contract + SIGKILL respawn. |
| 8.1 adversarial r1 synthesis | `9865afb` | Round-1 review (8 personas, 3 returned empty-diff). |

**Important design note discovered during 7.1**: `/worker/reconcile-orphans` is **self-restart recovery only** (scopes to the caller's own `worker_id`). Cross-worker orphan recovery is the daemon's internal watchdog sweep, NOT this HTTP route. Memory: `[[project_worker_reconcile_orphans_is_self_restart_only]]`.

### Adversarial rounds (2-round cap hit)

**Round 1** (`3b0c046`): 1 High + 1 Low fixed.
- High #1: `PenumbraClient.withWorkerTokenRetry` — on 401 from worker-scoped path, re-register with shared bearer, swap token, retry once. 403 propagates immediately (logic bug, not credential).
- Low #5: `/worker/register` rejects `metadata > 4096` with `400 metadata_too_large`.

**Round 2** (`1c89030`, synthesis `8def05d`): 1 High (introduced by round 1) + 3 Medium fixed.
- High #1: Concurrent 401s shared one in-flight `registerWorker` promise via `ensureFreshWorkerToken` (`reregisterInFlight: Promise<void> \| null`). Fleet-wide expiry now produces ONE new token, not N.
- Medium #2 (8 personas): `Buffer.byteLength(JSON.stringify(metadata), 'utf8')` with named constant `MAX_METADATA_BYTES`. Non-ASCII can no longer bypass the cap.
- Medium #3: Re-register failure preserved via `Error.cause` on the wrapped PenumbraHttpError.
- Medium #4: Boundary regression tests (exact 4096 pass, 4097 fail, multibyte bypass attempt rejected, all-multibyte under cap accepted).

### Rollout + live validation

Coordinated `launchctl kickstart -k` of daemon then worker. New daemon pid 24673, worker pid 24996 (`worker-b51o9` registered at 11:55:26 local, heartbeat flowing).

**Validation matrix (all green)**:

| # | Probe | Result |
|---|-------|--------|
| A1 | shared-bearer → /worker/heartbeat | 403 `worker_token_required` |
| A2 | worker-token + mismatched body | 403 `worker_id_mismatch` |
| A3 | worker-token + matching body | 200 `{ok:true}` |
| A4 | bogus bearer | 401 `unauthorized` |
| A4b | worker-token → /worker/register | 403 `shared_bearer_required_for_registration` |
| A5 | 5KB ASCII metadata | 400 `metadata_too_large` |
| A6 | 4100 UTF-8 bytes (2050×é) | 400 `metadata_too_large` (round-2 byte-length verified live) |
| B1 | worker kickstart → fresh registration | new row, new worker_id `worker-b51o9` |
| B2 | end-to-end dispatch through new worker | handoff `ccb7ca70` `completed` via worker-b51o9 |
| C1 | manual revoke → auto-recovery via PenumbraClient | new row at 08:58:58, 29s after revoke |
| C2 | single-flight under concurrent expiry | validated by `boot-token-registration.test.ts` 15/0; cannot synthesize concurrent worker-scoped calls externally |

## Live state

- **launchd**: `dev.penumbra.daemon` pid 24673, `dev.penumbra.worker` pid 24996 (`worker-b51o9`). Both on the post-rollout code path.
- **Local main = origin/main = `1c89030`**. Pushed.
- **worker_tokens** snapshot (4 rows):
  - `worker-b51o9` (08:58:58) — ACTIVE, the auto-recovered token from C1 validation.
  - `worker-b51o9` (08:55:26) — revoked (C1 test manual revoke).
  - `W-PROBE` (08:54:27) — revoked (A-probe cleanup).
  - `worker-xrgsk` (08:31:01) — ACTIVE but no live process (stale-but-not-yet-swept; sweeper will catch after 24h).
- **Daemon test slice**: 1070+/0 green pre-roundtrip (round-2 added 4 boundary tests).
- **Long-lived agents**: home-mgmt, task-refiner-primary, task-refiner-escalation all ticking `success` post-rollout.

## Open follow-ups

**From the two adversarial synthesis docs** (`docs/notes/adversarial-cycle-worker-token-binding-2026-05-21.md` + `…round2-2026-05-21.md`):

1. **#5 architect (Medium, deferred)** — dual worker-identity sources on PenumbraClient (cached `workerId` + per-call `worker_id` arg). Split-brain risk. **Real API design call**; needs user input on whether to flip to worker-scoped client / session.
2. **Single-active-token rotation** — round-1 #2 (architect + security). Re-registration today does NOT invalidate prior tokens (spec locked "many tokens per worker" as open-question #2 default). The compromised-token argument is real; if you want to flip the spec, this is a small code change (revoke caller's prior active tokens on register).
3. **Sweeper window externalisation** — round-1 #4 (already acknowledged in 6.1's commit). Move `staleWindowMs` to daemon config.
4. **PenumbraClient auto-re-register observability gap** — no log line on the silent 401 → register → retry. Ops can't see token churn. One-line follow-up: `log.info({ worker_id, reason: '401_retry' }, 'worker auto-reregistered')`.
5. **D1 stale-token sweep live validation** — needs 24h wall OR temporary config override. Not exercised in this session.
6. **Boot-reconcile worker-id stability** (handoff item from earlier session) — workers boot with random per-boot IDs; if stabilised, would enable proper rotation and less reliance on the watchdog cross-worker recovery path.
7. **Pass-2/3 stylistic tidy-up** (from the original GH #122 handoff) — naming drift + envelope consistency. Not started.

## Memories worth reading

- `[[project_worker_reconcile_orphans_is_self_restart_only]]` — the route is self-restart only; cross-worker recovery is the watchdog's job.
- `[[feedback_dispatch_land_409_verdict_gate]]` — dispatch_land needs `force=true` post-synthesis.
- `[[project_schema_migration_placement]]` — schema additive block placement.
- `[[feedback_chain_status_failed_check_response]]` — chain status=failed can be a spurious auto-handoff to a non-existent agent; read chain_get_response.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `sqlite3 ~/.penumbra/db.sqlite "SELECT worker_id, datetime(issued_at/1000,'unixepoch','localtime') AS issued, datetime(last_seen_at/1000,'unixepoch','localtime') AS seen, revoked_at IS NOT NULL AS revoked FROM worker_tokens ORDER BY issued_at DESC LIMIT 5;"` — sanity-check the live token state.
4. `mcp__penumbra__long_lived_list` → confirm the three agents are still ticking `success`.
5. Pick a direction with the user from the open follow-ups above. Natural sequence: observability log (4) → sweeper config externalisation (3) → token rotation design conversation (1 + 2) → stylistic tidy-up (7).
