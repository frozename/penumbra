# Workflow orchestration — adversarial-plan (harness-agnostic floor + harness-optimized edge)

> Generated 2026-06-01 via inline-spec CC adversarial-plan (architect/simplifier/risk/integration -> synthesized). Run wf_38a6d218-582.

This is a synthesis-only task. I'll merge the four planner outputs into one prioritized phased TDD plan. No tool calls needed — the inputs contain everything required.

# Phased TDD Plan: Harness-Agnostic Dispatch Orchestration Floor + Harness-Optimized Edge

**Operating principle (all four lenses agree):** Each harness runs its most-optimized orchestration; native `plugin/workflows/` is the harness-agnostic floor reachable via `workflow_run`; CC `.claude/workflows/*.js` is the CC-local accelerator on top. Porting a CC orchestration to native makes it available everywhere. All changes are additive, reversible, and (where they touch new code paths) gated by an opt-in flag. Repo-facing text stays harness-neutral; CC-specific clarifications live only in `~/.claude/CLAUDE.md`.

**Key invariants (architect) that must not break:**
- `WorkflowSpec.run` is the discriminated union `{ kind: "markdown-template" } | { kind: "ts-function" }`. Native workflows fit one.
- `WorkflowCtx.dispatch()` + `awaitChain()` are the only sanctioned native fan-out primitives. No raw `chain_start` HTTP inside a `ts-function`.
- **Landing stays with maestro.** No workflow (native or CC) calls `dispatch_land`.
- Native workflows must not import CC-only primitives (`parallel()`, `pipeline()`, `agent()`, `workflow()`). Dependency is one-directional.

---

## Phase 0 — Baseline inventory + behavior lock (INDEPENDENT; do first)

Locks current behavior at the mutation points and pins inventory so porting can't silently delete/diverge. (Risk lens; sharpened by architect Phase 0.)

