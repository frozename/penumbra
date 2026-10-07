import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { emptyRecall, testWorkflowCtx } from "../_shared/test-helpers.js";
import {
  beginCheckoutTripwire,
  type ClassifyContext,
  classifyTargetSnapshots,
  defaultTripwireRunner,
  type HeadMove,
  resolveTripwireTargets,
  snapshotTarget,
  type TargetSnapshot,
  type TripwireRunner,
} from "./checkout-tripwire.js";
import { fn, type Input } from "./workflow.js";

const WELL_FORMED_SYNTHESIS = `Land as-is.

## Shared concerns
none - single persona

## Contradictions
none

## Severity-ranked findings
none

## Recommended actions
none

## Skipped/failed personas
none`;

const LONG_PERSONA_REVIEW = `${"review body ".repeat(40)}

\`\`\`json
{"findings": []}
\`\`\``;

const CLASSIFY_CTX: ClassifyContext = {
  reviewPaths: new Set(["src/reviewed.ts"]),
  outDirRel: ".penumbra/reviews/run-1",
  fleetWorktreeRoot: "/fleet/penumbra-worktrees",
};

function snap(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    head: "aaaaaaaabbbbbbbb",
    branch: "main",
    statusPaths: {},
    stashes: [],
    worktrees: ["/repo/main", "/fleet/penumbra-worktrees/existing-wt"],
    ...overrides,
  };
}

function classify(
  before: TargetSnapshot,
  after: TargetSnapshot,
  headMove: HeadMove = { kind: "same" },
  ctx: ClassifyContext = CLASSIFY_CTX,
): { verdict: "clean" | "drift" | "mutated"; deltas: string[] } {
  return classifyTargetSnapshots({ before, after, headMove, ctx });
}

describe("classifyTargetSnapshots", () => {
  test("identical snapshots are clean", () => {
    const before = snap();
    const result = classify(before, snap());
    expect(result.verdict).toBe("clean");
    expect(result.deltas).toEqual([]);
  });

  test("a changed branch is mutated", () => {
    const result = classify(snap({ branch: "main" }), snap({ branch: "wip" }));
    expect(result.verdict).toBe("mutated");
  });

  test("a detached HEAD is mutated", () => {
    const result = classify(snap({ branch: "main" }), snap({ branch: null }));
    expect(result.verdict).toBe("mutated");
  });

  test("HEAD moved to a non-descendant is mutated", () => {
    const result = classify(snap(), snap({ head: "cccccccc" }), { kind: "non_descendant" });
    expect(result.verdict).toBe("mutated");
  });

  test("new commits on HEAD reachable from no other ref are mutated", () => {
    const result = classify(snap(), snap({ head: "cccccccc" }), {
      kind: "advanced_local_only",
    });
    expect(result.verdict).toBe("mutated");
  });

  test("a fast-forward reachable from another ref is drift", () => {
    const result = classify(snap(), snap({ head: "cccccccc" }), {
      kind: "reachable_elsewhere",
    });
    expect(result.verdict).toBe("drift");
  });

  test("a new WIP stash on the before-branch is mutated", () => {
    const result = classify(
      snap(),
      snap({ stashes: [{ sha: "s1", subject: "WIP on main: aaaaaaaa init" }] }),
    );
    expect(result.verdict).toBe("mutated");
  });

  test("an On-branch stash is drift", () => {
    const result = classify(
      snap(),
      snap({ stashes: [{ sha: "s1", subject: "On main: parked work" }] }),
    );
    expect(result.verdict).toBe("drift");
  });

  test("a lint-staged backup stash is drift", () => {
    const result = classify(
      snap(),
      snap({ stashes: [{ sha: "s1", subject: "lint-staged automatic backup" }] }),
    );
    expect(result.verdict).toBe("drift");
  });

  test("a worktree added outside the fleet root is mutated", () => {
    const result = classify(
      snap(),
      snap({ worktrees: [...snap().worktrees, "/somewhere/else/wt"] }),
    );
    expect(result.verdict).toBe("mutated");
  });

  test("a worktree added inside the fleet root is drift", () => {
    const result = classify(
      snap(),
      snap({ worktrees: [...snap().worktrees, "/fleet/penumbra-worktrees/new-wt"] }),
    );
    expect(result.verdict).toBe("drift");
  });

  test("a status delta on a review path is mutated", () => {
    const result = classify(
      snap(),
      snap({ statusPaths: { "src/reviewed.ts": { size: 10, mtimeMs: 1 } } }),
    );
    expect(result.verdict).toBe("mutated");
  });

  test("a size/mtime delta on a review path is mutated", () => {
    const result = classify(
      snap({ statusPaths: { "src/reviewed.ts": { size: 10, mtimeMs: 1 } } }),
      snap({ statusPaths: { "src/reviewed.ts": { size: 10, mtimeMs: 2 } } }),
    );
    expect(result.verdict).toBe("mutated");
  });

  test("a status delta on a non-review path is drift", () => {
    const result = classify(
      snap(),
      snap({ statusPaths: { "docs/readme.md": { size: 10, mtimeMs: 1 } } }),
    );
    expect(result.verdict).toBe("drift");
  });

  test("deltas under the review out_dir are ignored", () => {
    const result = classify(
      snap(),
      snap({
        statusPaths: {
          ".penumbra/reviews/run-1/reviewer.json": { size: 10, mtimeMs: 1 },
          ".penumbra/": { size: 4096, mtimeMs: 2 },
        },
      }),
    );
    expect(result.verdict).toBe("clean");
    expect(result.deltas).toEqual([]);
  });
});

