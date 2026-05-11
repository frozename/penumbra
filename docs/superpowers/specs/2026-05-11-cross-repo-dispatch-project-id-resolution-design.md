# Cross-Repo Dispatch — project_id Resolution Design Spec

**Status:** Draft 2026-05-11 · **Scope:** Close the silent-default that lets dispatches from a non-penumbra session misroute to penumbra worktrees. Complete the partial wiring left by the 2026-05-05 cross-repo plan-runtime spec. · **Depends on:** project registry (shipped 2026-05-05), workflow runtime V1, autonomous-maestro V1.

## Background

The 2026-05-05 cross-repo plan-runtime spec §5 specified that `WorktreeManager` would be parameterized off `project_id` via a `resolveProjectRoot` hook. The hook exists in `packages/core/src/worktree/manager.ts:31`. The construction in `packages/core/src/services.ts:157` never wires it through. Net effect:

1. `WorktreeManager.baseFor(project_id)` and `repoRootFor(project_id)` always fall through to penumbra defaults regardless of what `project_id` is passed.
2. `chain_start` accepts `project_id: null` and stores it as-is. The MCP layer in `packages/mcp/src/tools/chain-start.ts` is a pass-through; it doesn't resolve a default from caller context.
3. The combination means **any chain_start without an explicit, registered project_id lands in `/Volumes/WorkSSD/repos/penumbra-worktrees/` regardless of which repo the caller intended**.

On 2026-05-11 this manifested as two llamactl-maestro dispatches (`a4f19ef8`, `b1910bae`) where the prompts started with `cd /Volumes/WorkSSD/repos/personal/llamactl` but the worker ran in a penumbra worktree until the 15-min watchdog killed it. Both died before pollution reached penumbra refs, but only by luck.

## Goal

Make cross-repo dispatch correct-by-construction: a maestro running in repo X cannot misroute its dispatch into repo Y. When the caller's intent is unresolvable, the system fails loud at the API boundary, not silently in the worker.

## Design

### Architecture

Two-layer fix:

- **MCP layer** auto-resolves `project_id` from the MCP server's `process.cwd()` against the project registry. If the cwd matches a registered project's `root_path` (or is inside one — longest-prefix wins), inject `project_id` automatically. If the caller's cwd is not registered, reject before the daemon call.
- **Daemon layer** rejects chain-start with an explicit `project_id` that isn't in the registry. Also completes the missing wiring so `WorktreeManager` actually consults `resolveProjectRoot`.

Each MCP subprocess inherits its parent Claude Code session's cwd, so each maestro's MCP server identifies itself correctly. No per-call cwd plumbing is needed.

### Components

#### 1. `packages/core/src/projects/registry-cwd.ts` (new)

A standalone helper:

```ts
export function findProjectIdByCwd(
  registry: ProjectRegistry,
  cwd: string,
): string | undefined;
```

Walks `cwd` and its parents, returning the project_id of the longest registered `root_path` prefix that matches. Symlinks resolved via `realpath` before comparison so worktree-internal callers don't get spurious mismatches. Returns `undefined` when no registered root is an ancestor of `cwd`.

Exists separately because the same lookup will also be useful for `workflow_run` and `plan_start`; the current ad-hoc cwd→project_id lookup at `packages/daemon/src/serve.ts:959` can later migrate to this helper. Out of scope for V1 of this spec.

#### 2. `packages/mcp/src/tools/chain-start.ts`

Two changes:

- At MCP server module init, load the project registry once: `loadProjectRegistry(process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath())`. Re-read once per `chainStartHandler` call (cheap — small yaml, parsed in microseconds) so live edits to `~/.penumbra/projects.yaml` take effect without an MCP restart.
- In the handler: if `input.project_id` is null/undefined, call `findProjectIdByCwd(registry, process.cwd())`. If it returns a string, inject it into the daemon payload. If it returns undefined, throw a structured error that surfaces as a tool error with `error.code = 'cwd_not_registered'`, the cwd, and the list of registered roots.

When the caller passes `project_id` explicitly, pass through unchanged — the daemon validates it.

#### 3. `packages/daemon/src/routes/chains.ts`

In the chain-start route, after schema parse and before `buildStampedLongLivedPrompt`:

```ts
if (
  input.project_id !== null &&
  input.project_id !== undefined &&
  services.projectRegistry !== undefined &&
  services.projectRegistry.list().length > 0 &&
  !services.projectRegistry.has(input.project_id)
) {
  return json({
    error: {
      code: 'unknown_project_id',
      message: `project_id not in registry: ${input.project_id}`,
      project_id: input.project_id,
      registered: services.projectRegistry.list().map(p => p.project_id),
    },
  }, 400);
}
```

The `registry.list().length > 0` guard preserves backwards-compat for installations that haven't created `~/.penumbra/projects.yaml` yet. Once any project is registered, all subsequent chain-starts must use a registered id or omit it.

#### 4. `packages/core/src/services.ts:157`

Complete the wiring:

```ts
const worktreeManager = new WorktreeManager({
  rootDir: opts.worktreeRootDir,
  mainRepoDir: opts.mainRepoDir,
  log,
  resolveProjectRoot: opts.projectRegistry
    ? (id: string) => opts.projectRegistry?.get(id)?.root_path
    : undefined,
});
```

