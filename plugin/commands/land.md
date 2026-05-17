---
description: Land an agent/<handoff_id> branch via dispatch_land — the supported protocol path that re-stamps agent_performance.outcome correctly. Use instead of `git merge --ff-only` from the home checkout.
---

Land an agent branch via the daemon's `dispatch_land` protocol path. This is the supported alternative to `git merge --ff-only` from the home checkout and is REQUIRED whenever you want `agent_performance.outcome` to reflect reality.

## Why this exists

The merge-reconciler fires immediately after the agent's turn ends. For codex-acp-fast non-commit dispatches (where the agent ends its turn without committing and maestro recovers the work afterwards), the reconciler sees zero diff at chain-end and stamps `outcome='no_changes'` in `agent_performance`. Manual `git merge --ff-only` from the home checkout lands the work on main but does NOT re-stamp the row — so `agent_recommend` continues to see the agent as a failure.

Commit `ca27768` (2026-05-12) added a re-stamp step to `dispatch_land`'s success path. Using `dispatch_land` ensures the row flips from `no_changes` → `merged` after a successful land. Hand-merge bypasses that entirely.

See memory: `feedback_use_dispatch_land_not_manual_merge.md`.

## Usage

Argument: `<handoff_id>` of the agent branch to land (the implementer handoff, not the reviewer).

Optional second argument: `squash` (default) or `ff` for merge mode.

## What this command does

1. Look up the handoff record via `mcp__penumbra__handoff_get` to:
   - Confirm the handoff exists and is in a landable state.
   - Resolve `chain_task_type`, `to_agent`, and any `parent_handoff_id` for the commit message scaffolding.
2. Call `mcp__penumbra__dispatch_land` with:
   - `handoff_id`: the argument.
   - `commit_message`: a curated subject + body derived from the most recent commit on `agent/<handoff_id>` (read via `git log -1 agent/<id>`).
   - `mode`: 'ff' if the user specified ff, else 'squash'.
   - `force`: true when the reconciler verdict says `typecheck=fail` or `tests=fail` but maestro has verified the home-checkout is green (memory `project_core_dist_shadows_types.md` explains why reconciler-worktree-test failures are usually dist-shadow noise).
   - `delete_branch`: true (default).
3. After dispatch_land returns `ok: true`:
   - `git push origin main` to publish the new commit_sha to GitHub.
   - Verify `agent_performance.outcome` flipped from any prior state to `merged` by hitting `mcp__penumbra__handoff_get` (which surfaces the latest perf row) or a fast SQL check via `sqlite3 -readonly ~/.penumbra/db.sqlite "SELECT outcome, task_type FROM agent_performance WHERE handoff_id='<id>' ORDER BY ts DESC LIMIT 1"`.
4. Close any open lane row for the handoff via `lane_close` if not already closed.
5. Report back: the new `commit_sha`, the post-land `outcome` + `task_type`, and the lane status.

## When NOT to use this

- The handoff hasn't actually finished (`chain_wait` still pending).
- The agent branch has no real commits (the codex-non-commit pattern). In that case, first cd into the worktree, manually commit there with explicit `git add packages/...` paths, THEN run `/land`.
- The work is genuinely broken and shouldn't land. Use `lane_close gate_status=failed` or `gate_status=review_debt` instead.

## What NOT to do

- Do NOT `git merge --ff-only agent/<id>` from the home checkout. That bypasses the dispatch_land re-stamp and leaves the agent_performance row at whatever the reconciler stamped (often `no_changes`).
- Do NOT manually `git push` agent/<id> upstream as a feature branch unless `open_pr_on_review` was explicitly set on the dispatch.
- Do NOT call `dispatch_land` with `force: true` blindly — only use it when you've verified home-checkout typecheck + tests pass and the reconciler-worktree noise is dist-shadow or similar.
