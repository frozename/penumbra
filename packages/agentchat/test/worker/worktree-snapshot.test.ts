import { type WorktreeCommandRunner, WorktreeManager } from "@penumbra/core";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { getWorktreeSnapshot } from "@src/worker/worktree-snapshot.js";

const execFile = promisify(execFileCb);

const HANDOFF_ID = "77777777-7777-4777-8777-777777777777";
const OWNER = { name: "Parent Author", email: "parent@example.com" };

const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const fixtureRunner: WorktreeCommandRunner = async (cmd, args, opts) => {
  const res = await execFile(cmd, args, {
    ...opts,
    env: FIXTURE_ENV,
    encoding: opts?.encoding ?? "utf8",
  });
  return { stdout: res.stdout, stderr: res.stderr };
};

async function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const res = await execFile("git", args, {
    cwd,
    env: { ...FIXTURE_ENV, ...extraEnv },
    encoding: "utf8",
  });
  return res.stdout.trim();
}

describe("getWorktreeSnapshot against a WorktreeManager worktree", () => {
  let repoDir: string;
  let rootDir: string;
  let manager: WorktreeManager;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-snapshot-repo-"));
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-snapshot-root-"));
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.name", OWNER.name]);
    await git(repoDir, ["config", "user.email", OWNER.email]);
    await git(repoDir, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
    await git(repoDir, ["add", "README.md"]);
    await git(repoDir, ["commit", "-m", "init"]);
    manager = new WorktreeManager({ rootDir, mainRepoDir: repoDir, runner: fixtureRunner });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function snapshot(handoffId = HANDOFF_ID): ReturnType<typeof getWorktreeSnapshot> {
    return getWorktreeSnapshot(handoffId, {
      getWorktree: (id) => manager.getWorktree(id),
      env: FIXTURE_ENV,
    });
  }

  it("reports a fresh worktree as unchanged with clean evidence at the recorded base", async () => {
    const baseSha = await git(repoDir, ["rev-parse", "HEAD"]);
    await manager.createWorktree(HANDOFF_ID);

    expect(await snapshot()).toEqual({
      worktreeChanged: false,
      dirty: false,
      committed: false,
      commitIntegrity: {
        base_sha: baseSha,
        head_sha: baseSha,
        base_is_ancestor: true,
        identity: OWNER,
        mismatched_commits: [],
        mismatched_total: 0,
      },
    });
  });

  it("reports a commit on the dispatch branch as committed with clean evidence", async () => {
    const handle = await manager.createWorktree(HANDOFF_ID);
    fs.writeFileSync(path.join(handle.path, "work.txt"), "work\n");
    await git(handle.path, ["add", "work.txt"]);
    await git(handle.path, ["commit", "-m", "work"]);
    const headSha = await git(handle.path, ["rev-parse", `refs/heads/${handle.branchName}`]);

    const result = await snapshot();
    expect(result).toMatchObject({ worktreeChanged: true, dirty: false, committed: true });
    expect(result.commitIntegrity?.head_sha).toBe(headSha);
    expect(result.commitIntegrity?.mismatched_commits).toEqual([]);
  });

  it("reports untracked work and a foreign-identity commit on the dispatch branch", async () => {
    const handle = await manager.createWorktree(HANDOFF_ID);
    await git(handle.path, [
      "commit",
      "--allow-empty",
      "--author=Human Operator <human@example.com>",
      "-m",
      "foreign",
    ]);
    const foreignSha = await git(handle.path, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(handle.path, "untracked.txt"), "scratch\n");

    const result = await snapshot();
    expect(result).toMatchObject({ worktreeChanged: true, dirty: true, committed: true });
    expect(result.commitIntegrity?.mismatched_commits).toEqual([foreignSha]);
    expect(result.commitIntegrity?.mismatched_total).toBe(1);
  });

  it("returns unknown fields and no evidence for a handoff without a worktree", async () => {
    expect(await snapshot("88888888-8888-4888-8888-888888888888")).toEqual({
      worktreeChanged: null,
      dirty: null,
      committed: null,
    });
  });
});

// The worker bin has no harness of its own; pin its delegation to this module
// the way shutdown.test.ts pins the bin's signal handlers.
describe("agentchat-worker getWorktreeSnapshot wiring", () => {
  it("hands the dispatcher a snapshot bound to the worker's worktree manager", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "../../bin/agentchat-worker.ts"),
      "utf8",
    );
    const wiring =
      /getWorktreeSnapshot: \(handoffId\) =>\s+getWorktreeSnapshot\(handoffId, \{[^}]*\}\)/.exec(
        source,
      )?.[0];

    expect(
      source.includes('import { getWorktreeSnapshot } from "../src/worker/worktree-snapshot.js";'),
    ).toBe(true);
    expect(wiring).toContain("getWorktree: (id) => worktreeManager.getWorktree(id)");
  });
});
