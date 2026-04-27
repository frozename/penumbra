# Worktree-Per-Dispatch Isolation: Architecture & Implementation Plan

> **Goal**: confine the blast radius of parallel CLI agent dispatches by giving each its own git worktree, separate test-storage root, and a serialized merge reconciler. Prevents working-tree mess, stray files, and main-branch races we hit earlier in the session.
>
> **Source**: gemini design dispatch (handoff `d5eb7b7a`, 2026-04-27).
>
> **Constraints (decided pre-design)**:
> - Worktree root: `/Volumes/WorkSSD/repos/penumbra-worktrees/<handoff_id>/` (configurable via `PENUMBRA_WORKTREE_ROOT`)
> - Per-worktree storage root injected into spawn env: `PENUMBRA_STORAGE_ROOT=<worktree>/.test-storage`
> - Merge: FF -> rebase -> bounce to agent on conflict (NEVER `--strategy-option=theirs`)
> - Teardown: clean-merge defer 1h via `PENUMBRA_WORKTREE_RETAIN_MS`; failure retains until manual `worktree.cleanup(handoff_id)`

---

# Worktree-Per-Dispatch Architecture Design

This document details the architecture for isolating agentchat dispatches into temporary Git worktrees. This guarantees parallel CLI agents can operate concurrently without stepping on each other's working tree, modifying shared files, or hitting race conditions during commits to `main`.

## (1) Lifecycle

```ascii
User       Daemon       Worker (dispatcher)   WorktreeManager      Git (main)     CLI Agent
 │           │                  │                    │                 │              │
 ├─chain.start─────────>        │                    │                 │              │
 │           ├─claim handoff────>                    │                 │              │
 │           │                  ├─createWorktree()───>                 │              │
 │           │                  │                    ├─git worktree add>              │
 │           │                  │                    │<────────────────┘              │
 │           │                  ├─Bun.spawn(cwd: w)───────────────────────────────────>
 │           │                  │                    │                 │              │ (agent modifies
 │           │                  │                    │                 │              │  files & commits
 │           │                  │                    │                 │              │  in worktree)
 │           │                  │<─'completed'────────────────────────────────────────┘
 │           │<─'chain-end'─────┤                    │                 │
 │           │                  ├─mergeWorktree()    │                 │
 │           │                  │ ╔══════════════════════════════════╗ │
 │           │                  │ ║  acquire global merge mutex      ║ │
 │           │                  │ ╠══════════════════════════════════╣ │
 │           │                  │ ║  git merge --ff-only agent/ID    ║ │
 │           │                  │ ╚══════════════════════════════════╝ │
 │           │                  ├─teardownWorktree()─>                 │
 │           │                  │                    ├─git worktree rm─>
 ```

## (2) Worktree manager module

**Module Location:** `packages/agentchat/src/worker/worktree.ts`

**API:**
```typescript
interface WorktreeHandle {
  handoffId: string;
  path: string;
  branchName: string;
  storageRoot: string;
  createdAt: string;
  status: 'active' | 'merged' | 'conflict' | 'failed';
}

createWorktree(handoffId: string): Promise<WorktreeHandle>
getWorktree(handoffId: string): WorktreeHandle | null
listWorktrees(): WorktreeHandle[]
teardownWorktree(handoffId: string, force?: boolean): Promise<void>
```

**Implementation State Tracking:** **SQLite.**
We will add a new `agentchat_worktrees` table to the primary `db.sqlite`. In-memory state is too volatile; if the `agentchat-worker` process crashes or is restarted during a dispatch, the worktrees on disk would become orphaned with no way for `worktree.cleanup` to discover or reconcile them.

**Creation steps:**
1. `git worktree add --detach <path> HEAD`
2. `git -C <path> checkout -b agent/<handoffId>`
3. Symlink `node_modules/` and `bun.lock` from the main repository.
4. Inject `PENUMBRA_STORAGE_ROOT=<path>/.test-storage` so tests don't pollute `/tmp/penumbra-live`.

## (3) agentchat-worker integration

The worktree lifecycle wraps the agent dispatch. The exact insertion point is inside the worker's dispatch callback in **`packages/agentchat/bin/agentchat-worker.ts` at line 66**:

```typescript
// packages/agentchat/bin/agentchat-worker.ts (around line 66)
const worktree = await worktreeManager.createWorktree(handoff.handoff_id);

// Patch the config to inject the worktree cwd into the selected adapter's options
const patchedConfig = structuredClone(config);
const agentCfg = patchedConfig.agents.find(a => a.name === handoff.to_agent);
if (agentCfg && ['claude-cli', 'gemini-cli', 'codex-cli', 'opencode-cli'].includes(agentCfg.adapter)) {
  agentCfg.options = { ...agentCfg.options, cwd: worktree.path };
}

return await dispatchHandoff({
  handoff,
  config: patchedConfig, // Use the patched config
  // ...
});
```

This ensures that when `buildAdapter` creates the CLI adapter, it passes the `cwd` down to **`packages/agentchat/src/adapters/cli-spawn.ts` line 30**, where `Bun.spawn` correctly roots the subprocess in the isolated worktree. 

## (4) Merge reconciler

**Decision:** Option β (Async via `chain-terminated` analog).

**Reasoning:** Hooking the reconciler after the chain finishes cleanly decouples the business logic of "running a chat turn" from "resolving the git state." It also ensures we only merge when the agent has definitively declared the task finished (or failed). 

