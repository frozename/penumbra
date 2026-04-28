# ACP Phase 1b.2 — `fs.glob` and `fs.grep` MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new penumbra-mcp tools, `fs.glob` (filename pattern search) and `fs.grep` (content search), so ACP-dispatched agents can investigate code inside their dispatch's worktree without inlined plan content. Strictly downstream of Phase 1a (MCP injection) — these tools surface to ACP agents through the existing `options.mcpServers: [penumbra-mcp]` opt-in.

**Architecture:** Three layers. (1) MCP tool handlers in `packages/mcp/src/tools/fs-glob.ts` and `fs-grep.ts` — thin wrappers that resolve `handoff_id` (arg → `PENUMBRA_HANDOFF_ID` env → error) and forward to the daemon. (2) Daemon HTTP routes `POST /worktrees/:handoff_id/glob` and `/grep`, mirroring `worktrees.ts`'s shape. (3) Pure search functions in `packages/daemon/src/fs-search.ts`: `executeGlob` uses `Bun.Glob`, `executeGrep` spawns `rg --json`. Plus a small upstream wire: `stdio-acp.ts` injects `PENUMBRA_HANDOFF_ID=<dispatch handoff_id>` into the env of each penumbra-mcp `McpServerStdio` entry passed via `session/new`. Path validation reuses the realpath-relative pattern from Phase 1b.1's `executeReadTextFile` — extracted into `packages/core/src/fs-paths.ts` for a single source of truth.

**Tech Stack:** TypeScript, `bun:test`, `Bun.Glob`, `node:child_process` (spawn `rg`), `node:fs/promises`. New runtime dep: `ignore` npm package (battle-tested `.gitignore` filter).

**Spec:** `docs/superpowers/specs/2026-04-28-phase-1b2-fs-tools-design.md` (committed `b9664fb`).

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `packages/core/src/fs-paths.ts` | `resolveInsideWorktree(userPath, worktree)` — realpath both, assert `path.relative` doesn't escape. Single source of truth for the worktree-boundary check. Re-exports the `ReadTextFileError`-style error class as `FsPathError` with codes `outside_worktree`, `not_found`, `io`. |
| Modify | `packages/core/src/index.ts` | Re-export `resolveInsideWorktree` and `FsPathError`. |
| Create | `packages/core/test/fs-paths.test.ts` | Port the 4 path-validation tests from existing acp-fs.test.ts (inside / absolute-outside / relative-escape / symlink-escape). |
| Modify | `packages/agentchat/src/adapters/acp-fs.ts` | Replace local `resolveInsideWorktree` + `ReadTextFileError` with imports from `@penumbra/core`. Behavior-preserving — existing acp-fs tests continue to pass. |
| Create | `packages/daemon/src/fs-search.ts` | `executeGlob({pattern, path?, max_results?, include_ignored?}, worktree)` and `executeGrep({pattern, path?, glob?, output_mode, case_insensitive?, include_ignored?, max_results?}, worktree)`. Pure functions; no HTTP, no zod. Use `Bun.Glob` for glob, spawn `rg --json` for grep. Honor `.gitignore` via `ignore` package (glob) and `rg`'s default behavior (grep). Apply soft caps + truncated flag + 1KB per-line cap. |
| Create | `packages/daemon/src/routes/fs.ts` | `worktreesGlobRoute(req, handoff_id, services)` and `worktreesGrepRoute(...)`. Resolve worktree via `services.worktreeManager.getWorktree(handoff_id)` (404 if missing). Parse JSON body. Call `executeGlob`/`executeGrep`. Return JSON. |
| Modify | `packages/daemon/src/serve.ts` | Add two route matches inside the existing `worktrees/...` regex block (lines ~80–90). Imports for the new route handlers. |
| Modify | `packages/mcp/src/daemon-client.ts` | Add `globInWorktree(handoff_id, args)` and `grepInWorktree(handoff_id, args)` methods, both `POST /worktrees/<id>/{glob,grep}`. |
| Create | `packages/mcp/src/tools/fs-glob.ts` | Tool handler. zod input schema with `pattern` (required), `path?`, `max_results?` (`.max(5000)`), `include_ignored?`, `handoff_id?`. Resolve handoff_id (arg → `PENUMBRA_HANDOFF_ID` env → `no_handoff_context` error). Calls `daemon.globInWorktree`. Returns text-content JSON. |
| Create | `packages/mcp/src/tools/fs-grep.ts` | Same shape: `pattern` (required), `path?`, `glob?`, `output_mode` (`'content' \| 'files_with_matches'`, default `'content'`), `case_insensitive?`, `include_ignored?`, `max_results?` (`.max(500)` for content, `.max(5000)` for files_with_matches — enforced post-parse), `handoff_id?`. |
| Modify | `packages/mcp/src/server.ts` | Register `fs.glob` and `fs.grep` tools (insert after `worktree.cleanup`, before `daemon.reload_config`). Imports for the new handlers. |
| Modify | `packages/agentchat/src/sdk/adapter.ts` | Extend `DispatchInput` with `handoff_id?: string`. Optional/additive — existing callers unchanged. |
| Modify | `packages/agentchat/src/cli/dispatch-handoff.ts` (and any other DispatchInput construction site) | Populate `handoff_id` when calling `adapter.dispatch`/`dispatchStream`. |
| Modify | `packages/agentchat/src/adapters/stdio-acp.ts` | Inside `dispatchStream`, before `session/new`: clone `this.opts.mcpServers` and, for each `McpServerStdio` entry, append `{name: 'PENUMBRA_HANDOFF_ID', value: input.handoff_id}` to `env` if `input.handoff_id` is set. The existing `sessionParams.mcpServers = ...` then receives the cloned array. |
| Create | `packages/daemon/test/fs-search.test.ts` | Unit tests for `executeGlob` + `executeGrep` against `mkdtempSync` synthetic trees. |
| Create | `packages/daemon/test/routes-fs.test.ts` | HTTP route tests with daemon spun up in-test. |
| Create | `packages/mcp/test/tools/fs-glob.test.ts` | Tool handler tests vs mock DaemonClient. |
| Create | `packages/mcp/test/tools/fs-grep.test.ts` | Tool handler tests vs mock DaemonClient. |
| Modify | `packages/agentchat/test/adapters/stdio-acp.test.ts` | Add a test asserting the spawned penumbra-mcp's env contains `PENUMBRA_HANDOFF_ID=<dispatch-id>` when `input.handoff_id` is provided. |

**Implementer scope ends after the source-code commits land.** The maestro performs the agentchat.yaml update, daemon-config reload, agentchat-worker restart, and live ACP smoke test (Task 9). Per the `feedback_dont_make_agents_kill_their_host_worker` rule, dispatched implementers must NEVER restart workers — that responsibility belongs solely to the maestro.

**New runtime dep:** `ignore` package, added to `packages/daemon/package.json` in Task 2.

---

## Task 1: Extract `resolveInsideWorktree` to `@penumbra/core`

**Files:**
- Create: `packages/core/src/fs-paths.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/fs-paths.test.ts`
- Modify: `packages/agentchat/src/adapters/acp-fs.ts` (drop local copies, import from core)

This is a pure refactor. Behavior-preserving for Phase 1b.1's `executeReadTextFile`; the existing acp-fs.test.ts tests must continue to pass after the import swap. Phase 1b.2's daemon-side `fs-search.ts` will import the same helper.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/fs-paths.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveInsideWorktree, FsPathError } from '../src/fs-paths.js';

