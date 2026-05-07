# Maestro continuation prompt — 2026-05-08

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

Follow `AGENTS.md`. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Primary goal for this session

**`/write-plan` against `docs/superpowers/specs/2026-05-07-subscription-cost-tracking-design.md` — Phase 1 + Phase 2 only.** Phase 3 (cap mechanism) and Gemini gap stay deferred until Phase 1+2 data is trusted for one full work-day.

Read the spec first; it has forensics findings, design shape, code anchors, and three open questions to resolve in the plan (canonical Claude rate-limit source, OpenCode db research gate, `provider` filter arg).

## What shipped 2026-05-07 evening (commits `94d026e..5d64ce9`)

The whole `mcp.tool recall wiring + session-handoff fix` spec is closed. Two phases, 13 commits:

**Phase 1 — registry refactor** (`94d026e`):
- `packages/mcp/src/server.ts` shrunk 482 → 15 lines; loops over `TOOL_REGISTRY` from `packages/mcp/src/tools/registry.ts`
- All 57 MCP tools tagged with `readOnly: boolean`

**Phase 2 — pivot to native recall sources, drop `mcp.tool`** (`d55883a..5d64ce9`):
- Original Phase 2 (build `createMcpToolInvoker` + bucket aliasing) hit an architectural wall: handler factories take `DaemonClient` (HTTP), and the daemon can't HTTP-self-call cleanly. After a brainstorm, we pivoted: there were only TWO callsites for `source: mcp.tool` in the whole repo. Built native recall sources for both, deleted the generic.
- `recall-sources/memory.ts` now supports `tiers: ['t1','t2']` (a0ab4ed)
- New `recall-sources/agents.ts` — pulls from daemon's `services.agentRegistry` (312c4db)
- Daemon plumbs `agentRegistry` into all 3 `composeRecall` call sites (d11507e)
- `/write-plan` and `/handoff` playbooks swapped to native sources (486a9bd)
- `agents` registered in workflow schema discriminator (882d4df)
- Dead `mcp.tool` source + `createMcpToolInvoker` deleted (3 files, 4 edits, 282 LOC removed) (57cecc5)

Earlier abandoned scaffolding (`9ce8176`, `8d1237d`, `eeedbe7`) is reverted by `57cecc5`; commits stay in history as a record of the pivot.

## Smoke finding from this session — flag before subscription work

**`memory.search: no such table: t1_memories`** — emitted as a warning when `/handoff` ran with the new `tiers: ["t1","t2"]` arg. The recall source from task 2.1 needs a graceful fallback when t1 tables don't exist in this schema. Likely a tiny fix in `packages/workflows/src/recall-sources/memory.ts`: detect missing table, emit warning, return only t2 hits. Small. Worth fixing before subscription work consumes more memory bandwidth.

(The original Phase 3 spec said "verify t1 actually contains live-session events before Phase 3" — this is the verification gap. T1 doesn't exist in this storage shape; either the schema migration never ran here, or the t1 tier is a different table name. Worth a forensics pass.)

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. **Quick fix first:** patch the `memory.search` source to skip t1 gracefully when the table doesn't exist. ~5-10 LOC. Smoke `/handoff` afterwards to confirm the warning's gone.
4. **Then primary goal:** read `docs/superpowers/specs/2026-05-07-subscription-cost-tracking-design.md`. Run `/write-plan`. Anchor the plan on the spec; scope to Phase 1 + Phase 2 only; query `mcp__penumbra__chain_list_agents` directly for `preferred_agent` / `fallback_agent` if the workflow's `agents` recall doesn't surface in the `/write-plan` template.
5. Validate via `penumbra plan validate` and offer Subagent-Driven vs Inline execution to the user.

## Spec at-a-glance

**Phase 1**: Per-agent `pricing_mode: api | subscription` tag in `agentchat.yaml`; loader validation; reader fixes.
- `ClaudeJsonlReader` returns `[]` — decide if `ClaudeStatusLineBridge` is canonical (it consumes `/tmp/penumbra-claude-rl.json` already)
- `OpenCodeDbReader` returns `[]` — research the local db schema first
- `CodexRolloutReader` is implemented but unverified live
- Gemini explicitly deferred (in-memory only per `project_gemini_aftermodel_hook_payload.md`)

**Phase 2**: New MCP tool `mcp__penumbra__subscription_pressure_status` returning per-(provider, window_label) snapshots from `t0_events`. No new schema. Stale snapshots → warning, not error.

**Code anchors**: `packages/agentchat/src/usage-readers/`, `packages/core/src/cost.ts`, `packages/mcp/src/tools/cost-*.ts`.

## Memories to read at session start

- `feedback_phase_3b_cost_ledger.md` — Phase 3b cost ledger architecture (the existing surface)
- `project_gemini_aftermodel_hook_payload.md` — Gemini gap (relevant to Phase 1)
- `project_maestro_reply_channel_2026-05-06.md` — IPC bridge (relevant to deferred Phase 3 cap-warn)
- `project_daemon_reload_config_covers_workflows.md` — when reload-config suffices vs daemon restart
- `feedback_sequential_rollout_no_dispatch_loops.md` — sequential phase discipline
- `feedback_dispatch_reliability_workarounds.md` — codex-acp-fast `tool_failure_with_end_turn` is mostly cosmetic
- `feedback_delegate_dont_implement.md` — delegate via `chain_start`

## Open follow-ups carrying forward

- Cross-repo plan-runtime V2 phase 2c — stacked-PR base for chained leaves (V3-tier polish)
- Cost-overshoot pre-emptive cap (`$2.18 vs $2.00` budget on autonomous-maestro) — depends on subscription cost tracking landing first
- `soft_warned_at` stays null after IPC bridge merge — observability commit `2cc94cb` was meant to reveal whether the tracker tick fires; verify whether that commit landed
- Memory backlog: ~1,800 t1_unpromoted draining at ~9 promotions/tick (was the state on 2026-05-06; check current `mcp__penumbra__memory_status`)
- Mac-mini granite-8b running as untracked process — needs ssh-side cleanup to register under llamactl supervision
