# Maestro continuation prompt — 2026-05-08 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## What this session shipped

End-to-end subscription-aware cost tracking + cap mechanism. Three coherent waves landed across Phases 1, 2, follow-ups, and Phase 3 (cap enforcement):

### Wave 1 — Cost tracking Phase 1 + 2 + follow-ups
```
ca4cf9b feat(agentchat/config): pricing_mode + subscription_provider classification fields
20945c8 docs(usage-readers/claude-jsonl): codify statusline-bridge canonicality for rate limits
34d2013 docs(usage-readers/opencode-db): document rate-limit signal gap with regression test
9567b3c test(usage-readers/codex-rollout): snapshot test against verbatim production rate_limits payload
72e79c8 fix(agentchat-worker): drop never-true workerId='worker-primary' gate on usage poller + notification scheduler
de09e46 feat(core/readers/subscription-pressure): aggregator over t0 rate-limit-snapshot events
1a17a09 feat(daemon/routes/usage): GET /usage/subscription_pressure endpoint
649ecf0 refactor(daemon/routes/usage): use @penumbra/core import for readSubscriptionPressure
1be4956 feat(mcp/tools): subscription_pressure_status — read-only aggregator MCP tool
ae8dd07 docs(notes): subscription pressure smoke findings + plan
78d0ab2 feat(usage-readers/codex-rollout): cap rollout-file scan to last 24h
```

### Wave 2 — Phase 3 cap mechanism
```
1c8c6c9 docs(specs): subscription-pressure cap design (Phase 3)
bf82491 docs(plans): subscription-pressure cap implementation plan (Phase 3)
e2d87b7 feat(agentchat/config): pressure_caps per-window threshold map on providers
7e75904 feat(core/maestro/schema): pressure_capped termination reasons + subscription_pressure bounds axis
ddcc5f3 feat(core/maestro/subscription-pressure-cache): in-memory 30s-tick cache over t0 rate-limit-snapshots
09e3063 feat(core/maestro/check-pressure-cap): pure cap-check function with stale-warm/idle hybrid
60a720b feat(daemon): wire SubscriptionPressureCache into Services with 30s tick lifecycle
551976b feat(daemon/routes/chains): pre-dispatch subscription-pressure cap gate
719a3f6 feat(daemon/maestro/bounds-callbacks): subscription-pressure backstop on tracker tick
b801c9c fix(daemon/maestro): pressure check fires every tick, not only on hard kill
1df4ad9 fix(cli/start, core/cost-quota): thread pressure_caps through ProviderQuota mapping
e05e853 docs(notes): subscription-pressure cap smoke 2026-05-08
```

138 tests across 21 files green at end of session. Live config in place at `~/.config/agentchat/agentchat.yaml`:

- 58 agents annotated with `pricing_mode` (29 subscription / 29 api).
- Provider names canonicalized: `anthropic`, `openai`, `google`, `opencode-go` (yaml ↔ t0 join is direct equality).
- `anthropic.pressure_caps = { five_hour: 95, seven_day: 90 }` enforced. Other providers default to 90% via `checkPressureCap.defaultCapPct`.
- Verified end-to-end: cap=50 vs current seven_day=73% returned HTTP 400 `subscription_pressure_capped`; cap=90 lets dispatch through.

## Open follow-ups (next session candidates)

### Phase 3 cost-tracking deferrals (from the spec / smoke notes)

1. **Refuse-and-warn IPC** — soft-warn at e.g. 80% via the `chain_send_message` IPC bridge instead of binary refuse-and-stop. Depends on the bounds-tracker's existing 80% soft-warning path being verified end-to-end (wired but apparently never observed firing in production; see `feedback_phase_3b_cost_ledger.md` and `project_maestro_reply_channel_2026-05-06.md`).
2. **Auto-retry on window reset** — failed orchestrate tasks could schedule themselves to retry after `resets_at`. Interacts with the task-board reactor.
3. **Refuse-and-downgrade routing** — auto-fallback to a cheaper agent on cap-trip. Needs per-agent cost data we don't have.
4. **Gemini quota enforcement** — no reader exists. Upstream gap (`project_gemini_aftermodel_hook_payload.md`).
5. **Final-summary memory observation (3.4)** — was in the plan; skipped as redundant with the `subscription-pressure-cap-trip` t0_events row. Revisit if `memory.recall` on these events proves inadequate next time the maestro tries to surface "your last run hit pressure cap".

### Operational debt

