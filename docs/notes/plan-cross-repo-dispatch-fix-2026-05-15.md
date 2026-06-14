# Plan — Cross-repo dispatch routing fix

Surfaced 2026-05-15: 5 llamactl-spike `chain_start` calls landed in penumbra/main (1 commit had to be reverted: ebe709f → 3dca88a). Root cause is the silent cwd fallback in `chain_start`'s project_id resolution. Daemon's `WorkingDirectory` is fixed at penumbra, so every implicit dispatch resolves to `project_id: "penumbra"` regardless of which project the caller is actually working in.

This plan ships four layers in order. Each layer is independently mergeable; the trap is closed once Phase 1 lands. Phase 2 fixes the architecture so the trap can't recur structurally. Phase 3 catches the failure mode by content. Phase 4 enforces the right behavior by default.

## Phase 1 — Visibility + escape valve (B)

Goal: every fallback resolution becomes observable; operators can flip a switch to make it fatal.

Touches:
- `packages/mcp/src/tools/chain-start.ts`: when `effectiveProjectId` was resolved from cwd (not from explicit input), set `result.resolution_warning = "project_id_inferred_from_daemon_cwd"` with the resolved id. Also emit a `services.log.warn(...)` line at dispatch claim time.
- `packages/daemon/src/serve.ts` (chain start handler): respect `process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID === '1'` — when set, fallback → 400 with `{ error: 'project_id_required', resolved_candidate: '<...>', hint: 'pass project_id explicitly or set PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=0 to keep the legacy default' }`.
- Tests: 3 cases in `packages/mcp/test/tools/chain-start.test.ts` — explicit-id, cwd-fallback-with-warning, hard-mode-error.

Estimated: ~45 min. Zero breakage when env knob unset.

## Phase 2 — Caller-cwd plumbing (C)

Goal: callers tell the daemon their actual working directory, not the daemon's.

Touches:
- `packages/mcp/src/tools/chain-start.ts`: add optional `caller_cwd: z.string().optional()` to `ChainStartInputShape`. Resolution priority becomes: `project_id` > `caller_cwd → projects.yaml lookup` > daemon-cwd (with Phase 1 warning).
- `packages/core/src/services/project-registry.ts` (if exists) or `packages/core/src/projects.ts`: helper `resolveProjectIdFromPath(path: string): string | undefined` that walks parents looking for a registered root in `~/.penumbra/projects.yaml`.
- `packages/mcp/src/index.ts` or wherever the MCP server boots: capture `process.cwd()` at startup and auto-set `caller_cwd` for in-process MCP tool calls when the caller doesn't pass it. This makes the in-tree maestro Just Work.
- `plugin/skills/dispatching/SKILL.md`: update the `chain_start contract` section — recommend `caller_cwd` for cross-repo work as the lighter alternative to `project_id`.
- Tests: 3 cases — caller_cwd-resolves, caller_cwd-unregistered-falls-through, explicit-project_id-overrides-caller_cwd.

Estimated: ~75 min. Schema change → daemon kickstart + MCP restart required.

## Phase 3 — Prompt-vs-project sanity check (D)

Goal: catch the specific failure mode (work for project X dispatched to project Y) even when project_id resolution silently picked Y.

Touches:
- `packages/core/src/services/dispatch-routing-guard.ts` (new): given `(prompt: string, projectId: string)`, returns `{ status: 'ok' | 'mismatch', mentioned_paths: string[], missing_in_project: string[], suggested_project_id?: string }`. Heuristic:
  - Extract absolute paths matching `/Volumes/WorkSSD/repos/personal/<name>/...`. If any match a DIFFERENT registered project → mismatch with that as suggested.
  - Extract `packages/<name>` references; check `<project_root>/packages/<name>` exists on disk. If none match the resolved project but any match another registered project → mismatch.
  - If prompt mentions no paths at all → status='ok' (no signal).
- Wire into chain_start handler: when `dispatch-routing-guard` returns mismatch, log warning by default; if `PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH=1`, return 400.
- Tests: 6 cases — same-project paths pass, cross-project absolute path detected, cross-project packages/X detected, no-paths-no-signal, multi-project paths ambiguous (warn but accept), suggested_project_id correct.

Estimated: ~90 min. Pure addition; no breakage.

## Phase 4 — Default to strict (A as toggle)

Goal: once Phases 1-3 have baked for a few sessions and no false positives surfaced, make explicit project_id the default expectation.

Touches:
- `~/Library/LaunchAgents/dev.penumbra.daemon.plist`: add `PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=1` to `EnvironmentVariables`. One-line plist edit + bootout + bootstrap.
- Or, more invasively, change the default in code: `chain-start.ts` resolution returns a warning even when env-unset, then after a soak period, flip the fallback to error-by-default.
- Update penumbra:dispatching SKILL.md to drop the "optional" language around project_id.

Estimated: ~10 min (the env knob flip). Bigger change is the audit period between Phase 3 landing and this flip.

## Testing strategy across phases

- Per phase: unit tests in the same commit as the change.
- After Phase 1: run one canary chain_start without project_id, confirm `resolution_warning` appears in response. Run one with env-knob set, confirm 400.
- After Phase 2: re-test the original llamactl spike scenario — dispatch with only `caller_cwd: "/Volumes/WorkSSD/repos/personal/llamactl"` (no project_id) and confirm the worktree is created off llamactl/main.
- After Phase 3: dispatch a prompt referencing `packages/train/...` (which exists only in llamactl) without project_id from a non-llamactl cwd and confirm the guard catches it.
- After Phase 4: confirm long-lived ticks, internal hops, and orchestrate-reactor dispatches all still work with the strict default (or get updated to send project_id).

## Rollback per phase

- Phase 1: env knob `PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=0` reverts hard mode. Warning stays but is benign.
- Phase 2: drop the `caller_cwd` field via a code revert; daemon kickstart restores prior behavior.
- Phase 3: env knob `PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH=0` keeps the guard advisory only. Full revert deletes the guard module.
- Phase 4: revert the plist env addition.

## Order of execution

Sequential, one phase per commit, each one testable on its own. Don't fan out — same-day phases tend to interact through chain-start.ts edits, and the SKILL.md updates should reflect the actual shipped behavior.

Total estimated wall: ~3-4 hours across all 4 phases. Phase 1 alone (~45 min) closes the bug for safety-conscious callers; Phases 2-4 are the architectural cleanup.
