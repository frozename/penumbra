# Session Handoff — 2026-04-30 (Phase 3a shipped)

## TL;DR

Phase 3a (dispatch t0 capture) shipped end of session 2026-04-28. Mid-turn `agent-thought` and `agent-tool-use` events from ACP-dispatched turns are now persisted as `t0_events` via the existing `observe()` callback. The recall surface gained `session_id` and `event_types` filters end-to-end (RecallReader → MCP → CLI). Smoke test passes; recall over CoT works.

11 commits landed on main (9 phase + 1 ledger + 1 spec/plan revision). Phase 3a was 32 min of dispatch wall time across 9 tasks (OC-tier validated for substantive impl: oc-mimo, oc-kimi, oc-deepseek all 1/1 clean; codex-mini 14/14 streak; gemini caught a real architectural bug mid-flight — third occurrence).

## State of the world

- **main HEAD**: latest after Phase 3a + ledger commit. `git log --oneline -15` to see the 11-commit stack.
- **origin/main**: unpushed delta as of session end — pushed at end of last session per user request.
- **daemon**: running at /tmp/penumbra-live (PID 91092 last session — verify with `cat /tmp/penumbra-live/pid && ps -p $(cat /tmp/penumbra-live/pid)`); workers spawned at 16:05 with PRE-3a code, will need a restart to roll the 3a logic in for live capture.
- **Visual sugar (Phase 1d.5)**: confirmed working in live MCP tool calls. The `◌ chain_start agent h-xxx… trust=...` inline header renders above JSON output in this session and the smoke test stdout.

## Phase 3a — what shipped

Commits in order:

1. **765a35d** feat(core): agent-thought event_type
2. **0b65ce7** feat(agentchat): CapturePort coalesces dispatch CoT
3. **69d5406** feat(agentchat): stdio-acp adapter emits to CapturePort
4. **6d666ee** feat(agentchat): runChatTurn wires CapturePort
5. **fdfec8f** feat(core): recall accepts session_id + event_types filters
6. **84f5032** feat(mcp,cli): expose recall filters at MCP + CLI surfaces
7. **f143358** test(e2e): smoke for dispatch t0 capture
8. **68105f7** fix(agentchat): pass capturePort through stdio-acp builtIns factory
9. **887e871** test(e2e): scope smoke SQL to agentchat event_types

Plus:
- **5b45624** docs(agent-performance): Phase 3a routing data
- **978c43f / d0dfa65** docs: spec + plan from earlier in session

## Live verification status

- All 9 capture-port unit tests pass
- All 3 new recall filter tests pass (first run)
- E2E smoke test passes (1/1 / 8 expect calls / asserts all 4 event types land + recall scoped by session_id returns the t0 hit)
- Full agentchat suite: 452/0
- Full core suite: 247/0
- Full e2e smoke suite: 9/0/1 skip
- Typecheck: 0 errors

The smoke test correctly catches anything that would break the capture pipeline end-to-end. Future regressions in this surface will fail it.

## Open architectural items (not blocking)

1. **`/handoffs?status=completed&since=X` daemon route** — surfaced by codex-mini in the visual-sugar phase. The statusline's "done" count is hard-coded 0 in production until this exists. Half-day add when prioritized.
2. **Worktree-mid-flight rule sharpened** — Task 9 demonstrated that dispatch worktrees are forked at chain_start time, so merging a fix to main mid-dispatch doesn't reach in-flight worktrees. Already encoded in memory but worth highlighting before parallel-batch dispatches.
3. **CapturePort SDK-adapter integration deferred** — only stdio-acp wires through CapturePort today. Other adapters (claude-cli, gemini-cli, codex-cli, opencode-cli, etc.) don't capture mid-turn events. The `cli-spawn`-based adapters don't speak ACP, so they don't have an analogous notification stream — capture there would need a different approach (parse stdout streams, or hook into the agent CLI's transcript output). Out of scope for 3a; flag if any consumer needs it.
4. **agent-thought field in t0 / t1 / t2** — the spec assumed downstream consumers would handle the new event_type via fall-through. No exhaustiveness switches were broken (verified in Task 1), but t1 rollup and t2 promotion may want to surface thought content distinctly in the future. Watch for this if the rollup gets refactored.

## Routing data points added

- **oc-mimo-v2.5-pro**: 1/1 substantive impl clean (CapturePort + 9 tests, 2m04s) — first trustworthy OC-tier implementation datapoint.
- **oc-kimi-k2.6**: 1/1 multi-file SQL+schema clean, first-run pass on 3 new tests (6m48s).
- **oc-deepseek-v4-pro**: 1/1 multi-construct integration clean (3m28s).
- **codex-mini**: 14/14 lifetime streak on surgical/mechanical edits.
- **gemini**: 5/5 substantive, **caught a real architectural bug mid-flight** in Task 7 (registry.ts dropping capturePort) — third occurrence of this pattern; treat as a load-bearing routing signal.
- **gemini-flash**: 4/5 mechanical (the one NEEDS_CONTEXT was maestro prompt error, not agent skill).

