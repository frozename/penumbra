# Session Handoff — 2026-04-30 (Phase 3b ready to execute)

## TL;DR

Phase 3b (cost ledger + quota-aware routing + hook-based rate-limit visibility) is **specced and planned**. Spec at `docs/superpowers/specs/2026-04-28-phase-3b-cost-ledger-design.md` (commit 2619999). Plan at `docs/superpowers/plans/2026-04-28-phase-3b-cost-ledger.md` (commit 07624ef). 19 TDD-paired tasks across 8 phases. Estimated 6.5 days wall-time, but most agent dispatches are <5 min — total session time more like 1-2 days of attended dispatch + reviews.

Prior session shipped 9 commits on main: Phase 1d.2 (stdio-acp yaml caps + parser hardening), reconciler success logging, CapturePort err.body surfacing, stdio-acp session/prompt timeout. Plus 4 spec/plan revision commits for 3b. Plus 4 new memory entries. See `git log e943468..main --oneline` for the full set.

**This session's first action: dispatch Task 1 from the plan via subagent-driven-development.**

## State of the world (verify on resume)

```bash
cat /tmp/penumbra-live/pid && ps -p $(cat /tmp/penumbra-live/pid)
ps -ef | grep agentchat-worker | grep -v grep | wc -l
git log --oneline -10
```

Expected:
- 1 daemon PID alive (last session restarted on port 52235 with post-3a code)
- 4 worker processes (worker-primary/b/c/d, post-Phase-1d.2 code)
- main HEAD = 07624ef "docs(phase-3b): implementation plan — 19 TDD tasks across 8 phases"

If anything's missing: standard restart pattern (memory `feedback_daemon_restart_on_schema_change.md` has the exact commands).

**Test baseline** as of last run: 458/2 skip/0 fail across the monorepo. typecheck 0 errors.

## Phase 3b execution plan — 19 tasks with routing

Per-task subagent recommendations:

| Task | Phase | Subagent | Notes |
|---|---|---|---|
| T1 | Schema | codex-mini | EventTypeSchema enum + zod test. Surgical. **Daemon restart REQUIRED after this lands** before T17/T19 live verification. |
| T2 | ACP wire | codex-mini | CapturePort handleUsageUpdate + 3 tests. |
| T3 | ACP wire | codex-mini | stdio-acp `case 'usage_update'` + 1 test. |
| T4 | ACP wire | gemini OR codex-mini | opencode-acp audit + parallel emit if needed. May surface NEEDS_CONTEXT. |
| T5 | Reader | oc-mimo-v2.5-pro | recentCost SQL + 4 tests. |
| T6 | Reader | oc-mimo-v2.5-pro | quotaStatus + Services.providerQuotas + 4 tests. |
| T7 | Surface | codex-mini | Daemon HTTP routes + 4 tests. |
| T8 | Surface | codex-mini | MCP tools + 2 tests. |
| T9 | Reader iface | codex-mini | UsageReader interface (no test, just types). |
| T10 | Reader | oc-deepseek-v4-pro | CodexRolloutReader + 5 tests (largest reader). |
| T11 | Reader | oc-mimo-v2.5-pro | OpenCodeDbReader + 4 tests. |
| T12 | Reader | oc-mimo-v2.5-pro | ClaudeJsonlReader + 3 tests. |
| T13 | Reader | codex-mini | ClaudeStatusLineBridge + 3 tests. |
| T14 | Poller | gemini | Poller + cursor persistence + 2 tests. Multi-construct integration; gemini's architectural-concern surfacing is valuable here. |
| T15 | Wiring | maestro hand-edit | Worker singleton wiring (3-4 import lines + conditional). Restart workers after this lands. |
| T16 | Operator config | maestro hand-edit | yaml edits + daemon-side bridge + daemon restart. |
| T17 | CLI | codex-mini | `penumbra cost recent/quota` + 3 tests. |
| T18 | CLI | gemini OR oc-mimo-v2.5-pro | `penumbra hooks install/uninstall/status` + 5 tests. Touches operator filesystem (claude settings); careful test design. |
| T19 | Docs + smoke | maestro hand-edit | agent-fleet.md + memory + live verification dispatches. |

**Routing rationale**: codex-mini for surgical mechanical edits (14/14 lifetime streak); OC-tier (mimo / deepseek-v4-pro / kimi) for substantive impl; gemini for multi-file integration where its architectural-concern surfacing is valuable. Conserve Anthropic quota — no claude-acp-sonnet review dispatches needed.

## Discipline rules (load-bearing across all tasks)

- **Don't commit to main during a dispatch** (FF-merge breaker). Reconciler creates PRs from agent worktrees; concurrent main commits force manual conflict resolution.
- **Single implementer per task** even when multiple tasks could parallel. Dispatch one at a time; let each land before the next.
- **Don't tell dispatched agents to restart workers/daemon** — they're hosted by the worker; killing the worker kills the agent mid-task. Code-only commits.
- **Commit IMMEDIATELY after green tests, BEFORE final report**. Verified holding across Phase 3a + 1d.2 + last session.
- **Two-round cap on iterations**. If a task takes more than 2 dispatches, maestro hand-edits — don't loop.
- **Surface NEEDS_CONTEXT rather than force-fit**. T4 (opencode-acp audit) is explicitly designed to allow this.
- **Daemon restart after schema changes**. T1 lands new event_types; daemon MUST be restarted before any live verification or it silently 400s on the new types. Standard recovery: `kill -TERM $(cat /tmp/penumbra-live/pid) && PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live bun packages/cli/bin/penumbra.ts start --detach`.
- **Worker restart after worker-bin changes**. T15 modifies agentchat-worker.ts; restart workers before T19's live verification.