async function git(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", "-C", dir, ...args], stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-tripwire-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "tripwire@test"]);
  await git(dir, ["config", "user.name", "tripwire"]);
  await git(dir, ["config", "gc.auto", "0"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  await git(dir, ["add", "a.txt"]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
}

function makeReviewCtx(opts: {
  cwd: string;
  storageRoot: string;
  onPersonaWait?: () => Promise<void>;
}) {
  let dispatchCount = 0;
  return testWorkflowCtx<Input>({
    config: {
      workloads: {
        review_adversarial: {
          eligible_agents: ["reviewer"],
          synthesizer: "synth",
        },
      },
      personas: {
        reviewer: {
          bias: "Find correctness issues",
          system_prompt: "Review the change.",
          preferred_agent: "reviewer-agent",
        },
      },
    },
    cwd: opts.cwd,
    storageRoot: opts.storageRoot,
    project: "penumbra",
    args: {
      target_ref: "HEAD",
      base_ref: "main",
      timeout_ms: 1000,
      out_dir: "review-out",
    },
    dispatch: async () => {
      dispatchCount += 1;
      return {
        conversation_id: dispatchCount === 1 ? "persona-conv" : `synth-conv-${dispatchCount}`,
        handoff_id: `handoff-${dispatchCount}`,
      };
    },
    awaitChain: async (conversationId) => {
      if (conversationId === "persona-conv") {
        await opts.onPersonaWait?.();
        return {
          status: "completed" as const,
          final_agent: "reviewer-agent",
          response_text: LONG_PERSONA_REVIEW,
        };
      }
      return {
        status: "completed" as const,
        final_agent: "synth",
        response_text: WELL_FORMED_SYNTHESIS,
      };
    },
    fileWrite: async (path) => path,
  });
}

describe("checkout tripwire against a real repo", () => {
  for (const rootKind of ["project", "configured", "reconciler"] as const) {
    test(`a worktree added under the ${rootKind} root is drift`, async () => {
      const repo = await makeRepo();
      const realRepo = await realpath(repo);
      const configuredRoot = `${realRepo}-custom`;
      const prior = process.env.PENUMBRA_WORKTREE_ROOT;
      if (rootKind === "configured") process.env.PENUMBRA_WORKTREE_ROOT = configuredRoot;
      else delete process.env.PENUMBRA_WORKTREE_ROOT;
      let finishing = false;
      const root =
        rootKind === "reconciler"
          ? join(homedir(), ".penumbra", "rebase-scratch")
          : rootKind === "configured"
            ? configuredRoot
            : `${realRepo}-worktrees`;
      const runner: TripwireRunner = async (argv, opts) => {
        const result = await defaultTripwireRunner(argv, opts);
        if (finishing && argv.includes("worktree"))
          result.stdout += `\nworktree ${root}/new-fleet-seat\n`;
        return result;
      };
      try {
        const session = await beginCheckoutTripwire({
          cwd: repo,
          outDir: null,
          baseRef: "main",
          targetRef: "HEAD",
          runner,
        });
        finishing = true;
        expect((await session.finish()).verdict).toBe("drift");
      } finally {
        if (prior === undefined) delete process.env.PENUMBRA_WORKTREE_ROOT;
        else process.env.PENUMBRA_WORKTREE_ROOT = prior;
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  for (const command of ["rev-parse", "symbolic-ref", "status", "stash", "worktree"]) {
    test(`a failed ${command} snapshot in finish is unavailable`, async () => {
      const repo = await makeRepo();
      let finishing = false;
      const runner: TripwireRunner = (argv, opts) =>
        finishing && argv.includes(command)
          ? Promise.resolve({ code: 143, stdout: "", stderr: "timed out" })
          : defaultTripwireRunner(argv, opts);
      try {
        const session = await beginCheckoutTripwire({
          cwd: repo,
          outDir: null,
          baseRef: "main",
          targetRef: "HEAD",
          runner,
        });
        finishing = true;
        const report = await session.finish();
        expect(report.verdict).toBe("unavailable");
        expect(report.reason).toContain("snapshot failed");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  test("a slow git call in finish is unavailable", async () => {
    const repo = await makeRepo();
    let finishing = false;
    const runner: TripwireRunner = (argv, opts) =>
      defaultTripwireRunner(
        finishing && argv.includes("status") ? ["bun", "-e", "await Bun.sleep(2000)"] : argv,
        opts,
      );
    try {
      const session = await beginCheckoutTripwire({
        cwd: repo,
        outDir: null,
        baseRef: "main",
        targetRef: "HEAD",
        runner,
        perCallTimeoutMs: 400,
      });
      finishing = true;
      expect((await session.finish()).verdict).toBe("unavailable");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("finish has a fresh budget after a review longer than fifteen seconds", async () => {
    const repo = await makeRepo();
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const finishTimeouts: number[] = [];
    let finishing = false;
    const runner: TripwireRunner = (argv, opts) => {
      if (finishing) finishTimeouts.push(opts.timeoutMs);
      return defaultTripwireRunner(argv, opts);
    };
    try {
      const session = await beginCheckoutTripwire({
        cwd: repo,
        outDir: null,
        baseRef: "main",
        targetRef: "HEAD",
        runner,
      });
      clock.mockReturnValue(now + 20_000);
      finishing = true;
      expect((await session.finish()).verdict).toBe("clean");
      expect(finishTimeouts).toHaveLength(5);
      expect(finishTimeouts.every((timeout) => timeout === 4_000)).toBe(true);
    } finally {
      clock.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("symbolic-ref exit one still means detached HEAD", async () => {
    const repo = await makeRepo();
    try {
      await git(repo, ["checkout", "--detach"]);
      const snapshot = await snapshotTarget(repo, defaultTripwireRunner, 5_000);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.branch).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  test("snapshot uses --no-optional-locks and leaves .git/index untouched", async () => {
    const repo = await makeRepo();
    try {
      const indexPath = join(repo, ".git", "index");
      const before = statSync(indexPath).mtimeMs;
      const snapshot = await snapshotTarget(repo, defaultTripwireRunner, 5_000);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.head).not.toBeNull();
      expect(statSync(indexPath).mtimeMs).toBe(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("from a linked worktree both the worktree and the main checkout are targets", async () => {
    const repo = await makeRepo();
    const wt = `${repo}-linked`;
    try {
      await git(repo, ["worktree", "add", wt, "-b", "linked-branch"]);
      const resolved = await resolveTripwireTargets(wt, defaultTripwireRunner, 5_000);
      expect(resolved).not.toBeNull();
      const [realWt, realMain] = await Promise.all([realpath(wt), realpath(repo)]);
      expect(resolved?.targets).toContain(realWt);
      expect(resolved?.targets).toContain(realMain);
      expect(resolved?.mainCheckout).toBe(realMain);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("a stash created during the window is mutated", async () => {
    const repo = await makeRepo();
    try {
      const session = await beginCheckoutTripwire({
        cwd: repo,
        outDir: null,
        baseRef: "main",
        targetRef: "HEAD",
      });
      writeFileSync(join(repo, "a.txt"), "dirty\n");
      await git(repo, ["stash"]);
      const report = await session.finish();
      expect(report.verdict).toBe("mutated");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a fast-forward commit reachable from another ref is drift", async () => {
    const repo = await makeRepo();
    try {
      const session = await beginCheckoutTripwire({
        cwd: repo,
        outDir: null,
        baseRef: "main",
        targetRef: "HEAD",
      });
      for (let i = 0; i < 55; i++) await git(repo, ["branch", `a-${i}`]);
      await git(repo, ["checkout", "-b", "z-landable"]);
      writeFileSync(join(repo, "b.txt"), "new\n");
      await git(repo, ["add", "b.txt"]);
      await git(repo, ["commit", "-m", "landable work"]);
      await git(repo, ["checkout", "main"]);
      await git(repo, ["merge", "--ff-only", "z-landable"]);
      const report = await session.finish();
      expect(report.verdict).toBe("drift");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a local pull --ff-only reachable only from a remote ref is drift", async () => {
    const origin = await makeRepo();
    const repo = `${origin}-clone`;
    try {
      await git(origin, ["clone", origin, repo]);
      const session = await beginCheckoutTripwire({
        cwd: repo,
        outDir: null,
        baseRef: "main",
        targetRef: "HEAD",
      });
      writeFileSync(join(origin, "a.txt"), "pulled\n");
      await git(origin, ["commit", "-am", "upstream work"]);
      await git(repo, ["pull", "--ff-only"]);
      expect((await session.finish()).verdict).toBe("drift");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    }
  });

  for (const land of ["during", "before", "other-project"] as const) {
    test(`a squash land with deleted branch and ${land} event is ${land === "during" ? "drift" : "mutated"}`, async () => {
      const repo = await makeRepo();
      const db = new Database(":memory:");
      db.exec(
        "CREATE TABLE t0_events (ts TEXT, project_id TEXT, event_type TEXT, source_detail TEXT, payload_json TEXT)",
      );
      try {
        const ctx = makeReviewCtx({
          cwd: repo,
          storageRoot: join(repo, ".store"),
          onPersonaWait: async () => {
            await git(repo, ["checkout", "-b", "squash-source"]);
            writeFileSync(join(repo, "b.txt"), "new\n");
            await git(repo, ["add", "b.txt"]);
            await git(repo, ["commit", "-m", "fleet work"]);
            await git(repo, ["checkout", "main"]);
            await git(repo, ["merge", "--squash", "squash-source"]);
            await git(repo, ["commit", "-m", "land fleet work"]);
            await git(repo, ["branch", "-D", "squash-source"]);
            const sha = (await git(repo, ["rev-parse", "HEAD"])).trim();
            db.query(
              "INSERT INTO t0_events VALUES (?, ?, 'dispatch.landed', 'dispatch-land', ?)",
            ).run(
              land === "before" ? "2000-01-01T00:00:00.000Z" : new Date().toISOString(),
              land === "other-project" ? "other" : "penumbra",
              JSON.stringify({ commit_sha: sha, mode: "squash" }),
            );
          },
        });
        ctx.db = () => db;
        const result = (await fn(
          ctx,
          emptyRecall({ byKey: { "git.diff": "diff --git a/a.ts b/a.ts\n+changed\n" } }),
        )) as {
          ok: boolean;
          outcome: string;
          warnings?: string[];
          home_checkout_tripwire?: { verdict: string };
        };
        expect(result.ok).toBe(true);
        expect(result.outcome).toBe("success");
        expect(result.warnings ?? []).toEqual([]);
        expect(result.home_checkout_tripwire?.verdict).toBe(
          land === "during" ? "drift" : "mutated",
        );
      } finally {
        db.close();
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  test("a commit reachable from no other ref is mutated", async () => {
    const repo = await makeRepo();
    try {
      const session = await beginCheckoutTripwire({
        cwd: repo,
        outDir: null,
        baseRef: "main",
        targetRef: "HEAD",
      });
      writeFileSync(join(repo, "b.txt"), "new\n");
      await git(repo, ["add", "b.txt"]);
      await git(repo, ["commit", "-m", "persona commit"]);
      const report = await session.finish();
      expect(report.verdict).toBe("mutated");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a non-repo cwd yields unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-tripwire-norepo-"));
    try {
      const session = await beginCheckoutTripwire({
        cwd: dir,
        outDir: null,
        baseRef: "main",
        targetRef: "HEAD",
      });
      const report = await session.finish();
      expect(report.verdict).toBe("unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adversarial-review home checkout tripwire", () => {
  test("a diff review path change is recorded without changing the outcome", async () => {
    const repo = await makeRepo();
    try {
      await git(repo, ["checkout", "-b", "reviewed"]);
      writeFileSync(join(repo, "a.txt"), "reviewed change\n");
      await git(repo, ["commit", "-am", "reviewed change"]);
      const ctx = makeReviewCtx({
        cwd: repo,
        storageRoot: join(repo, ".store"),
        onPersonaWait: async () => {
          writeFileSync(join(repo, "a.txt"), "persona edit\n");
        },
      });
      const result = (await fn(
        ctx,
        emptyRecall({ byKey: { "git.diff": "diff --git a/a.txt b/a.txt\n+changed\n" } }),
      )) as {
        ok: boolean;
        outcome: string;
        warnings?: string[];
        home_checkout_tripwire?: { verdict: string; deltas: string[] };
      };
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("success");
      expect(result.warnings ?? []).toEqual([]);
      expect(result.home_checkout_tripwire?.verdict).toBe("mutated");
      expect(
        result.home_checkout_tripwire?.deltas.some((delta) =>
          delta.includes("review path changed: a.txt"),
        ),
      ).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a failed finish snapshot is unavailable and leaves the review successful", async () => {
    const repo = await makeRepo();
    try {
      const ctx = makeReviewCtx({
        cwd: repo,
        storageRoot: join(repo, ".store"),
        onPersonaWait: async () => {
          writeFileSync(join(repo, ".git", "HEAD"), "invalid head\n");
        },
      });
      const result = (await fn(
        ctx,
        emptyRecall({ byKey: { "git.diff": "diff --git a/a.ts b/a.ts\n+changed\n" } }),
      )) as {
        ok: boolean;
        outcome: string;
        warnings?: string[];
        home_checkout_tripwire?: { verdict: string; reason?: string };
      };
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("success");
      expect(result.warnings ?? []).toEqual([]);
      expect(result.home_checkout_tripwire?.verdict).toBe("unavailable");
      expect(result.home_checkout_tripwire?.reason).toContain("snapshot failed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  test("a persona git stash keeps the outcome but marks the result mutated", async () => {
    const repo = await makeRepo();
    try {
      const ctx = makeReviewCtx({
        cwd: repo,
        storageRoot: join(repo, ".store"),
        onPersonaWait: async () => {
          writeFileSync(join(repo, "a.txt"), "dirty\n");
          await git(repo, ["stash"]);
        },
      });
      const recall = emptyRecall({
        byKey: { "git.diff": "diff --git a/a.ts b/a.ts\n+changed\n" },
      });
      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        outcome: string;
        warnings?: string[];
        home_checkout_tripwire?: { verdict: string; deltas: string[] };
      };
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("success");
      expect(result.home_checkout_tripwire?.verdict).toBe("mutated");
      expect(result.warnings ?? []).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a persona branch switch keeps the outcome but marks the result mutated", async () => {
    const repo = await makeRepo();
    try {
      const ctx = makeReviewCtx({
        cwd: repo,
        storageRoot: join(repo, ".store"),
        onPersonaWait: async () => {
          await git(repo, ["checkout", "-b", "side-wip"]);
        },
      });
      const recall = emptyRecall({
        byKey: { "git.diff": "diff --git a/a.ts b/a.ts\n+changed\n" },
      });
      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        outcome: string;
        home_checkout_tripwire?: { verdict: string };
      };
      expect(result.ok).toBe(true);
      expect(result.home_checkout_tripwire?.verdict).toBe("mutated");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a clean run reports a clean tripwire", async () => {
    const repo = await makeRepo();
    try {
      const ctx = makeReviewCtx({ cwd: repo, storageRoot: join(repo, ".store") });
      const recall = emptyRecall({
        byKey: { "git.diff": "diff --git a/a.ts b/a.ts\n+changed\n" },
      });
      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        home_checkout_tripwire?: { verdict: string };
      };
      expect(result.ok).toBe(true);
      expect(result.home_checkout_tripwire?.verdict).toBe("clean");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a non-repo cwd reports unavailable without touching warnings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-review-norepo-"));
    try {
      const ctx = makeReviewCtx({ cwd: dir, storageRoot: join(dir, ".store") });
      const recall = emptyRecall({
        byKey: { "git.diff": "diff --git a/a.ts b/a.ts\n+changed\n" },
      });
      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        warnings?: string[];
        home_checkout_tripwire?: { verdict: string };
      };
      expect(result.ok).toBe(true);
      expect(result.home_checkout_tripwire?.verdict).toBe("unavailable");
      expect(result.warnings ?? []).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
