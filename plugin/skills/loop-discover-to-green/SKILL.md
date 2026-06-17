---
name: loop-discover-to-green
description: Use to run a full improvement round on a codebase — discover the next real defect, plan a test-first fix, implement it on the fleet, adversarially review the branch, and fix until both the check and the review are green. Lands nothing until the orchestrator verifies. Triggered by "do another improvement round / discover→plan→implement→review→fix-until-green".
---

# loop-discover-to-green

The end-to-end improvement cycle as one repeatable procedure: **discover → plan → implement → review → fix-until-green**. Harness-agnostic. The codified, fleet-augmenting version is the CC workflow `.claude/workflows/penumbra-loop-discover-to-green.js` — prefer running that over hand-gluing the stages; this skill is the contract it implements.

## When to use

- "Do another round," "find and fix the next thing," "improve the codebase" — when there is no specific diff or task named and the work itself is to _surface_ the next worthwhile change and carry it to a verified branch.
- Scoped sweeps: "harden the daemon," "find a concurrency bug in core and fix it."

Not for: a change you can already name (skip discover — plan or implement directly), or a pure review of an existing diff (use `adversarial-review`).

## The five stages

1. **Discover** — fan out finders across distinct lenses (concurrency/transactions, security/fail-closed, correctness/boundaries) over the scope. Each cites `file:line` and a concrete failure (input/sequence → wrong outcome); speculation and already-guarded "gaps" are dropped. Dedupe and rank worst-first by (severity, blast radius, confidence). The top candidate goes through the loop.
2. **Plan** — turn the top candidate into a phased, **test-first** fix spec: the root cause, the test that must go RED before / GREEN after (and RED again on revert), the minimal fail-safe fix, a tight scope guard, and a single concrete `check` command (a focused test slice + a typecheck — not the whole suite).
3. **Implement + fix-until-green** — dispatch the spec to one fleet agent; loop building on the prior branch until the `check` passes or a round cap. The worker works test-first and commits on its branch with a neutral message; it does **not** land.
4. **Review** — run the multi-persona adversarial review on the green branch. HIGH findings earn one fix-round under the 2-round cap, attested by an **independent grader** that refutes regression-risk fixes; then a re-review.
5. **Land (orchestrator only)** — the loop returns a typed land recommendation; it lands **nothing**. The orchestrator runs the authoritative land-check (a sibling worktree with its own install when the change crosses packages — fleet worktrees symlink `@penumbra/*` to main), confirms the new test bites, then `dispatch_land` → verify HEAD + content in main → push → teardown, each as its own verified step.

## Discipline (non-negotiable)

- **A finding is a hypothesis** until confirmed against the cited code; finders over-report, so the ranker re-verifies and the review double-checks.
- **Lands nothing.** Every branch comes back for the orchestrator to verify and land. Green-on-check is necessary, not sufficient — the review gate and the orchestrator's land-check are what make it landable.
- **2-round cap** on review fixes; remaining HIGH findings after the cap → `lane_close review_debt`, not a silent third round.
- **Scope frugality.** One coherent change per loop; the plan's scope guard names which files may change.

## Codified augmentation (CC)

`.claude/workflows/penumbra-loop-discover-to-green.js` composes the proven building blocks — `penumbra-fanout` for dispatch and `adversarial-review` for the review/fix/grade — and inlines the fix-until-green loop directly on top of fanout (it does **not** call `penumbra-fix-until-green` via `workflow()`, because that workflow itself nests `workflow(penumbra-fanout)` and `workflow()` nesting is one level only). Invoke with `args.scope` (where discover hunts) and optionally `args.exclude`, `args.fixAgent`, `args.maxFixRounds`, `args.candidates`, `args.base`, `args.dryRunPlan`. It returns `{ candidate, plan, fix_until_green, review, green_for_land, land_candidate, next }`.