describe('resolveInsideWorktree', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-paths-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves an absolute path inside the worktree to its realpath', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    const real = await resolveInsideWorktree(path.join(tmp, 'a.txt'), tmp);
    expect(real).toBe(fs.realpathSync(path.join(tmp, 'a.txt')));
  });

  it('rejects an absolute path outside the worktree', async () => {
    await expect(resolveInsideWorktree('/etc/passwd', tmp)).rejects.toThrow(FsPathError);
    try {
      await resolveInsideWorktree('/etc/passwd', tmp);
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe('outside_worktree');
    }
  });

  it('rejects a relative-with-.. path that escapes the worktree', async () => {
    const escape = path.join(tmp, '..', 'something.txt');
    await expect(resolveInsideWorktree(escape, tmp)).rejects.toThrow(/outside worktree/i);
  });

  it('rejects a symlink whose realpath is outside the worktree', async () => {
    fs.writeFileSync('/tmp/fs-paths-target.txt', 'secret');
    fs.symlinkSync('/tmp/fs-paths-target.txt', path.join(tmp, 'link'));
    try {
      await resolveInsideWorktree(path.join(tmp, 'link'), tmp);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe('outside_worktree');
    } finally {
      fs.unlinkSync('/tmp/fs-paths-target.txt');
    }
  });

  it('throws FsPathError with code "not_found" for missing path', async () => {
    try {
      await resolveInsideWorktree(path.join(tmp, 'nope.txt'), tmp);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe('not_found');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/core/test/fs-paths.test.ts`

Expected: FAIL — `resolveInsideWorktree`/`FsPathError` not exported.

- [ ] **Step 3: Implement `fs-paths.ts`**

Create `packages/core/src/fs-paths.ts`:

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class FsPathError extends Error {
  constructor(
    public readonly code: 'outside_worktree' | 'not_found' | 'io',
    message: string,
  ) {
    super(message);
    this.name = 'FsPathError';
  }
}

/**
 * Resolves the agent's requested path against the worktree, asserting the
 * realpath is within the worktree's realpath. Walks symlinks. Throws an
 * FsPathError with code "outside_worktree" on escape, "not_found" if the
 * path doesn't exist, or "io" for other filesystem failures.
 */
export async function resolveInsideWorktree(userPath: string, worktree: string): Promise<string> {
  const worktreeReal = await fs.realpath(worktree);
  const candidate = path.isAbsolute(userPath) ? userPath : path.join(worktreeReal, userPath);
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new FsPathError('not_found', `path not found: ${userPath}`);
    }
    throw new FsPathError('io', `failed to resolve ${userPath}: ${err.message}`);
  }
  const rel = path.relative(worktreeReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new FsPathError(
      'outside_worktree',
      `path "${userPath}" resolves outside worktree (real path: ${real})`,
    );
  }
  return real;
}
```

- [ ] **Step 4: Re-export from core's barrel**

In `packages/core/src/index.ts`, add a line near the other exports:

```ts
export { resolveInsideWorktree, FsPathError } from './fs-paths.js';
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test packages/core/test/fs-paths.test.ts`

Expected: 5 pass.

- [ ] **Step 6: Swap acp-fs.ts to use the core helper**

In `packages/agentchat/src/adapters/acp-fs.ts`:

a) Add at the top of the file:

```ts
import { resolveInsideWorktree, FsPathError } from '@penumbra/core';
```

b) Delete the local `resolveInsideWorktree` function (currently lines ~30–50 of acp-fs.ts; the function ending where the export of `executeReadTextFile` begins).

c) Keep the local `ReadTextFileError` for now (it has slightly different code variants that callers depend on), but rewrite its construction inside `executeReadTextFile` to map from `FsPathError`:

```ts
// Inside executeReadTextFile, replace the call to the local resolveInsideWorktree:
let real: string;
try {
  real = await resolveInsideWorktree(args.path, worktree);
} catch (err) {
  if (err instanceof FsPathError) {
    if (err.code === 'outside_worktree') {
      throw new ReadTextFileError('outside_worktree', err.message);
    }
    if (err.code === 'not_found') {
      throw new ReadTextFileError('not_found', err.message);
    }
    throw new ReadTextFileError('io', err.message);
  }
  throw err;
}
```

This keeps `ReadTextFileError` in the public surface of acp-fs.ts (Phase 1b.1 callers still work) while routing through the shared helper.

- [ ] **Step 7: Run acp-fs's existing tests for regression**

Run: `bun test packages/agentchat/test/adapters/acp-fs.test.ts`

Expected: 8 pass (no behavior change).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/fs-paths.ts packages/core/src/index.ts packages/core/test/fs-paths.test.ts packages/agentchat/src/adapters/acp-fs.ts
git commit -m "refactor(core): extract resolveInsideWorktree from acp-fs into shared fs-paths"
```

---

## Task 2: `executeGlob` in `packages/daemon/src/fs-search.ts`

**Files:**
- Create: `packages/daemon/src/fs-search.ts`
- Modify: `packages/daemon/package.json` (add `ignore` dep)
- Create: `packages/daemon/test/fs-search.test.ts`

`executeGlob` walks the search root with `Bun.Glob`, applies `.gitignore` filtering via the `ignore` package, sorts surviving paths by `mtime` desc, applies the soft cap, returns `{ results: string[], truncated: boolean }`. Paths in `results` are relative to `worktree`.

- [ ] **Step 1: Add the `ignore` runtime dep**

In `packages/daemon/package.json`, add to `dependencies`:

```json
"ignore": "^5.3.0"
```

Run: `bun install` from the repo root.

Expected: `ignore` resolved into `node_modules/.bun/ignore@*`.

- [ ] **Step 2: Write the failing tests**

Create `packages/daemon/test/fs-search.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeGlob } from '../src/fs-search.js';

