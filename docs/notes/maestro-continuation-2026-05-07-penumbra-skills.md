# Maestro continuation prompt — 2026-05-07: phase out superpowers, build penumbra-native skills

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

Follow `AGENTS.md`. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Goal of this session

Phase out the `superpowers/*` skill dependency. Build penumbra-native equivalents under `plugin/skills/` that auto-apply via Claude Code's plugin layer, bundled with penumbra.

## Locked-in design choices (from prior brainstorm)

1. **Plugin layer, not MCP playbooks.** Skills live as `plugin/skills/<name>.md` with frontmatter, same shape as superpowers. Cross-CLI compatible (claude/codex/gemini all read the plugin). Daemon-served playbooks stay where they are (`plugin/playbooks/`) for maestro-internal workflows.
2. **Auto-apply.** Skills fire on prompt-match like superpowers does. No explicit invocation requirement.
3. **No offline degradation needed.** Skills can assume the penumbra daemon is reachable since they're bundled with penumbra.

## Existing scaffold

- `plugin/skills/mem-search` — one skill exists already. Read it to understand the file shape penumbra has settled on.
- `plugin/playbooks/{brainstorm, delegate-suggest, file-context, maestro-context-prime, prompt-classify, session-handoff, session-summarize, write-plan}` — internal workflows. Some overlap with superpowers skills; decide whether to duplicate or share.
- `~/.claude/plugins/installed_plugins.json` — current Claude Code plugin registry.

## Replacement map (audit-gated — only port what we actually use)

**Step zero: audit transcripts before deciding what to replace.** Grep recent session transcripts for `Skill(` invocations under `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/`. Anything that hasn't fired in the last ~10 sessions is dormant — drop it without porting.

Best guess from observed maestro flow (refine via the audit):

