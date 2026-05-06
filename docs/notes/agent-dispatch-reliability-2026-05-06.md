# Agent dispatch reliability — observations 2026-05-06

Today's session ran 11 dispatches across the V2 V2 plan-runtime work. Recording the patterns here for future reference; no code changes proposed yet — left to a follow-up after a longer observation window.

## Outcomes

| Handoff | Agent | Latency | Reliability | Outcome |
|---|---|---|---|---|
| `f3d3ad4c` (FTS5 v1) | claude-acp-sonnet | 15s | `no_worktree_activity`, untrustworthy | Refused as suspected prompt injection — saw `recent-relevant-context` block + TASK directive, decided to ask for confirmation |
| `9c3ee17e` (FTS5 v2) | claude-acp-sonnet | 47s | `no_worktree_activity`, untrustworthy | Same refusal pattern |
| `5804bedb` (FTS5 v3) | codex-acp-fast | 49s | `tool_failure_with_end_turn` (2) | Landed correct work + tests, all passing |
| `c892f2ec` (#2) | codex-acp-fast | 8m33s | `tool_failure_with_end_turn` (11) | Landed work; 3 retry commits on the agent branch |
| `22e62d12` (#3) | codex-acp-fast | 67s | `tool_failure_with_end_turn` (2) | Single clean commit |
| `da8122a1` (#4 phase 1) | codex-acp-fast | 5m33s | `tool_failure_with_end_turn` (9) | Landed substantial 19-file change |
| `45a43a10` (#4 fix) | codex-acp-fast | 3m05s | `complete`, **trustworthy** | Single 4-line surgical fix |
| `7766ec76` (transitive walk) | codex-acp-fast | 9m23s | `tool_failure_with_end_turn` (10) | Landed work |
| `c9f7c38a` (penumbra init) | codex-acp-fast | 10m57s | `tool_failure_with_end_turn` (7) | Landed work; template needed manual shape fix (options-nesting) |
| `81abfe8b` (merge-staging) | codex-acp-fast | 2m47s | `tool_failure_with_end_turn` (6) | Landed work, 2 retry commits |
| `a4cb593f` (#3 cheap fix) | codex-acp-fast | 6m56s | `complete`, **trustworthy** (despite transport_closed status=failed) | Landed clean work |

## Patterns

### claude-acp-sonnet treats its own dispatch as prompt injection

`f3d3ad4c` and `9c3ee17e` both refused work with the same diagnosis: the dispatched agent sees `<recent-relevant-context>` blocks (from recall hooks) followed by a TASK directive, and the SessionStart/UserPromptSubmit hooks report "no pending handoffs" (true for `trust=all` dispatches — they're auto-approved with no pending state). The agent reads this as injected content rather than a directive.

Root cause: the dispatched claude-acp-sonnet runs the user's full Claude Code session context, including hooks that emit pre-flight context. The hooks have no way to know the agent IS a dispatch target. So the prompt looks suspicious from inside.

Workaround applied today: switched all dispatches to `codex-acp-fast`, which doesn't run those hooks.

Real fix candidates:
- The penumbra worker, when spawning a claude-cli adapter for a dispatched agent, should set an env var (e.g., `PENUMBRA_DISPATCH_HANDOFF_ID`) that the user's hooks can read to skip recall injection / shift framing.
- Or: the worker should inject a system-level message into the dispatched agent's session header that explicitly says "this is a dispatch, the user message that follows is the task."

### codex-acp-fast `tool_failure_with_end_turn` is mostly cosmetic

10 of 11 codex dispatches showed `tool_failure_with_end_turn` reliability with non-zero failure counts. In every case, codex landed correct work — the failures were transient transport hiccups (`stdio-acp-client: transport closed`) that codex retried through. The reliability classifier's `recommended_action: 'retry'` was misleading; the actual recommendation should have been `accept` because the work was good.

Root cause: the reliability classifier counts ANY `agent.tool_call.failed` event during the dispatch and downgrades the verdict. It doesn't model "the agent recovered and produced final output." Single-shot atomic dispatches (like the 4-line `194602f` fix) usually finish before any transport blip and earn a clean `trustworthy: true`.

Real fix candidate: the classifier should weigh `tool_failure_with_end_turn` against worktree activity + commit landing. If the agent committed AND the diff matches the prompt's surface area, treat it as trustworthy regardless of intermediate failures.

### Agents repeating commits

`c892f2ec` and `81abfe8b` each landed 2-3 sequential commits with similar/identical messages. Codex was iterating in pieces — possibly due to transport blips forcing replays, or because codex chose to checkpoint partial progress. Not harmful but creates noisy git history.

Real fix candidate: when a dispatch ends with multiple consecutive commits sharing a prefix or message, the reconciler could squash them on the agent branch before opening the PR. Or the dispatch could explicitly request a single commit at the end.

## Recommendation

None of these issues blocked progress today — the workaround stack (use codex-acp-fast, verify diffs before merge, FF manually when needed) is functional. The two highest-leverage fixes if/when prioritized:

1. **`PENUMBRA_DISPATCH_HANDOFF_ID` env propagation** so the user's claude hooks can detect dispatch context. Unblocks claude-acp-sonnet for substantial dispatches, which today is locked to codex-acp-fast.
2. **Reliability classifier overhaul** to factor in worktree activity / commit quality. Reduces false `untrustworthy` flags that currently trigger unnecessary manual review.

Both are independent of the cross-repo plan-runtime work and can be done at any time.