describe('executeGlob', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-glob-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns paths matching a simple pattern, relative to worktree', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'b.md'), 'y');
    const r = await executeGlob({ pattern: '*.ts' }, tmp);
    expect(r.results).toEqual(['a.ts']);
    expect(r.truncated).toBe(false);
  });

  it('matches recursive ** patterns', async () => {
    fs.mkdirSync(path.join(tmp, 'nested'));
    fs.writeFileSync(path.join(tmp, 'nested/c.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'd.ts'), 'y');
    const r = await executeGlob({ pattern: '**/*.ts' }, tmp);
    expect(r.results.sort()).toEqual(['d.ts', 'nested/c.ts']);
  });

  it('sorts results by mtime descending', async () => {
    fs.writeFileSync(path.join(tmp, 'old.ts'), 'x');
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmp, 'old.ts'), oldTime, oldTime);
    fs.writeFileSync(path.join(tmp, 'new.ts'), 'y');
    const r = await executeGlob({ pattern: '*.ts' }, tmp);
    expect(r.results).toEqual(['new.ts', 'old.ts']);
  });

  it('honors .gitignore by default', async () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(tmp, 'kept.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'ignored.ts'), 'y');
    const r = await executeGlob({ pattern: '*.ts' }, tmp);
    expect(r.results).toEqual(['kept.ts']);
  });

  it('include_ignored=true overrides .gitignore', async () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(tmp, 'kept.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'ignored.ts'), 'y');
    const r = await executeGlob({ pattern: '*.ts', include_ignored: true }, tmp);
    expect(r.results.sort()).toEqual(['ignored.ts', 'kept.ts']);
  });

  it('caps at default 1000 and sets truncated=true when more matches exist', async () => {
    for (let i = 0; i < 1005; i++) {
      fs.writeFileSync(path.join(tmp, `f${i}.txt`), 'x');
    }
    const r = await executeGlob({ pattern: '*.txt' }, tmp);
    expect(r.results.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it('respects a smaller max_results override', async () => {
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(tmp, `f${i}.txt`), 'x');
    }
    const r = await executeGlob({ pattern: '*.txt', max_results: 10 }, tmp);
    expect(r.results.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('skips broken symlinks silently', async () => {
    fs.symlinkSync('/nonexistent/path', path.join(tmp, 'broken'));
    fs.writeFileSync(path.join(tmp, 'real.txt'), 'x');
    const r = await executeGlob({ pattern: '*' }, tmp);
    expect(r.results).toContain('real.txt');
  });

  it('returns empty results for non-matching pattern', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'x');
    const r = await executeGlob({ pattern: '*.py' }, tmp);
    expect(r.results).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `bun test packages/daemon/test/fs-search.test.ts`

Expected: FAIL — `executeGlob` not exported.

- [ ] **Step 4: Implement `executeGlob`**

Create `packages/daemon/src/fs-search.ts`:

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore from 'ignore';

const GLOB_DEFAULT_MAX = 1000;
const GLOB_HARD_CEILING = 5000;

export interface GlobArgs {
  pattern: string;
  /** Optional sub-path to search; defaults to the worktree root. */
  path?: string | null;
  max_results?: number | null;
  include_ignored?: boolean | null;
}

export interface GlobResult {
  results: string[];
  truncated: boolean;
}

interface PathWithMtime {
  rel: string;
  mtimeMs: number;
}

async function readGitignore(root: string): Promise<ReturnType<typeof ignore> | null> {
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    return ignore().add(content);
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function executeGlob(args: GlobArgs, worktree: string): Promise<GlobResult> {
  const cap = Math.min(args.max_results ?? GLOB_DEFAULT_MAX, GLOB_HARD_CEILING);
  const searchRoot = args.path ? path.resolve(worktree, args.path) : worktree;

  const ig = args.include_ignored ? null : await readGitignore(worktree);

  // Bun.Glob is provided by the Bun runtime; the daemon already runs under Bun.
  const glob = new Bun.Glob(args.pattern);
  const collected: PathWithMtime[] = [];
  for await (const rel of glob.scan({ cwd: searchRoot, onlyFiles: true, absolute: false })) {
    const relFromWorktree = path.relative(worktree, path.resolve(searchRoot, rel));
    if (ig && ig.ignores(relFromWorktree)) continue;
    let mtimeMs = 0;
    try {
      const st = await fs.stat(path.resolve(searchRoot, rel));
      mtimeMs = st.mtimeMs;
    } catch {
      // Broken symlink — skip silently to match ripgrep default.
      continue;
    }
    collected.push({ rel: relFromWorktree, mtimeMs });
    if (collected.length > cap) break; // Stop scanning once we've exceeded — flag below.
  }

  const truncated = collected.length > cap;
  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { results: collected.slice(0, cap).map((p) => p.rel), truncated };
}
```

Note: `Bun.Glob` is the Bun runtime built-in. If a glob match's `fs.stat` throws (broken symlink), we skip it. The `> cap` check breaks early — we always read at most `cap + 1` entries to detect truncation cheaply.

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test packages/daemon/test/fs-search.test.ts`

Expected: 9 pass (the executeGlob block).

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/fs-search.ts packages/daemon/test/fs-search.test.ts packages/daemon/package.json bun.lock
git commit -m "feat(daemon): fs-search — executeGlob with .gitignore filter, mtime sort, soft cap"
```

---

## Task 3: `executeGrep` in `packages/daemon/src/fs-search.ts`

**Files:**
- Modify: `packages/daemon/src/fs-search.ts` (append `executeGrep`)
- Modify: `packages/daemon/test/fs-search.test.ts` (append grep tests)

Grep spawns `rg --json` and counts `match` events client-side to enforce a global cap (`rg`'s `-m` is per-file, not global).

- [ ] **Step 1: Append the failing tests**

Append to `packages/daemon/test/fs-search.test.ts`:

```ts
import { executeGrep } from '../src/fs-search.js';

describe('executeGrep', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-grep-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('content mode: returns {path, line, text} rows for each match', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'foo\nTODO bar\nbaz\n');
    fs.writeFileSync(path.join(tmp, 'b.ts'), 'no match\n');
    const r = await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
    expect(r.results).toEqual([{ path: 'a.ts', line: 2, text: 'TODO bar' }]);
    expect(r.truncated).toBe(false);
  });

  it('respects glob filter', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'TODO\n');
    fs.writeFileSync(path.join(tmp, 'a.md'), 'TODO\n');
    const r = await executeGrep({ pattern: 'TODO', glob: '*.ts', output_mode: 'content' }, tmp);
    expect(r.results.map((x: any) => x.path)).toEqual(['a.ts']);
  });

  it('case_insensitive=true matches mixed case', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'todo lower\nTODO upper\n');
    const r = await executeGrep({ pattern: 'todo', case_insensitive: true, output_mode: 'content' }, tmp);
    expect(r.results.length).toBe(2);
  });

  it('truncates content mode at default 50 and sets truncated=true', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push('TODO line ' + i);
    fs.writeFileSync(path.join(tmp, 'big.ts'), lines.join('\n') + '\n');
    const r = await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
    expect(r.results.length).toBe(50);
    expect(r.truncated).toBe(true);
  });

  it('per-line text capped at 1KB with ellipsis suffix', async () => {
    const long = 'TODO ' + 'x'.repeat(2000);
    fs.writeFileSync(path.join(tmp, 'big.ts'), long + '\n');
    const r = await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
    expect(r.results[0].text.length).toBeLessThanOrEqual(1024);
    expect(r.results[0].text.endsWith('…')).toBe(true);
  });

  it('files_with_matches mode returns deduped paths', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'TODO\nTODO again\n');
    fs.writeFileSync(path.join(tmp, 'b.ts'), 'no\n');
    const r = await executeGrep({ pattern: 'TODO', output_mode: 'files_with_matches' }, tmp);
    expect(r.results).toEqual(['a.ts']);
    expect(r.truncated).toBe(false);
  });

  it('returns engine_unavailable error when rg binary missing', async () => {
    process.env.PENUMBRA_RG_BINARY = '/nonexistent/rg';
    try {
      await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('engine_unavailable');
    } finally {
      delete process.env.PENUMBRA_RG_BINARY;
    }
  });

  it('returns bad_pattern error for an invalid regex', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'x\n');
    try {
      await executeGrep({ pattern: '[invalid', output_mode: 'content' }, tmp);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('bad_pattern');
    }
  });

  it('include_ignored=true passes --no-ignore to rg', async () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(tmp, 'ignored.ts'), 'TODO\n');
    fs.writeFileSync(path.join(tmp, 'kept.ts'), 'TODO\n');
    const without = await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
    expect(without.results.map((x: any) => x.path).sort()).toEqual(['kept.ts']);
    const withIgnored = await executeGrep({ pattern: 'TODO', output_mode: 'content', include_ignored: true }, tmp);
    expect(withIgnored.results.map((x: any) => x.path).sort()).toEqual(['ignored.ts', 'kept.ts']);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/daemon/test/fs-search.test.ts`

Expected: FAIL — `executeGrep` not exported.

- [ ] **Step 3: Implement `executeGrep`**

Append to `packages/daemon/src/fs-search.ts`:

```ts
import { spawn } from 'node:child_process';

