# Cross-Repo Dispatch — project_id Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the silent-default that lets `chain_start` calls without an explicit, registered `project_id` misroute to penumbra worktrees. Complete the partial wiring from the 2026-05-05 cross-repo plan-runtime spec.

**Architecture:** Two-layer fix. MCP layer auto-resolves `project_id` from MCP server `process.cwd()` against `~/.penumbra/projects.yaml`; rejects when cwd is not registered. Daemon layer rejects chain-start with explicit `project_id` not in the registry, completes the `resolveProjectRoot` wiring on `WorktreeManager` construction, and adds a defensive throw inside `WorktreeManager.createWorktree`.

**Tech Stack:** TypeScript, bun:test, bun:sqlite. Three packages touched: `@penumbra/core`, `@penumbra/mcp`, `@penumbra/daemon`. No DB schema change.

**Spec:** `docs/superpowers/specs/2026-05-11-cross-repo-dispatch-project-id-resolution-design.md`

---

## File map

**Create:**
- `packages/core/src/projects/registry-cwd.ts` — `findProjectIdByCwd(registry, cwd)` longest-prefix lookup
- `packages/core/test/projects/registry-cwd.test.ts` — unit tests for the lookup helper

**Modify:**
- `packages/core/src/index.ts` — re-export `findProjectIdByCwd`
- `packages/core/src/services.ts` (~line 157) — pass `resolveProjectRoot` derived from `opts.projectRegistry` into `new WorktreeManager(...)`
- `packages/core/test/services.test.ts` — assert `worktreeManager.baseFor(known-id)` works after wiring
- `packages/core/src/worktree/manager.ts` (createWorktree) — throw `unresolvable_project_id` when `project_id` is set, `resolveProjectRoot` is defined, and lookup returns undefined
- `packages/core/test/worktree/manager-project.test.ts` — extend with unresolvable-throw test + legacy-fallback test
- `packages/mcp/src/tools/chain-start.ts` — accept injectable resolver opt; default to a registry-loading + `findProjectIdByCwd` impl; in the handler, when caller omits `project_id`, call resolver and inject — or throw a structured tool error when unresolved
- `packages/mcp/test/tools/chain-start.test.ts` — extend with resolver injection cases
- `packages/daemon/src/routes/chains.ts` (chain-start route) — reject when `input.project_id` is set, registry is non-empty, and registry does not contain it
- `packages/daemon/test/routes/chains.test.ts` — extend with unknown-project_id rejection + known-id acceptance

**Test infrastructure already exists:**
- `packages/core/test/projects/registry-fixtures.ts` — `writeBootstrapRegistry` writes a known projects.yaml
- `packages/core/test/worktree/manager-project.test.ts` — already tests `resolveProjectRoot` parameterization works in isolation (proves the WorktreeManager hook is correct; only the wiring was missing)

---

## Task 1: Add `findProjectIdByCwd` helper

**Files:**
- Create: `packages/core/src/projects/registry-cwd.ts`
- Test: `packages/core/test/projects/registry-cwd.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1.1: Write the failing test**

Create `packages/core/test/projects/registry-cwd.test.ts`:

```ts
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, realpathSync } from 'node:path';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { findProjectIdByCwd } from '../../src/projects/registry-cwd.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function mkdir(prefix: string): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  dirs.push(d);
  return d;
}

function registry(entries: Array<{ project_id: string; root_path: string }>): ProjectRegistry {
  const m = new Map<string, { project_id: string; root_path: string }>();
  for (const e of entries) m.set(e.project_id, e);
  return new ProjectRegistry(m);
}

test('exact-match cwd resolves to its project_id', () => {
  const llamactl = mkdir('penumbra-test-llamactl-');
  const r = registry([{ project_id: 'llamactl', root_path: llamactl }]);
  expect(findProjectIdByCwd(r, llamactl)).toBe('llamactl');
});

test('nested cwd inside a registered root resolves to that root', () => {
  const llamactl = mkdir('penumbra-test-llamactl-');
  const sub = join(llamactl, 'packages/cli');
  mkdirSync(sub, { recursive: true });
  const r = registry([{ project_id: 'llamactl', root_path: llamactl }]);
  expect(findProjectIdByCwd(r, sub)).toBe('llamactl');
});

