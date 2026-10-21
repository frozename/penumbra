import {
  buildServices,
  loadSqliteVec,
  migrate,
  type Services,
  type WorktreeHandle,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chainsStartRoute } from "@src/routes/chains.js";
import {
  worktreesCleanupRoute,
  worktreesInspectRoute,
  worktreesListRoute,
} from "@src/routes/worktrees.js";

import {
  createInspectionWorktree,
  createWorktreeInspectionHarness,
  gitOutput,
  seedInspectionHandoff,
  type WorktreeInspectionHarness,
} from "../helpers/worktree-inspection.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch (err) {
  void err;
}

// strict-mode env can leak from a live maestro shell; clear it here so test fixtures stay deterministic
beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

interface WorktreeListBody {
  worktrees: WorktreeHandle[];
}

interface WorktreeInspectBody {
  worktree?: WorktreeHandle;
  diff_against_main: string;
  branch_log: string;
  head_sha: string;
  branch_name: string;
  base_ref: string;
  base_fallback: boolean;
  base_attempted_ref: string;
  base_fallback_reason: string | null;
  dirty: boolean;
  truncation: {
    diff_against_main: boolean;
    branch_log: boolean;
    total: boolean;
  };
}

interface WorktreeCleanupBody {
  status: string;
}

interface ChainsStartBody {
  handoff_id: string;
}

interface ErrorBody {
  error: { code?: string; message?: string } | string;
  hint?: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const BASE_CHAIN_LIMIT = 16;

function commitFeatureBase(harness: WorktreeInspectionHarness): void {
  gitOutput(harness, harness.repoRoot, ["checkout", "-b", "feature/base"]);
  writeFileSync(join(harness.repoRoot, "feature-only.txt"), "feature only\n");
  gitOutput(harness, harness.repoRoot, ["add", "feature-only.txt"]);
  gitOutput(harness, harness.repoRoot, ["commit", "-m", "feature only"]);
  gitOutput(harness, harness.repoRoot, ["checkout", "main"]);
}

// Seeds `links` same-project handoffs chain/1 -> chain/2 -> ... -> root and returns the
// head of the chain. Only chain/1 exists in Git, because it seeds the inspected worktree.
function seedOwnedBaseChain(
  harness: WorktreeInspectionHarness,
  links: number,
  root: string,
): string {
  for (let link = 1; link <= links; link += 1) {
    seedInspectionHandoff(harness.services, {
      handoffId: `00000000-0000-4000-8000-${String(link).padStart(12, "0")}`,
      projectId: "project-a",
      branchName: `chain/${String(link)}`,
      branchBase: link === links ? root : `chain/${String(link + 1)}`,
    });
  }
  gitOutput(harness, harness.repoRoot, ["branch", "chain/1", root]);
  return "chain/1";
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/worktrees-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: () => `id-${String(++n)}`,
    agentRegistry: ["gemini"],
  });
  services.watchdog = {
    recordHeartbeat: (): void => {
      /* no-op */
    },
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  return services;
}

test("worktree.list with no worktrees", async () => {
  const services = tempServices();
  spyOn(services.worktreeManager, "listWorktrees").mockReturnValue([]);

  const res = worktreesListRoute(new Request("http://h/worktrees"), services);
  expect(res.status).toBe(200);
  const body = await readJson<WorktreeListBody>(res);
  expect(body).toEqual({ worktrees: [] });
});

test("worktree.list returns tracked worktrees", async () => {
  const services = tempServices();
  const handle: WorktreeHandle = {
    handoffId: "h1",
    path: "/tmp/wt1",
    branchName: "agent/h1",
    storageRoot: "/tmp/wt1/.test-storage",
    createdAt: "2026-04-26T00:00:00Z",
    status: "created",
    worktreeMode: "symlink_mirror",
  };
  spyOn(services.worktreeManager, "listWorktrees").mockReturnValue([handle]);

  const res = worktreesListRoute(new Request("http://h/worktrees"), services);
  const body = await readJson<WorktreeListBody>(res);
  expect(body.worktrees).toHaveLength(1);
  expect(body.worktrees[0]?.handoffId).toBe("h1");
});

