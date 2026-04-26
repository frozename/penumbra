# Gemini handoff prompt — agentchat daemon-driven worker (phase 1)

This file is the prompt to send to a Gemini agent (via penumbra `chain.start`, agentchat `--auto`, or pasted into Gemini CLI directly) to execute the implementation plan end-to-end. It expects superpowers skills available in Gemini's environment (mirrored from `~/.claude/plugins/cache/claude-plugins-official/superpowers`).

---

## Prompt body (send this to Gemini)

You are implementing **agentchat daemon-driven dispatch worker — phase 1** in the Penumbra monorepo.

**Repo:** `/Volumes/WorkSSD/repos/personal/penumbra` (already on `main`).
**Spec:** `docs/superpowers/specs/2026-04-26-agentchat-daemon-worker-design.md`
**Plan:** `docs/superpowers/plans/2026-04-26-agentchat-daemon-worker.md`

Read both files **completely** before doing anything else. They are the source of truth. The plan is bite-sized and TDD-shaped; follow it task by task.

### Required superpowers skills (use them — they are not optional)

Invoke these skills **before** their respective work, exactly as the skill mechanics expect (announce the skill, follow it):

1. **`superpowers:subagent-driven-development`** — use this to drive the entire execution. Dispatch one fresh sub-agent per task. Review the sub-agent's diff and test output between tasks before moving on.
2. **`superpowers:test-driven-development`** — every task in the plan is already TDD-shaped (failing test → red → impl → green → commit). Each sub-agent must follow it.
3. **`superpowers:verification-before-completion`** — before claiming a task is done, the sub-agent MUST run the relevant test command and verify the output. No assertions without evidence.
4. **`superpowers:dispatching-parallel-agents`** — within a wave, multiple sub-agents may run in parallel against the same branch. Use this skill to coordinate.

### Execution model — parallel waves

The plan defines 5 waves of tasks with explicit `Depends:` lines. Execute them in order; **within a wave, dispatch sub-agents in parallel** (one sub-agent per task):

| Wave | Tasks | Parallelism | Notes |
|---|---|---|---|
| **A** | T1, T2, T3 | 3 sub-agents in parallel | Foundations; fully independent |
| **B** | T4, T5, T6, T7, T8 | up to 5 in parallel | All depend only on Wave A artifacts |
| **C** | T9, T10, T11 | T9 and T10 in parallel; T11 sequentially after both | T11 imports the modules built in T9+T10 |
| **D** | T12 | 1 sub-agent (alongside Wave C) | Depends only on Wave B; runs concurrently with Wave C |
| **E** | T13, T14, T15 | T13 then T14 sequentially; T15 in parallel with either | Integration tests + docs |

After every wave completes, **you (the orchestrator)** run `bun test` from the repo root and confirm the green count grows monotonically. If any sub-agent reports failure or your verification finds a regression, stop the wave and re-dispatch with a corrective brief that names the failing test by file and line.

### Per-sub-agent brief template

For each task, dispatch a sub-agent with this exact form:

> You are implementing **Task <N> — <title>** from `docs/superpowers/plans/2026-04-26-agentchat-daemon-worker.md`. Spec at `docs/superpowers/specs/2026-04-26-agentchat-daemon-worker-design.md`.
>
> Open the plan, read the entire Task <N> section, and execute every numbered step in order. Each step is checkbox-tracked; tick boxes as you complete them. Do not skip the failing-test step or the run-it-fails step — they are load-bearing for TDD.
>
> Required skills: `superpowers:test-driven-development`, `superpowers:verification-before-completion`. Invoke them at the start.
>
> Constraints (non-negotiable):
> - **No AI / agent attribution in commit messages.** Use neutral conventional commits exactly as the plan dictates. Do NOT add "co-authored-by", "🤖", "Generated with", "Claude", "Gemini", or similar.
> - **TDD discipline:** failing test first, run red, minimal implementation, run green, commit. One test concept per test.
> - **Verification before claim:** before reporting success, run `bun test packages/<pkg>/test/<file>.test.ts` (or the path the plan specifies) and confirm the actual pass/fail line. The Bun ONNX teardown panic at the end of `bun test` is cosmetic — judge by pass count, not exit code.
> - **Don't expand scope.** If the plan says "modify file X", do not refactor unrelated code in file X. Stick to the plan.
> - **Don't invent endpoints, types, or names.** They are pinned in the plan.
>
> When done, report:
>   - exact commit SHA(s) created
>   - test command(s) you ran and the pass/fail counts
>   - any deviation from the plan (with reason)