**Location:** We hook the reconciler inside **`packages/agentchat/src/worker/dispatcher.ts` around line 196**, immediately after the `chain-end` event is posted.

```typescript
// packages/agentchat/src/worker/dispatcher.ts (line 196)
await deps.postProgress(handoff.handoff_id, {
  type: 'chain-end',
  chain_id: handoff.conversation_id,
  reason: reasonMap[result.terminatedReason] ?? 'completed',
} as any);

// NEW: Trigger the merge reconciler asynchronously without blocking completion
void runMergeReconciler(handoff.handoff_id, result.terminatedReason);
```

**Merge Result Event Shape:**
The reconciler publishes a `merge-result` event to the `t0_events` table (or via progress API) with the following shape:
```typescript
{
  status: 'merged' | 'rebased' | 'rebase_conflict' | 'test_failed' | 'typecheck_failed';
  conflict_files?: string[];
  regression_summary?: string;
}
```

## (5) Concurrency lock

**Decision:** **Single global mutex.**

**Reasoning:** Reconciling involves standard `git` operations (fetch, merge, rebase). Git internally uses index lock files (`.git/index.lock`), making parallel mutations to the same repository inherently unsafe. A single global mutex ensures that `agentchat-worker` serializes all merge/rebase attempts into the `main` branch. Because merges are fast local operations, the contention overhead is negligible compared to the complexity of building a DAG for per-file mutexes.

## (6) MCP tool surface

The following tools will be added to the MCP surface (`packages/mcp/src/tools/`):

- `worktree.list`: Returns all tracked worktrees and their statuses.
- `worktree.inspect(handoff_id)`: Returns the git status, commit log, and diff of a specific worktree.
- `worktree.cleanup(handoff_id, force = false)`: Manually tears down a worktree (useful for failed or conflicted states).

**Opt-out:** `chain.start` gains an optional `use_worktree?: boolean` flag (default `true`). Passing `false` bypasses creation and defaults the agent to the main repo (useful for read-only fleet queries or when intentionally desiring direct modification).

## (7) Failure modes

- **Worktree creation fail:** The creation process must be atomic. If symlinking fails, `git worktree remove --force` is called immediately, and the handoff fails early.
- **Agent crash:** If the agent process dies, `runChatTurn` throws, and `dispatcher.ts` catches it. The reconciler is not triggered. The worktree remains in the `failed` state for forensic inspection.
- **Test fail:** If the post-merge verification (typecheck/tests) fails, the branch is not merged into `main`. The `merge-result` event emits `test_failed`, and the worktree is preserved for inspection.
- **Rebase conflict:** If `main` advanced and a non-FF rebase fails, the `merge-result` emits `rebase_conflict`. The orchestrator can intercept this and bounce the chain back to the agent with a prompt detailing the conflict markers.
- **Daemon restart:** Since worktree metadata is tracked in SQLite, a restarted daemon/worker can query the DB on boot and run a cleanup sweep of abandoned or aged worktrees.

## (8) Test isolation gotchas

- **bun:sqlite WAL files:** SQLite uses write-ahead logs (`-wal` and `-shm` files). Copying or symlinking a live SQLite database into a worktree leads to corruption. The worktree must rely on the injected `PENUMBRA_STORAGE_ROOT` to create its own fresh test DBs.
- **Port collisions:** If multiple tests in parallel worktrees spin up fastify servers on fixed ports (e.g., `8080`), they will collide. Test servers must bind to port `0` (random ephemeral port) and communicate their assigned port back to the test runner.
- **ONNX cache:** Models downloaded to the local cache shouldn't be duplicated per worktree. The `node_modules` symlink solves most of this, but any hardcoded cache paths should point to the absolute path of the main repo's cache folder.

## (9) 4-commit implementation plan

1. **C1: worktree manager + tests.** Implements SQLite state tracking, `createWorktree`, and `teardownWorktree`.
   - *Acceptance:* `sqlite3 db.sqlite "select * from agentchat_worktrees"` returns rows.
2. **C2: worker integration.** Injects worktree creation in `agentchat-worker.ts` and overrides `cwd` in the CLI adapter config.
   - *Acceptance:* CLI agents spawn and commit inside the worktree directory, leaving main repo untouched.
3. **C3: merge reconciler + lock.** Implements global mutex, FF/rebase logic, and hooks into `dispatcher.ts`.
   - *Acceptance:* `git log -1` on the main branch shows the cleanly merged commit from the agent.
4. **C4: MCP tools + opt-out flag.** Registers the read/cleanup tools and the `use_worktree` override.
   - *Acceptance:* `mcp__penumbra__worktree_list` returns active worktrees via an MCP client.

## (10) Risks & open questions

- **Node modules symlinking:** Symlinking `node_modules` is fast, but if the agent executes an `npm install` or `bun install` inside the worktree, it will mutate the *main* repository's `node_modules`. We may need to block package manager commands or use hard links/copy-on-write if the agent routinely updates dependencies.
- **Merge Queue Throttling:** If 10 agents finish simultaneously, the global mutex serializes them. If the 10th agent's worktree requires a rebase that conflicts with the 1st agent's merge, it will fail late.
- **Resource Exhaustion:** Each worktree consumes inode space and some disk space. The hourly garbage collection sweep is critical to prevent the CI host from running out of disk.

 @docs/superpowers/notes/2026-04-27-penumbra-mcp-friction-review.md chain-terminated
