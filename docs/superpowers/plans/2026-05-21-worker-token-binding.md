# Plan — Worker token binding (defer-1 from GH #122)

Spec: [`docs/specs/2026-05-20-worker-token-binding.md`](../../specs/2026-05-20-worker-token-binding.md)

Goal: every worker-scoped HTTP request derives `worker_id` from a per-worker bearer (not from the request body). Removes the spoof-peer-identity vector that the GH #122 pass-3 adversarial review flagged as the last "High" finding. The shared bearer continues to work for non-worker callers (CLI, MCP, ops, tests during migration).

The TDD discipline: every task lands a *failing* test first, then the change to make it pass. Real code in every step, no placeholders.

## Phase 1 — Schema additive

```
Dispatch graph: 1.1
```

### Task 1.1 — Add `worker_tokens` table + index to `applySchema`

```yaml meta
id: "1.1"
files:
  - packages/core/src/db/schema.ts
  - packages/core/test/db/schema-worker-tokens.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: schema-aware
```

- Write `packages/core/test/schema/worker-tokens.test.ts` first: opens a fresh in-memory db via the schema-applier, asserts `worker_tokens` table exists with columns `(token_hash TEXT PRIMARY KEY, worker_id TEXT NOT NULL, issued_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER NULL, metadata_json TEXT NULL)` and that the partial index `idx_worker_tokens_worker` (on `worker_id WHERE revoked_at IS NULL`) is present.
- Add the `CREATE TABLE` + `CREATE INDEX` to the additive block in `applySchema` (per `[[project_schema_migration_placement]]`). Do not introduce a fresh `db.exec` block; placement is load-bearing.
- Run the daemon test slice — must still be 1010+ green.

Integration: cherry-pick onto `main` once green; subsequent phases assume the table exists.

## Phase 2 — Token store + auth middleware

```
Dispatch graph: 2.1 ∥ 2.2
```

### Task 2.1 — `WorkerTokenStore` (issue / lookup / touch / revoke)

```yaml meta
id: "2.1"
files:
  - packages/core/src/auth/worker-token-store.ts
  - packages/core/test/auth/worker-token-store.test.ts
file_scope: extend-shared
depends_on: ["1.1"]
parallel_with: ["2.2"]
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

- Test first: a store wired to a fresh schema-applied db can `issue({ worker_id, metadata })` returning `{ token, token_hash }`; `lookup(token)` returns the row (or `null` if missing/revoked); `touch(token_hash, now)` updates `last_seen_at`; `revoke(token_hash, now)` sets `revoked_at`; revoked tokens no longer resolve via `lookup`.
- Token generation: 32-byte `crypto.randomBytes` then `base64url`. Hash: sha256 hex of the plaintext. Plaintext is never persisted.
- Store is a thin class taking a `Database` in its constructor; no global state.

### Task 2.2 — Principal-extracting auth middleware

```yaml meta
id: "2.2"
files:
  - packages/daemon/src/auth.ts
  - packages/daemon/test/auth/principal.test.ts
file_scope: extend-shared
depends_on: ["1.1"]
parallel_with: ["2.1"]
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: bootstrap-touching
```

- Test first: given a request with `Authorization: Bearer <shared>`, principal is `{ kind: 'shared', via: 'config' }`. Given a request with `Authorization: Bearer <worker-token>` (token issued via the store), principal is `{ kind: 'worker', worker_id, token_hash }`. Missing header is 401. Header that is neither the shared token nor a known worker token is 401. No body parsing happens at the auth layer — assert this by passing a request with malformed JSON and confirming the auth middleware still returns its expected principal/401.
- Extend `createBearerAuth` to take an optional `workerTokenStore` and return a `(req) => { principal, response }` shape. When the store is absent (e.g., bootstrap), only the shared bearer is accepted (preserves current behaviour).
- Principal is attached via a per-request `WeakMap<Request, Principal>`; export a `getPrincipal(req): Principal | null` accessor.

Integration: 2.1 + 2.2 cherry-picked together onto `main`; no behaviour change yet because no route reads the principal.

## Phase 3 — Registration endpoint

```
Dispatch graph: 3.1
```

### Task 3.1 — `POST /worker/register`

```yaml meta
id: "3.1"
files:
  - packages/daemon/src/routes/worker-register.ts
  - packages/daemon/src/serve.ts
  - packages/daemon/test/routes/worker-register.test.ts