### Coordination rules

- **No force-push, no rewriting committed history.** Only forward-only commits on `main`.
- **No `--no-verify` ever.** If a hook fails, fix the underlying issue.
- **Bun ONNX teardown panic is benign.** It appears at the end of `bun test` runs in this repo; ignore it. Look at the pass/fail counts on the line preceding the panic.
- **Dependency-first dispatch:** never start a Wave-B task before all of Wave A is committed. Use `git log` to confirm.
- **Stale snapshot risk:** sub-agents may run against an older `main` if dispatched before earlier waves' commits propagate. Have each sub-agent run `git pull --ff-only` (or `git status` to confirm the workspace already has the latest) at start of work.
- **The bin must keep working through phase 1.** Do not delete or rewrite `runAutoChain`'s public API. Existing tests in `packages/agentchat/test/cli/auto-loop.test.ts` must stay green at every commit.

### Acceptance gate

Phase 1 is complete only when **all** of these hold:

1. Every task in the plan is committed with green tests at HEAD.
2. From the repo root: `bun test` reports a higher pass count than the start of the work, with zero new failures (the ONNX teardown panic does not count).
3. Manual smoke per the plan's "Final verification > Step F.2" succeeds: a chain started via `POST /chains/start` (or MCP `chain.start`) is dispatched by `agentchat-worker`, lands t0 events for one `user-prompt` + two `agent-prompt` + two `agent-response` + one `agent-handoff`, and all handoffs end at `completed`.
4. The 7 acceptance criteria in the spec's "Acceptance criteria" section are individually verified.

When done, post a final summary listing every commit SHA in order and the final `bun test` totals. Do not declare success without the smoke-test outcome.

---

## How to send this to Gemini

Pick whichever fits your current environment:

### Option A — via penumbra MCP `chain.start` (preferred once Task 12 lands; bootstrap-friendly even today by hitting the daemon directly)

```bash
curl -X POST "http://127.0.0.1:$(cat /tmp/penumbra-live/port)/chains/start" \
  -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
  -H "content-type: application/json" \
  -d "$(jq -Rn --arg msg "$(cat docs/superpowers/plans/2026-04-26-agentchat-daemon-worker-gemini-handoff.md)" \
        '{initial_agent: "executor", message: $msg, max_hops: 50, trust_mode: "config"}')"
```

(*The route does not exist yet on `main` — only after Task 7 lands. Use Option B for the bootstrap dispatch that builds the route itself.*)

### Option B — via agentchat bin `--auto` (the bootstrap path, works today)

```bash
agentchat new --auto --max-hops 50 --transcript-budget 16384 <<< "$(cat docs/superpowers/plans/2026-04-26-agentchat-daemon-worker-gemini-handoff.md)"
```

This routes through whichever agent your `~/.config/agentchat/agentchat.yaml` defines as the `executor` role (currently mac-mini gemma). The chain runs in-process; you can watch streaming output in the bin.

### Option C — paste into Gemini CLI directly

Copy the **Prompt body** section above and paste it into a fresh Gemini CLI conversation. Gemini will read the spec + plan and execute. Manual but always available.

---

## Notes for the orchestrator (you, sending this)

- **Wave A is fully parallel (3 sub-agents).** This is the cleanest stress-test of the parallel dispatch — each task touches a disjoint part of `core/` and `agentchat/`.
- **Wave B has the highest parallelism (5).** All 5 tasks depend only on Wave A and are mutually independent. Watch for merge conflicts on `packages/daemon/src/serve.ts` (Tasks 4, 5, 6, 7 all add a route line). Sub-agents should rebase before commit if `serve.ts` has changed since they checked out — the plan's edits to `serve.ts` are additive (new `if`-blocks), so conflicts auto-resolve cleanly.
- **Track sub-agent commits.** Each task ends with a single commit; dispatch logs should map 1:1 to task commits.
- **Ralph-loop is overkill here.** The plan is finite (15 tasks) and the dependency graph is shallow (5 waves). Linear wave-by-wave dispatch with the orchestrator gating between waves is the right tool.