test('unregistered cwd returns undefined', () => {
  const other = mkdir('penumbra-test-other-');
  const llamactl = mkdir('penumbra-test-llamactl-');
  const r = registry([{ project_id: 'llamactl', root_path: llamactl }]);
  expect(findProjectIdByCwd(r, other)).toBeUndefined();
});

test('sibling-but-not-child returns undefined', () => {
  const parent = mkdir('penumbra-test-parent-');
  const a = join(parent, 'a');
  const b = join(parent, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const r = registry([{ project_id: 'a', root_path: a }]);
  expect(findProjectIdByCwd(r, b)).toBeUndefined();
});

test('longest-prefix wins when multiple roots are nested', () => {
  const outer = mkdir('penumbra-test-outer-');
  const inner = join(outer, 'inner');
  mkdirSync(inner);
  const r = registry([
    { project_id: 'outer', root_path: outer },
    { project_id: 'inner', root_path: inner },
  ]);
  expect(findProjectIdByCwd(r, inner)).toBe('inner');
  expect(findProjectIdByCwd(r, outer)).toBe('outer');
});

test('symlinked cwd realpath-normalizes before comparison', () => {
  const llamactl = mkdir('penumbra-test-llamactl-');
  const linkParent = mkdir('penumbra-test-link-');
  const link = join(linkParent, 'link');
  symlinkSync(llamactl, link);
  const r = registry([{ project_id: 'llamactl', root_path: llamactl }]);
  expect(findProjectIdByCwd(r, link)).toBe('llamactl');
});

test('empty registry returns undefined', () => {
  const cwd = mkdir('penumbra-test-empty-');
  const r = registry([]);
  expect(findProjectIdByCwd(r, cwd)).toBeUndefined();
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `bun test packages/core/test/projects/registry-cwd.test.ts`
Expected: FAIL — `Cannot find module '../../src/projects/registry-cwd.js'`

- [ ] **Step 1.3: Implement `findProjectIdByCwd`**

Create `packages/core/src/projects/registry-cwd.ts`:

```ts
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProjectRegistry } from './registry.js';

/**
 * Walk cwd and its parents looking for a registered root.
 * Longest-prefix wins. Returns undefined when no registered root is an ancestor.
 * Both cwd and each entry's root_path are realpath-resolved before comparison.
 */
export function findProjectIdByCwd(
  registry: ProjectRegistry,
  cwd: string,
): string | undefined {
  const entries = registry.list();
  if (entries.length === 0) return undefined;

  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return undefined;
  }

  const roots: Array<{ id: string; root: string }> = [];
  for (const e of entries) {
    try {
      roots.push({ id: e.project_id, root: realpathSync(e.root_path) });
    } catch {
      // Skip entries whose root_path doesn't exist on this machine.
    }
  }

  let bestId: string | undefined;
  let bestLen = -1;

  let cur = real;
  for (;;) {
    for (const { id, root } of roots) {
      if (root === cur && root.length > bestLen) {
        bestId = id;
        bestLen = root.length;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return bestId;
}
```

- [ ] **Step 1.4: Run the tests; verify all pass**

Run: `bun test packages/core/test/projects/registry-cwd.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 1.5: Re-export from core's index**

Modify `packages/core/src/index.ts` — add alongside the existing project-registry re-exports (find the block that exports `loadProjectRegistry` / `ProjectRegistry`):

```ts
export { findProjectIdByCwd } from './projects/registry-cwd.js';
```

- [ ] **Step 1.6: Typecheck core**

Run: `cd packages/core && bun tsc -b`
Expected: clean exit. If `dist/` staleness fires TS2339-style errors, run `rm -rf packages/core/dist && bun tsc -b --force` per the `project_core_dist_shadows_types` memory.

- [ ] **Step 1.7: Commit**

```bash
git add packages/core/src/projects/registry-cwd.ts \
        packages/core/test/projects/registry-cwd.test.ts \
        packages/core/src/index.ts
git commit -m "feat(core/projects): findProjectIdByCwd — longest-prefix cwd→project_id lookup"
```

---

## Task 2: Wire `resolveProjectRoot` in `buildServices`

**Files:**
- Modify: `packages/core/src/services.ts:157`
- Test: `packages/core/test/services.test.ts`

- [ ] **Step 2.1: Write the failing test**

Append to `packages/core/test/services.test.ts` (or create a new dedicated test file `packages/core/test/services-project-wiring.test.ts` if the existing file's setup is incompatible — the test needs only `buildServices` + an in-memory ProjectRegistry):

```ts
test('buildServices wires resolveProjectRoot from projectRegistry', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const reg = new ProjectRegistry(new Map([
    ['sirius', { project_id: 'sirius', root_path: '/tmp/sirius-not-real' }],
  ]));

  const services = buildServices({
    env: {}, input: {}, storageRoot: '/tmp/svc-wiring-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    projectRegistry: reg,
  });

  // baseFor('sirius') hits resolveProjectRoot → returns '/tmp/sirius-not-real-worktrees'
  // Compare to the no-registry path which returns whatever WorktreeManager.rootDir is.
  // We probe the WorktreeManager via a public method or a constructor-time effect.
  expect((services.worktreeManager as any).baseFor('sirius')).toBe('/tmp/sirius-not-real-worktrees');
  expect((services.worktreeManager as any).repoRootFor('sirius')).toBe('/tmp/sirius-not-real');
});

test('buildServices without projectRegistry leaves resolveProjectRoot undefined', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const services = buildServices({
    env: {}, input: {}, storageRoot: '/tmp/svc-noreg-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
  });

  // No registry → no resolver → baseFor falls through to home rootDir
  expect((services.worktreeManager as any).baseFor('sirius')).not.toContain('sirius-not-real');
});
```

Imports for the new tests (add to the top of the file):

```ts
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, ProjectRegistry } from '../src/index.js';
import { TestEmbedder } from '../src/testing/index.js';
```

If `ProjectRegistry` is not exported from `../src/index.js`, import from `../src/projects/registry.js` directly.

`baseFor` and `repoRootFor` are private methods. The test reaches them via `as any`. If you prefer not to test against private methods, an alternative is to call `worktreeManager.createWorktree(...)` against a real temp repo and assert the worktree path — but that costs more in setup and time. Keep the `as any` probe for V1; refactor only if linting complains.

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `bun test packages/core/test/services.test.ts`
Expected: FAIL — `baseFor('sirius')` returns the default root (`/Volumes/WorkSSD/repos/penumbra-worktrees/` or whatever the env injects), not `/tmp/sirius-not-real-worktrees`.

- [ ] **Step 2.3: Wire `resolveProjectRoot` in services.ts**

Edit `packages/core/src/services.ts` around line 157. Change the `WorktreeManager` construction from:

```ts
const worktreeManager = new WorktreeManager({
  rootDir: opts.worktreeRootDir,
  mainRepoDir: opts.mainRepoDir,
  log,
});
```

to:

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

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `bun test packages/core/test/services.test.ts`
Expected: PASS — both new tests + all existing tests.

- [ ] **Step 2.5: Typecheck core**

Run: `cd packages/core && bun tsc -b`
Expected: clean.

- [ ] **Step 2.6: Commit**

```bash
git add packages/core/src/services.ts packages/core/test/services.test.ts
git commit -m "fix(core/services): wire resolveProjectRoot from projectRegistry into WorktreeManager"
```

---

## Task 3: Defensive throw in `WorktreeManager.createWorktree`

**Files:**
- Modify: `packages/core/src/worktree/manager.ts` (createWorktree, near `this.baseFor` call)
- Test: `packages/core/test/worktree/manager-project.test.ts`

- [ ] **Step 3.1: Write the failing test**

Append to `packages/core/test/worktree/manager-project.test.ts` inside the existing `describe('WorktreeManager — project parameterization', ...)` block:

```ts
it('throws unresolvable_project_id when project_id is set but resolver returns undefined', async () => {
  const manager = new WorktreeManager({
    rootDir: homeRoot,
    mainRepoDir: homeRepo,
    resolveProjectRoot: (id) => (id === 'known' ? homeRepo : undefined),
  });
  const id = nextHandoff();
  await expect(
    manager.createWorktree(id, { project_id: 'totally-bogus' }),
  ).rejects.toThrow(/unresolvable_project_id: totally-bogus/);
  // No worktree should be created.
  expect(manager.getWorktree(id)).toBeNull();
});