## What last session shipped (commit log on main)

```
8bcb2b0  fix(agentchat): stdio-acp parser skips non-JSON status lines
db8797c  fix(agentchat): surface PR creation success and HTTP error bodies
66922a1  fix(agentchat): bound stdio-acp session/prompt with requestTimeoutMs
2c1bf19  docs(phase-3b): cost ledger + quota-aware routing design
e5c23b6  docs(phase-3b): add OpenCodeDbReader — richest local usage source
ea4f20d  docs(phase-3b): codex rollout JSONL + claude statusLine integration
621377c  docs(phase-3b): independent statusLine + stable HTTP routes
2619999  docs(phase-3b): review pass — fix stale refs + missing tests
07624ef  docs(phase-3b): implementation plan — 19 TDD tasks across 8 phases
```

Side findings investigated and resolved (no commits, knowledge captured in memory):
- Reconciler "stall" was silent success — PR creation worked; logging gap fixed in db8797c.
- CapturePort HTTP 400 root cause = stale daemon predating Phase 3a's `agent-thought` enum addition. Daemon restart resolved.
- codex-acp orphan-process leak: 30+ pre-existing orphans cleaned; future hangs prevented by 66922a1.
- 3 stale GitHub PRs (#16, #17, #19) closed as superseded.
- agent-thought capture verified live with claude-acp-sonnet (yaml `MAX_THINKING_TOKENS: "8000"` env). 0/4 other ACP agents emit thoughts via spec.

## New memory entries written last session

- `feedback_stdio_acp_caps_yaml_driven.md` — caps live in agentchat.yaml options; missing flags trip the kill-on-tool_call gate
- `feedback_daemon_restart_on_schema_change.md` — daemon caches zod schemas at boot; HTTP 400s after a schema-touching commit usually mean the daemon is older than the change
- `feedback_acp_thought_chunk_emitters.md` — claude-acp-sonnet needs MAX_THINKING_TOKENS env; gemini-acp default doesn't emit; codex-acp + opencode-acp upstream-blocked

## First moves for this session

1. **Read the plan**: `docs/superpowers/plans/2026-04-28-phase-3b-cost-ledger.md`. Each task is self-contained; you'll paste the verbatim task body into each agent's `chain_start` message.
2. **Verify daemon + worker state** (commands above).
3. **Invoke the subagent-driven-development skill** before starting dispatches.
4. **Dispatch Task 1 to codex-mini** via `chain_start`. Paste Task 1's full body (steps 1-7) as the agent prompt. Wait ~52s based on prior codex-mini surgical-edit timing. After completion: confirm commit via `git log` and PR auto-merge via `gh pr list --state merged --search "[codex-mini] feat(core): add usage-update"`.
5. **Restart the daemon** before Task 2 starts dispatching:
   ```bash
   kill -TERM $(cat /tmp/penumbra-live/pid)
   sleep 3
   PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live bun packages/cli/bin/penumbra.ts start --detach
   sleep 4
   cat /tmp/penumbra-live/pid && cat /tmp/penumbra-live/port
   ```
6. **Continue with T2 (CapturePort)**, then T3, etc., per the plan. Each task has explicit verification steps; honor them. If a task hits NEEDS_CONTEXT, route to maestro hand-edit (don't dispatch a second time blindly).

## Backlog snapshot

**Specced + planned (this session executes)**:
- Phase 3b — cost ledger + quota-aware routing + hooks (~6.5 days, 19 tasks)

**Specced, not built (deferred)**:
- maestro-shell MCP design — deferred indefinitely; revisit only with concrete consumer

**Idea backlog**:
- Phase 3c — extract usage tracking into standalone daemon (only if other tools start consuming penumbra's `/usage/*` routes; YAGNI for now)
- Phase 3d — agent-performance ledger codification (uses 3b's cost data as a routing signal)
- Phase 1d.5 — persistent shells (Bun PTY confirmed working)
- Reconciler hardening — remaining work after last session's logging fix
- `/handoffs?status=completed&since=X` daemon route + statusline done-count fix (still hard-coded 0)

## Stress-test routing reminder

- **Stress codex-mini + gemini family + OC-tier (mimo/kimi/deepseek-v4-pro)** — all four have multi-task validated streaks.
- **Deprioritize claude-acp-sonnet for review** — Anthropic quota conserved; Phase 3a + 1d.2 + this session's fix-all all shipped without reviewer dispatches because integration-test surfaces are richer.
- **Don't dispatch chat-only agents (gemini-pro-direct, openai-compat-http) for tool work** — silent-fail.
- **Phase 3a's t0 capture is fully verified now** — agent-thought events land for claude-acp-sonnet (MAX_THINKING_TOKENS=8000 in yaml). Cost ledger from Phase 3b will start collecting authoritative data the moment T15 wires the poller.