| superpowers/* skill | Likely status | Replacement strategy if active |
|---|---|---|
| `using-superpowers` (meta) | **active — every session** | New `plugin/skills/penumbra-skill-loader.md` — same role, references penumbra surface. |
| `brainstorming` | **active — design discussions** | Thin skill auto-applying `plugin/playbooks/brainstorm`. |
| `writing-plans` | **active — when spec → plan** | Thin skill auto-applying `plugin/playbooks/write-plan`. |
| `handoff` | **active — end of session** | Thin skill auto-applying `plugin/playbooks/session-handoff`. |
| `executing-plans` | **likely active — phase exec** | DROP. Plan-runtime sweeper already does this; replace with a one-liner skill: "phased plans go to plan-runtime via filing them as a kind=orchestrate task." |
| `subagent-driven-development` | **likely active** | Merge into a `dispatching` skill that references chain_start + agent-recommend. |
| `dispatching-parallel-agents` | **likely active — multi-task** | Same `dispatching` skill above. |
| `using-git-worktrees` | dormant in maestro flow (penumbra owns worktrees) | DROP entirely. |
| `test-driven-development` | unclear — audit will tell | If active: write penumbra-flavored TDD (bun test, loadSqliteVec pattern). |
| `verification-before-completion` | unclear | If active: replace with `worktree-state-audit` net-new skill below. |
| `requesting-code-review` / `receiving-code-review` | unclear — likely dormant in maestro flow | DROP unless audit says otherwise. |
| `systematic-debugging` | unclear | Replace with the `dispatch-reliability-triage` net-new skill if active. |
| `finishing-a-development-branch` | unclear | Replace with a one-liner referencing reconciler-PR-mode memory. |
| `writing-skills` | only used when authoring skills | DROP unless we're actively writing more. |

The point: minimize what we port. Most maestro flow runs through penumbra primitives (chain_start, plan-runtime, autonomous-maestro, agent_recommend) — these substitute for half the superpowers surface without needing skill bodies.

## Net-new skills (penumbra-only, no superpowers equivalent)

These exist BECAUSE of penumbra's unique surface — recall corpus, agent-performance ledger, autonomous maestro, llamactl fleet, plan-runtime sweeper. Worth shipping alongside the replacements:

| Skill | What it auto-does | Why penumbra-only |
|---|---|---|
| `maestro-recall-prime` | Before any non-trivial action, surface 3-5 most-relevant t2 memories. | Requires t2 corpus + memory_search MCP. |
| `agent-pick-via-ledger` | When about to dispatch, consult `agent_recommend(task_type)` before choosing the agent. Suggest the top-ranked candidate with confidence + last-observed timestamp. | Requires the agent-performance ledger. |
| `dispatch-reliability-triage` | When a dispatch fails, classify the failure (transport-closed / cost-cap / prompt-injection-refused / parse-fail) and reference the matching memory note. Skip retry if the failure is structural rather than transient. | Penumbra-specific failure taxonomy. |
| `worktree-state-audit` | After any chain_start that returns success, before merging, run `git log/diff/status` in the worktree and verify what landed actually matches the prompt's surface area. (We've been doing this manually all session.) | Penumbra owns the agent-branch/worktree lifecycle. |
| `workload-health-check` | Before relying on a local LLM, hit `llamactl_workload_list` + `/v1/models` on the gateway. If the model isn't loaded, surface the apply command. | Tied to llamactl MCP. |
| `plan-runtime-aware` | When editing a `docs/superpowers/plans/*.md` file, remind the user the plan-runtime sweeper will fire its `kind=orchestrate` leaves automatically once the plan starts. | Plan-runtime is penumbra-specific. |
| `cost-budget-awareness` | When filing a `kind=orchestrate` task, suggest realistic bounds (wall-clock, cost, sub-dispatch) based on agent-performance ledger latency/cost p50 for the task_type. | Requires bounds-tracker + ledger. |
| `incident-postmortem` | When a bug is fixed, prompt to write a t2 memory entry capturing the trap so future-self / future-agents can avoid it via recall. | Reinforces the memory pipeline as the project's institutional memory. |
| `t2-promotion-debug` | When promotions aren't landing, run the diagnostic flow (memory_status, last "promoted session" log line, judge probe via `chain send-message` if a wedged child is involved). | Pipeline-specific. |
| `session-fast-context` | At session start, auto-load the most recent `maestro-continuation-*` note + last 5 commits + `handoff_list_pending` + recall hits. (We have `maestro-context-prime` playbook; promote to a skill.) | Penumbra has structured session-start hooks. |
| `knowledge-distillation-trigger` | After N new t2 memories accumulate, file a `kind=orchestrate` task to consolidate them into a higher-level memory or doc. | Self-improving memory loop. |
| `cross-judge-verification` (V3) | For any high-value memory write, dispatch the same prompt to TWO judges in the pool and only persist if both agree on a similar fact. | Maps onto the deferred flavor-2 cross-validation. |

These can ship in any order — start with `maestro-recall-prime`, `agent-pick-via-ledger`, `worktree-state-audit`, and `session-fast-context` (highest leverage, all already partial in playbooks/MCP).

## Phasing

1. **Audit** — read transcripts of recent sessions, grep `Skill(` invocations, confirm which superpowers skills actually fire vs. dormant.
2. **Migrate dormant skills first** — those that can be deleted with no loss (using-git-worktrees, executing-plans).
3. **Migrate placeholders next** — skills where penumbra already has a playbook (brainstorming, writing-plans, handoff). Write the thin skill that auto-applies and delegates to the playbook.
4. **Build new skills** — TDD, verification, code-review, debugging, finishing — these are workflow heuristics with no current penumbra equivalent.
5. **Switchover** — uninstall the superpowers plugin once all replacements ship and a smoke session validates the maestro flow without it.

Don't touch `~/.claude/plugins/superpowers/` directly; phase out by not depending on it.

## First moves

```
git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5
mcp__penumbra__handoff_list_pending
ls plugin/skills/ plugin/playbooks/
cat plugin/skills/mem-search/SKILL.md   # or whatever convention is used
```

## Key memories to read at session start

- `project_t2_promotion_pipeline_2026-05-06.md` — the memory pipeline state we just rebuilt; reference for how penumbra-native auto-applies should observe outcomes
- `project_maestro_reply_channel_2026-05-06.md` — chain_send_message + IPC bridge; relevant if any new skill needs to talk to live dispatches
- `project_reconciler_pr_mode.md` — informs the `finishing-a-development-branch` replacement

## Open follow-ups carrying forward

- Cross-repo plan-runtime V2 phase 2c — stacked-PR base for chained leaves (deferred V3-tier polish)
- Cost-overshoot pre-emptive cap (`$2.18 vs $2.00` budget on autonomous-maestro)
- Memory backlog: ~1,800 t1_unpromoted draining at ~9 promotions/tick
- Mac-mini granite-8b running as untracked process (no auto-restart)
