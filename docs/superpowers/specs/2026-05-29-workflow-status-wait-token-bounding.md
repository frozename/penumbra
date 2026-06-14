# Spec — Token-bound `workflow_status` / `workflow_wait` MCP responses

**Status:** ready for adversarial planning · **Date:** 2026-05-29 · **Origin:** `task_653bfa4e` (closed-as-fixed; see below)

## TL;DR for planners

Produce a **phased TDD plan** that makes the penumbra MCP tools `workflow_status` and
`workflow_wait` return token-bounded responses, **reusing the machinery from the in-flight
MCP token-optimization plan** (`docs/superpowers/plans/2026-05-27-mcp-token-optimization.md`)
so this work can **land together with / as a named slice of** that plan rather than as a
piecemeal fix that later collides with its envelope + handle-store design.

The deliverable is a plan, not code. Each phase must start with a failing test (name,
assertion, file path), name the smallest implementation, and name the exact verify command.

## Context & motivation

`task_653bfa4e` was filed 2026-05-21 reporting `mcp__penumbra__workflow_wait` returns
`HTTP 400` immediately. **That 400 is already fixed** on current `main` (`a0ba98b5`): the
config/routing refactor (~05-26) unified scope resolution so `workflowsStatusRoute` and
`workflowsWaitRoute` both call `resolveWorkflowScopeOrReject(body.cwd ?? process.cwd(), …)`
against the daemon cwd (the penumbra repo root), which resolves to the registered "penumbra"
project. **Do not re-fix the 400** — instead include a regression test that guards it.

The *real* residual blocker — the reason the supported MCP wait/status path is still avoided
in favor of Bash/`grep` and reading `.penumbra/reviews/<ts>/` directly — is **response size**:
both tools inline the **entire** workflow result into the MCP response.

## Evidence (live reproduction, this session)

- Ran `workflow_run({name:"memory-digest", wait:false})` → run id `5b624033-68fb-4e88-b925-1b51efbeded5`.
- `workflow_wait` on it → **100,795-byte** success body (`{"status":"completed","result":{"outcome":"success","runResult":"<full digest>"}}`).
- `workflow_status` on it → **100,832-byte** success body — *the full result too*.
- Both exceeded the MCP harness inline-token limit and were spilled to tool-result files; the model cannot read them inline.
- Neither returned a 400 → the filed bug does not reproduce.

`memory-digest` is a *small* workflow; adversarial-plan/review synthesis results are larger.
A `workflow_status` call — a cheap liveness/progress check — returning ~25K tokens of payload
is the core defect.

## Current architecture (precise references — verify before acting)

- **Routes:** `packages/daemon/src/routes/workflows.ts`
  - `workflowsStatusRoute` (~L541): returns `json(await workflowRuns.getStatus(id))` — the
    status record **includes the full `result`**.
  - `workflowsWaitRoute` (~L564): returns `json(status)` where `status` is the full record
    incl. `result`/`error`.
  - Both already share `resolveWorkflowScopeOrReject` and the `info.project_id !== scope.project`
    → 404 check. Scope resolution is **not** the problem.
- **Registry:** `packages/daemon/src/services/workflow-runs-registry.ts`
  - `INLINE_JSON_LIMIT = 64 * 1024`: results larger than 64 KB are **already spilled to disk**
    at `<storageRoot>/.penumbra/workflow-runs/<id>.json` (`writePayload`), and the DB stores
    `result_spill_path`. **But** `readPayload` reads the spill back, and `getStatus` /
    `waitForResult` return the full hydrated `result` regardless. The spill is a DB-storage
    optimization only — it never reaches the MCP response boundary.
  - `getStatus` (~L470) returns `{...entry.record}` incl. `result`. `waitForResult` (~L493)
    resolves the full record.
- **MCP shims:** `packages/mcp/src/tools/workflow-status.ts` + `packages/mcp/src/daemon-client.ts`
  - `WorkflowStatusInputShape` = `{workflow_run_id}`; `WorkflowWaitInputShape` =
    `{workflow_run_id, timeout_ms}`. **Neither accepts `cwd` or `project_id`** (so the task's
    "regardless of whether project_id is passed" was a no-op param).
  - Handlers `toTextContent(await daemon.workflowStatus/Wait(input))` — bare `ContentBlock[]`,
    no envelope.
- **MCP tool registry:** `packages/mcp/src/tools/registry.ts` (entries `workflow_status`,
  `workflow_wait`, `workflow_run` ~L577-599).

