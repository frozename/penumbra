import type { WorktreeCommandRunner, WorktreeCommandRunnerOptions } from "@src/worktree/manager.js";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

type ProbeModule = typeof import("@src/worktree/branch-land-probe.js") & {
  classifyBranchLandStatus?: (
    runner: WorktreeCommandRunner,
    repoDir: string,
    candidateRef: string,
    baseRef: string,
  ) => Promise<string>;
};

const gitRunner: WorktreeCommandRunner = (cmd, args, opts) =>
  execFile(cmd, args, { ...opts, encoding: opts?.encoding ?? "utf8" });

async function git(repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await gitRunner("git", args, { cwd: repoDir });
}

async function setupTempRepo(prefix: string): Promise<string> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.email", "test@example.com"]);
  await git(repoDir, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "init"]);
  return repoDir;
}

async function commitOnBranch(repoDir: string, branch: string, fileName: string): Promise<void> {
  await git(repoDir, ["checkout", "-b", branch]);
  fs.writeFileSync(path.join(repoDir, fileName), `${branch}\n`);
  await git(repoDir, ["add", fileName]);
  await git(repoDir, ["commit", "-m", `${branch} change`]);
}

async function classifyBranchLandStatus(
  runner: WorktreeCommandRunner,
  repoDir: string,
  candidateRef: string,
  baseRef: string,
): Promise<string> {
  const mod = (await import("@src/worktree/branch-land-probe.js")) as ProbeModule;
  expect(typeof mod.classifyBranchLandStatus).toBe("function");
  return await mod.classifyBranchLandStatus(runner, repoDir, candidateRef, baseRef);
}

describe("classifyBranchLandStatus", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await setupTempRepo("penumbra-branch-land-probe-");
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test("reports a squash-landed non-ancestor branch as landed by content", async () => {
    const branch = "agent/squash-landed";
    await commitOnBranch(repoDir, branch, "feature.txt");
    await git(repoDir, ["checkout", "main"]);
    await git(repoDir, ["merge", "--squash", branch]);
    await git(repoDir, ["commit", "-m", "squash land"]);

    let ancestorCheckRejected = false;
    try {
      await git(repoDir, ["merge-base", "--is-ancestor", branch, "main"]);
    } catch {
      ancestorCheckRejected = true;
    }
    expect(ancestorCheckRejected).toBe(true);

    const status = await classifyBranchLandStatus(gitRunner, repoDir, branch, "main");

    expect(status).toBe("landed");
  });

  test("reports a genuinely divergent branch as unlanded", async () => {
    const branch = "agent/unlanded";
    await commitOnBranch(repoDir, branch, "agent-only.txt");
    await git(repoDir, ["checkout", "main"]);

    const status = await classifyBranchLandStatus(gitRunner, repoDir, branch, "main");

    expect(status).toBe("unlanded");
  });

  test("reports an unexpected content-probe exit as error", async () => {
    const branch = "agent/probe-error";
    await commitOnBranch(repoDir, branch, "agent-only.txt");
    await git(repoDir, ["checkout", "main"]);
    const runner: WorktreeCommandRunner = (cmd, args, opts?: WorktreeCommandRunnerOptions) => {
      if (cmd === "git" && args[0] === "merge-tree") {
        const err = new Error("synthetic merge-tree failure") as Error & { code?: number };
        err.code = 2;
        return Promise.reject(err);
      }
      return gitRunner(cmd, args, opts);
    };

    const status = await classifyBranchLandStatus(runner, repoDir, branch, "main");

    expect(status).toBe("error");
  });

  test("reports an ff-merged branch as landed without the content probe", async () => {
    const branch = "agent/ff-landed";
    await commitOnBranch(repoDir, branch, "ff.txt");
    await git(repoDir, ["checkout", "main"]);
    await git(repoDir, ["merge", "--ff-only", branch]);
    const runner: WorktreeCommandRunner = (cmd, args, opts?: WorktreeCommandRunnerOptions) => {
      if (cmd === "git" && args[0] === "merge-tree") {
        throw new Error("content probe should not run for ancestor branches");
      }
      return gitRunner(cmd, args, opts);
    };

    const status = await classifyBranchLandStatus(runner, repoDir, branch, "main");

    expect(status).toBe("landed");
  });
});