When the daemon's caller doesn't supply a `projectRegistry`, `resolveProjectRoot` stays undefined and the existing single-project fallback persists. With a registry: the WorktreeManager finally honors `project_id`.

#### 5. `packages/core/src/worktree/manager.ts`

In `createWorktree(handoffId, opts)`: when `opts.project_id` is a non-empty string AND `this.resolveProjectRoot` is defined AND `this.resolveProjectRoot(opts.project_id)` returns undefined, throw `Error('unresolvable_project_id: ' + opts.project_id)`. The path where `opts.project_id` is undefined retains current behavior (uses `this.mainRepoDir`) — that path covers the legacy single-project case and sweeper-internal callers that rely on home-project default. The path where `this.resolveProjectRoot` itself is undefined (no registry installed) also retains current behavior: every `project_id` is silently treated as the home project.

This is a defensive backstop. Chain-start should already have rejected unknown ids; the throw catches any non-chain-start caller (plan-runtime sweeper, stageMergedBase, future internal callers) that accidentally feeds an unregistered id.

### Data flow — happy path

1. Llamactl maestro at `cwd=/Volumes/WorkSSD/repos/personal/llamactl` calls `chain_start` without `project_id`.
2. MCP server's `chainStartHandler` re-loads registry, calls `findProjectIdByCwd(registry, "/Volumes/WorkSSD/repos/personal/llamactl")` → returns `"llamactl"`.
3. Daemon receives `project_id: "llamactl"`; passes registry check.
4. Handoff row written with `project_id="llamactl"`.
5. Worker claims handoff; calls `WorktreeManager.createWorktree(handoffId, { project_id: "llamactl", baseRef })`.
6. `baseFor("llamactl")` → `resolveProjectRoot("llamactl")` → `/Volumes/WorkSSD/repos/personal/llamactl` → worktree path `/Volumes/WorkSSD/repos/personal/llamactl-worktrees/<handoff_id>`.
7. `git -C /Volumes/WorkSSD/repos/personal/llamactl worktree add ...` runs in llamactl. Codex sees llamactl code.

### Data flow — failure paths

| Scenario                                          | Behavior                                                                       |
|---------------------------------------------------|--------------------------------------------------------------------------------|
| Cwd not registered, no explicit project_id        | MCP tool errors with `cwd_not_registered`; no daemon call                       |
| Explicit unknown project_id                       | Daemon 400 `unknown_project_id`; no handoff row written                         |
| Caller bypasses MCP (raw HTTP)                    | Daemon's chain-start check still applies; cwd resolution does not              |
| Internal caller (sweeper, reactor) with bad id    | `WorktreeManager.createWorktree` throws `unresolvable_project_id`              |
| Caller in nested cwd inside a registered project  | Longest-prefix match resolves correctly to the enclosing project's id           |
| `~/.penumbra/projects.yaml` absent or empty       | Registry empty → daemon skips the unknown-id check → existing behavior         |

### Testing

- `packages/core/test/projects/registry-cwd-lookup.test.ts` (new) — `findProjectIdByCwd` matrix: exact match, parent-dir match, nested-cwd match, sibling-but-not-child no-match, multiple roots longest-prefix wins, symlinked cwd realpath-normalizes.
- `packages/mcp/test/tools/chain-start.test.ts` — cwd auto-resolution: cwd matches → daemon receives injected id; cwd no-match → tool errors with `cwd_not_registered`; explicit id always wins over cwd auto-resolution; registry-load failure falls through gracefully.
- `packages/daemon/test/routes/chains.test.ts` — extend with: unknown project_id returns 400; registered project_id is accepted; null project_id with non-empty registry is accepted (auto-resolution is MCP's job, not daemon's).
- `packages/core/test/worktree/manager.test.ts` — `createWorktree` throws on registered-but-unresolvable id; succeeds when registry maps id; undefined id retains legacy mainRepoDir behavior.
- `packages/core/test/services.test.ts` — `buildServices` wires `resolveProjectRoot`: construct services with a known registry, assert `worktreeManager.baseFor("known-id")` returns the registered root + "-worktrees".

### Migration & backwards compat

- Existing penumbra-maestro dispatches that omit `project_id`: their MCP server's cwd is the penumbra repo, auto-resolves to `"penumbra"`, behavior unchanged.
- Existing dispatches that pass `project_id`: continue working if the value is in projects.yaml. Typo'd or removed values now fail loud at chain-start instead of silently misrouting.
- Historical handoff rows with `project_id=NULL` are not backfilled.
- No DB schema change.
- Daemon + worker restart required for code changes to take effect. MCP servers pick up changes on next process start (each Claude Code session restart) — the registry re-read per chain_start handles live edits to projects.yaml without restart.

### Operational notes

- Add `~/.penumbra/projects.yaml` entries for any new repo before dispatching to it.
- The two failure-flow errors (`cwd_not_registered`, `unknown_project_id`) should both include the list of registered project_ids in their payload so the operator can self-diagnose without grepping for the yaml.

## Out of scope

- Per-project agent allow-lists (deferred to V2 V2 per the 2026-05-05 spec).
- DB-backed project registry (deferred to V2 V2).
- Backfilling historical NULL project_ids.
- Migrating `serve.ts:959` workflow cwd resolution to the new helper.
- Per-project commit-signing or secrets.
- Auto-detection of new repos (still operator-curated yaml).

## Open questions

None at write time. The design surface is small; the bug is precisely-scoped.