## Integration target — the MCP token-optimization plan

`docs/superpowers/plans/2026-05-27-mcp-token-optimization.md` phases:

- **Phase 0** — `packages/mcp/src/responses/envelope.ts` (EnvelopeResult, `handle_id`, budget
  utils). The reusable primitive for opt-in bounded responses.
- **Phase 1** — `memory_search` reference migration (`envelope: z.boolean().optional()`
  opt-in pattern; bare `ContentBlock[]` when omitted, for backward-compat).
- **Phase 2** — Measurement: run the invocation summarizer over 24h traffic, populate the
  TBD top-10-tools-by-`result_bytes` table, pick top-3 for Phase 3. `workflow_status`/`wait`
  are near-certain top-bytes offenders (demonstrated: ~100 KB each).
- **Phase 3** — Migrate top-3 tools (TOOL_A/B/C placeholders).
- **Phase 4** — Handle store + `read_handle` MCP tool (in-memory `Map`, TTL eviction). The
  natural home for "result available behind a handle."
- The plan does **not** yet name `workflow_status`/`wait` anywhere.

The planners must decide **how this slice composes with that plan**, e.g.:
- Does `workflow_status` get a *hard* contract change (never inline `result` — return
  `status`, `started_at`, `finished_at`, `result_available`, `result_bytes`, persistence
  status, and a handle/spill reference), independent of the envelope opt-in? A status check
  arguably should never carry the payload, so this may not need to be opt-in.
- Does `workflow_wait` keep returning the result but bounded via the Phase 0 envelope +
  Phase 4 handle (so `read_handle` fetches the full body on demand), or via the *existing*
  registry spill-path surfaced to the client?
- Sequencing: can these land as a dedicated phase appended to the token-opt plan (depends on
  Phase 0 + Phase 4), or do they slot into Phase 3/Phase 8 as named targets after Phase 2
  measurement? Which ordering lets both plans land in one coherent branch series?

## Goals

1. `workflow_status` responses are small and bounded regardless of result size (a status
   check must not stream the payload).
2. `workflow_wait` responses are bounded; the full result remains retrievable (handle,
   spill-path reference, or projection) without a second giant inline blob.
3. Reuse Phase 0 envelope + Phase 4 handle-store primitives rather than inventing parallel
   machinery; the work lands as part of / alongside the token-opt plan.
4. Backward-compat preserved per the token-opt plan's opt-in convention where it applies.
5. A regression test guards the already-fixed `untrusted_cwd` 400 for both `/workflows/wait`
   and `/workflows/status` (same-project run resolves from daemon cwd → success, not 400).

## Constraints / invariants

- **Delegate-only repo:** the plan will be executed by dispatched agents; write it
  dispatch-aware (per-task file scope, exact verify commands, `bun test <path>` / `bun run
  typecheck`). Test runner is **bun:test**, not vitest.
- Daemon caches zod schemas + routes at boot — call out any **daemon restart / kickstart**
  a phase requires. Long-lived agent breakers must be resumed after a restart.
- Do **not** replace the registry spill mechanism; build on it.
- No DB schema churn unless a phase justifies it (the `workflow_runs` table already has
  `result_spill_path`/`error_spill_path`).
- Keep `workflow_run`'s own `wait:true` path (route returns full result) in mind — decide
  whether it shares the same bounding contract or stays as-is (it's a deliberate
  caller-waited path).
- Honor existing security: spill-path containment checks in `readPayload` (absolute-path
  reject, realpath containment) must not regress.

## Out of scope

- Re-fixing the `untrusted_cwd` 400 (already fixed — regression-test only).
- The broader token-opt phases not touching these two tools.
- Cross-repo `workflow_wait` (daemon cwd is fixed; wait can't currently scope to a
  non-cwd project) — note as a follow-up only, do not solve here.

## Open questions for the planners to resolve

1. Hard contract change vs. opt-in envelope for `workflow_status`?
2. For `workflow_wait`: handle-store reference vs. surface the existing registry spill-path
   vs. field projection?
3. Exact sequencing against the token-opt plan's Phase 0/2/3/4 — one branch series or two?
4. Should the registry expose a `getStatusLight()` (no payload hydration) so the route never
   pays the spill read for a status check?
5. What's the smallest backward-compatible response shape that keeps existing callers
   (skills, plan-runtime) working?
