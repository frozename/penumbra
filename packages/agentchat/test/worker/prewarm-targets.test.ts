import { describe, expect, test } from "bun:test";

import { computePrewarmTargets } from "../../src/worker/prewarm-targets.js";

/**
 * Phase 1 — pure eligible-tuple resolver. No subprocesses; provably a subset of
 * what the daemon would route to this worker, bounded by `cap`.
 */

const resolveProjectRoot = (projectId?: string): string | undefined => {
  const map: Record<string, string> = {
    penumbra: "/repos/penumbra",
    omlx: "/repos/omlx",
  };
  return projectId ? map[projectId] : undefined;
};
const mainRepoPath = "/repos/penumbra";

const agent = (
  name: string,
  options: Record<string, unknown>,
): { name: string; options: Record<string, unknown> } => ({ name, options });

describe("computePrewarmTargets", () => {
  test("(a) includes only agents opted into BOTH warm_pool and warm_pool_prewarm", () => {
    const agents = [
      agent("a-both", { warm_pool: true, warm_pool_prewarm: true }),
      agent("b-warm-only", { warm_pool: true }),
      agent("c-prewarm-only", { warm_pool_prewarm: true }),
      agent("d-none", {}),
    ];
    const out = computePrewarmTargets({
      agents,
      isolation: "sticky",
      workerProjectId: "penumbra",
      resolveProjectRoot,
      mainRepoPath,
      cap: 10,
    });
    expect(out).toEqual([{ agent: "a-both", repoRoot: "/repos/penumbra", slot: 0 }]);
  });

  test("(b) hard worker yields tuples at its pinned project root", () => {
    const agents = [agent("x", { warm_pool: true, warm_pool_prewarm: true })];
    const out = computePrewarmTargets({
      agents,
      isolation: "hard",
      workerProjectId: "omlx",
      resolveProjectRoot,
      mainRepoPath,
      cap: 10,
    });
    expect(out).toEqual([{ agent: "x", repoRoot: "/repos/omlx", slot: 0 }]);
  });

  test("(c) sticky yields its home repoRoot; shared (no project) falls back to mainRepoPath", () => {
    const agents = [agent("x", { warm_pool: true, warm_pool_prewarm: true })];
    const sticky = computePrewarmTargets({
      agents,
      isolation: "sticky",
      workerProjectId: "omlx",
      resolveProjectRoot,
      mainRepoPath,
      cap: 10,
    });
    expect(sticky).toEqual([{ agent: "x", repoRoot: "/repos/omlx", slot: 0 }]);

    const shared = computePrewarmTargets({
      agents,
      isolation: "shared",
      workerProjectId: undefined,
      resolveProjectRoot,
      mainRepoPath,
      cap: 10,
    });
    expect(shared).toEqual([{ agent: "x", repoRoot: "/repos/penumbra", slot: 0 }]); // mainRepoPath fallback
  });

  test("(d) truncates to cap with stable (config) ordering", () => {
    const agents = [
      agent("a1", { warm_pool: true, warm_pool_prewarm: true }),
      agent("a2", { warm_pool: true, warm_pool_prewarm: true }),
      agent("a3", { warm_pool: true, warm_pool_prewarm: true }),
    ];
    const out = computePrewarmTargets({
      agents,
      isolation: "sticky",
      workerProjectId: "penumbra",
      resolveProjectRoot,
      mainRepoPath,
      cap: 2,
    });
    expect(out).toEqual([
      { agent: "a1", repoRoot: "/repos/penumbra", slot: 0 },
      { agent: "a2", repoRoot: "/repos/penumbra", slot: 0 },
    ]);
  });

  test("expands warm_pool_size into bounded per-agent slots", () => {
    const agents = [
      agent("premium", { warm_pool: true, warm_pool_prewarm: true, warm_pool_size: 3 }),
      agent("standard", { warm_pool: true, warm_pool_prewarm: true }),
    ];
    const out = computePrewarmTargets({
      agents,
      isolation: "sticky",
      workerProjectId: "penumbra",
      resolveProjectRoot,
      mainRepoPath,
      cap: 3,
    });

    expect(out).toEqual([
      { agent: "premium", repoRoot: "/repos/penumbra", slot: 0 },
      { agent: "premium", repoRoot: "/repos/penumbra", slot: 1 },
      { agent: "premium", repoRoot: "/repos/penumbra", slot: 2 },
    ]);
  });

  test("(e) empty when no agent opts in, and when cap <= 0", () => {
    const agents = [agent("a", { warm_pool: true }), agent("b", {})];
    expect(
      computePrewarmTargets({
        agents,
        isolation: "sticky",
        workerProjectId: "penumbra",
        resolveProjectRoot,
        mainRepoPath,
        cap: 10,
      }),
    ).toEqual([]);

    const opted = [agent("a", { warm_pool: true, warm_pool_prewarm: true })];
    expect(
      computePrewarmTargets({
        agents: opted,
        isolation: "sticky",
        workerProjectId: "penumbra",
        resolveProjectRoot,
        mainRepoPath,
        cap: 0,
      }),
    ).toEqual([]);
  });

  test("dedupes identical (agent, repoRoot) tuples", () => {
    const agents = [
      agent("dup", { warm_pool: true, warm_pool_prewarm: true }),
      agent("dup", { warm_pool: true, warm_pool_prewarm: true }),
    ];
    const out = computePrewarmTargets({
      agents,
      isolation: "sticky",
      workerProjectId: "penumbra",
      resolveProjectRoot,
      mainRepoPath,
      cap: 10,
    });
    expect(out).toEqual([{ agent: "dup", repoRoot: "/repos/penumbra", slot: 0 }]);
  });

  test("isolation-invariant property: result is bounded and repoRoot equals home across all isolation modes", () => {
    const agents = [
      agent("a1", { warm_pool: true, warm_pool_prewarm: true }),
      agent("a2", { warm_pool: true, warm_pool_prewarm: true }),
    ];
    for (const isolation of ["hard", "sticky", "shared"] as const) {
      for (const projectId of ["penumbra", "omlx", undefined]) {
        const out = computePrewarmTargets({
          agents,
          isolation,
          workerProjectId: projectId,
          resolveProjectRoot,
          mainRepoPath,
          cap: 5,
        });
        const home = resolveProjectRoot(projectId) ?? mainRepoPath;
        expect(out.length).toBeLessThanOrEqual(5);
        expect(out.every((t) => t.repoRoot === home)).toBe(true);
        expect(out.map((t) => t.agent)).toEqual(["a1", "a2"]); // stable order
      }
    }
  });

  test("exit gate: emitted repoRoot byte-equals the adapter poolScope (repoRoot ?? cwd) for the project", () => {
    // The adapter computes poolScope = opts.repoRoot ?? cwd (stdio-acp.ts:313), and
    // worktree-integration sets repoRoot = resolveProjectRoot(project_id) ?? mainRepoPath.
    // So a prewarm target's repoRoot must equal that exact value or reuse won't hit.
    const projectId = "penumbra";
    const agents = [agent("codex-acp-fast", { warm_pool: true, warm_pool_prewarm: true })];
    const out = computePrewarmTargets({
      agents,
      isolation: "sticky",
      workerProjectId: projectId,
      resolveProjectRoot,
      mainRepoPath,
      cap: 10,
    });
    const adapterPoolScope = resolveProjectRoot(projectId) ?? mainRepoPath;
    expect(out[0]!.repoRoot).toBe(adapterPoolScope);
  });
});
