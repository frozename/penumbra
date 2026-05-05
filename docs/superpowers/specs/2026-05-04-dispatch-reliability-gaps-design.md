# Dispatch Reliability Gaps — Design

Date: 2026-05-04
Status: Draft
Owner: maestro

## Summary

Five concrete failures observed in today's dispatch-heavy session that the existing reliability + workflow infrastructure didn't catch (or caught too late). All five have well-scoped fixes; this spec captures them so the implementation plan can drop straight into execution.

## Problem 1 — `delegate-suggest` fires on every tool (P0 noise)

The new `lifecycle:post-tool-use` trigger has no tool-name filter. The intent was Edit/Write only, but the playbook fires for every Bash, ToolSearch, MCP call, etc. — visible in the current session as a duplicated reminder after every tool. Same hole exists for any future PostToolUse playbook.

**Fix**: extend the lifecycle trigger schema with an optional filter:

```ts
{ kind: 'lifecycle', event: 'post-tool-use', filter?: { tool_name?: string[] } }
```

The hook command (`packages/cli/src/commands/hook.ts`) extracts `tool_name` from the Claude Code event payload and skips forwarding when the matched workflow's filter excludes it. Daemon side stays simple — filter is a no-op there.

## Problem 2 — Silent-commit pattern (P0; 1 incident this session)

Task 1.3 dispatch (codex-acp-fast) wrote files to the worktree but never committed them. `dispatch_timeline` shows the smoking gun: `agent.tool_call.failed` fired mid-dispatch (the `git commit` invocation), agent ignored the failure, ended with `end_turn`. Reliability classifier saw `worktree_changed: true` (untracked files counted) and reported trustworthy.

**Fix**: classifier returns a new status when `tool_failure_count > 0 AND terminal end_turn AND worktree_changed === true`:

- New `DispatchReliabilityStatus` value: `tool_failure_with_end_turn`
- `recommended_action: 'retry'` (auto-retry-eligible)
- Worker auto-retry trigger keys off this status (Phase 1 of `maestro-behavior-hooks` already wired the retry path; just add this class to the trigger condition).

Optional follow-up: separate `worktree_changed` (untracked) from `worktree_committed` (commits added). Out of scope for the immediate fix; the failure-count signal alone catches the most common manifestation.

## Problem 3 — Silent-completion wedge (P1; 1 incident this session, 10+ min recovery)

Task mb-4.1+4.2 dispatch (claude-acp-sonnet) committed `278f505` but the ACP session never sent a terminal event. `chain_wait` timed out at 10 min. The reliability classifier correctly flagged `non_terminal_stale` (Phase 1 maestro-hooks work), but auto-retry didn't fire because retry trigger only runs at `agent_performance` upsert time, which only happens after a terminal event. Catch-22.

**Fix**: a daemon sweeper that polls dispatched handoffs and force-resolves stale ones.

```
Every N seconds:
  for handoff WHERE status='dispatched' AND ts < now - staleAfterMs:
    report = classifyDispatchReliability(handoff, events)
    if report.status === 'non_terminal_stale':
      write synthetic dispatch.end with status='failed', meta.reason='stale'
      // Existing capture pipeline now sees terminal event, runs through
      // computeDispatchSignals → AgentPerformanceWriter, which triggers
      // the worker's retry on no_worktree_activity / non_terminal_stale
      // (already wired in Phase 1 of maestro-behavior-hooks).
```

Per-handoff cooldown like the workflow-trigger sweeper, to avoid hammering the same wedged handoff.

## Problem 4 — Manual-takeover not tracked in agent_performance (P2)

After `chain_cancel`, `dispatch_audit` returns `trustworthy: true` for handoffs that required maestro intervention to resolve. The `agent_performance` ledger reads as if the agent succeeded. The schema already has a `maestro_takeover_required` column (per `packages/core/src/db/schema.ts:384`); it's not being populated.

**Fix**: when the chain_cancel route resolves a non-terminal handoff (i.e. cancellation was used as recovery, not as user-initiated abort), set `maestro_takeover_required=true` on the resulting agent_performance row. Surfaced in `agent.recommend` as a tiebreaker — agents that need takeover are deprioritized vs. agents that complete cleanly.

Distinguishing "recovery cancel" from "user abort" is hard from the daemon side. Heuristic: if `cancel_requested AND no terminal event from the agent within N seconds prior to cancel`, it's a takeover. If terminal event from agent preceded the cancel, it's a duplicate / no-op cancel. Both cases write the column; only the first marks `maestro_takeover_required=true`.

## Problem 5 — Memory recall is empty (P2 cosmetic)

The new `prompt-classify` and `maestro-context-prime` playbooks pull `memory.search` results, but the live `t2_memories` table in the daemon's db is empty — claude-mem writes its memories to a separate database (`~/.claude-mem/claude-mem.db`). The session reminder injection works end-to-end, but the recall sections render as blank lists.

**Fix**: two flavors, pick one when implementing.

- A. Bridge: extend `runMemorySearchSource` so it also queries claude-mem's sqlite if penumbra has zero rows. Read-only, no schema changes; just FFI to the other db.
- B. Bypass: replace `memory.search` in the playbooks with a `claude-mem.timeline` recall source. Requires defining the new source in `packages/workflows/src/recall-sources/`.
- C. Defer: the recall is empty *because* nothing is calling `memory.observe` on the penumbra side. If memories *should* be flowing into penumbra (the design intent), the right fix is upstream — observe more aggressively from the agentchat-worker / hook command. Not a workflow runtime bug.

Recommend (C) — penumbra memories are accumulated by `mcp__penumbra__memory_observe` calls, which are sparse; aggressive memory writes from hook events would close the gap. Out of scope for the dispatch-reliability plan.

## Acceptance criteria

1. `delegate-suggest` fires only after Edit/Write, not after Read/Bash/MCP/etc. Verified by reading the next ~10 turns of session reminders and seeing them only after Edit/Write.
2. A test fixture seeded with `tool_call.failed + end_turn + worktree_changed=true` (no commits) classifies as `tool_failure_with_end_turn` and auto-retries.
3. A wedged dispatch (non_terminal_stale) is auto-cancelled and retried within 60s of crossing the stale threshold.
4. Cancellation-as-recovery sets `agent_performance.maestro_takeover_required=true`; agent.recommend deprioritizes such agents in tiebreakers.

## Out of scope

- Memory-recall empty-state fix (Problem 5; treat as upstream).
- Distinguishing untracked-only vs. committed worktree changes (defer; the tool-failure signal is sufficient for the common manifestation).
- Replacing the maestro-behavior-hooks playbooks with smarter content (separate effort once these noise/correctness gaps close).
