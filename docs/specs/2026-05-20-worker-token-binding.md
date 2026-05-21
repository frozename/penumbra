# Spec — Worker token binding (defer-1 from GH #122)

## Problem

Today the daemon authenticates HTTP callers with a single shared bearer token (`packages/daemon/src/auth.ts`). The token authenticates the *caller is local-trusted*, but says nothing about *which worker* the caller is. Worker-scoped routes accept the worker's identity from the body:

| Route | Caller supplies | Trust today |
|-------|-----------------|-------------|
| `POST /worker/heartbeat` | `body.worker_id` | claimed identity is taken at face value |
| `POST /worker/reconcile-orphans` | `body.worker_id` | claimed identity scopes which orphans are recovered |
| `POST /handoffs/claim-dispatch` | `body.worker_id` | becomes the row's `worker_id` |
| `POST /handoffs/:id/complete` | optional `body.worker_id` | used as `expected_worker_id` on CAS |
| `POST /handoffs/:id/fail` | optional `body.worker_id` | used as `expected_worker_id` on CAS |

Any holder of the shared bearer can therefore impersonate any worker — claim leases out from under a peer, mark a peer's in-flight dispatches complete, or invoke another worker's orphan recovery. The TODO marker is at `packages/daemon/src/routes/worker-reconcile-orphans.ts:35`.

This was deliberately deferred from the GH #122 worker-hardening Tier 2 epic so the epic could land; the adversarial-review pass-3 synthesis flagged it as the remaining "High" finding, and the resolution was "track separately." This spec is that separate track.

## Threat model

All callers today are local subprocess children of the same daemon, behind a `127.0.0.1` bind under launchd. So:

- **In scope:** misbehaving or buggy workers spoofing peer identities; an attacker who gains code-execution as one worker pivoting to corrupt another worker's leases; admin/test callers accidentally writing to the wrong worker.
- **Out of scope (covered by host security):** an attacker who already has the shared bearer + arbitrary FS access. Token binding is defense-in-depth on top of, not a substitute for, the loopback bind and process-isolation guarantees.

The win is making `expected_worker_id` *enforceable everywhere* without losing the current admin-force-terminate escape hatch.

## Goal

Bind every worker-scoped HTTP request to a *single* server-known `worker_id`, so:

1. A request's effective `worker_id` is derived from the credential it presents, not from request body.
2. Any body-supplied `worker_id` that disagrees with the credential's binding is rejected with 403 (not silently overridden).
3. Routes that today accept an *optional* `expected_worker_id` (terminal CAS, `markCompleted`/`markFailed`) can be tightened later — once token binding ships, the optional escape hatch can be retired for worker-originated calls while admin/MCP/CLI paths keep it.
4. The shared bearer continues to work for **non-worker** callers (CLI, MCP, ops scripts) so the migration is incremental.

## Floor — minimum viable token binding

### Data model

A new daemon-managed table:

```sql
CREATE TABLE worker_tokens (
  token_hash TEXT PRIMARY KEY,           -- sha256 of the token, never the plaintext
  worker_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,            -- epoch ms
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER NULL,
  metadata_json TEXT NULL                -- optional: hostname, pid, agent version
);
CREATE INDEX idx_worker_tokens_worker ON worker_tokens(worker_id) WHERE revoked_at IS NULL;
```

Notes:

- Plaintext token never persists; `token_hash` is the lookup key. Constant-time compare is unnecessary because hashing already destroys timing-attack surface, but the comparison should still be sha256-equality (not substring).
- One worker can have multiple active tokens during a rotation window. `worker_id` → many `token_hash`, but each `token_hash` → one `worker_id`.
- Revocation is soft: `revoked_at` set, row retained for audit.

### Registration flow

```
worker boot
  ↓
POST /worker/register
  Authorization: Bearer <shared-secret>          ← bootstrap credential
  body: { worker_id, metadata }
  ↓
daemon: mint token (32-byte random base64url), hash, insert worker_tokens row
  ↓
response: { worker_token }                        ← per-worker credential
  ↓
worker uses Authorization: Bearer <worker_token> for all subsequent /worker/* + /handoffs/* claim+terminal calls
```

The shared bearer remains valid for `/worker/register` (bootstrap), `/admin/*`, and CLI/MCP paths. After registration, the worker switches to its per-worker token for write paths.

### Middleware contract

Augment `createBearerAuth` (or wrap it) so that the existing pass-through returns not just `Response | null` but also an attached principal:

```ts
type Principal =
  | { kind: 'shared'; via: 'config' }
  | { kind: 'worker'; worker_id: string; token_hash: string };
```

The principal is attached to the Request via a per-request context (Bun's `Request` doesn't carry one natively — use a `WeakMap<Request, Principal>` or a thin wrapper, whichever the existing code prefers).

Worker-scoped routes then enforce:

```ts
const principal = getPrincipal(req);
if (principal.kind !== 'worker') return forbidden('worker token required');
if (body.worker_id !== principal.worker_id) return forbidden('worker_id mismatch');
```

Admin/CLI paths keep the `shared` principal and the existing behaviour.

### Lifecycle: rotation, revocation, restart

- **Restart with same `worker_id`**: today worker IDs are random per boot; spec'ing this without that changing would mean re-registering on every boot. That's fine — `worker_id` stability is a separate follow-up (handoff item #3). Token rotation is a no-op until then.
- **Stale tokens**: if `last_seen_at` is older than a configurable window (default: 24h) AND no active heartbeat, revoke. This catches abandoned tokens from crashed workers whose `worker_id` was never reused.
- **Manual revoke**: `POST /admin/worker-tokens/:hash/revoke` for ops use.

## Hard constraints

1. **Migration must be incremental.** Each non-worker caller (MCP tools, CLI, in-process tests) is updated independently; tests can keep using the shared bearer.
2. **Bootstrap remains the shared bearer.** A worker that has not yet registered cannot present a per-worker token — only `/worker/register` accepts the shared bearer for worker routes. (Optionally: `/worker/heartbeat` also accepts shared bearer during a deprecation window.)
3. **No silent override.** If a worker presents its token *and* a `worker_id` in body that disagrees, the response is 403 — not "we ignored your body and used the principal." Surface the conflict.
4. **The 401 → 403 distinction matters.** 401 = no/invalid credential. 403 = valid credential, wrong identity. Existing callers check status codes; do not collapse them.
5. **Test-utils ergonomic constant.** `packages/daemon/test/test-utils.ts` (the re-export module landed in `e1cc49e`) should expose a `registerWorkerForTest(worker_id)` helper so daemon tests that need a per-worker token don't reinvent the registration handshake.

## Out of scope

- Mutual TLS or socket-peer-uid binding. The bearer model is sufficient at this defense-in-depth tier.
- Per-route capability scopes (e.g., "this worker can heartbeat but not claim"). Today all workers are uniform; revisit if/when we get specialised worker classes.
- Cross-worker delegation. A worker cannot vouch for another worker.
- Token-binding for MCP tools. MCP callers stay on the shared bearer because they're the orchestrator, not a worker.
- Rotating *the shared bearer itself*. That's a separate ops concern.
- Worker-ID stabilisation (handoff item #3) — a sibling change that this spec assumes is independent.

## Acceptance test (lockable contract)

Integration test in `packages/daemon/test/routes/` (or `packages/daemon/test/integration/`):

1. **Cold boot** — bring up a fresh daemon, register worker `W-A` via `POST /worker/register` with the shared bearer; assert response contains a `worker_token`.
2. **Self-traffic ok** — `POST /worker/heartbeat` with `Bearer W-A-token` + `body.worker_id = "W-A"` → 200. The `worker_tokens.last_seen_at` updates.
3. **Body mismatch** — `POST /worker/heartbeat` with `Bearer W-A-token` + `body.worker_id = "W-B"` → 403 with `code: "worker_id_mismatch"`.
4. **Wrong credential type** — `POST /worker/heartbeat` with `Bearer <shared>` + `body.worker_id = "W-A"` → 403 with `code: "worker_token_required"` (or, during deprecation window, 200 + a Deprecation header — pick one and lock it in the test).
5. **Claim collision** — register `W-B`. Have `W-A` `claimDispatch` a handoff. `W-B` attempts the same `claimDispatch` with its own token + body.worker_id="W-B" → no row stolen; the handoff is `claimed_by W-A`. (Existing single-claim semantics still hold; token binding just removes the spoof vector.)
6. **Terminal CAS** — `W-A` issues `POST /handoffs/:id/complete` with no body `worker_id`. The middleware injects `expected_worker_id = "W-A"` from the principal. CAS still fires correctly.
7. **Revocation** — `POST /admin/worker-tokens/:hash/revoke`; subsequent `W-A` calls 401.

Plus a unit test on the middleware itself: principal extraction is purely a function of `Authorization` header + `worker_tokens` table state; no body parsing happens at the auth layer.

## Relevant priors

- `[[project_dispatch_routing_guard]]` — STRICT MODE LIVE: a precedent for daemon-side binding/enforcement (project_id scoping). Worker token binding is the same family for `worker_id`.
- `[[feedback_use_dispatch_land_not_manual_merge]]` — landing this work is dispatch_land, not manual merge; the agent_performance loop wants the stamp.
- `[[project_daemon_sweepers_event_aware_2026_05_19]]` — the stale-token sweeper (revoking by `last_seen_at`) should follow the event-aware sweeper pattern, not poll on a timer.
- `[[feedback_run_home_checkout_typecheck_before_push]]` — schema migration → run home-checkout typecheck before push.
- `[[project_schema_migration_placement]]` — `worker_tokens` table + index must live in the additive block of `applySchema`, not a fresh `db.exec` block.
- `[[feedback_dispatch_land_409_verdict_gate]]` — landing the integration phase needs `force=true` post-synthesis.

## Shape of the planned deliverable

Phased TDD plan with:

1. **Phase 1 — Schema additive.** `worker_tokens` table + index, no read/write paths touch it yet. One commit.
2. **Phase 2 — Token store + middleware.**
   - 2.1: `WorkerTokenStore` (issue / lookup / revoke / touch `last_seen_at`).
   - 2.2: principal-extracting middleware wrapping `createBearerAuth`; per-request principal accessor; unit tests on the middleware in isolation.
3. **Phase 3 — Registration endpoint.** `POST /worker/register` mints a token; response shape locked.
4. **Phase 4 — Tighten worker routes.**
   - 4.1: `/worker/heartbeat` enforces principal=worker + body match. Existing tests + a new mismatch test.
   - 4.2: `/worker/reconcile-orphans` enforces same; the TODO at line 35 of that file is removed in this commit.
   - 4.3: `/handoffs/claim-dispatch` enforces same.
   - 4.4: `/handoffs/:id/complete` and `:id/fail` derive `expected_worker_id` from the principal when present; body `worker_id` retained as override only for `shared` principals (admin/CLI).
5. **Phase 5 — Test-utils + worker boot wiring.** `registerWorkerForTest` helper + agentchat-worker boot flow (`packages/agentchat/src/worker/*`) calls `/worker/register` before any other write path; switches its HTTP client to the per-worker token.
6. **Phase 6 — Stale-token sweep.** Event-aware sweeper revoking tokens with stale `last_seen_at`. Default window 24h; configurable via daemon config.
7. **Phase 7 — Integration acceptance.** The seven scenarios above in one acceptance file. SIGKILL-and-restart path verified: a respawned worker registers fresh, sees orphans for its *previous* worker_id (because IDs are still per-boot random), and can recover them only under its old token (now revoked) — surface the recovery path needed.
8. **Phase 8 — Adversarial review fan-out.** Standard 8-persona pass; iterate to zero High findings; one bundled stylistic round.

Per-phase dispatch graphs decided at plan-writing time (`/write-plan` after this spec lands).

## Open questions

1. **Bootstrap window for `/worker/heartbeat`** — should heartbeat accept the shared bearer during a deprecation window (so a worker that hasn't yet registered still emits liveness), or strictly require a worker token from first call? Recommend: yes, accept shared bearer on heartbeat for one release; log a deprecation event.
2. **Single token per worker, or many?** Many is more flexible (rotation, blue/green), single is simpler. Recommend single now, table schema admits many later.
3. **Where does the worker persist its token?** In-memory only (re-register on every boot) is simplest given that `worker_id` is already per-boot random. If/when `worker_id` stabilises, persist `~/.config/penumbra/worker-token`.
4. **Does the existing `machineId` service interact?** `services.machineId.get()` is used in `markFailed`'s `resolved_by`. Token binding doesn't change machineId, but the spec for Phase 4.4 should confirm the two are independent identifiers.
5. **MCP path for admin token operations.** Should `worker_tokens` operations be exposed via the MCP surface (issue/revoke/list) or only as HTTP admin routes? Lean toward MCP for ergonomics, but only after Phase 7.

## Estimated wall

Multi-day work, probably 2–3 implementation sessions. Phases 1–3 fit in one session; 4 needs careful per-route handling; 5–6 are net-new wiring + sweepers; 7–8 are integration + adversarial loop. Closes the last "High" finding from the GH #122 pass-3 synthesis.