const GREP_CONTENT_DEFAULT_MAX = 50;
const GREP_CONTENT_HARD_CEILING = 500;
const GREP_FILES_DEFAULT_MAX = 1000;
const GREP_FILES_HARD_CEILING = 5000;
const PER_LINE_TEXT_CAP = 1024;

export class GrepError extends Error {
  constructor(
    public readonly code: 'engine_unavailable' | 'bad_pattern' | 'io',
    message: string,
  ) {
    super(message);
    this.name = 'GrepError';
  }
}

export type GrepOutputMode = 'content' | 'files_with_matches';

export interface GrepArgs {
  pattern: string;
  path?: string | null;
  glob?: string | null;
  output_mode?: GrepOutputMode | null;
  case_insensitive?: boolean | null;
  include_ignored?: boolean | null;
  max_results?: number | null;
}

export interface GrepContentRow {
  path: string;
  line: number;
  text: string;
}

export interface GrepResult {
  results: GrepContentRow[] | string[];
  truncated: boolean;
}

function rgBinary(): string {
  return process.env.PENUMBRA_RG_BINARY || 'rg';
}

function capTextLine(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= PER_LINE_TEXT_CAP) return text;
  const slice = Buffer.from(text, 'utf8').subarray(0, PER_LINE_TEXT_CAP - 1).toString('utf8');
  return slice + '…';
}