it('preserves legacy fallback when no resolver is configured (project_id ignored, mainRepoDir used)', async () => {
  const manager = new WorktreeManager({
    rootDir: homeRoot,
    mainRepoDir: homeRepo,
    // resolveProjectRoot intentionally omitted
  });
  const id = nextHandoff();
  const handle = await manager.createWorktree(id, { project_id: 'whatever' });
  expect(handle.path).toBe(path.join(homeRoot, id));
  await manager.teardownWorktree(id, true);
});
```

- [ ] **Step 3.2: Run the test to verify it fails**

Run: `bun test packages/core/test/worktree/manager-project.test.ts`
Expected: FAIL — the unresolvable case currently falls through silently and either succeeds against `mainRepoDir` or fails with a confusing git error.

- [ ] **Step 3.3: Add the throw in `createWorktree`**

In `packages/core/src/worktree/manager.ts`, inside `createWorktree(handoffId, opts)`, locate the block where `project_id` and `base`/`repoRoot` are derived (~line 112-114):

```ts
const project_id = opts?.project_id;
const base = this.baseFor(project_id);
const repoRoot = this.repoRootFor(project_id);
```

Replace with:

```ts
const project_id = opts?.project_id;
if (
  project_id &&
  this.resolveProjectRoot &&
  this.resolveProjectRoot(project_id) === undefined
) {
  throw new Error(`unresolvable_project_id: ${project_id}`);
}
const base = this.baseFor(project_id);
const repoRoot = this.repoRootFor(project_id);
```

- [ ] **Step 3.4: Run the tests to verify all pass**

Run: `bun test packages/core/test/worktree/manager-project.test.ts`
Expected: PASS — including the existing legacy-fallback test that constructs a manager *without* `resolveProjectRoot`.

- [ ] **Step 3.5: Typecheck core**

Run: `cd packages/core && bun tsc -b`
Expected: clean.

- [ ] **Step 3.6: Commit**

```bash
git add packages/core/src/worktree/manager.ts packages/core/test/worktree/manager-project.test.ts
git commit -m "fix(core/worktree): throw unresolvable_project_id when registry lookup fails"
```

---

## Task 4: Daemon chain-start rejects unknown `project_id`

**Files:**
- Modify: `packages/daemon/src/routes/chains.ts` (chain-start route, after schema parse, before `buildStampedLongLivedPrompt`)
- Test: `packages/daemon/test/routes/chains.test.ts`

- [ ] **Step 4.1: Locate the schema-parse / route entry**

Read `packages/daemon/src/routes/chains.ts:330-345` to find the function that handles chain-start (look for `chainsStartRoute` or `chainStartFromInput` exported names). The `input` object should already be schema-validated at that point. Add the registry-check block immediately after the schema parse and BEFORE `buildStampedLongLivedPrompt(input, services)` (currently at line 343).

- [ ] **Step 4.2: Write the failing tests**

Append to `packages/daemon/test/routes/chains.test.ts` (use whatever existing helpers like `tempServices` and `seedAgentRegistry` are already in scope):

```ts
test('chain-start rejects unknown project_id when registry has entries', async () => {
  const services = tempServices({ agentRegistry: ['planner'] });
  services.projectRegistry = new ProjectRegistry(new Map([
    ['penumbra', { project_id: 'penumbra', root_path: '/tmp/penumbra' }],
  ]));

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'hi',
      project_id: 'not-in-registry',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  const body: any = await res.json();
  expect(body.error.code).toBe('unknown_project_id');
  expect(body.error.project_id).toBe('not-in-registry');
  expect(body.error.registered).toEqual(['penumbra']);
});

