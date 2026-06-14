# CC-Workflow ⇄ penumbra-maestro mutual augmentation — adversarial-plan

> Generated 2026-05-30 via adversarial-plan-integration workflow (CC Workflow, not hand-orchestrated).
> Personas: architect, simplifier, test-first, risk, integration (0 failed). Synthesizer: workflow default.
> Anchor: HEAD a8e327b6. Source-verified by planners; brief corrected in 4 places (see top of plan).

# Merged Phased TDD Plan: CC-Workflow ⇄ penumbra-maestro Mutual Augmentation

**Ordering law:** (a) unblock-most-work, (b) safety-criticality, (c) cost. Landing stays maestro-owned; penumbra code changes go via the fleet + TDD; ultracode ON. All paths absolute. Anchor: HEAD `a8e327b6`.

**Verified ground-truth corrections that reshape the brief** (cross-confirmed by ≥2 planners):
- **C8 is mis-framed in the brief.** Teardown is NOT a no-op — `teardownWorktree` is symlink-aware (`removeNodeModuleSymlinks`, `manager.ts:298-301`) and deletes the branch (`manager.ts:313`). The *real* defects: (1) the route also runs `git branch -D` itself (`dispatch-land.ts:515`) → **double-delete**; (2) the route reports `worktree_torn_down:true` from a try/catch that can diverge from disk reality; (3) after a daemon restart the in-memory `worktrees` map is empty, so teardown hits the `!handle` branch — removes the dir but skips the branch and still reports optimistically (integration planner's finding).
- **C9 is a producer-side gap, not a sink gap.** `resolveToolOrigin` already reads `x-penumbra-origin`/`_meta.origin`; it returns `"unknown"` because maestro, fleet-worker, and sub-agent MCP clients never set it. Fix is at injection sites + an env/context fallback.
- **C10 has a live bug in the batch script:** `penumbra-token-opt-batch.js:166` passes `rebase=true` to `dispatch_land`, which has no such param (`mode: "squash"|"ff"`). The script's land step calls a non-existent param today (integration planner). This gates running the batch.
- **C12:** `task_type` still consumed by `agent-routing.ts` + `agent_performance` rows — it is NOT unused, so deprecate-in-place, don't remove.

---

## Conflict resolutions (named, with the winner)

1. **A2 (`dispatch_land_batch`) + A3 (interlock): keep both, but gated — REJECT the simplifier's cut.** Simplifier argues the `for…await` loop already serializes and A2/A3 are speculative. Four other planners (architect, test-first, risk, integration) independently flag the same hazard: the loop only serializes *within one process/run*; it provides **zero protection against a concurrent interactive `dispatch_land` from maestro or a second workflow run** racing rebase+squash on `main`. That cross-process race is exactly the data-loss/fabrication surface this whole effort exists to close. *Winner: keep A3 (the enforced interlock) and A2 (daemon-owned ordering). Justification: the simplifier's "the loop is the serialization" is only true single-process; the verified hazard is cross-process, which prose and a loop cannot fence.* **However, adopt the simplifier's discipline on A2:** build it behind a real consumer (the batch workflow) and keep it a thin composition of the single-land path — no new git logic.

2. **A3 semantics — reject vs serialize:** risk and integration split. *Winner: serialize via an async mutex that the batch path can also call with `reject_if_held` for a fast structured refusal.* Justification: the mutex IS reusable as the A2 ordering primitive (one mechanism, not two), and a structured `lifecycle_busy` refusal is available for callers that prefer to learn-and-serialize rather than block.

3. **Guard override mechanism (B4) — sentinel file vs inline-token parsing:** all five converge on "don't read the hook's own process env." *Winner: sentinel file (TTL-bounded) as the primary, plus parse an inline `PENUMBRA_ALLOW_AGENT_GC=1` token from the command string and `tool_input.env` as secondary paths.* Justification: the sentinel leaves an auditable artifact and works across the process boundary; the inline-token parse covers the form operators actually type.

4. **Hook test location / canonicalization:** test-first wants to mirror the hook into the repo (`scripts/hooks/`) for CI-testability; risk hosts tests under `packages/cli/test/hooks/`; architect/simplifier/integration keep it at `~/.claude/hooks/`. *Winner: keep the hook canonical at `~/.claude/hooks/` and host tests in-repo, but DEFER the repo-mirror+symlink move to an open question* (it adds an install step and is not required for the safety fix to land). Tests shell out to the absolute hook path. Justification: smallest change that unblocks B6 now; the mirror is a hygiene improvement, not a blocker.

5. **C8 scope:** architect took the brief literally ("make teardown actually tear down"); test-first/integration found teardown already works and the real bugs are double-delete + optimistic boolean + restart-rediscovery. *Winner: the corrected scope (truthful reporting + single-source-of-truth deletion + restart rediscovery).* Justification: source-verified; the literal reading would re-add logic that exists.

6. **C11 auto-detect vs input signal:** architect/test-first/risk all land on "take completeness as an input now, defer the auto-detector." *Winner: input-signal, advisory-gating (blocks auto-accept, never force-rejects), config-thresholded, NULL-default for historical rows.* Move to a late/optional phase (lowest unblock value).

7. **Phase 0 harness:** architect/test-first/integration all want the workflow scripts made importable (`run(ctx, args)` with injected globals). *Winner: keep it, but fold it into the first workflow-smoke phase rather than a standalone phase* — it's one refactor, not its own wave.

---

## Dependency / parallelism map

```
Wave 1 (parallel, independent surfaces — hook / workflow-JS / MCP-origin):
  P1 guard (B4,B5,B6)   P2 workflow-smoke+harness (B7, C10-precursor)   P3 origin (C9)

Wave 2 (parallel, different packages):
  P4 dispatch-land ergonomics+teardown (C10, C8)     P5 task_type drift (C12)

Wave 3 (sequential tail — all touch dispatch-land.ts + the land path):
  P6 interlock (A3)  ->  P7 batch validate+harden (A1)  ->  P8 dispatch_land_batch (A2)

Anytime after P3 has data:
  P9 contract-completeness (C11)  [optional]
```

Critical-path-to-throughput: **P1 → P6 → P7 → P8**, with P4 feeding P6/P8.

---

## Phase 1 — Guard hardening + regression suite (B4, B5, B6)

**Covers:** B4, B5, B6. **SAFETY-CRITICAL. Independent (parallelizable).** Own review (B5 broadens a destructive matcher). No daemon involved.

This is first because the guard is the only backstop against a repeat of the data-loss incident, and we must not increase parallel destruction paths (P7/P8) before it is correct *and tested*. Tests lock current correct behavior before B4/B5 touch the file.

- **Failing test (new):** `/Users/acordeiro/.claude/hooks/test/penumbra-agent-gc-guard.test.sh` (plain bash + `mktemp -d` throwaway repos; use `bats` only if `command -v bats` succeeds, else a plain-sh harness). Each case pipes a PreToolUse JSON (`{"tool_input":{"command":...},"cwd":<tmp>}`) and asserts exit code:
  - **Characterization (must pass against current hook):** unlanded→2; tip ancestor-of-main→0; squash empty-diff→0; stale-base own-files-empty→0; fail-open (no `jq` via `PATH` shim / no repo / branch absent)→0; non-destructive cmd (`git status`)→0.
  - **B4 (initially red):** inline `PENUMBRA_ALLOW_AGENT_GC=1 git branch -D agent/<uuid>` on unlanded → must end at exit 0 once fixed (proves inline prefix never reached hook env before); sentinel-file present → exit 0; sentinel absent → unlanded still blocks.
  - **B5 (initially red), each on an unlanded branch → exit 2:** `git update-ref -d refs/heads/agent/<uuid>`; `git push origin :agent/<uuid>`; `git push origin --delete agent/<uuid>`; `rm -rf <repo>-worktrees/<uuid>`; `git branch --delete --force agent/<uuid>`.
- **Impl** in `/Users/acordeiro/.claude/hooks/penumbra-agent-gc-guard.sh`:
  - **B4:** override from (i) sentinel file `${TMPDIR}/penumbra-allow-agent-gc` or `<repo>/.penumbra-allow-agent-gc`, TTL-bounded by mtime; (ii) inline `PENUMBRA_ALLOW_AGENT_GC=1` token parsed from `$cmd`; (iii) `tool_input.env.PENUMBRA_ALLOW_AGENT_GC`; keep the existing process-env read as a fourth fallback. Never block-blindly: any override-parse uncertainty falls through to the diff checks.
  - **B5:** broaden the `case` (L38-41) to ref-deletion *intent*: add `update-ref -d`, `push * :<ref>`, `push *--delete`, `branch --delete`, and `rm -rf` targeting `*-worktrees/<uuid>`. Extend the token extraction (L44-46) to also capture `worktrees/<uuid>` and map it back to its branch via `git worktree list --porcelain`. For `push --delete`/`push :ref`, compare against `origin/main` (remote landing) and label the block message "remote ref". **Fail-open on any unparseable ref/path** — the guard is a safety net, not a perimeter (risk planner's explicit call; accepted to avoid wedging the session).
  - Deliberately do NOT chase arbitrary aliases/obfuscation (simplifier + risk): threat model is the operator's own bundled mistake, not an adversary. Match the high-frequency literal vectors and stop.
- **Verify:** `bash /Users/acordeiro/.claude/hooks/test/penumbra-agent-gc-guard.test.sh` all green. **No restart** (hooks load per-invocation).

---

## Phase 2 — Workflow-script smoke tests + importable harness + fix the live land-param bug (B7, C10-precursor)

**Covers:** B7. **Independent (parallelizable).** No daemon, no fleet — pure JS arg-parse + shape assertions. Test-only + one string fix.

The batch script is the throughput engine but has never run and currently calls `dispatch_land` with a non-existent `rebase=true`. Smoke tests surface this for free and make the scripts safe to validate live in P7.

- **Harness refactor (folded in):** make both workflow scripts importable — wrap each body in `export default async function run(ctx){...}` taking injected `{ agent, pipeline, phase, log, args }`, keep `meta` exported, guard any top-level execution behind `import.meta.main`. New `/Volumes/WorkSSD/repos/personal/penumbra/.claude/workflows/test/_harness.ts` exposing `loadWorkflow(name)` with mocked globals.
- **Failing tests (new):** `/Volumes/WorkSSD/repos/personal/penumbra/.claude/workflows/test/token-opt-scripts.test.ts` (bun test), covering both `penumbra-token-opt-batch.js` and `penumbra-token-opt-migrate.js`:
  - args as JSON string parses; args as object passes through; non-JSON string throws the documented error.
  - empty/missing `migrations` throws; migration missing `tool`/`dispatchPrompt` throws.
  - dispatch returning `branch:"MISSING"` → item classified `skipped:'no-branch'`, never reaches verify/land.
  - **no-auto-land guarantee:** with `push:false`, no land `agent()` call is issued for any item whose verify verdict ≠ `pass`, and no `git push` is ever requested.
  - **land is sequential:** instrument the mocked land `agent()` with enter/exit timestamps; assert no two land calls overlap.
  - **land params match `DispatchLandInputShape`** — fails today (`rebase=true`).
  - migrate-specific: `land_hint.command` contains the verbatim `handoff_id`; migrate never issues `dispatch_land`.
- **Impl:** correct the batch land prompt (`penumbra-token-opt-batch.js:166`) `rebase=true` → `mode="squash"`; note `commit_message` requirement (set up by C10/P4). Keep manual teardown in the prompt for now, guarded by the Phase-1 hook; it is replaced by truthful `dispatch_land` teardown in P7 once P4 lands.
- **Verify:** `bun test /Volumes/WorkSSD/repos/personal/penumbra/.claude/workflows/test/token-opt-scripts.test.ts`. **No restart.**

---

## Phase 3 — Real MCP invocation origin (C9)

**Covers:** C9. **Independent (parallelizable).** Highest unblock value after safety — gates frequency-weighted migration ranking. **Package boundary:** `packages/mcp` (resolver + injection) + federation client. No core schema change (`InvocationRow.origin` exists).

- **Failing tests:** extend `/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/test/tool-origin.test.ts` and `.../packages/mcp/test/instrumentation.test.ts`:
  - `extra` with no header and no `_meta` but a server-context/env identity → `resolveToolOrigin` returns `maestro` | `fleet-worker` | `sub-agent`, not `unknown`.
  - federated/proxied call → `fleet-worker`; direct maestro call → `maestro`.
  - precedence: explicit `_meta.origin`/header wins over env/context (federation's innermost origin preserved, not relabeled by an outer hop).
- **Impl:**
  - `/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/tool-origin.ts`: fallback chain after header/`_meta` → server-context default (threaded via `instrumentHandler`'s `serverCtx`, already available at `server.ts:105`) → `PENUMBRA_MCP_ORIGIN` env → `unknown` last resort.
  - `/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/instrumentation.ts:96`: thread the context/env origin so the common case resolves; keep `?? "unknown"` only as genuine last resort; add a fallthrough counter so a high `unknown` rate is visible.
  - **Injection (the actual fix):** set `PENUMBRA_MCP_ORIGIN` (or stamp `x-penumbra-origin`) at each MCP-client spawn site — fleet worker in `packages/agentchat` → `fleet-worker`; maestro harness → `maestro`; sub-agent dispatch → `sub-agent`; and stamp `x-penumbra-origin: fleet-worker` in `/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/federation/client.ts`. Centralize the three constants as `type ToolOrigin` in `@penumbra/api-contract`.
- **Schema delta:** add `PENUMBRA_MCP_ORIGIN` to `packages/config/src/env.ts`. Document `PENUMBRA_MCP_INVOCATION_LOG_ENABLED` must be on (`instrumentation.ts:90`).
- **Restart:** **MCP shims** (maestro + fleet); daemon NOT needed (sink lives in the MCP process). Order: rebuild `@penumbra/mcp` → restart maestro shim → restart fleet shims.
- **Verify:** `bun test packages/mcp/test/`; tail the invocations JSONL after restart, confirm non-`unknown` origins.
- **Security note (flagged for the future):** origin is observability-only — must NOT later gate any permission off a spoofable header without server-side re-derivation.

---

## Phase 4 — `dispatch_land` ergonomics + truthful, restart-safe teardown (C10, C8)

**Covers:** C10, C8. **Independent of P1-P3; gates P6/P8. Sequential pair (share `dispatch-land.ts` + one daemon restart).** Own review for the teardown half (deletes branches in a restart path). **Package boundary:** `packages/daemon` (route) + `packages/core` (worktree manager) + `packages/mcp` (relax `.min(1)`).

### 4a — C10: default `commit_message` to the branch's own subject
- **Failing test:** `/Volumes/WorkSSD/repos/personal/penumbra/packages/daemon/test/routes/dispatch-land.test.ts` — POST `{ handoff_id }` with no `commit_message`; seed branch tip subject `feat: x`; assert 202 → landed with `message_subject === "feat: x"` (today: 400 zod error). Mirror in `.../packages/mcp/test/tools/dispatch-land.test.ts`.
- **Impl:** daemon route is authority. Make `commit_message` `.optional()` in `DispatchLandInputSchema` (`dispatch-land.ts:9-15`); when absent, derive via `runGit(["log","-1","--format=%s", branch])` **before** checkout/merge (capture while ref intact); fall back to `land ${handoff_id}`. Relax `.min(1)`→`.optional()` in the MCP shape (`/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/tools/dispatch-land.ts:6`) with updated `.describe()`. Echo the resolved `commit_message` in the result (auditable, no hand-narration). Default computed **server-side only** so maestro/fleet/federation/CLI all behave identically.
- **Schema delta:** `commit_message` optional in route schema + MCP shape + any `@penumbra/api-contract` type.

### 4b — C8: truthful, double-delete-safe, restart-safe teardown
- **Failing tests:**
  - **Truthfulness/restart** (`packages/core/test/worktree/manager*.test.ts` + `packages/daemon/test/routes/dispatch-land.test.ts`): fresh `WorktreeManager` (empty in-memory `worktrees` map, post-restart) with worktree dir + branch still on disk → `teardownWorktree(handoff_id)` rediscovers, removes symlink-safely, deletes the branch, returns `{ worktree_removed, branch_deleted, path }`; route sets `worktree_torn_down` from the real `removed` flag, not "didn't throw."
  - **No double-delete:** spy on `runGit`; assert `["branch","-D","agent/<id>"]` issued exactly once across the whole land (today: route L515 + teardown L313).
  - **Symlink safety regression:** worktree with `node_modules` symlink into MAIN → teardown → assert MAIN's `node_modules` survives unmodified (delete the link, never recurse).
- **Impl:** in `manager.ts`, change `teardownWorktree` return `void`→ a small result object; in the `!handle` rediscovery branch also resolve+delete `agent/<handoffId>` and run `removeNodeModuleSymlinks` before `git worktree remove` (UUID-exact path join only — review guards against matching the wrong handoff). In `dispatch-land.ts`, **remove the route-level `git branch -D` (L513-517)** so teardown is the single deletion source; set `worktree_torn_down`/`branch_deleted` from the returned result; on failure record the orphan where `worktree-gc` can sweep it.
- **Risk callout:** changing the teardown return type touches every caller — grep `teardownWorktree(` (route, `worktree-gc`, long-lived/teardown, routes/worktrees) and update.
- **Schema delta:** `DispatchLandSuccess.worktree_torn_down:boolean` → keep the boolean but back it with truth, plus optional `teardown:{ worktree_removed, branch_deleted, orphan_path? }` for callers/GC (api-contract update).

- **Restart:** **daemon** (route + manager) + **MCP shims** (C10 schema relaxation). Order: rebuild core/daemon/mcp → restart daemon → restart shims.
- **Verify:** `bun test packages/core/test/worktree/ packages/daemon/test/routes/dispatch-land.test.ts packages/mcp/test/tools/dispatch-land.test.ts`.

---

## Phase 5 — `task_type` deprecation drift (C12)

**Covers:** C12. **Independent (parallelizable), lowest cost.** No behavior change. Sequence after C9 only to avoid file-churn on the ranking path. **Package boundary:** `packages/mcp` + `packages/core` schema.

- **Failing test:** `/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/test/tools/chain-start.test.ts` — assert `task_type`'s `.describe()` contains a deprecation marker pointing to `workload`, `workload` is documented as primary, the alias-resolution (chain-start.ts:164-178) still maps legacy `task_type`→`workload`, and the deprecation logs exactly once (reset via `resetChainStartTaskTypeDeprecationForTests`).
- **Impl:** **deprecate-in-place, do NOT remove** (`task_type` is still consumed by `agent-routing.ts` + `agent_performance`; removing the wire field severs ranking continuity). Update `.describe()` on `task_type` (`chain-start.ts:44`) to `"DEPRECATED: use 'workload'. Accepted as an alias for back-compat."`; promote `workload` to primary; leave `chain.ts:24` accepting it with an alias-only comment; mirror parity in `agent_recommend` schema (`packages/daemon/src/routes/agents.ts`). **Coupled follow-up:** update both workflow scripts to pass `workload` instead of `task_type` (one line each — batch L114, migrate L64).
- **Restart:** **MCP shims** (advertised schema). Daemon NOT needed (already maps `task_type`).
- **Verify:** `bun test packages/mcp/test/tools/chain-start.test.ts`.

---

## Phase 6 — Runtime dispatch-lifecycle interlock (A3)

**Covers:** A3. **SAFETY for parallelism. Sequential — gated by P4 (shares `dispatch-land.ts`), gates P8.** Own review (lock TTL / crash release). **Package boundary:** `packages/daemon` (lock service) + `packages/mcp` (surface refusal as structured result).

Converts anti-fab rule 3 ("one dispatch-lifecycle step per turn") from prose into an enforced primitive. The existing `dispatchLandQueue` (`dispatch-land.ts:85`) serializes within one process but is invisible and gives no cross-call/cross-process guard — exactly the hidden state that breeds fabrication under parallelism.

- **Failing test:** `/Volumes/WorkSSD/repos/personal/penumbra/packages/daemon/test/routes/dispatch-land-interlock.test.ts` — fire two `dispatch_land` concurrently for different handoffs; assert they do not interleave git writes (instrument `runGit` ordering), and the second either serializes behind the lock or (with `reject_if_held`) returns a structured `{ ok:false, error:{ code:"lifecycle_busy", holder, retry_after_ms } }` (not a thrown 500, not a silent queue). Same-handoff retry is idempotent (returns in-flight task_id). Include a land that **throws mid-way** → assert the lock is released (no wedge).
- **Impl:** new `/Volumes/WorkSSD/repos/personal/penumbra/packages/daemon/src/dispatch/lifecycle-lock.ts` — single-holder async mutex keyed on the contended resource (repo git-write), acquired around checkout→merge→commit→rev-parse, released in `finally`, with a stale-lock TTL + holder+timestamp so a crashed land is reclaimable. Keep `dispatchLandQueue` as the same-process fast path; the lock is the cross-call contract. Map `lifecycle_busy` to a clean MCP result in `packages/mcp/src/tools/dispatch-land.ts`. Add optional `reject_if_held` to `DispatchLandInputShape`. Emit a `lifecycle_lock_held_ms` metric.
- **Schema delta:** `reject_if_held: z.boolean().optional().default(false)`; optional `PENUMBRA_LIFECYCLE_LOCK_TIMEOUT_MS`.
- **Restart:** **daemon** (route logic — full restart, not `daemon_reload_config`).
- **Verify:** interlock test green; existing `dispatch-land.test.ts` green; drive the sequential batch land loop and confirm it never trips `lifecycle_busy` (lock is invisible to correct serial landing).

---

## Phase 7 — Validate + harden the batch workflow, first real run (A1)

**Covers:** A1, B7 (remainder). **Sequential — depends on P2 (harness), P4 (truthful teardown), P6 (interlock).** Own review (writes to main, deletes branches). Medium cost (dispatches).

The script already has the right shape (parallel dispatch+verify barrier → sequential land loop, `:154-178`). Hardening makes that serialization daemon-defended and splits land from teardown so the data-loss-shaped *bundling* (`:163-176`, STEP 5) becomes control-flow, not prose.

- **Failing tests** (extend P2's harness): mock land `agent` to return "dispatch_land errored" → assert the workflow issues **no** teardown call for that item (structural, not trust-based). Assert with the interlock live: a second concurrent batch run is serialized/refused, never interleaved.
- **Impl — split land and teardown into two workflow turns (land-before-teardown as control flow):**
  1. Turn A `land:<tool>`: only `dispatch_land` (now `mode="squash"`, default `commit_message` from P4) + read `head_after` + compute `content_in_main`. No deletion in this prompt.
  2. JS gate (workflow, not agent): `if (!landResult.landed || !landResult.content_in_main) { failed.push; continue; }`.
  3. Turn B `teardown:<tool>`: delegate to `dispatch_land`'s now-truthful teardown (P4) rather than hand-rolled `rm`/`git worktree remove`; `cleaned_up` reported only after independent `git worktree list`/`rev-parse` confirmation.
- **Live validation (GATED — pause and ask):** run `workflow_run penumbra-token-opt-batch` on **2** low-risk un-migrated tools, `push:false`. Confirm: both dispatch+verify in parallel; land strictly sequential; HEAD advances by exactly the landed count; each landed tool's own files byte-identical in main; no orphan `*-worktrees/` dirs; no stale override sentinel afterward. **Maestro does the single `git push`** after reviewing HEAD. (Blast-radius + cost gates → confirm before running.)
- **Restart:** none for the script itself (inherits P4/P6 restarts).
- **Verify:** harness tests green; live run as above.

---

## Phase 8 — `dispatch_land_batch([handoff_ids])` primitive (A2)

**Covers:** A2. **THROUGHPUT capstone. Sequential — depends on P4 (default msg + truthful teardown), P6 (interlock), P7 (validated workflow).** Own review (widest blast radius — one primitive driving multiple main mutations). **Package boundary:** `packages/daemon` (route) + `packages/mcp` (tool + registry) + `@penumbra/api-contract`.

Moves land-ordering ownership out of the workflow loop and into penumbra so the fleet runs fully parallel while the daemon serializes git writes. Pure composition of P4 + P6 — **no new git logic** (adopting the simplifier's anti-overengineering discipline even while keeping the primitive).

- **Failing tests:** `/Volumes/WorkSSD/repos/personal/penumbra/packages/daemon/test/routes/dispatch-land-batch.test.ts` — POST `{ handoff_ids:[a,b,c], push? }` → lands strictly sequentially under the P6 lock, each re-resolved onto the current `main` tip (monotonic advance, no lost update), returns a per-id result array `[{ handoff_id, ok, commit_sha, message_subject, worktree_torn_down, branch_deleted, error? }]`; **stop-on-first-failure default** (avoid landing on a possibly-inconsistent main) with the decision surfaced; teardown per id via P4; result carries `main_tip_before`/`main_tip_after` for deterministic verify/revert. Concurrent two batch calls → serialized by P6. New `packages/mcp/test/tools/dispatch-land-batch.test.ts` for the thin shim.
- **Impl:** new route `/Volumes/WorkSSD/repos/personal/penumbra/packages/daemon/src/routes/dispatch-land-batch.ts` iterating `executeLand` per id under the P6 lock; new tool `/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/tools/dispatch-land-batch.ts` registered in `packages/mcp/src/tools/registry.ts`; `DispatchLandBatchRequest`/`DispatchLandBatchResult` in `@penumbra/api-contract`. Emit one `dispatch.landed` event per item + `batch_land_duration_ms`.
- **Workflow rewrite (A1 final):** replace the Land `for`-loop in `penumbra-token-opt-batch.js` with a **single** `dispatch_land_batch` call carrying the verified handoff_ids; the workflow returns the structured per-id array verbatim (impossible to confabulate). DispatchVerify stays full-width parallel; the only serialized step now lives inside penumbra.
- **Schema delta:** new MCP tool schema `{ handoff_ids, commit_messages?, mode?, stop_on_error?, push? }`; api-contract batch types.
- **Restart:** **daemon** (new route) + **MCP shims** (new tool). Order: rebuild core/daemon/mcp/api-contract → restart daemon → restart shims.
- **Verify:** `bun test packages/daemon/test/routes/dispatch-land-batch.test.ts packages/mcp/test/tools/dispatch-land-batch.test.ts`; then a **gated** live 2-3 id run with `push:false` after P7's live run is clean.

---

## Phase 9 — Contract-completeness signal (C11) [OPTIONAL, anytime after P3 has data]

**Covers:** C11. **Independent. Lowest unblock value — does not gate throughput.** Own review (schema migration). **Package boundary:** `packages/core` (reliability/capture + schema migration) + `packages/mcp`/`packages/daemon` (agent_recommend wiring).

A 12-tool dispatch that did 2/12 currently scores `complete`/`accept`, poisoning the recommender.

- **Failing test:** `packages/core/test/services/dispatch-reliability*.test.ts` (+ `agent_recommend` test) — input where the contract enumerated N deliverables but evidence shows k≪N → `recommended_action !== "accept"`, a `completeness:{ declared, observed, ratio }` block with `trustworthy=false` below threshold; a 2/12 dispatch ranks below a 12/12 of equal merge state.
- **Impl:** extend `DispatchReliabilityInput` with optional `contract:{ declared_units }` and derive `observed_units` from dispatch evidence; add a `completeness` clause to `classifyDispatchReliability` that downgrades `accept`→`revise` (advisory-gating: blocks auto-accept, never force-rejects). Thread through `dispatch-audit.ts` and into `agent_recommend` success-rate accounting. Add `completeness REAL NULL` to the agent_performance table (migration; historical rows default NULL = "unknown," not penalized). Threshold config-driven in `packages/config`, default conservative.
- **Restart:** **daemon** (+ migration on start).
- **Verify:** core + `packages/mcp/test/tools/agent-recommend*.test.ts`.

---

## Scope-coverage matrix

| Phase | Scope | Independent? | Depends on | Restart | Own review |
|---|---|---|---|---|---|
| 1 | B4,B5,B6 | yes | — | none (hook) | yes (B5 matcher) |
| 2 | B7, C10-precursor | yes | — | none | no |
| 3 | C9 | yes | — | MCP shims | light |
| 4 | C10, C8 | yes | — | daemon + MCP shims | yes (4b) |
| 5 | C12 | yes | after C9 (hygiene) | MCP shims | no |
| 6 | A3 | no | P4 | daemon | yes (lock TTL) |
| 7 | A1, B7-rem | no | P2, P4, P6 | none (inherits) | yes (lands to main) |
| 8 | A2 | no | P4, P6, P7 | daemon + MCP shims | yes (widest) |
| 9 | C11 | yes (optional) | P3 (data) | daemon + migration | yes (migration) |

**Maximally-parallel first wave:** P1, P2, P3 (hook / workflow-JS / MCP-origin — zero shared files). Then P4 + P5 in parallel (different files/packages). Strictly sequential tail: P4 → P6 → P7 → P8. P9 whenever data exists. **Batch daemon restarts:** P4 (one), P6 (one), P8 (one) to minimize churn.

---

## Trade-offs

- **Kept A2+A3 over the simplifier's cut.** The `for…await` loop only serializes single-process; the verified hazard is a cross-process concurrent land (interactive maestro or a second run) racing rebase+squash on main — the exact data-loss/fabrication surface. Cost: a new daemon lock + a new primitive + restarts. Benefit: concurrent landing becomes structurally impossible, not prose-discouraged. We did adopt the simplifier's discipline: A2 is a thin composition of the single-land path with no new git logic, and is built only behind a real consumer.
- **A3 serializes (not rejects) by default, with `reject_if_held` available.** One mutex doubles as the A2 ordering primitive; the structured refusal is opt-in for callers that prefer to learn-and-serialize. Liveness risk (hung land holds the lock) is bounded by a TTL + reclaimable holder row.
- **Guard matcher is deliberately incomplete (B5)** and fails-open on ambiguity. Threat model is the operator's own bundled mistake, not an adversary; a guard that wedges the session would get disabled, which is strictly worse. The land-before-teardown control-flow split (P7) means the guard is a backstop, not the only defense.
- **C8 reframed against the brief** to the source-verified defects (double-delete, optimistic boolean, restart-rediscovery, symlink-safe). The literal "make teardown actually tear down" would have re-added existing logic.
- **C11 takes completeness as an input and is advisory-gating, NULL-default for history.** The auto-detector (deriving declared/observed from a contract) is deferred; better a partial signal now than blind accept, and advisory-gating avoids false-rejecting legitimately small diffs.
- **Cut from the inputs:** standalone "Phase 0 harness" (folded into P2); the `dispatch_land_batch` measurement-gate phase (simplifier's Phase 6 — we keep A2 outright since the cross-process hazard justifies it regardless of wall-clock); the repo-mirror of the hook (deferred — see open questions); aggressive alias/obfuscation matching in B5; a self-clearing one-shot override sentinel; per-call wire-field origin (env/context fallback is the cheap correct fix, `_meta` precedence retained for federation).

## Open questions

1. **Hook canonicalization:** keep the guard at `~/.claude/hooks/` with in-repo tests shelling to the absolute path (current plan), or mirror it to `/Volumes/WorkSSD/repos/personal/penumbra/scripts/hooks/` + symlink for CI-testability? The mirror adds an install step; recommend deferring unless CI must run B6.
2. **A2 batch failure semantics:** stop-on-first-failure (chosen default, conservative) vs continue-on-error (risk/integration leaned continue, with per-id truthful results). Continue-on-error gives more throughput but leaves main advanced for some ids — acceptable only if the per-id array + `main_tip_before/after` are trusted as the recovery contract. Confirm preference before P8 impl.
3. **A3 lock granularity / scope:** in-process mutex (covers single-daemon, the common case) vs a sqlite-backed `dispatch_land_lock` CAS row (covers an out-of-band `git merge` from the home checkout during a land). The DB lock is stronger but heavier; confirm whether out-of-band home-checkout merges during a land are a real risk worth the cross-process lock.
4. **C9 sub-agent origin:** confirm sub-agent dispatches spawn their own MCP client (so env-at-spawn attributes correctly) vs reusing the worker's — if reused, sub-agent rows will tag `fleet-worker`. Granularity acceptable?
5. **Live-run authorization:** P7 and P8 each include a gated live run that writes to local main + burns fleet cost. Pre-authorize a 2-tool `push:false` run, or pause for explicit confirmation each time?
