# Maestro continuation — 2026-05-07 pm: Phase 5 smoke + AGENTS.md ref swap

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `{{repo_root}}` (the penumbra repo at `/Volumes/WorkSSD/repos/personal/penumbra`).

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## What this session shipped (commits `4a13c23..aab4dd5`)

The penumbra-native skill plugin scaffold landed. Plan: `docs/superpowers/plans/2026-05-07-penumbra-skill-plugin.md`. Status: Phases 0–4 complete; Phase 5 (smoke + ref swap) is the open task.

**12 skills now live under `plugin/skills/`:**

| Skill | Phase | Replaces |
|---|---|---|
| `penumbra-skill-loader` | 1.1 | `superpowers:using-superpowers` (meta auto-load) |
| `brainstorming` | 2.1 | `superpowers:brainstorming` (thin → `plugin/playbooks/brainstorm`) |
| `writing-plans` | 2.2 | `superpowers:writing-plans` (thin → `plugin/playbooks/write-plan`) |
| `handoff` | 2.3 | new (thin → `plugin/playbooks/session-handoff`) |
| `mem-search` | 2.4 | (existing — tool-name alignment + description tightening) |
| `dispatching` | 3.1 | `superpowers:subagent-driven-development` + `dispatching-parallel-agents` (merged) |
| `test-driven-development` | 3.2 | `superpowers:test-driven-development` (penumbra-flavored, framework-agnostic) |
| `dispatch-reliability-triage` | 3.3 | `superpowers:systematic-debugging` (penumbra failure taxonomy) |
| `maestro-recall-prime` | 4.1 | new — pre-action t2 memory prime |
| `agent-pick-via-ledger` | 4.2 | new — `agent_recommend` gate before dispatch |
| `worktree-state-audit` | 4.3 | `superpowers:verification-before-completion` (penumbra-mediated) |
| `session-fast-context` | 4.4 | new — session-start context auto-prime |

**Dropped without porting** (audit confirmed dormant in last 7 days): `executing-plans`, `using-git-worktrees`, `requesting-code-review`, `receiving-code-review`, `finishing-a-development-branch`, `writing-skills`.

**Plumbing landed:**
- `packages/core/src/plugin/skill-meta.ts` + tests — frontmatter validator (loader for `plugin/skills/*/SKILL.md`).
- `packages/core/test/plugin/playbook-portability.test.ts` — regression guard. Banned-pattern grep over `plugin/playbooks/*/playbook.md`. Escape hatch: `<!-- portability-allow -->` ... `<!-- /portability-allow -->`.
- `{{cwd}}` and `{{repo_root}}` template vars added to `packages/workflows/src/template-vars.ts` + threaded through `daemon/serve.ts`, `daemon/routes/workflows.ts`, `workflows/exec.ts`. Daemon was restarted to pick up the new context fields.
- `plugin/playbooks/session-handoff/playbook.md` and `maestro-context-prime/playbook.md` softened: `{{repo_root}}` substitution, AGENTS.md is gated on existence.

**Verification status:** `bun test ./packages/core/test/plugin/skill-meta.test.ts ./packages/core/test/plugin/playbook-portability.test.ts` → 4 pass, 0 fail. All 12 skills' frontmatter validates.

**Locked-in design rule** (binding for any future skill work):

> Skills ship with the penumbra plugin and run in any user project. Skill bodies must NOT reference penumbra-repo internals — no hardcoded `/Volumes/...` paths, no `packages/...` imports, no `bun test`, no `loadSqliteVec`, no language- or test-framework assumption. Skills MAY rely on penumbra MCP tool names, plan-runtime, agentchat registry, t2 memory corpus.

## Phase 5 — open task

Phase 5 of the plan is the switchover smoke + doc swap. It's designed to be hand-run by maestro, NOT dispatched. Two parts:

### Part A — smoke session (just opened — do this first)

1. Confirm the new skills appear in the available-skills list at session start (you should see `brainstorming`, `writing-plans`, `handoff`, `dispatching`, `test-driven-development`, `dispatch-reliability-triage`, `maestro-recall-prime`, `agent-pick-via-ledger`, `worktree-state-audit`, `session-fast-context`, `penumbra-skill-loader`, `mem-search` as penumbra-native, alongside the still-installed `superpowers:*` set).
2. Try a small exercise: `/brainstorm` then `/write-plan` for a fictional 1-task spec then `/handoff`. Watch the harness pick the penumbra skill over the superpowers equivalent on description match.
3. If a `superpowers:*` skill still wins on a tie for a given trigger phrase, tighten the penumbra `description` until the penumbra version matches first.
4. Confirm `{{repo_root}}` substitution works in the handoff playbook (the prompt template now uses it, the daemon was restarted to pick up the new template var). The composed handoff prompt should reference your actual cwd, not `/Volumes/WorkSSD/...`.

### Part B — AGENTS.md / CLAUDE.md ref swap

Grep for explicit `superpowers:*` references and swap them to point at the penumbra equivalents:

```
grep -rEn 'superpowers:[a-z-]+' AGENTS.md CLAUDE.md docs/notes/maestro-continuation-* 2>/dev/null
```

Update each match using the replacement table above. Single commit:

```
docs: switch maestro flow references from superpowers/* to penumbra plugin skills
```

Defer the actual `superpowers/` plugin uninstall to a follow-up session — leave it installed but unused for at least one full work-day to catch any missed call-sites.

## Backlog (V2 of this initiative — DO NOT start without explicit user buy-in)

From the plan's deferred net-new list:
- `workload-health-check` (llamactl gate before relying on a local LLM)
- `plan-runtime-aware` (warn when editing a plan that plan-runtime is actively executing)
- `cost-budget-awareness` (bounds-tracker p50 hints when filing `kind=orchestrate`)
- `incident-postmortem` (auto-prompt to write a t2 memory note after a fix)
- `t2-promotion-debug` (judge-pool diagnostic flow)
- `knowledge-distillation-trigger` (consolidate after N memories accumulate)
- `cross-judge-verification` (V3 dual-judge writes)

## Other open follow-ups carried forward (not skill-related)

- Cross-repo plan-runtime V2 phase 2c — stacked-PR base for chained leaves (V3-tier polish)
- Cost-overshoot pre-emptive cap (`$2.18 vs $2.00` budget on autonomous-maestro)
- Memory backlog: ~1,800 t1_unpromoted draining at ~9 promotions/tick
- Mac-mini granite-8b running as untracked process (no auto-restart)
- `soft_warned_at` stays null even after IPC bridge merge — observability commit `2cc94cb` should reveal whether the tracker tick fires; verify next time bounds are exceeded.

## Memories to read at session start

- `feedback_delegate_dont_implement.md` — penumbra orchestrator rule
- `feedback_dispatch_reliability_workarounds.md` — claude-acp-sonnet refusal + cosmetic codex-acp tool_failure
- `feedback_sequential_rollout_no_dispatch_loops.md` — when to parallel vs serialize
- `project_reconciler_pr_mode.md` — agent branches do NOT auto-FF; cherry-pick or use the PR flow
- `project_t2_promotion_pipeline_2026-05-06.md` — promotion plumbing state
- `project_maestro_reply_channel_2026-05-06.md` — chain_send_message + IPC bridge

## First moves

```
git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5
mcp__penumbra__handoff_list_pending
ls plugin/skills/   # confirm 12 skills present
bun test ./packages/core/test/plugin/skill-meta.test.ts ./packages/core/test/plugin/playbook-portability.test.ts
```

Then proceed with Part A (smoke) and Part B (ref swap). Report any tie-break-loss to the superpowers equivalents so the description can be tightened before the eventual uninstall.