test('chain-start accepts a project_id present in the registry', async () => {
  const services = tempServices({ agentRegistry: ['planner'] });
  services.projectRegistry = new ProjectRegistry(new Map([
    ['penumbra', { project_id: 'penumbra', root_path: '/tmp/penumbra' }],
  ]));

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'hi',
      project_id: 'penumbra',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
});

test('chain-start accepts null project_id even with non-empty registry (MCP-layer responsibility)', async () => {
  const services = tempServices({ agentRegistry: ['planner'] });
  services.projectRegistry = new ProjectRegistry(new Map([
    ['penumbra', { project_id: 'penumbra', root_path: '/tmp/penumbra' }],
  ]));

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'hi',
      // no project_id
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
});
```

Add the import at the top of the test file if missing:

```ts
import { ProjectRegistry } from '../../../core/src/projects/registry.js';
```

- [ ] **Step 4.3: Run the tests to verify they fail**

Run: `bun test packages/daemon/test/routes/chains.test.ts`
Expected: FAIL — the unknown-project_id test will get a 200 (or some other non-400 status) because the daemon currently accepts unknown project_ids silently.

- [ ] **Step 4.4: Add the registry check to chains.ts**

In `packages/daemon/src/routes/chains.ts`, inside the chain-start handler (the one that calls `buildStampedLongLivedPrompt`), insert after schema parsing and BEFORE the `const ts = services.clock().toISOString();` line:

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
      registered: services.projectRegistry.list().map((p) => p.project_id),
    },
  }, 400);
}
```

