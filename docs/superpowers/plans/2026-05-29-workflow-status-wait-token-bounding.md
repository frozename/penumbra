# Phased TDD Plan — Token-bounded `workflow_status` / `workflow_wait`

**Date:** 2026-05-29
**Spec:** `docs/superpowers/specs/2026-05-29-workflow-status-wait-token-bounding.md`
**Integrates with:** `docs/superpowers/plans/2026-05-27-mcp-token-optimization.md`
**Branch series:** `feat/workflow-mcp-bounded` — S0/S1/S2 land immediately; S3 rebases once token-opt Phase 4 (handle store) lands.
**Source:** adversarial-plan synthesis `.penumbra/reviews/2026-05-29T01-23-02.800Z/synthesis.md` (4/5 personas; architect timed out), with two corrections applied after code verification (see "Corrections" below).

---

## Background (verified this session)

The originally-reported `workflow_wait` `HTTP 400 untrusted_cwd` (`task_653bfa4e`, filed 2026-05-21) is **already fixed** on `main` — both `/workflows/status` and `/workflows/wait` share `resolveWorkflowScopeOrReject(body.cwd ?? process.cwd(), …)` and resolve against the daemon cwd. Reproduced live: both returned `{"status":"completed","result":{…}}`, not a 400. **Do not re-fix the 400 — guard it with a regression test (Phase S0).**

The real blocker: both tools inline the **full** workflow result (~100 KB / ~25 K tokens for `memory-digest`; larger for adversarial workflows). The registry already spills results >64 KB to disk (`INLINE_JSON_LIMIT`, `workflow-runs-registry.ts`), but `getStatus`/`waitForResult` hydrate the spill back and the routes return the whole payload. `workflow_status` returning the full result is a plain defect — a status check must be cheap.

## Corrections vs. the raw synthesis

1. **DB migration mechanism.** Penumbra has **no** `packages/daemon/src/db/migrations/` directory and uses **no** raw `ALTER TABLE` files. Schema lives in `packages/core/src/db/schema.ts`; additive columns are added via `addColumnIfMissing(db, table, col, type)` inside the additive migration block. The `workflow_runs` additions sit at `schema.ts:644-646` (immediately before the `workflow_runs` index `db.exec` at 647-650). New columns + backfill go **there**, in that same `db.exec`/migration block (per the schema-ordering invariant: a `CREATE INDEX` referencing a column must be in the same-or-later block as the column add).
2. **Route response idiom.** Daemon route handlers have signature `(req: Request, services: Services) => Promise<Response>` and return via the `json(body, status = 200)` helper from `packages/daemon/src/routes/_helpers.ts`. There is **no** Hono `c.json(...)`. All route snippets below use `return json({...})`.