export async function executeGrep(args: GrepArgs, worktree: string): Promise<GrepResult> {
  const outputMode: GrepOutputMode = args.output_mode ?? 'content';
  const defaultMax = outputMode === 'content' ? GREP_CONTENT_DEFAULT_MAX : GREP_FILES_DEFAULT_MAX;
  const ceiling = outputMode === 'content' ? GREP_CONTENT_HARD_CEILING : GREP_FILES_HARD_CEILING;
  const cap = Math.min(args.max_results ?? defaultMax, ceiling);
  const searchRoot = args.path ? path.resolve(worktree, args.path) : worktree;

  const rgArgs: string[] = ['--json', '--no-config'];
  if (args.case_insensitive) rgArgs.push('-i');
  if (args.glob) rgArgs.push('-g', args.glob);
  if (args.include_ignored) rgArgs.push('--no-ignore');
  // Note: we do NOT pass --files-with-matches to rg. Instead we always run a
  // normal grep and dedup paths client-side from the `match` event stream.
  // Passing --files-with-matches changes rg's JSON event output (no `match`
  // events) and complicates parsing without a meaningful perf win for the
  // expected workload.
  rgArgs.push('--', args.pattern, searchRoot);

  return await new Promise<GrepResult>((resolve, reject) => {
    const child = spawn(rgBinary(), rgArgs, { cwd: worktree });
    const results: GrepContentRow[] | string[] = outputMode === 'content' ? [] : [];
    const seenPaths = new Set<string>();
    let stderr = '';
    let buffer = '';
    let truncated = false;
    let killed = false;
    let totalMatches = 0;

    child.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        reject(new GrepError('engine_unavailable', `ripgrep not found (binary: ${rgBinary()}). Set PENUMBRA_RG_BINARY or install ripgrep.`));
      } else {
        reject(new GrepError('io', err.message));
      }
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (killed) return;
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let evt: any;
        try { evt = JSON.parse(line); } catch { continue; }
        if (outputMode === 'content' && evt.type === 'match') {
          totalMatches += 1;
          if (totalMatches > cap) {
            truncated = true;
            killed = true;
            child.kill();
            return;
          }
          const matchPath = evt.data?.path?.text ?? '';
          const lineNumber = evt.data?.line_number ?? 0;
          const text = (evt.data?.lines?.text ?? '').replace(/\n$/, '');
          (results as GrepContentRow[]).push({
            path: path.relative(worktree, matchPath),
            line: lineNumber,
            text: capTextLine(text),
          });
        } else if (outputMode === 'files_with_matches' && evt.type === 'match') {
          // Dedup paths from the `match` event stream (we deliberately don't
          // pass --files-with-matches; see flag construction above).
          const matchPath = evt.data?.path?.text ?? '';
          if (!matchPath) continue;
          const rel = path.relative(worktree, matchPath);
          if (seenPaths.has(rel)) continue;
          seenPaths.add(rel);
          totalMatches += 1;
          if (totalMatches > cap) {
            truncated = true;
            killed = true;
            child.kill();
            return;
          }
          (results as string[]).push(rel);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('close', (code: number | null) => {
      if (killed) {
        resolve({ results, truncated });
        return;
      }
      // ripgrep exit codes: 0 = matches, 1 = no matches (also success), 2 = error
      if (code === 0 || code === 1) {
        resolve({ results, truncated });
        return;
      }
      const firstLine = stderr.split('\n')[0] || `rg exited with code ${code}`;
      // Heuristic: invalid regex shows as a parse-error message.
      if (/regex parse error|unclosed character class|repetition operator missing/i.test(stderr)) {
        reject(new GrepError('bad_pattern', firstLine));
      } else {
        reject(new GrepError('io', firstLine));
      }
    });
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/daemon/test/fs-search.test.ts`

Expected: all 18 pass (9 glob + 9 grep).

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/fs-search.ts packages/daemon/test/fs-search.test.ts
git commit -m "feat(daemon): fs-search — executeGrep via rg --json with global cap, .gitignore, glob filter"
```

---

## Task 4: Daemon HTTP routes for `/worktrees/:id/{glob,grep}`

**Files:**
- Create: `packages/daemon/src/routes/fs.ts`
- Modify: `packages/daemon/src/serve.ts` (register two new routes)
- Create: `packages/daemon/test/routes-fs.test.ts`

The routes mirror `worktreesInspectRoute`'s shape: lookup worktree, 404 if missing, delegate to fs-search, return JSON.

- [ ] **Step 1: Write the failing route tests**

Create `packages/daemon/test/routes-fs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { worktreesGlobRoute, worktreesGrepRoute } from '../src/routes/fs.js';

function fakeServices(worktrees: Record<string, string>): any {
  return {
    worktreeManager: {
      getWorktree: (id: string) => worktrees[id] ? { handoffId: id, path: worktrees[id] } : null,
    },
  };
}

describe('worktrees fs routes', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-fs-'));
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'TODO\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('glob: returns 404 when handoff is unknown', async () => {
    const services = fakeServices({});
    const req = new Request('http://x/worktrees/UNKNOWN/glob', {
      method: 'POST',
      body: JSON.stringify({ pattern: '*.ts' }),
    });
    const res = await worktreesGlobRoute(req, 'UNKNOWN', services);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('glob: returns matches on happy path', async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request('http://x/worktrees/H1/glob', {
      method: 'POST',
      body: JSON.stringify({ pattern: '*.ts' }),
    });
    const res = await worktreesGlobRoute(req, 'H1', services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual(['a.ts']);
  });

  it('glob: returns 400 when args.path resolves outside worktree', async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request('http://x/worktrees/H1/glob', {
      method: 'POST',
      body: JSON.stringify({ pattern: '*.ts', path: '/etc' }),
    });
    const res = await worktreesGlobRoute(req, 'H1', services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('outside_worktree');
  });

  it('grep: returns matches on happy path', async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request('http://x/worktrees/H1/grep', {
      method: 'POST',
      body: JSON.stringify({ pattern: 'TODO', output_mode: 'content' }),
    });
    const res = await worktreesGrepRoute(req, 'H1', services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBe(1);
    expect(body.results[0].text).toBe('TODO');
  });

  it('grep: returns 404 when handoff is unknown', async () => {
    const services = fakeServices({});
    const req = new Request('http://x/worktrees/UNKNOWN/grep', {
      method: 'POST',
      body: JSON.stringify({ pattern: 'TODO' }),
    });
    const res = await worktreesGrepRoute(req, 'UNKNOWN', services);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/daemon/test/routes-fs.test.ts`

Expected: FAIL — route handlers not exported.

- [ ] **Step 3: Implement the route handlers**

Create `packages/daemon/src/routes/fs.ts`:

```ts
import type { Services } from '@penumbra/core';
import { FsPathError, resolveInsideWorktree } from '@penumbra/core';
import { executeGlob, executeGrep, GrepError } from '../fs-search.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function worktreesGlobRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const wt = services.worktreeManager.getWorktree(handoff_id);
  if (!wt) {
    return json({ error: { code: 'not_found', message: `worktree for handoff ${handoff_id} not found` } }, 404);
  }

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  if (!body?.pattern || typeof body.pattern !== 'string') {
    return json({ error: { code: 'invalid_args', message: 'pattern (string) required' } }, 400);
  }

  // Validate args.path is inside the worktree before passing into executeGlob.
  if (body.path) {
    try {
      await resolveInsideWorktree(body.path, wt.path);
    } catch (err) {
      if (err instanceof FsPathError) {
        return json({ error: { code: err.code, message: err.message } }, err.code === 'outside_worktree' ? 400 : 404);
      }
      throw err;
    }
  }

  try {
    const result = await executeGlob(
      {
        pattern: body.pattern,
        path: body.path ?? null,
        max_results: typeof body.max_results === 'number' ? body.max_results : null,
        include_ignored: body.include_ignored === true,
      },
      wt.path,
    );
    return json(result);
  } catch (err: any) {
    return json({ error: { code: 'internal_error', message: err.message } }, 500);
  }
}

export async function worktreesGrepRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const wt = services.worktreeManager.getWorktree(handoff_id);
  if (!wt) {
    return json({ error: { code: 'not_found', message: `worktree for handoff ${handoff_id} not found` } }, 404);
  }

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  if (!body?.pattern || typeof body.pattern !== 'string') {
    return json({ error: { code: 'invalid_args', message: 'pattern (string) required' } }, 400);
  }

  if (body.path) {
    try {
      await resolveInsideWorktree(body.path, wt.path);
    } catch (err) {
      if (err instanceof FsPathError) {
        return json({ error: { code: err.code, message: err.message } }, err.code === 'outside_worktree' ? 400 : 404);
      }
      throw err;
    }
  }

  try {
    const result = await executeGrep(
      {
        pattern: body.pattern,
        path: body.path ?? null,
        glob: body.glob ?? null,
        output_mode: body.output_mode ?? 'content',
        case_insensitive: body.case_insensitive === true,
        include_ignored: body.include_ignored === true,
        max_results: typeof body.max_results === 'number' ? body.max_results : null,
      },
      wt.path,
    );
    return json(result);
  } catch (err) {
    if (err instanceof GrepError) {
      const status = err.code === 'engine_unavailable' ? 500 : err.code === 'bad_pattern' ? 400 : 500;
      return json({ error: { code: err.code, message: err.message } }, status);
    }
    return json({ error: { code: 'internal_error', message: (err as Error).message } }, 500);
  }
}
```

- [ ] **Step 4: Register the routes in `serve.ts`**

In `packages/daemon/src/serve.ts`, add an import near line 25:

```ts
import { worktreesGlobRoute, worktreesGrepRoute } from './routes/fs.js';
```

After the existing `worktreesCleanupRoute` block (around line 87–89), add:

```ts
const worktreeGlobMatch = url.pathname.match(/^\/worktrees\/([^/]+)\/glob$/);
if (worktreeGlobMatch && req.method === 'POST') {
  return worktreesGlobRoute(req, worktreeGlobMatch[1]!, opts.services);
}
const worktreeGrepMatch = url.pathname.match(/^\/worktrees\/([^/]+)\/grep$/);
if (worktreeGrepMatch && req.method === 'POST') {
  return worktreesGrepRoute(req, worktreeGrepMatch[1]!, opts.services);
}
```

Important: place these BEFORE the existing single-segment `^\/worktrees\/([^/]+)$` match (worktreeMatch around line 83–85). Otherwise the single-segment match captures `H1/glob` style paths first. The cleanup route's regex `\/cleanup$` already protects against this for cleanup; the new ones need the same precedence ordering — i.e., put the more-specific routes ABOVE the less-specific one in the file. Refactor the order if needed; verify with the route tests that all four (`/worktrees/:id`, `/worktrees/:id/cleanup`, `/worktrees/:id/glob`, `/worktrees/:id/grep`) resolve correctly.

- [ ] **Step 5: Run route tests to verify pass**

Run: `bun test packages/daemon/test/routes-fs.test.ts`

Expected: 5 pass.

- [ ] **Step 6: Run full daemon route suite for regressions**

Run: `bun test packages/daemon/test/`

Expected: all pre-existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/routes/fs.ts packages/daemon/src/serve.ts packages/daemon/test/routes-fs.test.ts
git commit -m "feat(daemon): http routes — POST /worktrees/:id/glob and /grep with worktree-scoped path validation"
```

---

## Task 5: DaemonClient methods + MCP tool handlers

**Files:**
- Modify: `packages/mcp/src/daemon-client.ts`
- Create: `packages/mcp/src/tools/fs-glob.ts`
- Create: `packages/mcp/src/tools/fs-grep.ts`
- Create: `packages/mcp/test/tools/fs-glob.test.ts`
- Create: `packages/mcp/test/tools/fs-grep.test.ts`

- [ ] **Step 1: Add the DaemonClient methods**

In `packages/mcp/src/daemon-client.ts`, append to the `DaemonClient` class (after `inspectWorktree` around line 110):

```ts
async globInWorktree(handoff_id: string, args: {
  pattern: string;
  path?: string | null;
  max_results?: number | null;
  include_ignored?: boolean | null;
}): Promise<{ results: string[]; truncated: boolean }> {
  return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/glob`, args);
}

async grepInWorktree(handoff_id: string, args: {
  pattern: string;
  path?: string | null;
  glob?: string | null;
  output_mode?: 'content' | 'files_with_matches';
  case_insensitive?: boolean | null;
  include_ignored?: boolean | null;
  max_results?: number | null;
}): Promise<{ results: any[] | string[]; truncated: boolean }> {
  return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/grep`, args);
}
```

- [ ] **Step 2: Write the failing fs-glob tool test**

Create `packages/mcp/test/tools/fs-glob.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'bun:test';
import { fsGlobHandler } from '../../src/tools/fs-glob.js';

function fakeDaemon(impl?: Partial<{ globInWorktree: any }>): any {
  return { globInWorktree: impl?.globInWorktree ?? (async () => ({ results: [], truncated: false })) };
}

describe('fs.glob handler', () => {
  afterEach(() => { delete process.env.PENUMBRA_HANDOFF_ID; });

  it('forwards pattern + path + handoff_id to daemon', async () => {
    let received: any = null;
    const daemon = fakeDaemon({
      globInWorktree: async (id: string, args: any) => { received = { id, args }; return { results: ['x'], truncated: false }; },
    });
    const handler = fsGlobHandler(daemon);
    const out = await handler({ pattern: '*.ts', handoff_id: 'H1' });
    expect(received.id).toBe('H1');
    expect(received.args.pattern).toBe('*.ts');
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.results).toEqual(['x']);
  });

  it('defaults handoff_id from PENUMBRA_HANDOFF_ID env when arg absent', async () => {
    process.env.PENUMBRA_HANDOFF_ID = 'H_ENV';
    let receivedId: string | null = null;
    const daemon = fakeDaemon({
      globInWorktree: async (id: string) => { receivedId = id; return { results: [], truncated: false }; },
    });
    const handler = fsGlobHandler(daemon);
    await handler({ pattern: '*.ts' });
    expect(receivedId).toBe('H_ENV');
  });

  it('returns no_handoff_context error when neither arg nor env set', async () => {
    const daemon = fakeDaemon();
    const handler = fsGlobHandler(daemon);
    const out = await handler({ pattern: '*.ts' });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe('no_handoff_context');
  });

  it('surfaces daemon HTTP errors as isError with code preserved', async () => {
    const daemon = fakeDaemon({
      globInWorktree: async () => {
        const err: any = new Error('daemon error');
        err.status = 404;
        err.body = { error: { code: 'not_found', message: 'worktree not found' } };
        throw err;
      },
    });
    const handler = fsGlobHandler(daemon);
    const out = await handler({ pattern: '*.ts', handoff_id: 'X' });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe('not_found');
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `bun test packages/mcp/test/tools/fs-glob.test.ts`

Expected: FAIL — `fsGlobHandler` not exported.

- [ ] **Step 4: Implement `fs-glob.ts`**

Create `packages/mcp/src/tools/fs-glob.ts`:

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const FsGlobInputShape = {
  pattern: z.string().min(1).describe('Glob pattern (e.g. "**/*.ts").'),
  path: z.string().optional().describe('Optional sub-path inside the worktree to search; defaults to worktree root.'),
  max_results: z.number().int().positive().max(5000).optional().describe('Soft cap; default 1000, hard ceiling 5000.'),
  include_ignored: z.boolean().optional().describe('When true, ignore .gitignore. Default false.'),
  handoff_id: z.string().optional().describe('Worktree to scope the search to. Defaults to PENUMBRA_HANDOFF_ID env var.'),
};

function errorContent(code: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

export function fsGlobHandler(daemon: DaemonClient) {
  return async (input: any) => {
    const handoff_id = input.handoff_id || process.env.PENUMBRA_HANDOFF_ID;
    if (!handoff_id) {
      return errorContent('no_handoff_context', 'pass handoff_id explicitly or run inside a dispatch (PENUMBRA_HANDOFF_ID env var unset)');
    }
    try {
      const result = await daemon.globInWorktree(handoff_id, {
        pattern: input.pattern,
        path: input.path ?? null,
        max_results: input.max_results ?? null,
        include_ignored: input.include_ignored === true,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: any) {
      const code = err?.body?.error?.code ?? 'internal_error';
      const message = err?.body?.error?.message ?? err?.message ?? 'unknown error';
      return errorContent(code, message);
    }
  };
}
```

- [ ] **Step 5: Write the failing fs-grep tool test**

Create `packages/mcp/test/tools/fs-grep.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'bun:test';
import { fsGrepHandler } from '../../src/tools/fs-grep.js';

function fakeDaemon(impl?: Partial<{ grepInWorktree: any }>): any {
  return { grepInWorktree: impl?.grepInWorktree ?? (async () => ({ results: [], truncated: false })) };
}

describe('fs.grep handler', () => {
  afterEach(() => { delete process.env.PENUMBRA_HANDOFF_ID; });

  it('forwards all relevant fields to daemon', async () => {
    let received: any = null;
    const daemon = fakeDaemon({
      grepInWorktree: async (id: string, args: any) => { received = { id, args }; return { results: [], truncated: false }; },
    });
    const handler = fsGrepHandler(daemon);
    await handler({ pattern: 'TODO', glob: '*.ts', output_mode: 'content', case_insensitive: true, handoff_id: 'H1' });
    expect(received.id).toBe('H1');
    expect(received.args).toMatchObject({ pattern: 'TODO', glob: '*.ts', output_mode: 'content', case_insensitive: true });
  });

  it('defaults handoff_id from env', async () => {
    process.env.PENUMBRA_HANDOFF_ID = 'H_ENV';
    let receivedId: string | null = null;
    const daemon = fakeDaemon({
      grepInWorktree: async (id: string) => { receivedId = id; return { results: [], truncated: false }; },
    });
    const handler = fsGrepHandler(daemon);
    await handler({ pattern: 'TODO' });
    expect(receivedId).toBe('H_ENV');
  });

  it('returns no_handoff_context error when neither arg nor env set', async () => {
    const daemon = fakeDaemon();
    const handler = fsGrepHandler(daemon);
    const out = await handler({ pattern: 'TODO' });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe('no_handoff_context');
  });

  it('surfaces daemon engine_unavailable', async () => {
    const daemon = fakeDaemon({
      grepInWorktree: async () => {
        const err: any = new Error('daemon error');
        err.body = { error: { code: 'engine_unavailable', message: 'rg missing' } };
        throw err;
      },
    });
    const handler = fsGrepHandler(daemon);
    const out = await handler({ pattern: 'TODO', handoff_id: 'X' });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe('engine_unavailable');
  });
});
```

- [ ] **Step 6: Implement `fs-grep.ts`**

Create `packages/mcp/src/tools/fs-grep.ts`:

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const FsGrepInputShape = {
  pattern: z.string().min(1).describe('Regular expression to search for.'),
  path: z.string().optional().describe('Optional sub-path inside the worktree to search; defaults to worktree root.'),
  glob: z.string().optional().describe('Optional file pattern filter (e.g. "*.ts").'),
  output_mode: z.enum(['content', 'files_with_matches']).optional().describe('Default "content" returns matching lines; "files_with_matches" returns just paths.'),
  case_insensitive: z.boolean().optional().describe('Case-insensitive match. Default false.'),
  include_ignored: z.boolean().optional().describe('Search files normally excluded by .gitignore. Default false.'),
  max_results: z.number().int().positive().max(5000).optional().describe('Soft cap. Default: content=50 (ceiling 500), files_with_matches=1000 (ceiling 5000).'),
  handoff_id: z.string().optional().describe('Worktree to scope the search to. Defaults to PENUMBRA_HANDOFF_ID env var.'),
};

function errorContent(code: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

export function fsGrepHandler(daemon: DaemonClient) {
  return async (input: any) => {
    const handoff_id = input.handoff_id || process.env.PENUMBRA_HANDOFF_ID;
    if (!handoff_id) {
      return errorContent('no_handoff_context', 'pass handoff_id explicitly or run inside a dispatch (PENUMBRA_HANDOFF_ID env var unset)');
    }
    try {
      const result = await daemon.grepInWorktree(handoff_id, {
        pattern: input.pattern,
        path: input.path ?? null,
        glob: input.glob ?? null,
        output_mode: input.output_mode ?? 'content',
        case_insensitive: input.case_insensitive === true,
        include_ignored: input.include_ignored === true,
        max_results: input.max_results ?? null,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: any) {
      const code = err?.body?.error?.code ?? 'internal_error';
      const message = err?.body?.error?.message ?? err?.message ?? 'unknown error';
      return errorContent(code, message);
    }
  };
}
```

- [ ] **Step 7: Run all tool tests to verify pass**

Run: `bun test packages/mcp/test/tools/fs-glob.test.ts packages/mcp/test/tools/fs-grep.test.ts`

Expected: 8 pass (4 + 4).

- [ ] **Step 8: Commit**

```bash
git add packages/mcp/src/daemon-client.ts packages/mcp/src/tools/fs-glob.ts packages/mcp/src/tools/fs-grep.ts packages/mcp/test/tools/fs-glob.test.ts packages/mcp/test/tools/fs-grep.test.ts
git commit -m "feat(mcp): fs.glob and fs.grep tool handlers + DaemonClient HTTP wrappers"
```

---

## Task 6: Register tools in `packages/mcp/src/server.ts`

**Files:**
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Register the tools**

In `packages/mcp/src/server.ts`, add imports near the other tool imports:

```ts
import { FsGlobInputShape, fsGlobHandler } from './tools/fs-glob.js';
import { FsGrepInputShape, fsGrepHandler } from './tools/fs-grep.js';
```

After the `worktree.cleanup` registration (around line 138), and before `daemon.reload_config`, add:

```ts
server.registerTool(
  'fs.glob',
  {
    description:
      'Find files inside the dispatch\'s worktree by glob pattern (e.g. "**/*.ts"). Honors .gitignore by default. Sorted by mtime desc. handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
    inputSchema: FsGlobInputShape,
  },
  fsGlobHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
);
server.registerTool(
  'fs.grep',
  {
    description:
      'Search file contents in the dispatch\'s worktree using ripgrep. Two output modes: "content" returns {path, line, text} rows (default; cap 50/ceiling 500); "files_with_matches" returns paths only (cap 1000/ceiling 5000). handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
    inputSchema: FsGrepInputShape,
  },
  fsGrepHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
);
```

- [ ] **Step 2: Verify with a smoke `bun run typecheck`**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 3: Run full mcp test suite for regressions**

Run: `bun test packages/mcp/test/`

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): register fs.glob and fs.grep tools alongside existing 18"
```

---

## Task 7: Thread `handoff_id` through `DispatchInput` → stdio-acp env injection

**Files:**
- Modify: `packages/agentchat/src/sdk/adapter.ts`
- Modify: `packages/agentchat/src/cli/dispatch-handoff.ts` (and any other DispatchInput construction sites)
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify: `packages/agentchat/test/adapters/stdio-acp.test.ts` (extend with one new test)

The implementer's first move on this task is to grep for every site that constructs a `DispatchInput` literal — there is more than one. The plan lists the known site (`dispatch-handoff.ts`); confirm with `grep -rn "prompt:" packages/agentchat/src --include='*.ts' | grep -i 'dispatch'`.

- [ ] **Step 1: Extend `DispatchInput`**

In `packages/agentchat/src/sdk/adapter.ts`, change:

```ts
export interface DispatchInput {
  prompt: string;
  conversation: { id: string; project_id: string | null };
  config: Record<string, unknown>;
  signal: AbortSignal;
  requestPermission?: (toolCall: ToolCallContext) => Promise<PermissionDecision>;
}
```

to:

```ts
export interface DispatchInput {
  prompt: string;
  conversation: { id: string; project_id: string | null };
  config: Record<string, unknown>;
  signal: AbortSignal;
  requestPermission?: (toolCall: ToolCallContext) => Promise<PermissionDecision>;
  /** Optional. Set by the worker for ACP dispatches; lets adapters inject
   *  PENUMBRA_HANDOFF_ID into spawned MCP server envs so penumbra-mcp tools
   *  (fs.glob, fs.grep, etc.) can scope to the dispatch's worktree without
   *  the agent needing to know its own handoff_id. */
  handoff_id?: string;
}
```

- [ ] **Step 2: Find DispatchInput construction sites and populate `handoff_id`**

Run: `grep -rn "prompt:" packages/agentchat/src --include='*.ts'` to find construction sites. Expected sites at time of writing:

- `packages/agentchat/src/cli/dispatch-handoff.ts`
- (possibly) `packages/agentchat/src/cli/auto-loop.ts`

For each site that calls `adapter.dispatch(...)` or `adapter.dispatchStream(...)` with a `DispatchInput` literal: locate the surrounding scope where the handoff_id is available (typically a variable named `currentHandoff`, `created.handoff_id`, or similar — see lines around `auto-loop.ts:34` and `dispatch-handoff.ts:138` for examples), and add `handoff_id: <that variable>` to the literal.

If the literal has the form `{ prompt, conversation, config, signal }`, change it to `{ prompt, conversation, config, signal, handoff_id }`. Backward-compatible.

- [ ] **Step 3: Inject env in stdio-acp.ts**

In `packages/agentchat/src/adapters/stdio-acp.ts`, locate the `sessionParams.mcpServers = this.opts.mcpServers ?? []` (around line 167). Replace the surrounding block with:

```ts
const mcpServers = this.opts.mcpServers ?? [];
const mcpServersWithEnv = input.handoff_id
  ? mcpServers.map((s: any) =>
      s.command !== undefined && Array.isArray(s.env)
        ? {
            ...s,
            env: [
              ...s.env.filter((e: any) => e.name !== 'PENUMBRA_HANDOFF_ID'),
              { name: 'PENUMBRA_HANDOFF_ID', value: input.handoff_id },
            ],
          }
        : s,
    )
  : mcpServers;

const sessionParams: any = {
  cwd,
  mcpServers: mcpServersWithEnv,
};
```

The `s.command !== undefined && Array.isArray(s.env)` guard restricts injection to `McpServerStdio` shape (which has `env: EnvVariable[]`); HTTP/SSE entries are passed through unchanged.

- [ ] **Step 4: Add the regression test**

In `packages/agentchat/test/adapters/stdio-acp.test.ts`, append a new test (find a suitable describe block matching the existing test conventions):

```ts
it('injects PENUMBRA_HANDOFF_ID into McpServerStdio env when input.handoff_id is set', async () => {
  // Construct a fixture that captures the sessionParams sent to session/new
  let capturedSessionParams: any = null;
  const fakeClient: any = {
    onRequest: () => {},
    request: async (method: string, params: any) => {
      if (method === 'initialize') return { protocolVersion: 1, authMethods: [] };
      if (method === 'session/new') { capturedSessionParams = params; return { sessionId: 's1' }; }
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    },
    on: () => {},
  };

  const adapter = new StdioAcpAdapter(
    {
      binary: '/bin/true',
      mcpServers: [
        { name: 'penumbra-mcp', command: '/bin/penumbra-mcp', args: [], env: [{ name: 'X', value: 'Y' }] },
      ],
    },
    {
      startServer: async () => ({ stdin: { write: () => {} }, stdout: {} } as any),
      createClient: () => fakeClient,
    },
  );

  await adapter.dispatch({
    prompt: 'hi',
    conversation: { id: 'c1', project_id: null },
    config: {},
    signal: new AbortController().signal,
    handoff_id: 'HANDOFF_ABC',
  });

  expect(capturedSessionParams.mcpServers).toBeDefined();
  expect(capturedSessionParams.mcpServers[0].env).toEqual([
    { name: 'X', value: 'Y' },
    { name: 'PENUMBRA_HANDOFF_ID', value: 'HANDOFF_ABC' },
  ]);
});
```

The exact fixture shape may need adjusting to match the surrounding test file's conventions. The pre-existing tests will guide you — run them first (`bun test packages/agentchat/test/adapters/stdio-acp.test.ts`) to confirm they still pass, then layer the new one on top. The dependency-injection signature `new StdioAcpAdapter(opts, deps)` is established in the constructor (lines 28–34 of stdio-acp.ts).

- [ ] **Step 5: Run the test suite**

Run: `bun test packages/agentchat/test/adapters/stdio-acp.test.ts`

Expected: all pre-existing tests pass plus the one new test.

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/sdk/adapter.ts packages/agentchat/src/cli/dispatch-handoff.ts packages/agentchat/src/cli/auto-loop.ts packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/test/adapters/stdio-acp.test.ts
git commit -m "feat(agentchat): thread handoff_id into DispatchInput; stdio-acp injects PENUMBRA_HANDOFF_ID into mcpServers env"
```

---

## Task 8: Final cross-package regression sweep + commit

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`

Expected: all tests pass across all packages.

- [ ] **Step 2: Typecheck the whole tree**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 3: Verify no stray TODOs in implementer-scope changes**

Run: `git diff main...HEAD --name-only | xargs grep -nl 'TODO\|FIXME' 2>/dev/null || echo "clean"`

Expected: `clean`, or only TODOs that pre-existed (sanity-check by `git blame` on each).

- [ ] **Step 4: Stop here**

Implementer scope ends. The maestro will run the yaml + worker restart + smoke test (Task 9).

---

## Task 9: Maestro-side smoke (NOT implementer scope)

This task is OUT OF SCOPE for the dispatched implementer. Per the `feedback_dont_make_agents_kill_their_host_worker` rule, dispatched implementers must NEVER restart the agentchat-worker — that responsibility is the maestro's, after the implementer's commits have landed.

The maestro performs the following:

- [ ] **Step 1: Verify all implementer commits are on main**

```bash
git log --oneline main | head -10
```

Expect to see the 8 implementer commits (Tasks 1–7 + cross-sweep).

- [ ] **Step 2: Confirm `rg` is available on the daemon's PATH**

```bash
which rg && rg --version
```

If missing, install (`brew install ripgrep` on macOS) before proceeding.

- [ ] **Step 3: Reload daemon config (no agentchat.yaml change required)**

`fs.glob`/`fs.grep` are unconditionally registered in penumbra-mcp; any agent already opted into `mcpServers: [penumbra-mcp]` (Phase 1a) gets them automatically. No yaml edit needed.

```bash
PORT=$(cat /tmp/penumbra-live/port); TOKEN=$(cat /tmp/penumbra-live/token)
curl -sS -X POST "http://127.0.0.1:$PORT/agentchat/reload" -H "Authorization: Bearer $TOKEN"
```

- [ ] **Step 4: Restart agentchat-worker**

The agentchat-worker hosts the live ACP adapter instances and must be restarted to pick up the new stdio-acp env injection logic. Use whatever launcher pattern is currently in use for the worker (mirror Phase 1b.1's smoke step).

- [ ] **Step 5: Live ACP smoke test**

Via penumbra MCP (or `chain.start`):

```
chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Use fs.glob to list every "*.test.ts" file under packages/agentchat/test, then fs.grep for "describe(" in those files. Reply with the total count of describe blocks across all matched files. Reply with the integer only.',
  use_worktree: true,
  trust_mode: 'all',
})
```

Then `chain_wait(timeout_ms: 240000)` + `chain_get_response`.

**Pass criterion:** the response is the integer that matches:

```bash
WT_PATH=$(curl -sS "http://127.0.0.1:$PORT/worktrees/<handoff_id>" -H "Authorization: Bearer $TOKEN" | jq -r .worktree.path)
rg -c 'describe\(' "$WT_PATH"/packages/agentchat/test --glob '*.test.ts' | awk -F: '{s+=$2} END {print s}'
```

If the agent returns an explanation rather than the integer, or refuses, capture the conversation log via `chain.get_messages` and inspect for `tool_call_failed` events. Common failure modes:
- penumbra-mcp env didn't include `PENUMBRA_HANDOFF_ID` → tool returns `no_handoff_context`. Diagnosis: check stdio-acp.ts injection logic.
- `rg` not on the daemon's PATH → tool returns `engine_unavailable`.
- Worktree was torn down before smoke completed → tool returns `unknown_handoff`.

- [ ] **Step 6: Append outcome to `docs/superpowers/notes/agent-performance.md`**

Add a row capturing: agent (claude-acp-sonnet), task_type (substantial_impl smoke for 1b.2), dispatch_id, outcome (passed/failed), latency, notes.

- [ ] **Step 7: Update memory**

Add a `memory_observe` for the smoke result (mirror Phase 1b.1's pattern). Suggested observation type: 🟣 if the smoke passed (Phase 1b.2 shipped), 🔴 if it failed (with diagnosis).

---

## Verification — does the plan cover the spec?

| Spec section / decision | Task |
|---|---|
| Decision 1: handoff_id-scoped tool args + env default | Task 5 (handler), Task 7 (env injection) |
| Decision 2: thin β API surface (pattern, path, glob, output_mode, case_insensitive, max_results, include_ignored) | Task 5 (zod input shapes) |
| Decision 3: hybrid engine (Bun.Glob + rg --json) | Tasks 2 (glob), 3 (grep) |
| Decision 4: no new permission gate; inherit Phase 1a opt-in | (no task — by design, just don't add gating) |
| Decision 5: soft default + ceiling + truncated flag + .gitignore | Tasks 2 (glob caps + ignore), 3 (grep caps + --no-ignore) |
| Architecture layer 1: MCP tools | Tasks 5, 6 |
| Architecture layer 2: daemon HTTP routes | Task 4 |
| Architecture layer 3: search module | Tasks 2, 3 |
| Upstream wire: PENUMBRA_HANDOFF_ID env injection | Task 7 |
| Shared path-validation refactor | Task 1 |
| Error model: unknown_handoff, no_handoff_context, outside_worktree, engine_unavailable, bad_pattern | Tasks 4 (route errors), 5 (handler errors), 3 (engine_unavailable / bad_pattern) |
| Testing: fs-paths, fs-search, routes-fs, fs-glob handler, fs-grep handler, stdio-acp injection | Tasks 1, 2, 3, 4, 5, 7 |
| Maestro smoke (separate scope) | Task 9 |

## Estimated effort

| Task | Effort |
|---|---|
| 1 — Extract `resolveInsideWorktree` + tests | 30 min |
| 2 — `executeGlob` + 9 tests + ignore dep | 1.5 h |
| 3 — `executeGrep` + 9 tests | 2 h |
| 4 — HTTP routes + 5 tests | 1 h |
| 5 — DaemonClient methods + tool handlers + 8 tests | 1 h |
| 6 — Register tools in server.ts | 15 min |
| 7 — DispatchInput threading + stdio-acp injection + 1 test | 45 min |
| 8 — Cross-sweep + final commit | 15 min |
| **Total implementer scope** | **~7 hours focused work** |
| 9 — Maestro smoke | 30–45 min (separate scope) |

Aligned with the spec's 6–7 hour estimate; ~1 day with breaks. Total tests added: ~30 (5 fs-paths + 18 fs-search + 5 routes-fs + 8 tool + 1 stdio-acp).