Use whatever local `json(...)` helper already exists in this file (grep nearby for `function json` or `import { json }`).

- [ ] **Step 4.5: Run the tests to verify they pass**

Run: `bun test packages/daemon/test/routes/chains.test.ts`
Expected: PASS — all three new tests, plus all existing tests in the file.

- [ ] **Step 4.6: Typecheck daemon**

Run: `cd packages/daemon && bun tsc -b`
Expected: pre-existing `bounds-callbacks.ts` / `serve.ts` errors may surface (baseline noise per `feedback_phase_3b_cost_ledger`). The new code must not add new TS errors.

- [ ] **Step 4.7: Commit**

```bash
git add packages/daemon/src/routes/chains.ts packages/daemon/test/routes/chains.test.ts
git commit -m "fix(daemon/chains): reject chain-start with unknown_project_id at the route boundary"
```

---

## Task 5: MCP chain-start auto-resolves cwd

**Files:**
- Modify: `packages/mcp/src/tools/chain-start.ts` (refactor factory to accept injectable resolver)
- Modify: caller of `chainStartHandler(daemon)` in `packages/mcp/src/tools/registry.ts` (or wherever it's instantiated — needs to pass the real resolver)
- Test: `packages/mcp/test/tools/chain-start.test.ts`

- [ ] **Step 5.1: Locate the handler's caller**

Run: `grep -rn "chainStartHandler" packages/mcp/src`
Expected: a single instantiation site (likely `packages/mcp/src/tools/registry.ts`). Note its location for Step 5.5.

- [ ] **Step 5.2: Write the failing tests**

Append to `packages/mcp/test/tools/chain-start.test.ts`:

```ts
test('chain.start auto-resolves project_id from cwd when caller omits it', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue('llamactl');
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await handler({ initial_agent: 'planner', message: 'hi' });

  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    initial_agent: 'planner',
    message: 'hi',
    project_id: 'llamactl',
  }));
});

test('chain.start throws cwd_not_registered when no project_id and cwd resolver returns undefined', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue(undefined);
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await expect(
    handler({ initial_agent: 'planner', message: 'hi' }),
  ).rejects.toThrow(/cwd_not_registered/);
  expect(daemon.startChain).not.toHaveBeenCalled();
});

test('chain.start does not auto-resolve when caller passes explicit project_id', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue('would-be-wrong');
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await handler({ initial_agent: 'planner', message: 'hi', project_id: 'sirius' });

  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    project_id: 'sirius',
  }));
  expect(resolver).not.toHaveBeenCalled();
});

test('chain.start without resolver opt passes through (legacy behavior)', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);

  await handler({ initial_agent: 'planner', message: 'hi' });

  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    initial_agent: 'planner',
    message: 'hi',
  }));
  // No project_id should be set — daemon's null is fine when no resolver is injected.
  const call = (daemon.startChain as any).mock.calls[0][0];
  expect(call.project_id).toBeUndefined();
});
```

- [ ] **Step 5.3: Run the tests to verify they fail**

Run: `bun test packages/mcp/test/tools/chain-start.test.ts`
Expected: FAIL on the auto-resolve cases — `chainStartHandler` currently doesn't accept a resolver opt. TypeScript will also error on the test's second argument.

- [ ] **Step 5.4: Refactor `chainStartHandler` to accept the resolver**

Edit `packages/mcp/src/tools/chain-start.ts`:

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';
import { formatChainStart, wrapWithSummary } from '../format-summary.js';

export const ChainStartInputShape = {
  /* ...unchanged from current source... */
};

export interface ChainStartHandlerOpts {
  /**
   * Called when the caller omits `project_id`. Should return the registered
   * project_id for the current MCP-server cwd, or undefined if cwd is not registered.
   */
  resolveProjectIdFromCwd?: () => string | undefined;
}

export function chainStartHandler(daemon: DaemonClient, opts: ChainStartHandlerOpts = {}) {
  return async (input: any) => {
    let effectiveProjectId: string | null | undefined = input.project_id;

    if (
      (effectiveProjectId === undefined || effectiveProjectId === null) &&
      opts.resolveProjectIdFromCwd !== undefined
    ) {
      const resolved = opts.resolveProjectIdFromCwd();
      if (resolved === undefined) {
        throw new Error(
          'cwd_not_registered: MCP server cwd does not match any entry in ~/.penumbra/projects.yaml; ' +
            'pass project_id explicitly or register the cwd as a project'
        );
      }
      effectiveProjectId = resolved;
    }

    const body: Record<string, unknown> = {
      initial_agent: input.initial_agent,
      message: input.message,
    };
    if (input.conversation_id !== undefined) body.conversation_id = input.conversation_id;
    if (effectiveProjectId !== undefined && effectiveProjectId !== null) {
      body.project_id = effectiveProjectId;
    }
    if (input.max_hops !== undefined) body.max_hops = input.max_hops;
    if (input.trust_mode !== undefined) body.trust_mode = input.trust_mode;
    if (input.use_worktree !== undefined) body.use_worktree = input.use_worktree;
    if (input.task_type !== undefined) body.task_type = input.task_type;
    if (input.parent_handoff_id !== undefined) body.parent_handoff_id = input.parent_handoff_id;
    if (input.dispatch_kind !== undefined) body.dispatch_kind = input.dispatch_kind;
    if (input.long_lived_agent_id !== undefined) body.long_lived_agent_id = input.long_lived_agent_id;
    if (input.long_lived_tick_id !== undefined) body.long_lived_tick_id = input.long_lived_tick_id;
    if (input.branch_base !== undefined) body.branch_base = input.branch_base;
    if (input.open_pr_on_review !== undefined) body.open_pr_on_review = input.open_pr_on_review;

    const res = await daemon.startChain(body as any);
    return {
      content: [{
        type: 'text',
        text: wrapWithSummary(
          formatChainStart({
            ...res,
            agent: input.initial_agent,
            trust_mode: input.trust_mode,
          }),
          res
        )
      }]
    };
  };
}
```

Preserve `ChainStartInputShape` verbatim from the current source — do not edit it.

- [ ] **Step 5.5: Wire the real resolver at the caller site**

Find the chainStartHandler instantiation (per Step 5.1). Inject a real resolver that loads the project registry from disk and calls `findProjectIdByCwd` against `process.cwd()`:

```ts
import { loadProjectRegistry, defaultProjectRegistryPath, findProjectIdByCwd } from '@penumbra/core';

// at the chainStartHandler call site:
chainStartHandler(daemon, {
  resolveProjectIdFromCwd: () => {
    try {
      const registryPath = process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath();
      const registry = loadProjectRegistry(registryPath);
      return findProjectIdByCwd(registry, process.cwd());
    } catch {
      return undefined;
    }
  },
})
```

The registry is reloaded on every call so live edits to `projects.yaml` take effect without restarting the MCP server. `loadProjectRegistry` already handles ENOENT gracefully (returns an empty registry); the try/catch is defensive against parse errors.

- [ ] **Step 5.6: Run the tests to verify they pass**

Run: `bun test packages/mcp/test/tools/chain-start.test.ts`
Expected: PASS — four new tests + all five existing tests.

- [ ] **Step 5.7: Typecheck mcp**

Run: `cd packages/mcp && bun tsc -b`
Expected: clean.

- [ ] **Step 5.8: Commit**

```bash
git add packages/mcp/src/tools/chain-start.ts \
        packages/mcp/src/tools/registry.ts \
        packages/mcp/test/tools/chain-start.test.ts
git commit -m "feat(mcp/chain-start): auto-resolve project_id from cwd; reject cwd_not_registered"
```

If the actual instantiation file is not `registry.ts`, substitute the correct path in the `git add` line. Use `git status` to verify.

---

## Task 6: Manual smoke verification

**Files:** None (operational verification only)

- [ ] **Step 6.1: Restart daemon and worker**

Run:
```bash
launchctl kickstart -k "gui/$(id -u)/dev.penumbra.daemon"
launchctl kickstart -k "gui/$(id -u)/dev.penumbra.worker"
sleep 3
launchctl list | grep penumbra
```
Expected: both PIDs are non-zero. No restart loops.

- [ ] **Step 6.2: Smoke — dispatch with explicit registered project_id**

From the penumbra checkout, invoke a small dispatch:

```bash
TOKEN=$(cat ~/.penumbra/token)
PORT=$(cat ~/.penumbra/port)
curl -sS -X POST "http://127.0.0.1:$PORT/chains/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"initial_agent":"codex-acp-fast","message":"echo smoke","project_id":"penumbra","use_worktree":true}' | head
```
Expected: 200 response with `conversation_id` and `handoff_id`.

- [ ] **Step 6.3: Smoke — unknown project_id rejected**

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/chains/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"initial_agent":"codex-acp-fast","message":"echo smoke","project_id":"totally-bogus","use_worktree":true}'
```
Expected: 400 response with `error.code === "unknown_project_id"` and `error.registered` listing the known ids.

- [ ] **Step 6.4: Smoke — MCP-side cwd_not_registered**

This requires a Claude Code session launched from a directory NOT in `~/.penumbra/projects.yaml`. From `cd /tmp && claude` (or equivalent), invoke `mcp__penumbra__chain_start` with no `project_id`. Expected: tool error containing `cwd_not_registered`. Skip this step if launching a parallel Claude Code session is impractical for this verification; the unit tests cover the contract.

- [ ] **Step 6.5: Verify no orphan worktrees were created during smoke**

```bash
ls /Volumes/WorkSSD/repos/penumbra-worktrees/ | wc -l
ls /Volumes/WorkSSD/repos/llamactl-worktrees/ 2>/dev/null | wc -l
```
Note the counts. After Step 6.2's dispatch completes (or you cancel it), verify the count returns to baseline (or the new worktree is in the llamactl dir if you dispatched there).

---

## Self-review checklist (run after all tasks pass)

- [ ] Every spec section maps to at least one task:
  - §Architecture → Task 2 (services wiring) + Task 5 (MCP resolver) + Task 4 (daemon reject)
  - §Components #1 (registry-cwd) → Task 1
  - §Components #2 (chain-start MCP) → Task 5
  - §Components #3 (chain-start daemon) → Task 4
  - §Components #4 (services.ts wiring) → Task 2
  - §Components #5 (manager throw) → Task 3
  - §Data flow happy + failure paths → covered by tests in 1, 3, 4, 5
  - §Testing matrix → tests in 1, 2, 3, 4, 5
  - §Migration → covered by Task 3's legacy-fallback test + Task 5's no-opts test
- [ ] No `TBD`, `TODO`, `(similar to)`, or other placeholder strings in any task body.
- [ ] Method signatures are consistent: `findProjectIdByCwd(registry, cwd)` used in Task 1, 5, and the helper file.
- [ ] Error codes consistent: `cwd_not_registered` (MCP), `unknown_project_id` (daemon), `unresolvable_project_id` (WorktreeManager).
- [ ] All commits use neutral text per the repo convention (no AI/tool attribution).

---

## Out of scope (deferred follow-ups for next session)

- Migrating `packages/daemon/src/serve.ts:959` workflow-cwd resolution to use the new `findProjectIdByCwd` helper.
- Backfilling historical `project_id=NULL` handoff rows.
- Per-project agent allow-lists (deferred to V2 V2 per the 2026-05-05 spec).
- DB-backed project registry.