All three target test files **already exist** (extend them, don't scaffold):
`packages/daemon/test/routes/workflows.test.ts` (76 K), `packages/daemon/test/services/workflow-runs-registry.test.ts` (19 K), `packages/mcp/test/tools/workflow-status.test.ts` (1 K).

---

## Resolved decisions

- **D1 — `workflow_status` is a hard contract change, no opt-in.** `result`/`error` removed permanently; status = run state only. Callers reading `.result` from `workflow_status` migrate to `workflow_wait`. Pre-merge migration audit gates S1.
- **D2 — `workflow_wait` bounding is MCP-shim-side where possible; daemon route gains a bounded shape but keeps full-payload availability.** (Synthesis put truncation in the daemon route for S2 because the MCP shim has no size budget yet until token-opt Phase 0 lands; see S2 note.)
- **D4 — `result_bytes`/`error_bytes` tracked in DB, written at payload-write time.** `getStatusLight()` must not stat the FS or call `readPayload`. Value = `Buffer.byteLength(payloadJson)` from `writePayload` (identical whether the payload spilled or stayed inline). Backfill legacy rows from `length(result_json)`/`length(error_json)`; spill-only legacy rows default to 0 (acceptable one-time bootstrap).
- **D5 — `workflow_run(wait:true)` is out of scope** for all phases; its response contract is unchanged. Note it in each PR description.

---

## Phase S0 — Schema prep + `getStatusLight()` + 400 regression guard

**Status: DONE (2026-05-29).** Shipped on branch `feat/workflow-mcp-bounded` as `cf341bc8` (impl) + `05f8f46b` (adversarial-review fixes F1–F6,F9). Not merged to main. adversarial-review synthesis: `.penumbra/reviews/2026-05-29T02-34-27.259Z/`. Findings F1 (byte-accurate backfill `CAST AS BLOB`), F2 (`result_available = status==="completed"`), F3 (no sweep on the light read), F4/F5/F6/F9 (test + doc hardening) all applied. F7/F8 (persistence_status semantics) deferred into S1 below. 22/22 registry + 43/43 route tests green, full typecheck clean.

**Depends on:** nothing. **Startable immediately.**

### Failing tests

Extend `packages/daemon/test/routes/workflows.test.ts`:

```ts
test("POST /workflows/status returns 200 (not 400 untrusted_cwd) for a same-project run");
// Arrange: register a run for the test project; call the status route with that project's cwd.
// Assert: res.status === 200; (await res.json()).error?.code !== "untrusted_cwd"

test("POST /workflows/wait returns 200 (not 400 untrusted_cwd) for a same-project run");
// Same arrangement against the wait route (use a short timeout_ms and a completed run so it returns immediately).
```

Extend `packages/daemon/test/services/workflow-runs-registry.test.ts`:

```ts
test("getStatusLight returns result_available + result_bytes WITHOUT calling readPayload");
// Spy/replace readPayload (module-local) and assert it is never invoked.
// Arrange a completed run with a known result; assert result_available === true && result_bytes > 0.

test("getStatusLight.result_bytes equals the byte length written by writePayload");
// Arrange recordResult with a known payload; assert result_bytes === Buffer.byteLength(serialized).
```

### Implementation

1. **`packages/core/src/db/schema.ts`** — in the additive block at ~L646 (right after the `workflow_runs` `error_spill_path`/`expires_at` adds, before the `workflow_runs_*` index `db.exec`):
   ```ts
   addColumnIfMissing(db, "workflow_runs", "result_bytes", "INTEGER NOT NULL DEFAULT 0");
   addColumnIfMissing(db, "workflow_runs", "error_bytes", "INTEGER NOT NULL DEFAULT 0");
   db.exec(
     `UPDATE workflow_runs SET result_bytes = length(result_json) WHERE result_json IS NOT NULL AND result_bytes = 0;`,
   );
   db.exec(
     `UPDATE workflow_runs SET error_bytes = length(error_json) WHERE error_json IS NOT NULL AND error_bytes = 0;`,
   );
   ```
2. **`packages/daemon/src/services/workflow-runs-registry.ts`** — write the byte counts at payload-write time:
   - In `recordResult`: after `const spill = await writePayload(...)`, set `result_bytes = Buffer.byteLength(spill.payloadJson)` in the `refreshPersistedState({...})` patch (both spill and inline branches share `spill.payloadJson`).
   - In `recordError`: same for `error_bytes` from its `writePayload` result; and the catch-path `safeStringify(error)` write sets `error_bytes = Buffer.byteLength(safeStringify(error))`.
3. **`getStatusLight(workflowRunId)`** — same file; add to the `WorkflowRunsRegistry` type and impl. Single `SELECT status, started_at, completed_at, result_bytes, error_bytes FROM workflow_runs WHERE id = ?` (+ `persistenceByRunId` lookup). Return `WorkflowStatusLight = { status, started_at, finished_at?, result_available: boolean, result_bytes: number, error_bytes: number, persistence_status? }`. **No `readPayload`, no FS.** Mirror `getStatus`'s sweep/purge calls and the running-vs-terminal branch, minus payload hydration.

### Verify
```bash
bun test packages/daemon/test/services/workflow-runs-registry.test.ts
bun test packages/daemon/test/routes/workflows.test.ts
bun run typecheck
```
Daemon schema change → **daemon restart required** to materialize columns on the live DB (and to re-cache the route once S1 lands). Defer the restart until S1 to batch it.

---

## Phase S1 — Hard contract: `workflow_status` route + MCP tool

**Status: DONE + LANDED + LIVE (2026-05-29).** Merged to main at `f929e316` (series: `ba4ddf09` impl → `309c0ba0` review fixes → `f929e316` augmentation cleanup) and activated via daemon restart (pid 51224). `workflow_status` / `POST /workflows/status` now returns run-state-only `{status, started_at, finished_at?, result_available, result_bytes, error_bytes}` — no inline `result`/`error`. **F7/F8 resolved by OMITTING `persistence_status`** from the public contract (in-memory `persistenceByRunId` is restart-unreliable + leaks spill state; durable DB-derived `status`+`result_available`+`result_bytes` cover the actionable signal; a persistence failure lands as `status=failed`+`result_bytes=0`). BOUNDARY gate: 8-persona adversarial-review (`.penumbra/reviews/2026-05-29T04-21-50.367Z/`, verdict "land with revisions"); blockers F1 (`.claude/workflows/penumbra-review-sweep.js` read outcome off `workflow_status` → now reads terminal `workflow_wait`), F3 (tool description lists all 6 fields), F4 (added `getStatusLight` to core `WorkflowRunsRegistry` interface + `WorkflowStatusLight` to core; dropped route type-assertion) all fixed; F2 (timing fields dropped) was a verified FALSE POSITIVE; F5/F6/F10 test rename+comment. Lane `lane-797e7cf1` closed `passed`. Verified: `tsc --build` clean + 72 tests green on correct node_modules topology; **live `workflow_status` on a 100,652-byte memory-digest run returned ~140 bytes** (no payload). Trap recorded: dispatched agents can't verify `@penumbra/core` type-surface changes (worktree node_modules symlinks to main → stale core) — see t2 `dispatch-worktree-nodemodules-symlink-blocks-core-contract-verification`.

**Depends on:** S0 (`getStatusLight` + `WorkflowStatusLight`).
**Slots into:** token-opt **Phase 3** as a pre-confirmed top-bytes target (skip the Phase 2 measurement step for this tool).

**Carried over from the S0 review (resolve before this route wiring):**
- **F7** — `persistence_status` is in-memory only (`persistenceByRunId`); after a daemon restart it is empty, so a fully-persisted run reports no `persistence_status` (indistinguishable from "pending"). Before exposing it on a live route, either rehydrate `persistenceByRunId` from DB state on startup, or rename to `persistence_outcome` and document "emitted only when a terminal outcome is known."
- **F8** — `persistence_status: "persistence_failed"` leaks internal spill-subsystem degradation to polling clients. Decide whether to omit it from the light shape or reduce to a boolean `persisted: true/false`.

### Pre-merge migration audit (D1)
```bash
rg -n "workflow_status|workflowStatus" packages/ -g '!**/*.test.ts' | rg '\.result\b'
```
Any internal caller reading `.result` off a `workflow_status` response must move to `workflow_wait` before S1 merges. Also check CLI (`packages/cli`) and any long-lived/skill scripts.

### Failing tests

Extend `packages/daemon/test/routes/workflows.test.ts`:
```ts
test("POST /workflows/status omits result and error fields");
// Assert: !("result" in body) && !("error" in body)

test("POST /workflows/status body is < 2 KB regardless of result size");
// Arrange a run with a ~100 KB result; assert Buffer.byteLength(JSON.stringify(body)) < 2048

test("POST /workflows/status uses getStatusLight, not getStatus");
// Spy: getStatusLight called; getStatus NOT called from the status route
```

Extend `packages/mcp/test/tools/workflow-status.test.ts`:
```ts
test("workflow_status MCP output contains no result field");
test("workflow_status MCP output contains result_available + result_bytes");
```

### Implementation
1. **`packages/daemon/src/routes/workflows.ts`** `workflowsStatusRoute`: replace `await workflowRuns.getStatus(id)` with `await workflowRuns.getStatusLight(id)`; keep the existing `verify` + scope + `info.project_id !== scope.project` 404 guards. Return `json(light)`.
2. **`packages/mcp/src/tools/workflow-status.ts`** `workflowStatusHandler`: surface `{ status, started_at, finished_at?, result_available, result_bytes, persistence_status? }` only. Tool description: append "Returns run state only; for the full result payload use `workflow_wait`."
3. **`packages/mcp/src/daemon-client.ts`**: update the `workflowStatus` return type (no `result`/`error`).

### Verify
```bash
bun test packages/daemon/test/routes/workflows.test.ts
bun test packages/mcp/test/tools/workflow-status.test.ts
bun run typecheck
```
**Daemon restart required** after deploy (route + schema). Resume any long-lived agents if their circuit breakers trip on the restart.

---

## Phase S2 — Temporary `workflow_wait` truncation safety net

**Status: DONE + LANDED + LIVE (2026-05-29).** Merged to main at `0cbbf6c3` and activated via daemon restart (pid 41053). `workflowsWaitRoute` caps terminal payloads at `WORKFLOW_WAIT_PAYLOAD_LIMIT = 8192`: under the cap, `result`/`error` return in full + `*_truncated: false`; over it, **`result`/`error` = `null`** (NOT an opaque string), `*_truncated: true`, and a separate `result_preview`/`error_preview` (byte-safe ~1 KB head via `Buffer.from(serialized).subarray(0, 1024).toString("utf8")`, O(1), surrogate-safe) + terminal marker. `result_bytes`/`error_bytes` always report true serialized size. `timeout`/`429` branches unchanged. `workflow_run(wait:true)` unchanged (D5). BOUNDARY gate: 6/8-persona adversarial-review (`.penumbra/reviews/2026-05-29T10-06-31.288Z/`, architect+security timed out), verdict "land with revisions". **H1 (opaque-string truncation destroyed structured fields read by S1's `penumbra-review-sweep.js` consumer)** + **H2 (O(N²) preview loop)** resolved by the null+preview redesign; M1 (lone surrogate), M2 (marker wording), M3 (whole response fits cap), M4 (tool desc), M5/M6 (naming/exported consts), L1/L2 (escape-heavy + error JSON-size tests) all addressed. Lane `lane-2b14ba66` closed `passed`. Verified: `tsc --build` clean + 52 tests green; **live `workflow_wait` on a 101,250-byte memory-digest run returned ~1.2 KB** (`result:null`, preview + true byte count). Note: security persona lens not applied (timed out) — low risk for a size-bound DoS mitigation.

**Depends on:** S1 (types stable). **Explicitly temporary — S3 removes it.**
Rationale: token-opt Phase 4 (handle store) may be weeks out; without a cap, the first large `workflow_wait` after S1 still dumps ~100 KB to MCP clients. The cap is visible and reversible.

### Failing tests
Add `packages/daemon/test/routes/workflows-wait-bounded.test.ts`:
```ts
const LIMIT = 8192;
test("POST /workflows/wait truncates a result larger than the limit");
// Arrange ~50 KB result. Assert: body.result_truncated === true; body.result_bytes === 50000;
// Buffer.byteLength(body.result) <= LIMIT; body.result ends with the truncation marker.

test("POST /workflows/wait returns the full result when below the limit");
// Assert: body.result_truncated falsy; result complete.

test("POST /workflows/wait always includes result_bytes");
```

### Implementation
`packages/daemon/src/routes/workflows.ts` `workflowsWaitRoute`, after `waitForResult` returns a terminal `status` with a `result`:
```ts
const WORKFLOW_WAIT_RESULT_LIMIT = 8192; // temporary; replaced in Phase S3
const resultStr = JSON.stringify(status.result);
const resultBytes = Buffer.byteLength(resultStr);
if (resultBytes > WORKFLOW_WAIT_RESULT_LIMIT) {
  const marker = `…[truncated — ${resultBytes} bytes total; use read_handle once available]`;
  const head = resultStr.slice(0, WORKFLOW_WAIT_RESULT_LIMIT - Buffer.byteLength(marker));
  return json({ status: status.status, started_at: status.started_at, finished_at: status.finished_at,
                result: head + marker, result_truncated: true, result_bytes: resultBytes });
}
return json({ ...status, result_truncated: false, result_bytes: resultBytes });
```
Leave the `timeout` (`{status:"timeout"}`) and `429 waiter_capacity_exhausted` branches unchanged.

### Verify
```bash
bun test packages/daemon/test/routes/workflows-wait-bounded.test.ts
bun run typecheck
```
**Daemon restart required.**

---

## Phase S3 — `workflow_wait` bounding moves to the MCP shim (handle store)

> **CORRECTED 2026-05-29 after code verification — the original S3 below the line was architecturally stale.** It assumed a *daemon-side* handle store and told the implementer to call `handles.store()` inside `workflowsWaitRoute`. But token-opt **Phase 4 built the `HandleStore` in the MCP process** (`packages/mcp/src/handle-store.ts`, instantiated in `buildServer`, consumed by the MCP-side `read_handle` tool). The daemon has no handle store, and `read_handle` cannot read a daemon-side store across the process boundary. Verified load-bearing fact: the **only** consumer of the daemon `/workflows/wait` route is `packages/mcp/src/daemon-client.ts workflowWait()` (grep-confirmed; `.claude/workflows/penumbra-review-sweep.js` consumes it *through* the MCP `workflow_wait` tool, not the daemon route). So the size cap can move daemon→MCP without breaking any direct daemon consumer. This is what spec D2 ("MCP-shim-side where possible") preferred all along — S2 only went daemon-side because Phase 0 + the store didn't exist yet. See t2 `workflow-bounding-s3-architecture-correction-2026-05-29`.

**Depends on:** token-opt **Phase 4** (handle store + `read_handle`, both merged: `64a075e4`/`de1d75a4`). **Reverts** the S2 daemon truncation; bounds MCP-side instead.

### Design (the corrected shape)
1. **Daemon** `workflowsWaitRoute` — REVERT the S2 cap. Always return the full `result`/`error` plus `result_bytes`/`error_bytes`. The daemon→MCP hop is local HTTP and cheap; it is NOT the token-expensive hop. Drop `WORKFLOW_WAIT_PAYLOAD_LIMIT`/`WORKFLOW_WAIT_PREVIEW_BYTES`/`buildPayloadPreview` and the `result_truncated`/`result_preview` branches.
2. **MCP** `workflowWaitHandler` (`packages/mcp/src/tools/workflow-status.ts`) — this is where bounding belongs (the MCP→agent hop is the one the model pays tokens for). After `daemon.workflowWait(input)`, serialize `result`; if `Buffer.byteLength(serialized,'utf8') > DEFAULT_BUDGET*4` (budget.ts; ~32 KB ≈ 8000 tokens) → `handleStore.put(serialized)` and return an envelope `{ status, started_at, finished_at, result: null, result_bytes, result_truncated: true, handle_id, result_preview }` (preview via the existing surrogate-safe `truncateToTokens`); else return the full payload inline with `result_truncated: false`. Same for `error`.
3. **Wiring (the key call):** `workflow_wait` stays IN `TOOL_REGISTRY`. Thread the store through the already-present-but-unused second `opts` param of `ToolDef.makeHandler` (`(daemon, opts?) => ...`). In `buildServer`, create `handleStore` BEFORE the loop (it already exists for `read_handle` — reuse the SAME instance so handles round-trip), and change the loop call `def.makeHandler(opts.daemon)` → `def.makeHandler(opts.daemon, { handleStore })`. Every other handler ignores the second arg; only `workflowWaitHandler(daemon, opts)` reads `opts?.handleStore`. Do NOT pull `workflow_wait` out of the loop (that would churn the server.test registration-set assertion and duplicate the read_handle special-case).

### Failing tests
Rewrite `packages/daemon/test/routes/workflows-wait-bounded.test.ts` — the daemon now returns FULL payloads:
```ts
test("POST /workflows/wait returns the full result inline regardless of size (no daemon cap)");
// Arrange ~50 KB result. Assert: body.result deepEquals the original; body.result_bytes === <true bytes>;
// !("result_truncated" in body) && !("result_preview" in body)  // daemon no longer truncates
test("POST /workflows/wait still reports result_bytes/error_bytes");
```
`packages/mcp/test/tools/workflow-status.test.ts` (MCP shim is where bounding is asserted now):
```ts
test("workflow_wait returns handle_id + result:null + result_truncated for an oversized result");
test("workflow_wait round-trips: handle_id from an oversized result resolves via read_handle to the full payload");
test("workflow_wait returns the full inline result when under the budget (no handle_id)");
test("workflow_wait tool description mentions read_handle for large results");
```

### Implementation
1. `packages/daemon/src/routes/workflows.ts`: delete the S2 cap block + the three consts + `buildPayloadPreview`; the `response` object always carries full `result`/`error` + `*_bytes`. Keep timeout/429 branches unchanged.
2. `packages/mcp/src/tools/workflow-status.ts`: `workflowWaitHandler(daemon, opts?: { handleStore?: HandleStore })` — bound as in Design §2; update `WorkflowWait` description.
3. `packages/mcp/src/server.ts`: hoist `handleStore` above the TOOL_REGISTRY loop (shared with `read_handle`); pass `{ handleStore }` as makeHandler's 2nd arg.
4. `packages/mcp/src/daemon-client.ts`: `workflowWait` return type already `unknown`; tighten if useful.
5. `packages/mcp/src/tools/registry.ts`: `workflowWaitHandler` is already wired via `makeHandler`; confirm the cast still holds with the new optional 2nd param.

### Verify
```bash
bun test packages/daemon/test/routes/workflows-wait-bounded.test.ts
bun test packages/mcp/test/tools/workflow-status.test.ts
bun test packages/mcp/test/server.test.ts
bun run typecheck
```
**Daemon restart required** (route change). Resume long-lived agents if breakers trip. BOUNDARY change (daemon↔MCP contract) → adversarial-review gate before close.

---

<details><summary>ORIGINAL S3 (stale — daemon-side store assumption; kept for provenance, DO NOT implement)</summary>

**Depends on:** token-opt **Phase 4** (handle store + `read_handle` merged). **Removes** the S2 truncation block.

### Failing tests
Replace the S2 assertions in `packages/daemon/test/routes/workflows-wait-bounded.test.ts`:
```ts
test("POST /workflows/wait returns handle_id (not a truncated string) for a large result");
// Assert: typeof body.handle_id === "string"; !("result" in body); !("result_truncated" in body);
// body.result_bytes === 50000

test("handle_id from /workflows/wait resolves to the full payload via read_handle");
// wait → handle_id; read_handle(handle_id) deepEquals the original result

test("POST /workflows/wait returns inline result when below the budget");
```

### Implementation
1. Remove the `WORKFLOW_WAIT_RESULT_LIMIT` truncation block from `workflowsWaitRoute`.
2. Replace with the handle-store path (token-opt Phase 4 service):
   ```ts
   if (resultBytes > BUDGET) {
     const handle_id = await handles.store(resultStr);
     return json({ status: status.status, started_at: status.started_at,
                   finished_at: status.finished_at, handle_id, result_bytes: resultBytes });
   }
   return json({ ...status, result_bytes: resultBytes });
   ```
5. Wire the `HandleStore` singleton into the wait path following the token-opt Phase 4 wiring pattern.

</details>

---

## Sequencing

```
token-opt Phase 0 (envelope.ts)            ── S0/S1/S2 have no dependency on it
token-opt Phase 3 (top-offender migration) ── S1 lands here as a named target
    S0 (schema + getStatusLight + 400 guard)  ← start now
    S1 (status hard change)                    ← after S0
    S2 (wait truncation safety net)            ← after S1
token-opt Phase 4 (handle store + read_handle)
    S3 (wait handle bounding)                  ← after Phase 4; removes S2
```

## Open questions
1. `workflow_run(wait:true)` contract — left as-is here; track as a token-opt follow-up for post-S3?
2. Migration audit scope — any non-`packages/` consumers (CLI scripts, long-lived agent scripts) reading `.result` off `workflow_status`?
3. S3 threshold — `DEFAULT_BUDGET` (token-opt Phase 0) vs. the 8 KB S2 floor. Recommendation: `DEFAULT_BUDGET`, 8 KB as floor.