The "agent-caught architectural concerns mid-flight" pattern is now confirmed across 3 distinct phases. Bias routing toward agents that surface architectural concerns rather than silently fix or work around — gemini and oc-deepseek-v4-pro both demonstrate this.

## Suggested first move for next session

**Verify the live capture render**, then choose one of three substantive next-phase moves.

**Verification (~2 min)**: roll the workers (SIGTERM existing 4 + auto-respawn picks up Phase 3a code), then dispatch any real ACP agent (gemini-acp-pro or oc-acp-deepseek-v4-pro) via chain_start, await completion, and probe:

```sh
sqlite3 /tmp/penumbra-live/penumbra.db \
  "SELECT event_type, source, COUNT(*) FROM t0_events WHERE source='agentchat' GROUP BY event_type, source"
```

Expected: non-zero counts for `agent-prompt`, `agent-response`, plus `agent-thought` (where the agent emits thoughts) and `agent-tool-use` (where the dispatch involved tools). Worker stderr should show `capture-port stats: sent=N failed=0` per dispatch.

**Then pick one of these as the next phase:**

A. **Phase 3b — cost ledger.** `usage_update` notifications → `cost.recent` MCP tool. Same audit-emission pattern Phase 1d and 3a both used. ~3 days. Useful for AI Ultra quota visibility. Cleanest next pick now that t0 capture is proven.

B. **Phase 3d — agent-performance ledger codification.** The ledger has 50+ rows now spanning 5 phases. Schema → table → ranking algorithm → auto-routing. Highest leverage long-term but bigger scope (~1 week table + capture, +1 week routing). Worth doing now that the data has stabilized.

C. **Phase 1d.5 — persistent shells.** Spec is on disk (specced-not-built). Bun PTY confirmed working. ~3-5 days. Revisit only if a concrete consumer surfaces; otherwise skip.

D. **Reconciler hardening.** Half-day. Skip unless a real failure surfaces.

E. **`/handoffs?status=completed&since=X` daemon route + statusline done-count fix.** Half-day. Good warm-up if you want a quick win before tackling 3b or 3d.

My recommendation: **A (Phase 3b)**. It's a tangible capability on a now-proven pattern, ships quickly, and the cost data starts informing routing decisions for free. D goes from interesting to almost-trivial after 3b — both audit emissions land via the same observe path you just hardened. Then 3d once 3b's cost data is flowing.

## Discipline rules to keep load-bearing

- **Don't commit to main during dispatch** (FF-merge breaker). Verified again in Task 9: dispatched agent's worktree was forked from pre-Task-8 main, so when I FF-merged Task 8 to main mid-Task-9, that worktree didn't have the registry fix. Rule holds.
- **Two-round cap on iterations** for any single piece of work. Triggered on Task 9 (test-filter design) — maestro hand-edited rather than dispatch a third correction.
- **Single implementer per task** even with parallel batches. Held.
- **Commit IMMEDIATELY after green tests, BEFORE final report**. Held by all 9 dispatches.
- **Don't tell dispatched agents to restart agentchat-worker** — they're hosted by it. Held.
- **Surface NEEDS_CONTEXT rather than force-fit** — Task 7 (gemini's registry catch) and Task 9 (gemini-flash's filter-insufficiency catch) are textbook examples; both yielded high-value diagnoses without silent over-scope.
- **Agent-caught architectural concerns mid-flight are high-value** — third instance confirms this is durable; route similar tasks (substantial impl + integration test) toward agents that have demonstrated this.

## Stress-test routing

Locked-in priority for next session unless reasons emerge to change:

- **Stress codex-mini + gemini family + OC-tier (mimo/kimi/deepseek-v4-pro).** All four now have multi-task validated streaks.
- **Deprioritize claude-acp-sonnet for review** — Phase 1d and 3a both shipped without reviewer dispatches because integration test surfaces are richer. Anthropic quota conserved.
- **Don't dispatch chat-only agents (gemini-pro-direct, openai-compat-http) for tool work** — they have no native tools; will silent-fail. Use only for pure reasoning over inlined content.

## Setup-before-first-dispatch

If main is rolled or daemon is freshly started, the standard pattern:

1. `cat /tmp/penumbra-live/pid && ps -p $(cat /tmp/penumbra-live/pid)` to confirm daemon
2. `ps -ef | grep agentchat-worker | grep -v grep` to confirm 4 workers
3. If workers are pre-3a (spawned before 0b65ce7), kill+restart so they pick up CapturePort: `kill -TERM <each worker PID>` and the daemon respawns them on the next handoff cycle.

If push status differs from end-of-last-session: `git log origin/main..HEAD --oneline` to see un-pushed commits.

## Backlog snapshot

- **Specced-and-built**: Phase 3a (this session). All capture + recall surfaces live.
- **Specced-not-built**: maestro-shell MCP design (deferred indefinitely; revisit only with a concrete consumer).
- **Idea backlog**: Phase 3b (cost ledger), Phase 3d (agent-performance ledger codification), Phase 1d.5 (persistent shells), reconciler hardening, daemon `/handoffs` route.
