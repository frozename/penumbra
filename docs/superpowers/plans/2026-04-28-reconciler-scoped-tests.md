# Merge Reconciler — Diff-Scoped Test Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the merge reconciler runs after a successful dispatch, scope `bun test` to only the packages whose source files were touched by the worktree's diff vs main. Stop letting a broken test in package A block merges of work in package B.

**Why:** the auto-merge gap diagnosed on 2026-04-28 — 3 dispatches in a row required maestro cherry-picking — was caused by a `bun test` (full suite) returning non-zero on 2 stale opencode-acp test mocks unrelated to ANY of those dispatches' work. Running tests for code the dispatch didn't change is wasted effort and a fragile gate.

**Architecture:** Replace the unconditional `bun test` (line 189 of `packages/agentchat/src/worker/merge-reconciler.ts`) with:

1. `git diff --name-only main..<branch>` (run in main repo dir) → list of changed paths
2. Map each path to its package root by walking up to the nearest `packages/<name>/` directory; collect the unique set
3. If the changed paths include any non-`packages/*` files (root configs, top-level docs that ship code via root tsconfig, etc.) → fall back to full `bun test` (conservative)
4. Otherwise: `bun test <pkg1>/test/ <pkg2>/test/ ...` — only the affected packages
5. If no `packages/*` changed (e.g. only docs), skip tests entirely (return success)

The typecheck step (line 170) stays as `bun run typecheck` — that's already a project-wide tsc --build via tsbuildinfo and is fast enough; scoping it would require parsing the build graph which isn't worth the complexity.

**Tech Stack:** TypeScript, `child_process.spawn` via the existing `runCmd` helper, vitest tests.

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Modify | `packages/agentchat/src/worker/merge-reconciler.ts` | Replace `bun test` with a scoped variant. Add a helper `resolveAffectedPackages(diffPaths): string[] \| null` returning null when full-suite fallback is needed. |
| Modify | `packages/agentchat/test/worker/merge-reconciler.test.ts` | Add tests for: (a) only-daemon-changed → only `bun test packages/daemon/test/`, (b) docs-only → no test command at all, (c) root-config-changed → falls back to full `bun test`, (d) multi-package → space-separated args. |

No new files. The helper lives next to the reconciler since it's a private implementation detail.

---

## Task 1: Add `resolveAffectedPackages` helper + tests

**Files:**
- Modify: `packages/agentchat/src/worker/merge-reconciler.ts`
- Modify: `packages/agentchat/test/worker/merge-reconciler.test.ts`

The helper is a pure function — no I/O. Easy to unit test.

- [ ] **Step 1: Write the failing tests**

In `packages/agentchat/test/worker/merge-reconciler.test.ts`, add a new describe block (place it after the existing tests; if the file uses bun:test or vitest, match the existing pattern):

```ts
import { resolveAffectedPackages } from '../../src/worker/merge-reconciler.js';

describe('resolveAffectedPackages', () => {
  it('returns single package for one daemon path', () => {
    const result = resolveAffectedPackages([
      'packages/daemon/src/routes/handoffs.ts',
    ]);
    expect(result).toEqual(['packages/daemon']);
  });

  it('returns multiple distinct packages, deduplicated', () => {
    const result = resolveAffectedPackages([
      'packages/daemon/src/routes/handoffs.ts',
      'packages/mcp/src/tools/chain-status.ts',
      'packages/daemon/test/routes/handoffs-status.test.ts',
    ]);
    expect(result?.sort()).toEqual(['packages/daemon', 'packages/mcp']);
  });

  it('returns null (full-suite fallback) when a non-package path is touched', () => {
    const result = resolveAffectedPackages([
      'packages/daemon/src/routes/handoffs.ts',
      'tsconfig.base.json',
    ]);
    expect(result).toBeNull();
  });

  it('returns null when bun.lock or package.json at root is touched', () => {
    expect(resolveAffectedPackages(['bun.lock'])).toBeNull();
    expect(resolveAffectedPackages(['package.json'])).toBeNull();
  });

  it('returns empty array (skip tests) for docs-only changes', () => {
    const result = resolveAffectedPackages([
      'docs/superpowers/plans/some-plan.md',
      'docs/notes/some-note.md',
    ]);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty diff', () => {
    expect(resolveAffectedPackages([])).toEqual([]);
  });

  it('handles paths inside packages but outside src/test (e.g. package.json) as scoping signal', () => {
    // packages/daemon/package.json change should still scope to packages/daemon
    const result = resolveAffectedPackages([
      'packages/daemon/package.json',
    ]);
    expect(result).toEqual(['packages/daemon']);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/agentchat/test/worker/merge-reconciler.test.ts -t "resolveAffectedPackages"`

