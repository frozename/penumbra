import { WorktreeManager } from "@penumbra/core";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  resolveScratchDispatch,
  type ScratchDispatchHandoff,
} from "@src/worker/scratch-dispatch.js";

const execFile = promisify(execFileCb);

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return stdout.trim();
}

describe("resolveScratchDispatch", () => {
  let repoDir: string;
  let base: string;
  let sha: string;
  let manager: WorktreeManager;
  let workerCwd: string;
  const RUN_ID = "run-9abc";

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-sd-repo-"));
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-m", "init"]);
    sha = await git(repoDir, ["rev-parse", "HEAD"]);
    base = `${repoDir}-worktrees`;
    workerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-sd-workercwd-"));
    // No rootDir: the manager defaults to `<mainRepo>-worktrees`, matching the
    // production layout where scratch dirs sit under the fleet base.
    manager = new WorktreeManager({ mainRepoDir: repoDir });
  });

  afterEach(() => {
    for (const p of [repoDir, base, workerCwd]) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  async function makeScratch(runId: string): Promise<string> {
    const { path: wtPath } = await manager.createScratchWorktree({
      owner_run_id: runId,
      repoRoot: repoDir,
      sha,
    });
    return wtPath;
  }

  function handoff(over: Partial<ScratchDispatchHandoff> = {}): ScratchDispatchHandoff {
    return {
      cwd_override: null,
      workflow_run_id: null,
      permission_profile: null,
      caller_cwd: null,
      project_id: null,
      ...over,
    };
  }

  test("returns 'none' when cwd_override is absent", () => {
    expect(resolveScratchDispatch(handoff(), { worktreeManager: manager, workerCwd })).toEqual({
      kind: "none",
    });
    expect(
      resolveScratchDispatch(handoff({ cwd_override: "" }), {
        worktreeManager: manager,
        workerCwd,
      }),
    ).toEqual({ kind: "none" });
  });

  test("returns 'invalid' when cwd_override is set without a workflow_run_id", () => {
    const result = resolveScratchDispatch(
      handoff({ cwd_override: path.join(base, ".scratch-run-9abc") }),
      { worktreeManager: manager, workerCwd },
    );
    expect(result).toEqual({ kind: "invalid", reason: "scratch_requires_workflow_run_id" });
  });

  test("returns 'invalid' when the override fails scratch validation", async () => {
    const wtPath = await makeScratch(RUN_ID);
    // Bound to a different run id → owner mismatch.
    const result = resolveScratchDispatch(
      handoff({ cwd_override: wtPath, workflow_run_id: "run-other" }),
      { worktreeManager: manager, workerCwd },
    );
    expect(result.kind).toBe("invalid");
  });

  test("resolves a valid scratch to its realpath cwd + repo root", async () => {
    const wtPath = await makeScratch(RUN_ID);
    const result = resolveScratchDispatch(
      handoff({ cwd_override: wtPath, workflow_run_id: RUN_ID }),
      { worktreeManager: manager, workerCwd },
    );
    expect(result.kind).toBe("scratch");
    if (result.kind !== "scratch") return;
    expect(result.cwd).toBe(fs.realpathSync(wtPath));
    expect(result.repoRoot).toBe(fs.realpathSync(repoDir));
    expect(result.executorRoot).toBe(result.cwd);
    // Unprofiled dispatches carry no deny set.
    expect(result.sandboxDenyRoots).toBeUndefined();
  });

  test("a profiled scratch dispatch denies writes under caller, project, fleet base, and worker cwd", async () => {
    const wtPath = await makeScratch(RUN_ID);
    const callerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-sd-caller-"));
    try {
      const result = resolveScratchDispatch(
        handoff({
          cwd_override: wtPath,
          workflow_run_id: RUN_ID,
          permission_profile: "review_readonly",
          caller_cwd: callerCwd,
        }),
        { worktreeManager: manager, workerCwd },
      );
      expect(result.kind).toBe("scratch");
      if (result.kind !== "scratch") return;
      const roots = result.sandboxDenyRoots ?? [];
      // The scratch cwd itself is denied (profiled dispatches are read-only),
      // and so are the mutable roots the persona could otherwise reach.
      expect(roots).toContain(fs.realpathSync(wtPath));
      expect(roots).toContain(fs.realpathSync(callerCwd));
      expect(roots).toContain(fs.realpathSync(workerCwd));
      expect(roots).toContain(fs.realpathSync(repoDir));
      expect(roots).toContain(fs.realpathSync(base));
    } finally {
      fs.rmSync(callerCwd, { recursive: true, force: true });
    }
  });

  async function makeGitRepo(prefix: string): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "init"]);
    return dir;
  }

  async function gitDirOf(wtPath: string): Promise<string> {
    const { stdout } = await execFile("git", ["-C", wtPath, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
    });
    return stdout.trim();
  }

  async function forgeOwnerMarker(wtPath: string, runId: string): Promise<void> {
    const gitDir = await gitDirOf(wtPath);
    fs.writeFileSync(
      path.join(gitDir, "penumbra-scratch.json"),
      `${JSON.stringify({ owner_run_id: runId, sha, created_at: new Date().toISOString() })}\n`,
    );
  }

  test("rejects a scratch outside the project's fleet base even with a matching owner file", async () => {
    // A detached worktree can live anywhere — only the fleet-base + common-dir
    // binding keeps a forged marker outside <root>-worktrees from resolving.
    const stray = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-sd-stray-"));
    const wtPath = path.join(stray, `.scratch-${RUN_ID}`);
    try {
      fs.mkdirSync(base, { recursive: true });
      await git(repoDir, ["worktree", "add", "--detach", wtPath, sha]);
      await forgeOwnerMarker(wtPath, RUN_ID);

      const result = resolveScratchDispatch(
        handoff({ cwd_override: wtPath, workflow_run_id: RUN_ID }),
        { worktreeManager: manager, workerCwd },
      );
      expect(result).toEqual({ kind: "invalid", reason: "scratch_outside_fleet_base" });
    } finally {
      fs.rmSync(stray, { recursive: true, force: true });
    }
  });

  test("rejects a foreign repo's .scratch dir inside the fleet base despite a matching owner file", async () => {
    // The dir sits under the expected fleet base but its common dir is a
    // different repository — only the common-dir check catches it.
    const otherRepo = await makeGitRepo("penumbra-sd-other-");
    const shaOther = await git(otherRepo, ["rev-parse", "HEAD"]);
    const wtPath = path.join(`${repoDir}-worktrees`, `.scratch-${RUN_ID}`);
    try {
      await git(otherRepo, ["worktree", "add", "--detach", wtPath, shaOther]);
      await forgeOwnerMarker(wtPath, RUN_ID);

      const result = resolveScratchDispatch(
        handoff({ cwd_override: wtPath, workflow_run_id: RUN_ID }),
        { worktreeManager: manager, workerCwd },
      );
      expect(result).toEqual({ kind: "invalid", reason: "common_dir_mismatch" });
    } finally {
      fs.rmSync(wtPath, { recursive: true, force: true });
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  test("a profiled dispatch bound to a registered project denies that project's root and fleet base", async () => {
    // projectRootFor must enter the deny set even when the project root
    // differs from mainRepoDir — otherwise the persona could write the
    // project checkout directly.
    const projectRepo = await makeGitRepo("penumbra-sd-proj-");
    const shaProj = await git(projectRepo, ["rev-parse", "HEAD"]);
    const projManager = new WorktreeManager({
      mainRepoDir: repoDir,
      resolveProjectRoot: (id: string): string | undefined =>
        id === "proj-b" ? projectRepo : undefined,
    });
    try {
      const { path: wtPath } = await projManager.createScratchWorktree({
        owner_run_id: RUN_ID,
        repoRoot: projectRepo,
        sha: shaProj,
      });
      const result = resolveScratchDispatch(
        handoff({
          cwd_override: wtPath,
          workflow_run_id: RUN_ID,
          permission_profile: "review_readonly",
          project_id: "proj-b",
        }),
        { worktreeManager: projManager, workerCwd },
      );
      expect(result.kind).toBe("scratch");
      if (result.kind !== "scratch") return;
      const roots = result.sandboxDenyRoots ?? [];
      expect(roots).toContain(fs.realpathSync(wtPath));
      expect(roots).toContain(fs.realpathSync(projectRepo));
      expect(roots).toContain(fs.realpathSync(`${projectRepo}-worktrees`));
      expect(roots).toContain(fs.realpathSync(repoDir));
      expect(roots).toContain(fs.realpathSync(workerCwd));
    } finally {
      fs.rmSync(`${projectRepo}-worktrees`, { recursive: true, force: true });
      fs.rmSync(projectRepo, { recursive: true, force: true });
    }
  });
});
