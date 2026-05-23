# Maestro continuation prompt — 2026-05-23 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool authorship. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

Execute the **First moves** checklist below immediately. Don't pause to ask permission per item — batch independent tool calls in parallel.

## What this session shipped

Three meta-themes: (1) **dreaming feature** finished + adversarialed + remediated through two rounds; (2) **memory curator** subsystem designed (adversarial-plan), shipped end-to-end (6 phases), and went through two more adversarial-review-and-fix cycles; (3) several **systemic infra fixes** unblocked everything else (worker heartbeat stalls, claude-acp-sonnet maestro-derailment).

### Headline commits (origin/main = `03d255aa`)

| Commit | Subject |
|---|---|
| `03d255aa` | curator adv round-2 — per-result cache key, cursor wrap fix, admin guard inversion, auto-apply env gate, batched cluster SELECTs, unified judge threshold, drop runtime DDL |
| `502716af` | curator adv round-1 — domain gate, intra-cluster max, cursor v1, principal guard v1, completed_with_curator_error, judge wiring, naming |
| `dd8db608` | Curator Phase 6 — wire PC1+PC2 into runDreamCycle (gated by `PENUMBRA_DREAMING_CURATOR_ENABLED=1`) + e2e |
| `fb2d4f18` | Curator Phase 5 — 4 MCP pattern tools + daemon `/curator/*` routes |
| `a5f2c16e` | Curator Phase 4 — heuristic content-quality judge for P5 results |
| `7c83da4b` | Curator Phase 3 — PC2 cluster dedup + revert |
| `34034e9f` | Curator Phase 2 — PC1 ephemera detector + sweep + revert |
| `86c92b37` | Curator Phase 1 — `curator_ephemera_patterns` table |
| `2afddab4` | **agentchat-worker: 10s heartbeat timeout** — fixes the ~14min worker stall pattern |
| `cef05e54` | dreaming P1 — ephemera filter + UUID-fallback drop + pre-promote dedup + judge ephemera-skip prompt |
| `935c1b04` | agentchat-worker — `flag()` helper accepts `--name=value` syntax |
| `bdd2c6f8` | agentchat-worker — persist workerId in `~/.penumbra/worker-id` (WTB#6) |
| Earlier today | dreaming Phase B–D feature shipped (FU#1–#6 + #5 query-source fix) + worker-token-binding follow-ups |

Total: **~25 commits since the prior handoff** (2026-05-21 pm-late at `c64006d`).

### Live config patches NOT yet in git (applied 2026-05-22)

1. `~/.config/agentchat/agentchat.yaml` — added `claudeCodeStrictMcpConfig: true`, `claudeCodeTools: []`, `claudeCodeAllowedTools: [...]` to the `claude-acp-sonnet` entry. Prevents the global `~/.claude/CLAUDE.md` + skill/agent contamination that derailed three implementer dispatches today. See `[[feedback_claude_acp_strict_mode_prevents_maestro_derailment]]`.
2. `~/.config/agentchat/agentchat.yaml` — `review_synthesizer.preferred_agent` swapped from `codex-acp-deep` to `claude-acp-sonnet` (ACP subscription, no API charge). User explicit choice.
3. launchd env: `FIRECRAWL_API_KEY` (sourced from Keychain), `PENUMBRA_DREAMING_ENABLED=1`. Dreaming cron is ON in production at 30-min cadence.

### Memories saved this session

- `[[feedback_session_prompts_must_never_reach_external_apis]]` — Gap #5 P4 shipped sending agent standing-prompts to Firecrawl; fixed via t2 titles.
- `[[feedback_observe_shelved_named_items_proactively]]` — MLX-1/4 had no memory traces; write project memories for shelved items proactively.
- `[[feedback_dispatch_must_pin_event_bus_types]]` — Phase D Task 4.2 invented McpEventBus; pin types or fall back to polling.
- `[[feedback_claude_acp_strict_mode_prevents_maestro_derailment]]` — 3 derailment incidents traced to global Claude Code config inheritance; strict-mode knobs fix.
- `[[project_dreaming_smoke_findings_2026_05_22]]` — 3 prod-blocking gaps from the dreaming smoke test.
- `[[project_worker_token_rotation_split_brain_2026_05_22]]` — split-brain workerId rotation design memo.
- `[[project_gh_122_pass_2_3_status_2026_05_22]]` — what remains of the GH #122 follow-ups.

## Live state

- **launchd**: `dev.penumbra.daemon` pid 18617 (last kickstart 22:34 BRT). Worker via launchd present too. Stable.
- **Worker pool**: 3 active — launchd `worker-srmw7` (8 slots) + two manually-spawned `worker-extra-1`/`worker-extra-2` (4 slots each). 16 concurrent dispatch slots total. All heartbeating fresh post `2afddab4` (10s timeout fix). Relaunch the extras as needed: `bun packages/agentchat/bin/agentchat-worker.ts --worker-id worker-extra-N --concurrency 4 > /tmp/penumbra-worker-extra-N.log 2>&1 &`.
- **launchd worker plist** `~/Library/LaunchAgents/dev.penumbra.worker.plist` was finicky earlier ("Input/output error 5" on bootstrap). The launchd-managed worker recovered via the persisted `worker-srmw7` ID; the plist itself may need attention. If kickstart fails: `launchctl bootout gui/$(id -u)/dev.penumbra.worker` then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.penumbra.worker.plist`.
- **Memory store**: ~346 active t2 (kinds: knowledge, decision, fact, preference, rule, convention, etc.) after 574 retired today. The `dream_actions` queue still has thousands of historical P2 link candidates with no `expires_at`.
- **Dreaming pipeline**: P0–P8 all wired and running. P5 (research/Firecrawl) gated by per-project `dreaming.research_provider` — penumbra is `firecrawl`. P6 (briefs) uses agentchat role `brief-synthesizer` when configured; defaults to stub if no agent is tagged. **Curator (PC1/PC2) gated by `PENUMBRA_DREAMING_CURATOR_ENABLED=1` — currently UNSET in launchd**.

## Open follow-ups

1. **Enable curator in production**: `launchctl setenv PENUMBRA_DREAMING_CURATOR_ENABLED 1`, then `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`. Also explicitly set `PENUMBRA_DREAMING_PC2_AUTO_APPLY=1` ONLY when ready for cluster_retire to auto-fire. Without that env, all PC2 actions ship `status='queued'` for human triage via `memory_list_pending_dream_actions`.
2. **Tag a brief-synthesizer agent in agentchat.yaml**: P6 currently writes stub briefs because no agent has `role: brief-synthesizer`. Natural dflash fit per the llamactl conversation.
3. **Recall reader doesn't honor `retired_at`**: the handoff workflow surfaced 12 retired UUID-ephemera memories in the recall section. Recall query needs `AND retired_at IS NULL`. Likely in `packages/daemon/src/recall/`. Small fix.
4. **Worker-token-binding leftovers**:
   - #1+#2: single-active-token rotation policy (now unblocked by stable workerId from `bdd2c6f`).
   - #5: D1 stale-token sweep 24h full live validation.
   - #6: stable workerId — DONE in `bdd2c6f`.
   - #7: GH #122 pass-2/3 — per `[[project_gh_122_pass_2_3_status_2026_05_22]]`, items 5+6 are architectural refactors; deferred.
5. **`task_653bfa4e`** — `mcp__penumbra__workflow_wait` HTTP 400 bug. Still pending.
6. **Pre-existing test failure**: `packages/daemon/test/dreaming/config.test.ts` — 1 fail on `-5` brief config negative-value test. Unrelated to today's work.

## Memories worth reading first

- `[[feedback_claude_acp_strict_mode_prevents_maestro_derailment]]` — applies to EVERY chain_start to claude-acp-sonnet. Knobs in production but the agent occasionally still writes stray notes; harness auto-WIPs them outside the commit now since `git add -A` is gone.
- `[[project_dreaming_smoke_findings_2026_05_22]]` — the three gaps that drove early-session work.
- `[[feedback_session_prompts_must_never_reach_external_apis]]` — prompt-leak pattern that bit twice (Firecrawl + t2 promotion). Watch for it on new external-service wiring.
- `[[project_claude_strict_mcp_config_lever]]` + `[[project_claude_code_tools_knob_prefill_lever]]` — the prefill-reduction levers used to fix claude-acp-sonnet contamination.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `pgrep -fl agentchat-worker` → confirm pool intact (launchd worker-srmw7 + two manual extras); relaunch extras if missing
4. `sqlite3 ~/.penumbra/db.sqlite "SELECT outcome, COUNT(*) FROM dream_cycles WHERE started_at > $(node -e 'console.log(Date.now()-3600000)') GROUP BY outcome;"` — confirm cron firing
5. `mcp__penumbra__long_lived_list` → home-mgmt + task-refiner-primary + task-refiner-escalation ticking?
6. Pick direction with the user:
   - **Enable curator in production** (follow-up #1 — natural next step).
   - **Tag brief-synthesizer agent** (follow-up #2 — small, high-value).
   - **Fix recall retired_at filter** (follow-up #3 — small).
   - **Worker-token rotation policy** (#4 — meatier; now unblocked).