Expected: FAIL — `resolveAffectedPackages` not exported.

- [ ] **Step 3: Implement `resolveAffectedPackages`**

In `packages/agentchat/src/worker/merge-reconciler.ts`, BEFORE `createMergeReconciler`, add:

```ts
/**
 * Maps a list of changed file paths (from `git diff --name-only`) to the set of
 * `packages/*` roots that contain them. Returns:
 *   - null  → at least one path is outside any package (root config etc.) — caller should run full suite as a conservative fallback
 *   - []    → only docs/non-code paths changed — caller should skip the test step entirely
 *   - [...] → one or more package roots, deduplicated and sorted
 *
 * Path classification:
 *   - "packages/<pkg>/..."        → adds packages/<pkg> to the set
 *   - "docs/..." or ".github/..." → docs-only signal, ignored
 *   - anything else (root configs, bun.lock, package.json, etc.) → forces null
 */
export function resolveAffectedPackages(paths: string[]): string[] | null {
  const packageRoots = new Set<string>();
  let docsOnly = true;
  for (const p of paths) {
    if (p.startsWith('packages/')) {
      const segment = p.split('/', 2)[1];
      if (!segment) continue;
      packageRoots.add(`packages/${segment}`);
      docsOnly = false;
      continue;
    }
    if (p.startsWith('docs/') || p.startsWith('.github/')) {
      // doc-only paths don't trigger tests
      continue;
    }
    // any other path (root config, bun.lock, scripts, top-level files) → conservative full suite
    return null;
  }
  if (packageRoots.size === 0 && docsOnly) {
    return [];
  }
  return Array.from(packageRoots).sort();
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/agentchat/test/worker/merge-reconciler.test.ts -t "resolveAffectedPackages"`

Expected: 7 pass.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/worker/merge-reconciler.ts packages/agentchat/test/worker/merge-reconciler.test.ts
git commit -m "feat(agentchat): merge-reconciler — resolveAffectedPackages helper for diff-scoped tests"
```

---

## Task 2: Wire the scoped test run into the reconciler

**Files:**
- Modify: `packages/agentchat/src/worker/merge-reconciler.ts`
- Modify: `packages/agentchat/test/worker/merge-reconciler.test.ts`

The current test step (line ~187-194 of merge-reconciler.ts) is:

```ts
try {
  deps.log.debug({ handoffId }, 'running tests in worktree');
  const timeout = Number(process.env.PENUMBRA_RECONCILE_TEST_TIMEOUT_S) || 300;
  const res = await runCmd('bun test', wt.path, timeout);
  if (res.timedOut) { ... }
} catch (err: any) { ... }
```

Replace with: query the diff against main, resolve affected packages, decide command (or skip).

- [ ] **Step 1: Write the failing integration test**

Add a new describe block in `packages/agentchat/test/worker/merge-reconciler.test.ts`:

```ts
describe('reconciler test step is diff-scoped', () => {
  it('runs `bun test packages/daemon/test/` when only daemon changed', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string, _opts: { cwd: string }) => {
      execCalls.push(cmd);
      // simulate diff: only daemon paths
      if (cmd.startsWith('git diff --name-only')) {
        return { stdout: 'packages/daemon/src/routes/handoffs.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const reconciler = createMergeReconciler({
      worktreeManager: stubWorktreeManager('h-1', '/tmp/wt-1', 'agent/h-1'),
      postProgress: async () => {},
      log: silentLog(),
      mainRepoDir: '/repo',
      exec,
    });
    await reconciler('h-1');
    const testCmd = execCalls.find((c) => c.startsWith('bun test'));
    expect(testCmd).toBe('bun test packages/daemon/test/');
  });

  it('skips test step entirely when diff is docs-only', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string, _opts: { cwd: string }) => {
      execCalls.push(cmd);
      if (cmd.startsWith('git diff --name-only')) {
        return { stdout: 'docs/plans/foo.md\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const reconciler = createMergeReconciler({
      worktreeManager: stubWorktreeManager('h-2', '/tmp/wt-2', 'agent/h-2'),
      postProgress: async () => {},
      log: silentLog(),
      mainRepoDir: '/repo',
      exec,
    });
    await reconciler('h-2');
    expect(execCalls.find((c) => c.startsWith('bun test'))).toBeUndefined();
  });

  it('falls back to full `bun test` when a root file changed', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string, _opts: { cwd: string }) => {
      execCalls.push(cmd);
      if (cmd.startsWith('git diff --name-only')) {
        return { stdout: 'packages/daemon/src/foo.ts\nbun.lock\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const reconciler = createMergeReconciler({
      worktreeManager: stubWorktreeManager('h-3', '/tmp/wt-3', 'agent/h-3'),
      postProgress: async () => {},
      log: silentLog(),
      mainRepoDir: '/repo',
      exec,
    });
    await reconciler('h-3');
    expect(execCalls).toContain('bun test');
  });
});

// Helpers — adapt to existing patterns in the test file.
function stubWorktreeManager(handoffId: string, path: string, branchName: string): any {
  return {
    getWorktree: (id: string) => (id === handoffId ? { path, branchName } : undefined),
  };
}
function silentLog(): any {
  return {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    child: () => silentLog(),
  };
}
```

(Adapt the test patterns to match what the existing `merge-reconciler.test.ts` already uses — same imports, same helpers if they're already defined there.)

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/agentchat/test/worker/merge-reconciler.test.ts -t "diff-scoped"`

Expected: FAIL — current code always runs `bun test` (full suite).

- [ ] **Step 3: Replace the test step in merge-reconciler.ts**

In `packages/agentchat/src/worker/merge-reconciler.ts`, locate the current test step (the second `try` block, around line 186-202). Replace with:

```ts
    // 2. Run tests — diff-scoped to packages touched by the worktree branch
    try {
      deps.log.debug({ handoffId }, 'running diff-scoped tests in worktree');
      const timeout = Number(process.env.PENUMBRA_RECONCILE_TEST_TIMEOUT_S) || 300;

      // Query changed files vs main. Run in the WORKTREE — its branch is what
      // we're about to merge.
      const diffRes = await runCmd(
        `git diff --name-only main..${wt.branchName}`,
        wt.path,
      );
      const paths = diffRes.stdout.split('\n').map((p) => p.trim()).filter(Boolean);
      const affected = resolveAffectedPackages(paths);

      let testCmd: string | null;
      if (affected === null) {
        // Conservative: a root-level file changed (bun.lock, tsconfig, etc.)
        testCmd = 'bun test';
      } else if (affected.length === 0) {
        // Docs-only — skip tests entirely.
        testCmd = null;
      } else {
        // Scoped: bun test packages/foo/test/ packages/bar/test/ ...
        testCmd = 'bun test ' + affected.map((p) => `${p}/test/`).join(' ');
      }

      if (testCmd) {
        const res = await runCmd(testCmd, wt.path, timeout);
        if (res.timedOut) {
          const result: MergeResult = { status: 'test_failed', timed_out: true, regression_summary: 'tests timed out' };
          await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
          return result;
        }
      } else {
        deps.log.info({ handoffId }, 'docs-only diff — skipping test step');
      }
    } catch (err: any) {
      const result: MergeResult = {
        status: 'test_failed',
        regression_summary: err.stderr || err.stdout || String(err),
      };
      await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
      return result;
    }
```

- [ ] **Step 4: Run new tests to verify pass**

Run: `bun test packages/agentchat/test/worker/merge-reconciler.test.ts -t "diff-scoped"`

Expected: 3 pass.

- [ ] **Step 5: Run the full reconciler test suite for regression**

Run: `bun test packages/agentchat/test/worker/merge-reconciler.test.ts`

Expected: all pre-existing reconciler tests still pass (some may need their `exec` mocks updated to handle the new `git diff` call — wire each one to return whatever's needed for that test's diff scenario).

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/worker/merge-reconciler.ts packages/agentchat/test/worker/merge-reconciler.test.ts
git commit -m "$(cat <<'EOF'
feat(agentchat): merge-reconciler — scope `bun test` to packages in the worktree's diff

Stops a broken test in package A from blocking merges of work in package
B. The reconciler now:
  - queries `git diff --name-only main..<branch>` in the worktree
  - resolves the affected packages/* roots via resolveAffectedPackages
  - runs `bun test packages/<pkg>/test/ ...` for just those packages
  - falls back to full `bun test` when a root file changed (bun.lock,
    tsconfig, etc.) — conservative
  - skips tests entirely for docs-only diffs

Diagnosed and worked around on 2026-04-28 when 2 stale opencode-acp test
mocks (commit 755d3ab era) caused 3 consecutive dispatches to silently
fail auto-merge despite passing typecheck and their own targeted tests.
EOF
)"
```

---

## Verification — does the plan cover the spec?

| Goal | Task |
|---|---|
| Helper to map diff paths → affected packages, deduplicated | Task 1 |
| Conservative full-suite fallback when root files change | Task 1 (returns null) + Task 2 (handles null) |
| Skip tests for docs-only diffs | Task 1 (returns []) + Task 2 (handles []) |
| Multi-package scoping with space-separated dirs | Task 2 wiring |
| No regression to existing reconciler test paths | Task 2 Step 5 |

## End-to-end worked example

**Before this plan:** dispatch touched only `packages/daemon/src/routes/handoffs.ts`. Reconciler runs `bun test` (full suite, 264 tests across 55 files). 2 unrelated opencode-acp tests fail. Reconciler returns `test_failed`. No merge.

**After this plan:** same dispatch. Reconciler queries `git diff --name-only main..agent/abc123` → `packages/daemon/src/routes/handoffs.ts`. `resolveAffectedPackages` returns `['packages/daemon']`. Reconciler runs `bun test packages/daemon/test/` — 140 tests, all pass. Merge fires. ✅

**Edge — bun.lock bumped:** dispatch touched both `packages/daemon/...` and `bun.lock` (a workspace dep refresh). `resolveAffectedPackages` returns `null`. Reconciler runs full `bun test`. Behaves as today (still subject to the same broken-test risk, but only when root config changed — much rarer).

**Edge — docs-only:** dispatch only modified `docs/superpowers/plans/foo.md`. `resolveAffectedPackages` returns `[]`. Reconciler logs "docs-only diff — skipping test step" and proceeds to merge. Saves the test step entirely on what would have been a no-op anyway.

## Estimated effort

- Task 1 (helper + 7 unit tests): 30 minutes
- Task 2 (wiring + 3 integration tests + regression check): 45 minutes

Total: ~75 minutes focused work.

## Out of scope (explicit non-goals)

- **Per-package typecheck scoping**: tsc --build already amortizes via tsbuildinfo and runs in <2s on a hot cache. Not worth the build-graph parsing complexity.
- **Regression diff** (only fail on tests that newly broke vs. baseline): more complex; defer until we see a case where diff-scoping isn't enough.
- **Renaming packages or restructuring**: this plan assumes the `packages/*` layout. If that ever changes, this helper changes with it.
