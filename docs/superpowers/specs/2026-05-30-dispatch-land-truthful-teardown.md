# Spec — dispatch_land truthful teardown (P4 / C8 + C10)

Date: 2026-05-30. Status: source-verified, ready to dispatch.

## Problem (observed)

Every `dispatch_land` this cycle returned `worktree_torn_down: true`, yet the worktree
directory **and** the `agent/<handoff_id>` branch persisted on disk and had to be GC'd by
hand. Root cause is split across two files, verified line-by-line against current `main`
(`bc5ad668`).

## Root cause (verified)

### A. `packages/core/src/worktree/manager.ts` — `teardownWorktree` (265–321)

The method has two divergent paths keyed on whether the handoff is in the in-memory
`worktrees` Map:

- **handle present** (282–321): framework-file cleanup (symlinks / `.test-storage` /
  `bun.lock`), then `git worktree remove` (throws on failure), then `git branch -D`, then
  `worktrees.delete`.
- **`!handle` fallback** (270–281): the daemon's in-memory Map is **empty after a restart**
  (worker created the worktree in a *different* process). This path:
  - **skips** the framework-file cleanup, so non-force `git worktree remove` fails on the
    untracked node_modules symlinks / `.test-storage`;
  - **swallows** that error (`.catch(() => {})`);
  - **`return`s unconditionally** (no throw);
  - **never deletes the branch**.

So post-restart: caller sees no throw → reports success, but the dir + branch both survive.

### B. `packages/daemon/src/routes/dispatch-land.ts` (513–532)

- Line 515 runs `git branch -D agent/<id>` **before** the worktree is removed (525). The
  branch is still checked out in that worktree → delete fails → `branch_deleted=false`, and
  it's a redundant double-attempt (teardown also deletes the branch at manager.ts:313).
- Lines 523–532 set `worktree_torn_down = true` whenever `teardownWorktree` doesn't throw —
  an optimistic boolean that (combined with A) lies after a restart.

### C. C10 — required `commit_message`

Schema line 11 is `commit_message: z.string().min(1)` (required). Omitting it is a raw zod
error. Should default to the branch tip's commit message.

## Fix

### manager.ts `teardownWorktree(handoffId, force?, project_id?, deleteBranch = true)`

1. `let handle = this.worktrees.get(handoffId);`
2. If `!handle`: compute `wtPath = path.join(this.baseFor(project_id), handoffId)`.
   - If `!fs.existsSync(wtPath)` → idempotent no-op: `return { worktreeRemoved: false, branchDeleted: false }`.
   - Else synthesize a handle (`{ handoffId, path: wtPath, branchName: \`agent/${handoffId}\`,
     storageRoot: path.join(wtPath, ".test-storage"), createdAt: <iso>, status: "created", projectId: project_id }`)
     and **fall through to the common path** (delete the old 270–281 block).
3. Keep the `!force` framework-file cleanup.
4. `git worktree remove` keeps throwing on failure. **After** it returns, assert
   `!fs.existsSync(handle.path)` else `throw` (bulletproof truthfulness).
5. Branch deletion gated on `deleteBranch`; capture whether it succeeded
   (`git rev-parse --verify --quiet refs/heads/<branch>` is gone, or `git branch -D` exit 0).
6. `this.worktrees.delete(handoffId)`.
7. **Return** `{ worktreeRemoved: true, branchDeleted: <bool> }`.

Callers tolerate the new throw + return value: GC sweeper (worktree-gc.ts:52, in try/catch),
worktrees route (worktrees.ts:83, try/catch; also calls `getWorktree` first so it hydrates
the map and never hits the fallback). Both ignore the return value — non-breaking.

### dispatch-land.ts

1. Schema: `commit_message: z.string().min(1).optional()`.
2. `executeLand`: param `commit_message?: string`. Move `const branch = \`agent/${handoff_id}\``
   above the `message_subject` line; if `commit_message` is empty, resolve
   `git log -1 --format=%B <branch>` (trimmed); on git failure return
   `{ status: 500, error: { code: "git_failed", step: "resolve_commit_message", ... } }`.
3. Delete the premature branch -D block (513–517).
4. Replace the teardown block (523–532):
   ```ts
   let worktree_torn_down = false;
   let branch_deleted = false;
   try {
     const td = await services.worktreeManager.teardownWorktree(
       handoff_id, /*force=*/ false, handoff.project_id ?? undefined, delete_branch);
     worktree_torn_down = td.worktreeRemoved;
     branch_deleted = td.branchDeleted;
   } catch (err) {
     services.log?.warn?.({ handoff_id, err: String(err) },
       "dispatch-land worktree teardown failed; orphan worktree will need manual GC");
   }
   ```

## Acceptance tests (write FIRST, must fail before the fix)

### core (`packages/core/test/worktree/manager-project.test.ts` or new file)

- **post-restart teardown**: create a real worktree, then a **fresh** `WorktreeManager`
  (empty Map) → `teardownWorktree(id, false)` removes the dir **and** deletes `agent/<id>`,
  returns `{ worktreeRemoved: true, branchDeleted: true }`.
- **deleteBranch=false honored**: `teardownWorktree(id, false, undefined, false)` removes the
  worktree but **retains** the branch, returns `branchDeleted: false`.
- **truthful failure**: tearing down a path that exists but is **not** a git worktree throws
  (so the caller cannot report success).

### daemon (`packages/daemon/test/routes/dispatch-land.test.ts`)

- Update every `teardownWorktree` mock to return `{ worktreeRemoved: true, branchDeleted: true }`.
- `branch_deleted` now comes from the teardown return, not the route's own `git branch -D` —
  reconcile existing assertions accordingly.
- NEW: `commit_message` omitted → route resolves it from the branch tip (`git log -1 --format=%B`).
- NEW: teardown mock returning `{ worktreeRemoved: false, branchDeleted: false }` (no throw)
  → `worktree_torn_down` is `false` (proves the optimistic boolean is gone).

## Gate

`bunx tsc --build packages/core/tsconfig.json packages/daemon/tsconfig.json` exit 0; the two
test files green; no attribution lines in the commit message.
