# Design decision spec — sharing one HandleStore across `workflow_wait` + `read_handle` (token-opt S3 wiring)

**Date:** 2026-05-29
**Status:** design-decision spec for /adversarial-plan
**Context:** token-opt Phases 0/1/4 landed (`d91c7f55`). S3 moves `workflow_wait` payload bounding from the daemon (current S2 cap) to the MCP shim, where the `HandleStore` (Phase 4) lives. See [[workflow-bounding-s3-architecture-correction-2026-05-29]] and the corrected `docs/superpowers/plans/2026-05-29-workflow-status-wait-token-bounding.md` §S3.

## The decision to settle

S3 needs the MCP `workflow_wait` handler to spill oversized results into a `HandleStore`, returning a `handle_id` that the MCP `read_handle` tool can later resolve. **Both tools must share the SAME `HandleStore` instance** (a handle written by `workflow_wait` must be readable by `read_handle`). The question is *how to wire that shared instance* given the existing — and somewhat tangled — MCP tool-registration machinery.

## Verified current wiring (ground truth, read from code 2026-05-29)

1. **`buildServer`** (`packages/mcp/src/server.ts`) loops `TOOL_REGISTRY` and calls `def.makeHandler(opts.daemon)` — passes ONLY the daemon, no store, no per-build context.
2. **`TOOL_REGISTRY`** (`packages/mcp/src/tools/registry.ts:1373`) is derived from `RAW_TOOL_REGISTRY` by wrapping every entry:
   ```ts
   makeHandler: (daemon) => withActingOnEnvelope(def.makeHandler(daemon, def.handlerOpts?.()))
   ```
   So the *exported* `makeHandler` signature is `(daemon) => handler` — it **drops any 2nd argument** a caller might pass. The raw handler does receive a 2nd arg, but only from `def.handlerOpts?.()`.
3. **`ToolDef.handlerOpts`** is `() => unknown` — a **static thunk** with no access to anything buildServer-scoped. Precedent: `workflow_run` uses `handlerOpts: () => ({ resolveCwd: () => process.cwd() })` and `workflowRunHandler(daemon, opts)` reads `opts.resolveCwd`.
4. **`read_handle`** is registered OUTSIDE the loop (Task 4.3) with a direct closure over `const handleStore = new HandleStore()` created inside `buildServer`. It is intentionally NOT in `TOOL_REGISTRY` (it needs the store, not the daemon). The Phase 4 BOUNDARY review (handoff `9cfd09ae`) explicitly warned: **do not use a module-level global** for the store, and flagged that special-casing tools out of the loop risks double-registration / churns `server.test.ts`'s registered-set assertion.
5. **Live path** is `buildServer` only (`packages/mcp/bin/penumbra-mcp.ts` → `buildServer`). There is no second runtime builder.
6. `workflow_wait` IS currently in `TOOL_REGISTRY` (`makeHandler: workflowWaitHandler`), unlike `read_handle`.

## Constraints any solution must satisfy

- Same `HandleStore` instance shared between `workflow_wait` and `read_handle` within one `buildServer` call.
- No module-level global store (Phase 4 review constraint; breaks test isolation + lifecycle).
- Keep `instrumentHandler` wrapping + allowlist gating for `workflow_wait` (it's an existing instrumented tool).
- Keep `withActingOnEnvelope` behavior for `workflow_wait` (or justify dropping it).
- Minimize churn to `server.test.ts`'s `[...Object.keys(TOOL_REGISTRY), "read_handle"]` registered-set assertion.
- `buildServer` is reentrant (tests call it repeatedly) — no cross-call state bleed.
- BOUNDARY change (daemon↔MCP contract): daemon route reverts to full payload; MCP shim does the bounding.

## Candidate wirings (the fan-out should score these and may propose better)

**A. Per-build context threaded through `makeHandler`.** Change `ToolDef.makeHandler` to `(daemon, ctx?: { handleStore?: HandleStore }) => handler` and the `TOOL_REGISTRY` wrapper to forward `ctx`; `buildServer` creates `handleStore` before the loop and passes `{ handleStore }`. `workflowWaitHandler` reads `ctx.handleStore`; all other handlers ignore it. read_handle can then ALSO move into the loop (uniform), collapsing the Task 4.3 special-case. Most invasive to the shared wrapper; touches every handler's call site signature (but not their bodies).

**B. `handlerOpts` gains a build context arg.** Change `handlerOpts?: () => unknown` to `handlerOpts?: (ctx: BuildCtx) => unknown` where `BuildCtx = { handleStore: HandleStore }`; the wrapper/loop passes ctx. `workflow_wait`'s entry sets `handlerOpts: (ctx) => ({ handleStore: ctx.handleStore })`. Reuses the existing opts mechanism (workflow_run precedent), smaller blast radius than A, but makes `handlerOpts` impure (currently static).

**C. Keep `workflow_wait` out-of-loop like `read_handle`.** Pull `workflow_wait` from `TOOL_REGISTRY`, register it in `buildServer` with a closure over the same `handleStore`. Mirrors read_handle exactly, localized. BUT: churns `server.test.ts` (workflow_wait leaves the registry set), duplicates the special-case the review disliked, and loses `withActingOnEnvelope` unless re-added.

**D. Module singleton with explicit lifecycle.** Export a `getHandleStore()`/`resetHandleStore()` from `handle-store.ts`; both tools use it. Simplest wiring, but is the module-global the Phase 4 review rejected — only acceptable if paired with a reset hook for test isolation and a documented rationale that overrides the review.

## What to produce

A single phased TDD plan that: (1) picks ONE wiring (A/B/C/D or a synthesis) with explicit justification against the constraints, (2) reverts the daemon S2 cap, (3) implements MCP-side bounding with `DEFAULT_BUDGET`, (4) round-trips `workflow_wait → handle_id → read_handle`, (5) keeps `server.test.ts` green, (6) notes the daemon-restart + BOUNDARY-review requirements. Threshold: `DEFAULT_BUDGET` (budget.ts), 8 KB hard floor.
