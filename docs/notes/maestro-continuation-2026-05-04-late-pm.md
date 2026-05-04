# Maestro continuation — 2026-05-04 late PM → next session

Paste this as the next-session kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

Follow `AGENTS.md`. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## State at session start

- Branch: `main`, pushed to `origin/main` (frozename/penumbra)
- Latest commit: `c543a07` (Phase 2.3 — workflow registry)
- Daemon + worker: launchd-managed, both running.
- `bun test packages/workflows` → 12 pass, 0 fail (4 files: schema, markdown loader, ts loader, registry).
- No pending handoffs.

## What landed this session

**Workflow runtime — Phases 1–2 of the implementation plan.**

- Spec: `docs/superpowers/specs/2026-05-04-workflow-runtime-design.md`
- Plan: `docs/superpowers/plans/2026-05-04-workflow-runtime.md` (5,304 lines, 14 phases, 50 tasks, all TDD-staged with concrete code)

Commits in order:

| Commit | Phase.Task | Description |
|---|---|---|
| `553afaf` | 1.1 | `workflow_stats` table + bump SCHEMA_VERSION to 5 |
| `4497078` | 1.1 fix | Unpin SCHEMA_VERSION assertion in dispatch_events test (regression from 1.1) |
| `a3a17b8` | 1.2 | Scaffold `@penumbra/workflows` + zod `WorkflowSpec` contract |
| `63f4799`, `881f8af` | docs | Plan zod-version sync to v4 (matched workspace) |
| `be1dbe3` | 1.3 | Wire `@penumbra/workflows` into root tsconfig references |
| `e10b38a` | 2.1 | Markdown playbook loader with YAML frontmatter parser |
| `7f1f791` | 2.2 (retry) | TS workflow loader with default-export validation |
| `c543a07` | 2.3 | Workflow registry — boot from playbooks/+workflows/ with trigger index |

## Dispatch pattern that's working

- **Implementer**: `claude-acp-sonnet` is the gold-standard. Lands clean every time.
- **Spec/quality review**: maestro-direct review for diffs <200 lines (consistent with the existing pattern from `feedback_phase_3b_cost_ledger.md`); plan reserves dispatched reviewers for substantial multi-file tasks.
- **Parallelism**: dispatching 2.1 ∥ 2.2 in parallel worked, but `gemini-acp-pro` silent-failed on 2.2 (`reliability: no_worktree_activity`, empty diff in 1m27s). Auto-retry net DID NOT fire — the reliability classifier marked the dispatch `outcome=success` despite no changes, so the silent-failure trigger condition was never met. **This is a real follow-up bug** worth filing — today's auto-retry net only catches dispatches that performance-capture maps to `outcome=failed`, which doesn't include the `no_worktree_activity` reliability class.
- **Recovery**: re-dispatched 2.2 to `claude-acp-sonnet` with explicit "previous agent silent-failed; verify each step's expected output" preamble — landed clean in 40s.
- **Phase parallelism map** for upcoming phases:
  - Phase 3: 3.1 ∥ 3.2 ∥ 3.3 ∥ 3.4 → 3.5 (file-disjoint sources, then composer)
  - Phase 4: 4.1 ∥ 4.2 → 4.3
  - Phase 5: 5.1 → 5.2 ∥ 5.3 ∥ 5.4 → 5.5
  - Phase 6: sequential
  - Phase 7: 7.1 ∥ 7.2 → 7.3
  - Phase 8: sequential (same file)
  - Phase 9: sequential (shared daemon-client.ts + server.ts)
  - Phase 10: single
  - Phase 11: 11.1 ∥ 11.2 → 11.3
  - Phase 12: sequential
  - Phase 13: 13.1 → 13.2 ∥ 13.3
  - Phase 14: sequential (smoke + docs + install)

## Open work (resume point)

**Phase 3 — Recall composer + sources.** Tasks 3.1 (template-vars), 3.2 (git.log/diff), 3.3 (memory.search), 3.4 (dispatch_events + handoff.list_pending) are all parallelizable. 3.5 (composer) follows.

Each task has full TDD specification in `docs/superpowers/plans/2026-05-04-workflow-runtime.md`. The plan instructions are paste-into-dispatch ready.

## Tracked tasks (TaskList state)

| ID | Status | Phase |
|---|---|---|
| 7 | completed | Phase 1 |
| 8 | completed | Phase 2 |
| 9 | pending | Phase 3 — start here |
| 10 | pending | Phase 4 |
| 11 | pending | Phase 5 |
| 12 | pending | Phase 6 |
| 13 | pending | Phase 7 |
| 14 | pending | Phase 8 |
| 15 | pending | Phase 9 |
| 16 | pending | Phase 10 |
| 17 | pending | Phase 11 |
| 18 | pending | Phase 12 |
| 19 | pending | Phase 13 |
| 20 | pending | Phase 14 |

## Notes / gotchas

- **`bun install` is required after merging any task that touches `package.json` / `bun.lock`.** Tasks 2.1 and 1.2 both modified the workspace lock; merging without `bun install` left `yaml` uninstalled and broke `bun test packages/workflows`. After every merge that includes lock changes, run `bun install` before `bun test`.
- **Plan vs workspace inaccuracies caught**: zod `^3.23.8` was wrong (workspace uses `^4.3.0`); the plan was corrected mid-session in `63f4799` + `881f8af`. The workspaces array is a glob (`packages/*`), so adding `packages/workflows` to it is unnecessary; only the tsconfig reference is needed.
- **Auto-retry false-negative** — `gemini-acp-pro` silent-failed on 2.2 with `reliability: no_worktree_activity` but the chain still resolved as `status: completed`. Performance capture didn't classify this as `outcome=failed`, so the auto-retry didn't trigger. Open follow-up: extend silent-failure detection to include `no_worktree_activity` reliability class regardless of the explicit `outcome` value.
- **Reviewer pair pattern** is being held: maestro-direct review for diffs <200 lines, dispatched reviewer for larger. So far all merged tasks have been <200 LOC.
- **Pre-existing TypeScript diagnostics** (stdio-acp.test.ts, hybrid.test.ts, t2-promotion.test.ts, etc.) are not from this work — they were present before Phase 1. Ignore.
- **`bun test` post-test fastembed/ONNX panic** is cosmetic — exit 0 even with the panic banner. Ignore (memory: `bun_onnx_teardown_panic.md`).
- **Don't commit to main while a dispatch is in flight** — reconciler does FF-only merge; concurrent commits cause divergence and force manual cherry-pick. (Memory: `feedback_dont_commit_to_main_during_dispatch.md`).

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `bun test packages/workflows` → confirm 12 pass baseline
4. Mark task #9 `in_progress`
5. Dispatch Phase 3.1 (template-vars resolver) and 3.2 (git.log/diff) in parallel — both use `claude-acp-sonnet`, both file-disjoint. While they run, dispatch 3.3 (memory.search) and 3.4 (dispatch_events + handoff.list_pending). All four can run concurrently.
6. After all four merge, dispatch 3.5 (composer) — depends on all four sources existing.
7. Continue with Phase 4 — same parallel pattern.
8. **Suggested cadence:** finish Phase 3 + 4 + 5 + 6 in this next session. They are the bulk of the runtime. Phases 7–14 are surface-area (HTTP routes, MCP, CLI, hooks, playbooks, docs) and can land in a third session.

## Reminder on the eventual MVP

This implementation plan exists to ship `session-handoff` as the first workflow — automating exactly this kind of continuation prompt. Once Phase 12 lands, the manual "write a continuation file before /clear" ritual is gone.
