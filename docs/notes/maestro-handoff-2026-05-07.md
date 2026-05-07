# Maestro continuation prompt — 2026-05-07 evening

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

Follow `AGENTS.md`. Use Penumbra MCP for chain state; don't query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Primary goal for this session

**Phase out superpowers/* skill dependency. Build penumbra-native plugin equivalents under `plugin/skills/`.**

Full design brief: [`docs/notes/maestro-continuation-2026-05-07-penumbra-skills.md`](maestro-continuation-2026-05-07-penumbra-skills.md) (committed `26b1f1f`). Read it first.

Locked-in decisions:
- Plugin layer (cross-CLI), NOT MCP playbooks
- Auto-apply on prompt match (same model as superpowers)
- Bundled with penumbra (assume daemon reachable — no offline degradation)
- Replicate ONLY skills actively in use; audit transcripts first
- Net-new penumbra-only skills (recall-prime, agent-pick-via-ledger, worktree-state-audit, dispatch-reliability-triage, …) ship alongside

## Recent state — what shipped 2026-05-06

- **t2-promotion pipeline rebuilt** end-to-end: pool of judges from agentchat.yaml, lossless chunker, parse-tolerance, ANSI-escape strip, prompt rewrite, max_tokens 16K, 64K workload ctx. Memory backlog draining at ~9 promotions/tick. Memory note: `project_t2_promotion_pipeline_2026-05-06.md`.
- **Maestro reply channel + daemon→worker IPC bridge**: `chain_send_message` MCP tool, CLI wrapper, `POST /sessions/:id/inject` worker route. Bounds-tracker observability now logs each tick. Memory note: `project_maestro_reply_channel_2026-05-06.md`.
- **Live-tested autonomous-maestro twice** — both spawned, decomposed, committed cleanly. `1e0be11` (embedding-similarity dedupe in chunker) and `59781df` (penumbra chain send-message CLI) were authored by the maestro itself.
- **Display fix** — `penumbra task show` now renders termination reasons + real budget consumed instead of `terminated:unknown`/`NaNm`/`$NaN`.
- **Mac-mini stabilization** — deleted competing workload manifests (gemma-mini-q4, granite-3b-mac-mini); only granite-8b runs there now. Memory thrash gone.

## First moves

```
git status --short && launchctl list | grep penumbra && git log --oneline origin/main -10
mcp__penumbra__handoff_list_pending
mcp__penumbra__memory_status
ls plugin/skills/ plugin/playbooks/
cat plugin/skills/mem-search/*.md   # understand the existing skill file shape
```

Then:
1. Read `docs/notes/maestro-continuation-2026-05-07-penumbra-skills.md`
2. Audit step: grep `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/*/transcripts/` for `Skill(` invocations. Tabulate fire-rate per superpowers skill.
3. Discuss with the user which skills to keep, drop, port, and which net-new to build first.
4. Write a phased plan covering the agreed scope.
5. Dispatch implementation.

## Open follow-ups carrying forward

- Cross-repo plan-runtime V2 phase 2c — stacked-PR base for chained leaves (V3-tier polish)
- Cost-overshoot pre-emptive cap (`$2.18 vs $2.00` budget on autonomous-maestro)
- Memory backlog: ~1,800 t1_unpromoted draining at ~9 promotions/tick
- Mac-mini granite-8b running as untracked process (no auto-restart) — needs ssh-side cleanup to register under llamactl supervision
- soft_warned_at stays null even after IPC bridge merge — observability commit `2cc94cb` will reveal whether tracker tick fires at all

## Memories to read at session start

- `project_t2_promotion_pipeline_2026-05-06.md`
- `project_maestro_reply_channel_2026-05-06.md`
- `project_reconciler_pr_mode.md`
- `feedback_dispatch_reliability_workarounds.md`
- `agentchat_local_model_calibration.md`