**0.1 — Inventory pins**
- Failing test: `plugin/workflows/tests/inventory.test.ts` (consolidate risk's three shell scripts into one TS test for CI portability).
  - Asserts `ls .claude/workflows/*.js | wc -l` equals a pinned count.
  - Asserts native workflow dir file count equals a pinned count.
  - Asserts shared config (`plugin/`, `AGENTS.md`) contains zero `.claude/` path references and zero bare `chain_start` literals outside code blocks/tables.
- Impl: write the test; pin counts from real `ls` output. No code change.
- Verify: `bun test plugin/workflows/tests/inventory.test.ts` → green baseline.

**0.2 — Prose snapshot guards (fail now, pass after Phase 1)**
- Failing test: `packages/workflows/src/__tests__/playbook-lint.test.ts` (simplifier; one consolidated lint file for all prose assertions).
  - `playbook.md` body contains `workflow_run` and a "do not hand-roll" phrase (absent today → fails).
  - `AGENTS.md` Conventions contains a workflow-first rule (absent today → fails).
- Impl: none. Tests fail on unmodified files.
- Verify: `bun test packages/workflows/src/__tests__/playbook-lint.test.ts` → 2 fail (expected).

**Conflict — test harness style.** Risk uses standalone `.sh` scripts; simplifier/integration use TS lint tests; architect uses `*.test.ts`. **Winner: TS lint tests** — they run in the existing `bun test` suite, are CI-portable, and avoid grep false-positive fragility that risk itself flags as a hazard.

---

## Phase 1 — Enforcement: workflow-first directive at the decision moment (INDEPENDENT of Phase 2+; highest leverage)

Zero new runtime code, fires every session, reversible by editing text. All three edits are independent and parallelizable.

**1.1 — Maestro playbook directive** (passes 0.2 playbook assertion)
- Impl: edit `plugin/playbooks/maestro-context-prime/playbook.md`, between Conventions and First moves. Replace the vague `chain_start` line with:
  > For multi-step orchestration (fan-out, fix-until-green, review sweep, tournament, research): invoke the named workflow via `workflow_run` (any harness) or the harness-optimized equivalent. Do not hand-roll `chain_start` loops — the codified path handles state tracking, retries, and pass-rate gates. Dispatch a single bare `chain_start` only when no workflow covers the shape. Hand-implement only when the worker/daemon won't boot.
- Restart: none (playbook hot-loaded at session-start).

**1.2 — AGENTS.md Conventions** (passes 0.2 AGENTS assertion)
- Impl: edit `/Volumes/WorkSSD/repos/personal/penumbra/AGENTS.md` Conventions, under the `dispatch_land` bullet. Add two bullets:
  > - **Prefer the codified workflow over hand-rolled dispatch loops.** For fan-out / iterative fix / review sweep / tournament / research, call `workflow_run` (or the harness-optimized equivalent) rather than scripting `chain_start → chain_wait → chain_get_response`. Manual dispatch is reserved for single one-off dispatches.
  > - **Harness-optimized edge, harness-agnostic floor.** Each harness runs the most-optimized version available; porting an orchestration to native (`plugin/workflows/`) makes it available everywhere. The CC Workflow is the CC-local accelerator on top.
- Restart: none (committed text).

**1.3 — CC-local anti-fab de-conflict** (CC-only; not repo-tracked)
- Impl: edit `~/.claude/CLAUDE.md` anti-fab rule 3. The conflict the simplifier and integration both caught: maestro reads "one dispatch-lifecycle step per turn" as a ban on batching *any* lifecycle call, when it should scope only to the **irreversible** step. Revise to:
  > **One irreversible step per turn.** `dispatch_land` (and teardown) must each be its own turn, verified before proceeding. The fan-out lifecycle (`chain_start`/`chain_wait`/`chain_get_response`) is exempt when run inside a codified workflow or CC Workflow — the whole invocation is one turn. Hand-rolled loops outside a workflow still apply the discipline.
- Risk note (risk lens): `~/.claude/CLAUDE.md` is not repo-tracked — snapshot before editing; graceful degradation if absent (1.1/1.2 still hold). Follow-up (open question): promote into a repo-tracked CC fragment.
- Verify (local only, not CI): `grep -A3 'irreversible step per turn' ~/.claude/CLAUDE.md | grep -q 'dispatch_land'`.

**Conflict — does Phase 1 test `~/.claude/CLAUDE.md` in CI?** Architect/risk/integration propose grep tests against the user-global file; simplifier's Phase 4 adds a snapshot guard. **Winner: local-only check, no CI assertion.** The file isn't repo-tracked, so CI can't reliably read it; asserting on it makes the suite environment-dependent. Keep it a documented manual verify.

---

## Phase 2 — Prerequisite: native fan-out primitive `WorkflowCtx.parallelDispatch` (SEQUENTIAL; unblocks all ports)

The gap simplifier under-scoped and integration correctly caught: native `WorkflowCtx` has `dispatch()` + `awaitChain()` but no fan-out equivalent of CC `parallel()`. Every port below needs it. This is the single addition that lets us port without a CC dependency.

- Failing test: `packages/workflows/src/ctx.test.ts`, name `WorkflowCtx.parallelDispatch fans out N dispatches and awaits all`.
  - `parallelDispatch([input1, input2])` resolves to 2 merged results, each with `conversation_id` + `handoff_id`; both dispatches issued before either `awaitChain` (concurrency verified via fake call-log ordering).
- Impl: add `parallelDispatch(inputs, opts?)` to `packages/workflows/src/ctx.ts` as `Promise.all(inputs.map(dispatch → awaitChain → merge))`. Pure client-side over existing primitives.
- Package boundary: contained to `packages/workflows`. No daemon endpoint, no schema change, no restart.
- Verify: `bun test packages/workflows/src/ctx.test.ts && bun run typecheck`.

**Gap caught only by integration:** without 2.x, every port either copies CC primitives (violates the invariant) or hand-rolls — this phase is load-bearing.

---

## Phase 3 — Native `fanout` (P0 floor; SEQUENTIAL after Phase 2; unblocks Phases 4–5)

The floor primitive every other orchestration composes.

- Failing test: `plugin/workflows/fanout/workflow.test.ts`.
  - `inputSchema.parse({ tasks: [] })` throws; valid single-task parses.
  - Given fake `ctx`, `fn({ tasks: [t1, t2] })` → `{ ok: true, total: 2, completed: 2, branches: [...] }`; one failed `awaitChain` → `{ ok: false, failed: 1 }`.
- Impl: `plugin/workflows/fanout/workflow.ts` — `WorkflowSpec` with `run: { kind: "ts-function" }`, `triggers: [{ kind: "manual" }, { kind: "slash", command: "fanout" }]`. Zod `inputSchema` mirroring the CC args shape (`defaults?`, `tasks[]`, `timeout_ms?`). `fn` calls `ctx.parallelDispatch()`. Preserve BOUNDARY + `trust_mode:all` guard as a logged warning. No CC primitives.
- Package boundary: `plugin/workflows/` → loaded by daemon runtime.
- Verify: `bun test plugin/workflows/fanout/workflow.test.ts && bun run typecheck`.

**Conflict — CC `haiku` proxy / `agentType: penumbra-dispatcher` tool-lock.** Architect drops it (runtime manages concurrency, cheaper); the CC `.js` keeps it. **Winner: drop in native, keep in CC.** The proxy was a CC performance optimization, not a correctness requirement; native concurrency via `Promise.all` is the floor.

---

## Phase 4 — Native ports composing fanout (SEQUENTIAL after Phase 3; 4.1/4.2/4.3 independent of each other)

Each imports `fanoutFn` directly as a TypeScript call (not via `workflow_run`), sidestepping CC's one-level-nesting restriction. Schema literals copied from CC scripts, translated to Zod.

**4.1 — `fix-until-green`** (P1; most-hand-rolled multi-turn shape)
- Failing test: `plugin/workflows/fix-until-green/workflow.test.ts`. Round-1 `CHECK_RESULT: PASS` → `{ ok: true, green: true, rounds_used: 1 }`; three `FAIL` → `{ ok: false, green: false, rounds_used: 3, final_branch }`.
- Impl: `plugin/workflows/fix-until-green/workflow.ts` — sequential loop importing `fanoutFn` with a single-task args object per round, passing prior branch as `branch_base`. Inline `parseCheck()`. Escalation agent on final round preserved.
- Verify: `bun test plugin/workflows/fix-until-green/workflow.test.ts && bun run typecheck`.

**4.2 — `swarm` + `tournament`** (P2; independent of each other)
- Failing tests: `plugin/workflows/swarm/workflow.test.ts` (planner `dispatch` before `parallelDispatch`; returns `{ plan, branches }`), `plugin/workflows/tournament/workflow.test.ts` (K identical dispatches → judge dispatch → `{ winner }`).
- Impl: both import `fanoutFn`; planner/judge use `ctx.dispatch()` + `ctx.awaitChain()` (single dispatch). Validate parsed planner/judge JSON with Zod.
- Verify: `bun test plugin/workflows/swarm/workflow.test.ts plugin/workflows/tournament/workflow.test.ts && bun run typecheck`.

**4.3 — `review-sweep`** (P2)
- Failing test: `plugin/workflows/review-sweep/workflow.test.ts` — two targets → two `adversarial-review` invocations in parallel → `{ ok: true, reviewed_ok: 2 }`.
- Impl: `plugin/workflows/review-sweep/workflow.ts` uses `ctx.parallelDispatch()`; each item drives the already-native `adversarial-review`. **Watchdog-safe (integration + MEMORY.md):** native fn runs in the daemon process, so `ctx.awaitChain()` polls local handoff status — no 180s watchdog risk that the CC subagent path has. Simplify the loop accordingly.
- Verify: `bun test plugin/workflows/review-sweep/workflow.test.ts && bun run typecheck`.

**Conflict — port scope.** Simplifier ships only `dispatch-and-collect` + the floor and defers all loop workflows ("observe first"); architect/risk/integration port `fanout`/`fix-until-green`/`swarm`/`tournament`/`review-sweep`. **Winner: port `fanout` + `fix-until-green` now (Phases 3, 4.1); gate `swarm`/`tournament`/`review-sweep` (4.2/4.3) as a second wave behind Phase 2.** Justification: simplifier's "defer until a second harness is observed needing it" is right for the *low-frequency, heavy-state* workflows, but `fanout` and `fix-until-green` are the two shapes all four lenses name as most-hand-rolled — porting them is the actual value. 4.2/4.3 stay in the plan but are explicitly lower priority and skippable.

---

## Phase 5 — `dispatch-lifecycle`: codify the single most hand-glued path (SEQUENTIAL after Phase 3; INDEPENDENT of Phase 4)

The W4 core — single dispatch → wait → structured evidence, **land excluded by construction**. This is where the anti-fab reconciliation lands architecturally: the workflow never contains `dispatch_land`, so the irreversible step is always a separate maestro turn.

- Failing test: `plugin/workflows/dispatch-lifecycle/workflow.test.ts`, name `dispatch-lifecycle returns schema-validated dispatch evidence`.
  - `fn({ task, check_typecheck: true })` calls `ctx.dispatch()` once, polls `ctx.awaitChain()` in ≤90s increments (MEMORY.md watchdog note), returns `{ ok, handoff_id, conversation_id, branch, status, response_text, ready_to_land }` where `ready_to_land === (status === 'completed' && branch exists)`.
  - **Fabrication check (integration):** asserts returned `handoff_id` equals the value the fake `dispatch()` returned — not a generated string.
- Impl: `plugin/workflows/dispatch-lifecycle/workflow.ts`. Poll up to `ceil(total_timeout_ms / 90000)` iterations (default 30 min). Never calls `dispatch_land`. Returns the structured handoff; maestro runs `land` next turn.
- Verify: `bun test plugin/workflows/dispatch-lifecycle/workflow.test.ts && bun run typecheck`.

**Conflict — does the lifecycle workflow include LAND?** Risk's Phase 3a schema lists `land` as an in-workflow step (with an `irreversible: true` precondition); architect/simplifier/integration exclude it entirely. **Winner: exclude LAND.** Risk's own precondition machinery exists *because* embedding land is hazardous; the cleaner invariant — no workflow ever calls `dispatch_land` — removes the hazard instead of guarding it, and satisfies anti-fab rules 3+4 by construction. Risk's precondition-test idea is preserved in spirit as the `ready_to_land` boolean.

---

## Phase 6 — Registry + slash bridge (SEQUENTIAL after Phases 3–5; needs daemon reload)

- Failing test: `packages/workflows/src/registry.test.ts` (extend) — `registry.list()` includes `fanout`, `fix-until-green`, `dispatch-lifecycle` (+ `swarm`/`tournament`/`review-sweep` if 4.2/4.3 shipped); each has `triggers` `{ kind: "manual" }` + `{ kind: "slash", command: "<name>" }`.
- Impl: register new `WorkflowSpec` exports in `packages/workflows/src/registry.ts`; run `packages/workflows/src/slash-bridge.ts` to write `~/.claude/commands/<name>.md`. (Confirm whether auto-discovery from `plugin/workflows/*/workflow.ts` already picks these up — open question; if so, registry edit is a no-op.)
- Package boundary: `packages/workflows` (registry) → `packages/daemon` (runtime host).
- Restart: **daemon reload required** — `daemon_reload_config` (MCP) or `penumbra daemon_reload_config`. No schema migration.
- Verify: `bun test packages/workflows/src/registry.test.ts && bun packages/cli/bin/penumbra.ts workflow list | grep -E 'fanout|fix-until-green|dispatch-lifecycle'`.

---

## Phase 7 — Per-harness selection (SEQUENTIAL after Phase 6; 7.1 → 7.2 → 7.3; LOWER leverage)

Deferred-leaning per simplifier (W3 is speculative until a second harness is observed hand-rolling), but kept as a thin, additive, env-based path because integration/risk both flag that a Gemini/Codex maestro needs *some* selection signal. Auto-detection is explicitly env-var based with safe `unknown → native` fallback — no fragile capability probing.

**7.1 — Harness detection** (`TemplateVarContext` + `WorkflowCtx`)
- Failing test: `packages/workflows/src/template-vars.test.ts` — `CLAUDE_CODE=1` → `harness: 'claude-code'`; `GEMINI_CLI=1` → `'gemini'`; `CODEX_CLI=1` → `'codex'`; else `'unknown'`.
- Impl: add `harness` to `template-vars.ts` (env-based priority list); propagate as readonly `WorkflowCtx` field. No restart.
- Verify: `bun test packages/workflows/src/template-vars.test.ts && bun run typecheck`.

**7.2 — `workflow_suggest` harness-aware** (additive optional `harness` field)
- Failing test: `packages/mcp/test/tools/workflow-suggest.test.ts` — `workflow_suggest({ goal, harness: 'claude-code' })` returns `{ kind: 'cc-workflow', scriptPath }` from a static `CC_WORKFLOW_OVERRIDES` table; `harness: 'gemini'` returns `{ kind: 'native', invoke: "workflow_run({ name, ... })" }`.
- Impl: extend `packages/mcp/src/tools/workflow-suggest.ts` with optional `harness` + static override table. Additive, non-breaking.
- Restart: MCP shim reload if not hot-loaded.
- Verify: `bun test packages/mcp/test/tools/workflow-suggest.test.ts && bun run typecheck`.

**7.3 — Playbook wiring + harness dispatch matrix**
- Failing test: `playbook-lint.test.ts` (extend) — First moves block contains `workflow_suggest`; playbook contains a "Harness dispatch matrix" with rows for `claude-code`/`gemini`/`codex`/`unknown`.
- Impl: add to playbook First moves: "Before any multi-step dispatch, call `workflow_suggest` with the goal; use the returned `invoke` string verbatim." Add the matrix table (risk lens) so a non-CC operator can pick manually even without detection.
- Verify: `grep -c 'workflow_suggest' plugin/playbooks/maestro-context-prime/playbook.md` and the lint test.

**Conflict — implement W3 now or defer?** Simplifier defers entirely; architect/risk/integration build it. **Winner: build the thin env-based path + matrix (7.1–7.3), but rank it lowest leverage.** Simplifier is right that auto-routing is speculative, but the matrix table is near-free documentation that unblocks a manual Gemini/Codex operator today; env detection is ~20 lines with a safe fallback. We reject risk's `harness_matrix_complete.sh` and the heavier capability-probe — those add maintenance for unobserved need.

---

## Deferred / explicitly skipped (so non-CC maestro knows what's missing)

- **`fleet-verify` native port** — uses CC `pipeline()` (two-stage per-item). No native equivalent. Architect's two-wave `Promise.all` approximation (Option A) is the eventual path, but defer until needed; CC version keeps the optimized pipeline. (architect Phase 6 / risk Phase 4 / integration P3.)
- **`token-opt-batch`** — embeds in-workflow LAND by design for atomic batch migration. A native port would have to move land out (per the no-land invariant), making it *not* a drop-in replacement. Defer. (integration P4.)
- **`research`** — needs `WebSearch`/`WebFetch` recall sources; Gemini/Codex may lack them. Requires a capability-gate + `RecallSourceSchema` extension. Defer with a runtime capability check. (all lenses P3.)
- **`token-opt-migrate`, `adversarial-plan-topic`, `adversarial-plan-integration`** — one-off helper / CC wrappers around already-native `adversarial-plan`. Do not port. (integration.)
- **Phase 8 regression guards** (risk) — the broad `no-bare-chain_start` grep folds into Phase 0's inventory test; the standalone Phase 8 is dropped as redundant (its grep false-positive hazard is exactly why we chose TS lint over shell grep).

---

## Execution order (by leverage → safety → cost)

```
Phase 0  inventory + prose snapshots        INDEPENDENT — do first
Phase 1  enforcement prose (1.1/1.2/1.3)    INDEPENDENT of 2+ — highest leverage, parallel edits
Phase 2  WorkflowCtx.parallelDispatch        SEQUENTIAL — unblocks all ports
Phase 3  native fanout (P0)                  SEQUENTIAL after 2 — unblocks 4,5
Phase 4  4.1 fix-until-green (P1)            SEQUENTIAL after 3
         4.2 swarm+tournament / 4.3 sweep    lower priority; independent of each other; skippable
Phase 5  dispatch-lifecycle (W4 core)        SEQUENTIAL after 3; INDEPENDENT of 4
Phase 6  registry + slash bridge             SEQUENTIAL after 3-5 — DAEMON RELOAD
Phase 7  harness selection (7.1→7.2→7.3)     SEQUENTIAL; lowest leverage
```

**Restarts:** only Phase 6 (daemon reload) and Phase 7.2 (MCP shim reload). No schema migrations anywhere. **Flag/schema deltas:** all additive — new Zod `inputSchema` per workflow, optional `harness` field on `workflow_suggest`, new `WorkflowCtx.parallelDispatch` method + `harness` field. Gate the new native workflows behind an opt-in registry flag if the runtime supports per-workflow enablement (open question).

---

## Trade-offs

- **Two implementations per workflow (native + CC).** Native is the correctness floor; CC `.js` is the optimized edge. Drift is the cost. Mitigation: native ports import shared TypeScript (`fanoutFn`) rather than copying logic; Phase 0/3 schema tests catch input-contract divergence. (Risk's per-field schema-parity test is a good follow-up if drift is observed.)
- **`parallelDispatch` ≈ `parallel()`, not identical.** Loses CC's per-dispatch structured-output schema validation and the `haiku` proxy. Acceptable: Zod-typed `args` at the fn boundary + worker commit structure cover correctness; native is faster for fleet work anyway.
- **LAND excluded from every workflow.** Slightly more per-dispatch friction, but preserves the one-irreversible-step-per-turn safety property and correct `agent_performance` attribution by construction.
- **Env-var harness detection is fragile** for non-cooperating harnesses. Safe `unknown → native` fallback means no breakage, just no optimized path without config. Robust capability-probe detection is deferred.
- **`pipeline()` workflows deferred.** `fleet-verify` / `token-opt-batch` stay CC-only until the native runtime gains a `pipeline`/two-wave primitive.

## Open questions

1. **Auto-discovery vs explicit registry.** Does the daemon auto-discover `plugin/workflows/*/workflow.ts` (like `adversarial-plan`), making Phase 6's registry edit a no-op? Verify before writing registration code.
2. **Per-workflow enablement flag.** Does the runtime support gating individual native workflows behind an opt-in flag? If yes, ship the new ports disabled-by-default and flip per-workflow after verification.
3. **`~/.claude/CLAUDE.md` durability.** It's not repo-tracked (lost on rebuild). Promote the anti-fab de-conflict into a repo-tracked CC fragment imported by reference?
4. **`parseCheck` / planner-JSON contract stability.** The CC scripts parse `CHECK_RESULT: PASS|FAIL` and planner JSON from free response text. Native ports inherit this fragility — worth a stricter structured-output contract if the runtime can enforce one.
5. **Watchdog scope.** Confirm the 180s watchdog applies only to CC subagent MCP calls and not to in-daemon `ctx.awaitChain()` (integration asserts the latter is safe) before relying on the simplified Phase 4.3 loop.