file_scope: extend-shared
depends_on: ["2.1", "2.2"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

- Test first: `POST /worker/register` with `Authorization: Bearer <shared>` and body `{ worker_id, metadata? }` returns 200 with `{ worker_token: string, worker_id: string }`. `worker_token` is base64url, length matches a 32-byte source. The `worker_tokens` row is present in the db with the sha256(`worker_token`) as primary key. A second `register` call for the same `worker_id` returns a fresh token (does not 409) — multiple concurrent worker generations are allowed; the spec leaves "single vs many" open and we lock in "many for now".
- Worker callers cannot register with a `worker` principal (403 + `code: "shared_bearer_required_for_registration"`); only the shared bearer bootstraps.
- Wire the route into `serve.ts` next to the existing `/worker/*` routes.

Integration: cherry-pick onto `main`. After this lands, workers can register but no route yet enforces it; the rest of the pipeline still trusts body `worker_id`.

## Phase 4 — Tighten worker routes

```
Dispatch graph: 4.1 → 4.2 → 4.3 → 4.4
```

(Serial because each route shares the same enforcement helper that 4.1 introduces; later steps depend on the helper being stable.)

### Task 4.1 — `/worker/heartbeat` enforces principal=worker + body match

```yaml meta
id: "4.1"
files:
  - packages/daemon/src/routes/worker-heartbeat.ts
  - packages/daemon/src/auth.ts
  - packages/daemon/test/routes/worker-heartbeat.test.ts
file_scope: extend-shared
depends_on: ["3.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: schema-aware
```

- Add a `requireWorkerPrincipalMatch(req, body_worker_id): Response | null` helper in `auth.ts`. Returns 403 + `code: "worker_token_required"` if principal kind is not `worker`. Returns 403 + `code: "worker_id_mismatch"` if `principal.worker_id !== body_worker_id`. Returns `null` on success.
- Test first: heartbeat with shared bearer + `worker_id: "W-A"` is 403 (`worker_token_required`). Heartbeat with W-A's worker-token + `body.worker_id: "W-B"` is 403 (`worker_id_mismatch`). Heartbeat with W-A's worker-token + `body.worker_id: "W-A"` is 200 and `worker_tokens.last_seen_at` updated via `WorkerTokenStore.touch`.
- During the deprecation window, log a single warn-level "shared bearer used on /worker/heartbeat" event when the 403 fires, with `worker_id` from body included so operators can identify the lagging caller. The 403 itself is hard; the log is the observability.

### Task 4.2 — `/worker/reconcile-orphans` enforces principal=worker + body match

```yaml meta
id: "4.2"
files:
  - packages/daemon/src/routes/worker-reconcile-orphans.ts
  - packages/daemon/test/routes/worker-reconcile-orphans.test.ts
file_scope: extend-shared
depends_on: ["4.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: schema-aware
```

- Test first: same trio as 4.1 (shared-bearer is 403, mismatch is 403, match is 200).
- Apply `requireWorkerPrincipalMatch` before calling `recovery.runOnce`. Remove the `// TODO: authz fix - verify bearer token owns worker_id (tracked separately)` comment from line 35.

### Task 4.3 — `/handoffs/claim-dispatch` enforces principal=worker + body match

```yaml meta
id: "4.3"
files:
  - packages/daemon/src/routes/handoffs.ts
  - packages/daemon/test/routes/handoffs-claim-dispatch.test.ts
file_scope: extend-shared
depends_on: ["4.2"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: schema-aware
```

- Test first: claim-dispatch with shared-bearer + `worker_id: "W-A"` is 403. Claim-dispatch with W-A's worker-token + `body.worker_id: "W-B"` is 403. Match: existing single-claim semantics still hold (Phase 4 of the GH #122 epic added the attempt-aware lease; that behaviour must be preserved).
- The claim-collision scenario from the spec's acceptance test 5 is in scope here: register W-A and W-B; W-A claims; W-B attempts claim with its own token; row is not stolen; the handoff is `claimed_by W-A`.

### Task 4.4 — `/handoffs/:id/complete` + `:id/fail` derive `expected_worker_id` from principal

```yaml meta
id: "4.4"
files:
  - packages/daemon/src/routes/handoffs.ts
  - packages/daemon/test/routes/handoffs-terminal-cas.test.ts
file_scope: extend-shared
depends_on: ["4.3"]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

- Test first:
  - Worker principal: terminal CAS with no body `worker_id` uses `principal.worker_id` as `expected_worker_id`. Test asserts the CAS row's expected matches the principal.
  - Worker principal + body `worker_id` agreeing with principal: 200 (no conflict).
  - Worker principal + body `worker_id` disagreeing with principal: 403 (`worker_id_mismatch`) — no silent override.
  - Shared principal: existing optional `expected_worker_id` from body still honoured; if body omits it, no CAS check (existing admin/force-terminate path preserved).
- Touches both `markCompleted` and `markFailed` route handlers; the route-layer change is small but the test matrix is large enough to call this `substantial`.

Integration: each task cherry-picked individually onto `main`. After 4.4, every worker-originated write path is binding-checked; the shared bearer retains its admin escape hatch.

## Phase 5 — Test-utils + worker boot wiring

```
Dispatch graph: 5.1 ∥ 5.2
```

### Task 5.1 — `registerWorkerForTest` test helper

```yaml meta
id: "5.1"
files:
  - packages/daemon/test-utils.ts
  - packages/daemon/test/test-utils/register-worker.test.ts
file_scope: extend-shared
depends_on: ["3.1"]
parallel_with: ["5.2"]
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

- Add a `registerWorkerForTest(baseUrl, sharedBearer, worker_id, metadata?)` helper that posts to `/worker/register` and returns `{ worker_token }`. Test that it round-trips against an in-process daemon and that the returned token authenticates a follow-up `/worker/heartbeat`.
- The helper lives in the `@penumbra/daemon/test-utils` re-export module landed in `e1cc49e` — extend, do not re-introduce legacy `./src/*` daemon exports.

### Task 5.2 — agentchat-worker boot flow registers + switches to per-worker token

```yaml meta
id: "5.2"
files:
  - packages/agentchat/bin/agentchat-worker.ts
  - packages/agentchat/src/penumbra-client.ts
  - packages/agentchat/test/worker/boot-token-registration.test.ts
file_scope: extend-shared
depends_on: ["3.1"]
parallel_with: ["5.1"]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: bootstrap-touching
```

- Test first: on worker boot, before any write call, the worker registers with the shared bearer and obtains a `worker_token`. The worker's HTTP client switches to `Bearer <worker_token>` for `/worker/*` and `/handoffs/*` write paths; `/admin/*` and read-only paths continue to use the shared bearer.
- Persistence: worker token is held in-memory only (per the spec's open question 3 — `worker_id` is still per-boot random, so re-registration on every boot is fine).
- Failure mode: if `/worker/register` returns non-200, the worker logs and exits non-zero; launchd will respawn. Do not silently fall back to shared bearer for write paths.

Integration: 5.1 + 5.2 cherry-picked together. After this, fleet workers automatically use bound tokens; the shared bearer continues to serve MCP/CLI/ops.

## Phase 6 — Stale-token sweep

```
Dispatch graph: 6.1
```

### Task 6.1 — Event-aware sweeper revoking stale tokens

```yaml meta
id: "6.1"
files:
  - packages/daemon/src/sweepers/stale-worker-tokens.ts
  - packages/daemon/src/serve.ts
  - packages/daemon/test/sweepers/stale-worker-tokens.test.ts
file_scope: extend-shared
depends_on: ["2.1", "4.1"]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

- Test first: a token whose `last_seen_at` is older than the configured window (default 24h) is revoked by the sweeper. Active tokens (recent `last_seen_at`) are untouched. Revocation sets `revoked_at`; the row is retained.
- Follow the event-aware sweeper pattern per `[[project_daemon_sweepers_event_aware_2026_05_19]]`. The token store emits a `worker_tokens.touched` event on `touch()`; the sweeper subscribes and re-checks the affected worker's other tokens lazily. Add a periodic floor (`*/30 minutes`) for tokens that never see a `touched` event (i.e., the worker died immediately after registration).
- Configurable via daemon config: `workerTokens.staleWindowMs` (default `24 * 60 * 60 * 1000`).

Integration: cherry-pick onto `main`. After this, an abandoned worker's token cannot indefinitely impersonate; the worst case is one sweep interval of drift.

## Phase 7 — Integration acceptance

```
Dispatch graph: 7.1
```

### Task 7.1 — Seven-scenario integration test

```yaml meta
id: "7.1"
files:
  - packages/daemon/test/integration/worker-token-binding.acceptance.test.ts
file_scope: new
depends_on: ["4.4", "5.1", "5.2", "6.1"]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

- One file, seven `test()` blocks corresponding 1:1 to the spec's acceptance contract:
  1. Cold boot + register W-A; token returned.
  2. Self-traffic: heartbeat with bound token + matching body is 200; `last_seen_at` updates.
  3. Body mismatch: heartbeat with W-A token + body `worker_id: "W-B"` is 403 (`worker_id_mismatch`).
  4. Wrong credential type: heartbeat with shared bearer is 403 (`worker_token_required`).
  5. Claim collision: W-A claims; W-B re-claim attempt under W-B's token is no-theft.
  6. Terminal CAS: W-A issues complete with no body `worker_id`; CAS fires with `expected_worker_id = "W-A"` from principal.
  7. Revocation: admin revokes W-A's token; subsequent W-A calls return 401.
- Plus a SIGKILL-and-respawn flow: kill the agentchat-worker mid-flight on an in-flight dispatch. After respawn, the new worker has a new `worker_id` and new token (since IDs are still per-boot random). Assert that the dispatched row pinned to the dead `worker_id` is recovered by the new worker via `/worker/reconcile-orphans`, even though the new worker's token can't claim under the dead worker's identity directly — recovery happens via the `OrphanHandoffRecoveryService` re-leasing on behalf of the new worker. This validates that token binding doesn't break the GH #122 orphan-recovery path.

Integration: dispatch_land squash. Use `force=true` if the verdict gate isn't stamped (per `[[feedback_dispatch_land_409_verdict_gate]]`).

## Phase 8 — Adversarial review fan-out

```
Dispatch graph: 8.1
```

### Task 8.1 — 8-persona adversarial review

```yaml meta
id: "8.1"
files:
  - docs/notes/adversarial-cycle-worker-token-binding-2026-05-21.md
file_scope: new
depends_on: ["7.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: substantial
risk_class: paste-ready
```

- Run `/adversarial-review` against the branch with the standard 8-persona fan-out (architect, security, performance, maintainability, naming_clarity, data_correctness, devils_advocate, simplicity). Synthesise findings into a single prioritised list.
- Iterate to zero High findings. Each fix is a follow-up commit on `main`. Apply the 2-round cap.
- One bundled stylistic round at the end for Medium/Low items (the same pattern as the GH #122 pass-2 follow-up).

Integration: each round of fixes lands as its own commit; the final synthesis doc is committed under `docs/notes/`.

## Deferred questions

Locked-in defaults, with reversion points called out for plan-execution time:

- Bootstrap window for `/worker/heartbeat` — Phase 4.1 lands the 403 + warn log. If operators report breakage during rollout, soften to "shared bearer accepted on heartbeat with Deprecation header" as a one-commit follow-up. Default is hard 403.
- Single vs many tokens per worker — Phase 3.1 locks in "many" (re-register issues a fresh token, no 409). Sufficient for now; rotation policy is a future spec.
- Worker-side token persistence — Phase 5.2 locks in "in-memory only." Will revisit when `worker_id` stabilisation lands (handoff item 3).
- MachineId interaction — Phase 4.4 leaves `services.machineId` unchanged; token binding and machine identity are independent.
- MCP surface for admin operations — Out of scope for this plan. After Phase 7, file a separate task to expose `worker_tokens` issue/revoke/list via the MCP surface.

## Validator gate

After committing this plan, run:

```bash
penumbra plan validate docs/superpowers/plans/2026-05-21-worker-token-binding.md
```

Until it passes (parallel_with reciprocity, depends_on cycles, file_scope new collisions, agent membership in registry).