test("worktree.inspect returns 404 if not found", async () => {
  const services = tempServices();
  spyOn(services.worktreeManager, "getWorktree").mockReturnValue(null);

  const res = await worktreesInspectRoute(new Request("http://h/worktrees/h1"), "h1", services);
  expect(res.status).toBe(404);
  const body = await readJson<ErrorBody>(res);
  const err = body.error;
  expect(typeof err === "object" ? err.code : err).toBe("not_found");
});

test("worktree.inspect returns a measured immutable candidate snapshot", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    const head = gitOutput(handle.path, ["rev-parse", "HEAD"]).trim();

    expect(body).toMatchObject({
      worktree: handle,
      head_sha: head,
      branch_name: handle.branchName,
      dirty: false,
      truncation: {
        diff_against_main: false,
        branch_log: false,
        total: false,
      },
    });
    expect(body.head_sha).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    expect(body.diff_against_main).toContain("candidate.txt");
    expect(body.branch_log).toContain("candidate");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect diffs against the handoff branch_base, not main", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    gitOutput(harness, harness.repoRoot, ["checkout", "-b", "feature/base"]);
    writeFileSync(join(harness.repoRoot, "feature-only.txt"), "feature only\n");
    gitOutput(harness, harness.repoRoot, ["add", "feature-only.txt"]);
    gitOutput(harness, harness.repoRoot, ["commit", "-m", "feature only"]);
    gitOutput(harness, harness.repoRoot, ["checkout", "main"]);

    const handle = await createInspectionWorktree(harness, { branchBase: "feature/base" });
    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("feature/base");
    expect(body.diff_against_main).toContain("candidate.txt");
    expect(body.diff_against_main).not.toContain("feature-only.txt");
    expect(body.branch_log).toContain("candidate");
    expect(body.branch_log).not.toContain("feature only");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect of a later round diffs against the first round's base", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    gitOutput(harness, harness.repoRoot, ["checkout", "-b", "feature/base"]);
    writeFileSync(join(harness.repoRoot, "feature-only.txt"), "feature only\n");
    gitOutput(harness, harness.repoRoot, ["add", "feature-only.txt"]);
    gitOutput(harness, harness.repoRoot, ["commit", "-m", "feature only"]);
    gitOutput(harness, harness.repoRoot, ["checkout", "main"]);

    await createInspectionWorktree(harness, {
      handoffId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      branchBase: "feature/base",
    });
    const handleB = await createInspectionWorktree(harness, {
      handoffId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      branchBase: "agent/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      commit: false,
    });
    writeFileSync(join(handleB.path, "round-two.txt"), "round two\n");
    gitOutput(harness, handleB.path, ["add", "round-two.txt"]);
    gitOutput(harness, handleB.path, ["commit", "-m", "round two"]);

    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handleB.handoffId}`),
      handleB.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("feature/base");
    expect(body.base_fallback).toBe(false);
    expect(body.base_fallback_reason).toBeNull();
    expect(body.base_attempted_ref).toBe("feature/base");
    expect(body.diff_against_main).toContain("round-two.txt");
    expect(body.diff_against_main).toContain("candidate.txt");
    expect(body.diff_against_main).not.toContain("feature-only.txt");
    expect(body.branch_log).toContain("round two");
    expect(body.branch_log).toContain("candidate");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect falls back to main when the base branch was deleted", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    gitOutput(harness, harness.repoRoot, ["checkout", "-b", "feature/base"]);
    writeFileSync(join(harness.repoRoot, "feature-only.txt"), "feature only\n");
    gitOutput(harness, harness.repoRoot, ["add", "feature-only.txt"]);
    gitOutput(harness, harness.repoRoot, ["commit", "-m", "feature only"]);
    gitOutput(harness, harness.repoRoot, ["checkout", "main"]);

    const handle = await createInspectionWorktree(harness, { branchBase: "feature/base" });
    gitOutput(harness, harness.repoRoot, ["branch", "-D", "feature/base"]);

    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("main");
    expect(body.base_fallback).toBe(true);
    expect(body.base_fallback_reason).toBe("unresolvable");
    expect(body.base_attempted_ref).toBe("feature/base");
    expect(body.diff_against_main).toContain("candidate.txt");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect treats a null branch_base as main", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness, { branchBase: null });
    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("main");
    expect(body.base_fallback).toBe(false);
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect never uses HEAD as the base", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness, { branchBase: "HEAD" });
    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("main");
    expect(body.base_fallback).toBe(true);
    expect(body.base_fallback_reason).toBe("rejected_ref");
    expect(body.base_attempted_ref).toBe("HEAD");
    expect(body.diff_against_main).toContain("candidate.txt");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect follows a deleted intermediate handoff branch to the root base", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    gitOutput(harness, harness.repoRoot, ["checkout", "-b", "feature/base"]);
    writeFileSync(join(harness.repoRoot, "feature-only.txt"), "feature only\n");
    gitOutput(harness, harness.repoRoot, ["add", "feature-only.txt"]);
    gitOutput(harness, harness.repoRoot, ["commit", "-m", "feature only"]);
    gitOutput(harness, harness.repoRoot, ["checkout", "main"]);

    const handleA = await createInspectionWorktree(harness, {
      handoffId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      branchBase: "feature/base",
    });
    const handleB = await createInspectionWorktree(harness, {
      handoffId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      branchBase: handleA.branchName,
      commit: false,
    });
    writeFileSync(join(handleB.path, "round-two.txt"), "round two\n");
    gitOutput(harness, handleB.path, ["add", "round-two.txt"]);
    gitOutput(harness, handleB.path, ["commit", "-m", "round two"]);

    gitOutput(harness, harness.repoRoot, ["worktree", "remove", "--force", handleA.path]);
    gitOutput(harness, harness.repoRoot, ["branch", "-D", handleA.branchName]);

    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handleB.handoffId}`),
      handleB.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("feature/base");
    expect(body.base_fallback).toBe(false);
    expect(body.base_fallback_reason).toBeNull();
    expect(body.base_attempted_ref).toBe("feature/base");
    expect(body.diff_against_main).toContain("round-two.txt");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect ignores a base owner from another project", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    gitOutput(harness, harness.repoRoot, ["checkout", "-b", "other/branch"]);
    writeFileSync(join(harness.repoRoot, "other.txt"), "other project\n");
    gitOutput(harness, harness.repoRoot, ["add", "other.txt"]);
    gitOutput(harness, harness.repoRoot, ["commit", "-m", "other project"]);
    gitOutput(harness, harness.repoRoot, ["checkout", "main"]);

    seedInspectionHandoff(harness.services, {
      handoffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      projectId: "project-b",
      branchName: "other/branch",
    });
    const handleB = await createInspectionWorktree(harness, { branchBase: "other/branch" });

    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handleB.handoffId}`),
      handleB.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("other/branch");
    expect(body.base_fallback).toBe(false);
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect falls back to main when the base chain cycles", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    gitOutput(harness, harness.repoRoot, ["checkout", "-b", "loop/x"]);
    gitOutput(harness, harness.repoRoot, ["checkout", "main"]);

    seedInspectionHandoff(harness.services, {
      handoffId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      projectId: "project-a",
      branchName: "loop/x",
      branchBase: "loop/y",
    });
    seedInspectionHandoff(harness.services, {
      handoffId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      projectId: "project-a",
      branchName: "loop/y",
      branchBase: "loop/x",
    });
    const handleB = await createInspectionWorktree(harness, { branchBase: "loop/x" });

    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handleB.handoffId}`),
      handleB.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("main");
    expect(body.base_fallback).toBe(true);
    expect(body.base_fallback_reason).toBe("chain_limit");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect follows a base chain of exactly the chain limit to its root", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    commitFeatureBase(harness);
    const branchBase = seedOwnedBaseChain(harness, BASE_CHAIN_LIMIT, "feature/base");
    const handle = await createInspectionWorktree(harness, { branchBase });

    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("feature/base");
    expect(body.base_fallback).toBe(false);
    expect(body.base_fallback_reason).toBeNull();
    expect(body.base_attempted_ref).toBe("feature/base");
    expect(body.diff_against_main).toContain("candidate.txt");
    expect(body.diff_against_main).not.toContain("feature-only.txt");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect falls back to main when a non-cycling base chain exceeds the limit", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    commitFeatureBase(harness);
    const branchBase = seedOwnedBaseChain(harness, BASE_CHAIN_LIMIT + 1, "feature/base");
    const handle = await createInspectionWorktree(harness, { branchBase });

    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("main");
    expect(body.base_fallback).toBe(true);
    expect(body.base_fallback_reason).toBe("chain_limit");
    expect(body.base_attempted_ref).toBe(`chain/${String(BASE_CHAIN_LIMIT + 1)}`);
    expect(body.diff_against_main).toContain("candidate.txt");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect falls back to main when a base handoff is its own branch_base", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    gitOutput(harness, harness.repoRoot, ["branch", "loop/self", "main"]);
    seedInspectionHandoff(harness.services, {
      handoffId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      projectId: "project-a",
      branchName: "loop/self",
      branchBase: "loop/self",
    });
    const handle = await createInspectionWorktree(harness, { branchBase: "loop/self" });

    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);
    expect(body.base_ref).toBe("main");
    expect(body.base_fallback).toBe(true);
    expect(body.base_fallback_reason).toBe("chain_limit");
    expect(body.base_attempted_ref).toBe("loop/self");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect names only the refs it passed to rev-parse when no base resolves", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    gitOutput(harness, harness.repoRoot, ["branch", "loop/self", "main"]);
    gitOutput(harness, harness.repoRoot, ["branch", "feature/gone", "main"]);
    seedInspectionHandoff(harness.services, {
      handoffId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      projectId: "project-a",
      branchName: "loop/self",
      branchBase: "loop/self",
    });
    const cases = [
      { handle: await createInspectionWorktree(harness), tried: "main" },
      {
        handle: await createInspectionWorktree(harness, {
          handoffId: "abababab-abab-4bab-8bab-abababababab",
          branchBase: "HEAD",
        }),
        tried: "main",
      },
      {
        handle: await createInspectionWorktree(harness, {
          handoffId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
          branchBase: "loop/self",
        }),
        tried: "main",
      },
      {
        handle: await createInspectionWorktree(harness, {
          handoffId: "efefefef-efef-4fef-8fef-efefefefefef",
          branchBase: "feature/gone",
        }),
        tried: "feature/gone, main",
      },
    ];
    gitOutput(harness, harness.repoRoot, ["branch", "-D", "feature/gone"]);
    gitOutput(harness, harness.repoRoot, ["branch", "-m", "main", "trunk"]);

    for (const { handle, tried } of cases) {
      const res = await worktreesInspectRoute(
        new Request(`http://h/worktrees/${handle.handoffId}`),
        handle.handoffId,
        harness.services,
      );
      expect(res.status).toBe(500);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toEqual({
        code: "inspection_failed",
        message: `no inspection base resolves (tried ${tried})`,
      });
    }
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect includes relevant untracked files but filters framework symlinks", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness, { commit: false });
    writeFileSync(join(handle.path, "acp-promotion-smoke.txt"), "ACP_WRITE_OK");
    writeFileSync(join(handle.path, "node_modules"), "framework symlink placeholder");

    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<WorktreeInspectBody>(res);

    expect(body.diff_against_main).toContain("?? acp-promotion-smoke.txt");
    expect(body.diff_against_main).not.toContain("node_modules");
  } finally {
    harness.cleanup();
  }
});

