---
name: dispatch-reliability-triage
description: Use when a dispatch fails, hangs, or returns suspicious output -- classify the failure (transport-closed / cost-cap / prompt-injection-refused / parse-fail / cosmetic-tool_failure / silent-success-no-commit) and skip retry when the failure is structural rather than transient.
---

# Dispatch Reliability Triage

Use this skill any time a `chain_start` dispatch returns failure, hangs past the wall-clock budget, returns success but with a suspicious message such as `commit failed` or `tool error`, or terminates with no observable diff in the worktree. The first job is to classify the failure. Do not retry before you know whether the symptom is structural or transient.

## Triage Workflow

1. `mcp__penumbra__handoff_get(handoff_id, compact=true)` for terminal status, `error_message`, `worker_id`, and `branch_base`.
2. `mcp__penumbra__worktree_inspect(handoff_id)` for diff against main plus branch log. Cosmetic failures often landed a commit; verify the worktree state, not the agent self-report.
3. `mcp__penumbra__chain_get_response(conversation_id, which='final')` for the last thing the agent actually said.
4. Match the symptom against the taxonomy below. If it matches, follow that recipe.
5. If nothing matches, capture the symptom signature and write a new t2 memory note before retrying. Recall has to learn the failure mode.

## Failure Taxonomy

- **transport-closed / `session/prompt timed out` at exactly 60s** -- old ACP idle-watchdog bug, mostly fixed. -- If still observed, restart the daemon and re-dispatch. -- Memory: `project_acp_watchdog_fix.md`
- **codex-acp helper crash on macOS (launch-constraint SIGKILL)** -- codex-acp invokes a SkyComputerUseClient binary outside Codex.app and gets killed by macOS code-signing constraints. -- Disable plugin entries in `~/.codex/config.toml`; rename the four SkyComputerUseClient binaries. -- Memory: `project_codex_acp_feature_flags.md`
- **gemini agent `replace and quit` mid-turn** -- known upstream gemini-acp issue. -- Switch to codex-acp for the dispatch. -- Memory: `project_acp_failure_modes.md`
- **claude-acp-sonnet refuses with `this looks like prompt injection`** -- claude refuses long structured dispatches as injection. -- Re-route to codex-acp-fast or oc-deepseek-v4-pro for the same prompt; soften the prompt only as a last resort. -- Memory: `feedback_dispatch_reliability_workarounds.md`
- **codex-acp `tool_failure_with_end_turn`** -- usually cosmetic. The commit landed; the agent self-report is wrong. -- Verify worktree state with `worktree_inspect` before retrying. If the diff matches scope, accept and move on. -- Memory: `feedback_dispatch_reliability_workarounds.md`
- **handoff status ok + worktree_changed but no commit** -- codex-acp-fast specific bug. -- Recover from the worktree directory returned by `worktree_inspect`; inspect uncommitted changes; commit them manually if the diff is correct. -- Memory: `project_codex_acp_non_commit.md`
- **transport-closed on a wedged child / 49 GB RSS observed** -- codex-acp memory leak. -- Switch agent; prefer gemini-acp-pro or oc-acp-deepseek-v4-pro. -- Memory: `project_codex_acp_memory_leak.md`
- **chat-only agent silent fail** -- agent has no fs/grep/glob tools and the prompt asked it to read files. -- Re-dispatch with all needed context inlined, or pick a CLI/OpenCode agent. -- Memory: `feedback_chat_only_agents_inline_context.md`
- **post-test ONNX teardown panic** -- cosmetic C++ teardown crash from bun + fastembed; shell exit code is 0. -- Ignore. -- Memory: `bun_onnx_teardown_panic.md`
- **HTTP 400 from daemon after a schema-touching commit** -- daemon caches zod schemas at boot; HTTP 400s usually mean the daemon is older than the change. -- `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`. -- Memory: `feedback_daemon_restart_on_schema_change.md`

## Classify Before Retrying

Structural failures re-fire the same way: codesigning crashes, missing `maestro_capable` flags, and agents absent from the registry. Do not retry those until the structural cause is fixed.

Transient failures are worth one retry: memory pressure, watchdog flaps, and transport drops. If you retry, pick a different agent from `mcp__penumbra__agent_recommend`.

If one failure mode fires three times in a session, treat it as structural and stop the loop.