6. **t0_events backfill bloat** — when `72e79c8` opened the poller, ~1,250 historical codex rollout events back-emitted in the first poll. The 24h lookback (`78d0ab2`) prevents future re-walks; historical rows still in t0. One-time `DELETE FROM t0_events WHERE event_type='rate-limit-snapshot' AND ingest_ts < '2026-05-08'` would tidy storage. Not blocking — aggregator dedupes correctly.
7. **claude-acp-sonnet 5-min stall mid-tool-call** — 3.3's first dispatch hit `stdio-acp: no wire activity (session/update or onRequest) for 300000ms — agent stalled mid-turn` twice on `toolu_01FxxKPLiJnexyfciCpbndhi`. Worked around by re-dispatching to codex-acp-fast. Already known per `project_acp_failure_modes.md`; this specific tool-id pattern is worth memo'ing if it recurs.
8. **codex-mini auto-routed for 3.2** — I dispatched to claude-acp-sonnet, the chain executed on codex-mini. Some recall/redirection logic re-routed; the work landed correctly but worth understanding before relying on agent picks. Look at `agent_recommend` / `chain_start` routing in the daemon for the redirect mechanism.

### Trivia (non-blocking)

9. **Plan validator strictness** — `id: 1.1` (unquoted YAML float) silently fails the schema check during `penumbra plan validate`; the writing-plans skill could pre-format ids as quoted strings to save the validator iteration loop. Caught me twice today.
10. **`bounds-tracker-pressure.test.ts:103` typecheck noise** (number-vs-string assignability) and `beforeEach` unused import — trivial cleanup.
11. **`packages/daemon/src/serve.ts` rootDir warnings** — `@penumbra/workflows` cross-package imports trip TS rootDir checks. Pre-existing, not blocking.

### Tooling
12. **`session-handoff` workflow recall is broken** — emitted warnings `memory.search: no such table: t1_memories` and `recall budget exceeded: trimmed 1 items (target 8000 tokens)` while generating today's handoff. The "Today's session memories" / "Commits since midnight" / "Diff against main" sections all came back empty even though there were ~20 commits today. Likely the workflow's t1 table reference is stale (the schema has `memory_t1` or similar; check `packages/core/src/db/schema.ts` for the canonical name). The `git log --since` filter probably also hits a TZ mismatch — daemon runs UTC but commits are stamped with local TZ in `git log --oneline`. Both result in handoffs that need manual rewrites every session.

## Memories saved this session

- [Repo agentchat.yaml is a test skeleton, not the production fleet](project_repo_agentchat_yaml_is_skeleton.md) — real fleet at `~/.config/agentchat/agentchat.yaml`. Dispatching "edit agentchat.yaml" tasks without specifying which file leads coding agents to fabricate the entire fleet.
- [Local-state usage poller never runs in production](project_usage_poller_never_runs.md) — closed by `72e79c8`; documents the gate trap in case a future deployment regresses.
- [Canonical subscription_provider names](project_subscription_provider_canonical_names.md) — yaml uses `anthropic` / `openai` / `google` / `opencode-go` (not vendor-suffixed). Direct equality join with t0 `provider`.

## State at session end

```
$ git log --oneline -3
e05e853 docs(notes): subscription-pressure cap smoke 2026-05-08
1df4ad9 fix(cli/start, core/cost-quota): thread pressure_caps through ProviderQuota mapping
b801c9c fix(daemon/maestro): pressure check fires every tick, not only on hard kill

$ launchctl list | grep penumbra
<pid>  0  dev.penumbra.daemon
<pid>  0  dev.penumbra.worker

$ mcp__penumbra__handoff_list_pending
[]

$ mcp__penumbra__subscription_pressure_status (no args)
4 snapshots: anthropic/{five_hour:17, seven_day:73}, openai/{primary:2, secondary:6}; 0 warnings
```

Daemon + worker healthy. Pressure data flowing every poll tick. Cap gate live and tested.

## Memories worth reading at session start

- `project_subscription_provider_canonical_names.md` — yaml ↔ t0 provider naming
- `project_usage_poller_never_runs.md` — closed but documents the workerId-gate trap
- `project_repo_agentchat_yaml_is_skeleton.md` — agentchat.yaml fleet location trap
- `feedback_dispatch_reliability_workarounds.md` — claude-acp-sonnet stall pattern (relevant to follow-up 7)
- `feedback_sequential_rollout_no_dispatch_loops.md` — sequential phase discipline (any cost-tracking follow-up should follow this)
- `feedback_dont_commit_to_main_during_dispatch.md` — main-branch commits during dispatch break auto-merge

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `mcp__penumbra__subscription_pressure_status` → spot-check live data still flowing
4. Pick a direction with the user from the follow-ups inventory above. Most natural next step is **refuse-and-warn IPC (#1)** since it builds directly on the Phase 3 cap surface and only needs the existing soft-warn path validated. Most valuable infrastructure improvement is the **codex-mini auto-route investigation (#8)** since it affects how reliably dispatched agents stay on the agent the prompt named. The **session-handoff workflow recall fix (#12)** is small and quality-of-life — addresses why this very note had to be hand-written.