test("worktree.inspect rejects untrusted paths without shell interpretation", async () => {
  const services = tempServices();
  const dir = mkdtempSync(join(tmpdir(), "worktree-inspect-injection-"));
  const canarySemi = join(tmpdir(), `worktree-inspect-canary-semi-${String(Date.now())}`);
  const canarySubst = join(tmpdir(), `worktree-inspect-canary-subst-${String(Date.now())}`);
  const canaries: readonly string[] = [canarySemi, canarySubst];

  try {
    seedInspectionHandoff(services, {
      handoffId: "h-injection",
      projectId: "project-a",
      branchName: "agent/h-injection",
    });
    const variants = [`worktree; touch ${canarySemi}`, `worktree-$(touch ${canarySubst})`];

    for (const variant of variants) {
      const handle: WorktreeHandle = {
        handoffId: "h-injection",
        path: join(dir, variant),
        branchName: "agent/h-injection",
        storageRoot: join(dir, ".test-storage"),
        createdAt: "2026-04-26T00:00:00Z",
        status: "created",
        projectId: "project-a",
        worktreeMode: "symlink_mirror",
      };
      spyOn(services.worktreeManager, "getWorktree").mockReturnValue(handle);

      const res = await worktreesInspectRoute(
        new Request("http://h/worktrees/h-injection"),
        "h-injection",
        services,
      );
      expect(res.status).toBe(500);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error === "object" ? body.error.code : body.error).toBe(
        "inspection_failed",
      );
      if (typeof body.error === "string") throw new Error("expected structured inspection error");
      expect(body.error.message).toContain("ENOENT");
    }

    expect(canaries.every((file) => !existsSync(file))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const file of canaries) rmSync(file, { force: true });
  }
});

