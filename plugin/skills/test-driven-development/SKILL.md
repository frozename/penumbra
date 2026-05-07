---
name: test-driven-development
description: Use when implementing any feature or bugfix — write the smallest failing test first, then make it pass. Pairs with writing-plans and `chain_start` dispatches: the failing test becomes the dispatch contract that makes agent-driven development trustworthy.
---

# Test-Driven Development

## Why TDD pairs with penumbra dispatch

The failing test is the spec. Without it, a dispatched agent only has prose to interpret, and prose drifts. With it, the agent gets a binary red/green signal, and the reviewer gets an unambiguous merge gate. That is the compliance layer that makes agent-driven development trustworthy.

## Smallest failing test first

Start at the unit boundary closest to the change. One assertion is enough. Resist scope creep into integration coverage until the unit is green. The goal is a fast red/green loop, not coverage for its own sake.

## Detect the test stack

Before writing the test, look at project conventions and mirror what is already there:

- `package.json` `scripts.test` -> npm/yarn/pnpm/bun ecosystem
- `pyproject.toml` or `setup.py` -> pytest / unittest
- `go.mod` -> `go test`
- `Cargo.toml` -> `cargo test`
- `Gemfile` -> rspec / minitest
- Existing `*test*` files -> mirror their layout, framework, assertion style

Do not introduce a new test runner.

## Real behavior, not pattern-matching

Assertions must check actual outcomes: content, return values, and side effects. If the test would pass against a stub that just echoes the expected value, the test is too weak.

## Focused loop

Run only the affected test(s) while iterating. Reserve full-project typecheck or lint for commit time. If the project already has unrelated failures, do not let them block a focused commit. Stage only the files you intentionally changed.

## For dispatched implementations

1. Write the failing test first, locally or directly inside the dispatch prompt as a literal block.
2. In the `chain_start` `message`, include the test file path, the failing test body verbatim, the command to run just that test, and an explicit `do NOT modify the test; make the implementation pass it` instruction.
3. For substantial changes, dispatch a separate reviewer agent via `mcp__penumbra__agent_recommend(task_type="review_adversarial")` that re-runs the test before and after and reports red/green. Treat red as do not merge.
4. After dispatch returns, run the focused test against the agent's worktree with `mcp__penumbra__worktree_inspect` to find the path before cherry-picking onto main.

## Common traps

- Synthetic-pattern assertions that pass against a stub. Memory: `Trap: Initial Worktree Test Idea Inadequate`.
- Schema-layer change without the corresponding storage-layer update. Memory: `Trap: Schema Layer vs. Actual Table Mismatch`.
- Staging unrelated typecheck artifacts or lockfile noise alongside the focused commit. Memory: `User Preference: Stage Only Intended Source and Test Edits`.
