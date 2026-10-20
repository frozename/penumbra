import { createLogger, type HandoffRow, WorktreeManager } from "@penumbra/core";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createMergeReconciler, type ReconcilerVerdict } from "@src/worker/merge-reconciler.js";

const execFileAsync = promisify(execFile);

function makeHandoffRow(overrides: Partial<HandoffRow> = {}): HandoffRow {
  const base = {
    handoff_id: "h1",
    ts: "2026-04-28T00:00:00.000Z",
    project_id: null,
    conversation_id: "c-456",
    from_agent: "user",
    to_agent: "codex-mini",
    to_role: null,
    message: "dispatch prompt",
    status: "completed",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    open_pr_on_review: false,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
    dispatch_attempts: 0,
    max_dispatch_attempts: 3,
    ...overrides,
  };
  return base as unknown as HandoffRow;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
}

describe("merge reconciler project repo resolution (#219)", () => {
  let tmp: string;
  let repoA: string;
  let repoB: string;
  let verdicts: ReconcilerVerdict[];
  const handoffId = "h-pr-219";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "penumbra-reconcile-project-root-"));
    repoA = join(tmp, "a");
    repoB = join(tmp, "b");

    gitInit(repoA);
    git(repoA, ["commit", "--allow-empty", "-m", "init"]);

    gitInit(repoB);
    writeFileSync(join(repoB, "package.json"), JSON.stringify({ name: "b", private: true }));
    git(repoB, ["add", "package.json"]);
    git(repoB, ["commit", "-m", "init"]);

    git(repoB, ["checkout", "-b", "feature/only-in-b"]);
    writeFileSync(join(repoB, "feat.txt"), "feat");
    git(repoB, ["add", "feat.txt"]);
    git(repoB, ["commit", "-m", "feat only in b"]);
    git(repoB, ["checkout", "main"]);

    verdicts = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function setup(
    branchBase: string | null,
    opts: { handoffMissing?: boolean } = {},
  ): Promise<ReturnType<typeof createMergeReconciler>> {
    const manager = new WorktreeManager({
      rootDir: join(tmp, "default-worktrees"),
      mainRepoDir: repoA,
      resolveProjectRoot: (id: string): string | undefined => (id === "proj-b" ? repoB : undefined),
    });

    const handle = await manager.createWorktree(handoffId, {
      project_id: "proj-b",
      baseRef: branchBase ?? undefined,
    });

    mkdirSync(join(handle.path, "docs"));
    writeFileSync(join(handle.path, "docs", "note.md"), "# note\n");
    git(handle.path, ["add", "docs/note.md"]);
    git(handle.path, ["commit", "-m", "docs note"]);

    const reconciler = createMergeReconciler({
      worktreeManager: manager,
      mainRepoDir: repoA,
      reconcilerAutoRebase: false,
      rebaseScratchRoot: join(tmp, "scratch"),
      log: createLogger({ component: "test", level: "silent" }),
      postProgress: mock(() => Promise.resolve()),
      emitVerdict: (v: ReconcilerVerdict) => {
        verdicts.push(v);
      },
      getHandoff: mock(() =>
        Promise.resolve(
          opts.handoffMissing
            ? null
            : makeHandoffRow({
                handoff_id: handoffId,
                project_id: "proj-b",
                branch_base: branchBase,
              }),
        ),
      ),
      exec: async (argv: string[], opts: { cwd: string }) => {
        if (argv[0] === "git") {
          const { stdout, stderr } = await execFileAsync("git", argv.slice(1), {
            cwd: opts.cwd,
            encoding: "utf8",
          });
          return { stdout, stderr };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
    });

    return reconciler;
  }

  test("reconciles a feature branch_base that exists only in the project repo", async () => {
    const reconciler = await setup("feature/only-in-b");
    const result = await reconciler(handoffId);
    expect(result.status).toBe("verified");
    const expected = git(repoB, ["rev-parse", "feature/only-in-b"]).trim();
    expect(verdicts[0]?.base_sha).toBe(expected);
    expect(verdicts[0]?.ff_mergeable).toBe(true);
  });

  test("default branch_base reconciles against the project main, not the worker checkout", async () => {
    const reconciler = await setup(null);
    const result = await reconciler(handoffId);
    expect(result.status).toBe("verified");
    const repoBMain = git(repoB, ["rev-parse", "main"]).trim();
    const repoAMain = git(repoA, ["rev-parse", "main"]).trim();
    expect(verdicts[0]?.base_sha).toBe(repoBMain);
    expect(verdicts[0]?.base_sha).not.toBe(repoAMain);
    expect(verdicts[0]?.ff_mergeable).toBe(true);
  });

  test("resolves the project from the worktree when the handoff lookup fails", async () => {
    const reconciler = await setup(null, { handoffMissing: true });
    const result = await reconciler(handoffId);
    expect(result.status).toBe("verified");
    const repoBMain = git(repoB, ["rev-parse", "main"]).trim();
    expect(verdicts[0]?.base_sha).toBe(repoBMain);
    expect(verdicts[0]?.ff_mergeable).toBe(true);
  });
});