test("worktree.cleanup calls manager", async () => {
  const services = tempServices();
  const handle: WorktreeHandle = {
    handoffId: "h1",
    path: "/tmp/wt1",
    branchName: "agent/h1",
    storageRoot: "/tmp/wt1/.test-storage",
    createdAt: "2026-04-26T00:00:00Z",
    status: "created",
    worktreeMode: "symlink_mirror",
  };
  spyOn(services.worktreeManager, "getWorktree").mockReturnValue(handle);
  const teardownSpy = spyOn(services.worktreeManager, "teardownWorktree").mockResolvedValue(
    undefined,
  );

  const res = await worktreesCleanupRoute(
    new Request("http://h/worktrees/h1/cleanup?force=true"),
    "h1",
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJson<WorktreeCleanupBody>(res);
  expect(body.status).toBe("torn_down");
  expect(teardownSpy).toHaveBeenCalledWith("h1", true);
});

test("chain.start respects use_worktree: false", async () => {
  const services = tempServices();
  const req = new Request("http://h/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "gemini",
      message: "hello",
      use_worktree: false,
    }),
  });

  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const { handoff_id } = await readJson<ChainsStartBody>(res);

  // Assert the persisted storage shape directly: sqlite stores booleans as 0/1.
  // Going through handoffReader.get would read the column via HandoffRow's
  // `boolean | null` type, which is a runtime lie — no normalization happens.
  const stored = services.db
    .query<
      { use_worktree: number | null },
      [string]
    >("SELECT use_worktree FROM handoffs WHERE handoff_id = ?")
    .get(handoff_id);
  expect(stored?.use_worktree).toBe(0);
});

test("chain.start respects use_worktree: true", async () => {
  const services = tempServices();
  const req = new Request("http://h/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "gemini",
      message: "hello",
      use_worktree: true,
    }),
  });

  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const { handoff_id } = await readJson<ChainsStartBody>(res);

  const stored = services.db
    .query<
      { use_worktree: number | null },
      [string]
    >("SELECT use_worktree FROM handoffs WHERE handoff_id = ?")
    .get(handoff_id);
  expect(stored?.use_worktree).toBe(1);
});

test("chain.start rejects when use_worktree is omitted (strict project_id gate)", async () => {
  const prior = process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  try {
    const services = tempServices();
    const req = new Request("http://h/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "gemini",
        message: "hello",
      }),
    });

    const res = await chainsStartRoute(req, services);
    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(body).toEqual({
      error: "project_id_required",
      hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
    });
  } finally {
    if (prior === undefined) delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = prior;
  }
});
