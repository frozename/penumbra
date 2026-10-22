---
name: worktree-state-audit
description: Use AFTER any `chain_start` returns terminal and BEFORE merging the agent branch — verify the worktree state (git log, diff, status) actually matches what the prompt asked for. Trust the worktree, not the agent's self-report.
---

# Worktree State Audit

Agents can report failure even when the intended work landed, usually through a cosmetic terminal status like `tool_failure_with_end_turn`. They can also report success when nothing was committed. This skill exists to force a local check of the actual worktree before anyone merges or cherry-picks the branch. Trust the worktree, not the agent's self-report.

## Workflow

1. `mcp__penumbra__handoff_get(handoff_id, compact=true)`  
   Confirm the handoff reached a terminal state. Capture `worker_id` and any `error_message`.
2. `mcp__penumbra__worktree_inspect(handoff_id)`  
   Read the worktree path and agent branch name from Penumbra. Penumbra owns the path layout; do not assume any filesystem location.
3. Inspect the diff and branch log returned by `worktree_inspect`. Both are taken against `base_ref`, the root dispatch base: Penumbra walks the handoff's `branch_base` through every ref owned by a handoff in the same project and stops at the first ref no such handoff owns, or uses `main` on fallback. `base_ref` may be a feature branch rather than `main`, but it is never a stacked or fix-round parent owned by a handoff in the same project, so for a later fix round or stacked task the diff and log are cumulative over the whole chain, not only this agent's commits. `base_fallback` is `true` when inspection fell back to `main`. `base_attempted_ref` is the ref the walk tried: equal to `base_ref` without fallback; on `chain_limit` it is the still-owned ref where the walk stopped, not a root. `base_fallback_reason` is one of:
   - `unresolvable`: the attempted ref does not resolve to a commit, for example because its branch was deleted.
   - `rejected_ref`: the attempted ref is not a plain branch name (`HEAD`, `@`, a `..` range or disallowed characters), so it is never passed to git.
   - `chain_limit`: the walk hit a cycle or the owned-link limit before reaching a ref no same-project handoff owns.
4. If you need to run commands against the worktree, use the returned path and `base_ref`: `git -C <path> log --oneline -10`, `git -C <path> diff <base_ref>...HEAD --stat`, `git -C <path> status`.
5. If the project has a focused test command, run it against that worktree path before merging.

## Decision Matrix

- Commit landed + diff matches prompt scope -> safe to cherry-pick or merge onto `main`.
- Commit landed + diff includes unrelated files -> ask the user before merging; the agent may have over-reached.
- No commit + worktree dirty -> recover only if the diff content is clearly the intended work; otherwise re-dispatch with a sharper prompt.
- No commit + clean worktree -> silent failure; re-dispatch.
- Commit landed but the agent's final response says `failure` -> cosmetic. Verify the diff and proceed if it matches scope.

## When To Skip

- The dispatch was a one-shot status query that produced no expected diff.
- The dispatch's `chain_start` already surfaced the diff in its response and you have inspected it inline.

## Memories To Recall On Edge Cases

- `feedback_dispatch_reliability_workarounds.md` - cosmetic tool-failure pattern.
- `project_codex_acp_non_commit.md` - codex-acp-fast specific no-commit recovery.
- `feedback_dont_cleanup_active_worktrees.md` - do not delete the worktree until verification is done.
