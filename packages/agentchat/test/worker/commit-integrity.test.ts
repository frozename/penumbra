import { afterEach, describe, expect, it } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { DISPATCH_BASE_CONFIG_KEY } from "@penumbra/core";

import { probeCommitIntegrity } from "@src/worker/commit-integrity.js";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const res = await execFile("git", args, { cwd, env, encoding: "utf8" });
  return res.stdout.trim();
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let commitSeq = 0;

async function setupFixture(): Promise<{
  wtPath: string;
  baseSha: string;
  firstSha: string;
}> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-commit-integrity-"));
  tempDirs.push(repoDir);
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "Repo Owner"]);
  await git(repoDir, ["config", "user.email", "owner@example.com"]);
  fs.writeFileSync(path.join(repoDir, "a.txt"), "one\n");
  await git(repoDir, ["add", "a.txt"]);
  await git(repoDir, ["commit", "-m", "c1"]);
  const firstSha = await git(repoDir, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repoDir, "b.txt"), "two\n");
  await git(repoDir, ["add", "b.txt"]);
  await git(repoDir, ["commit", "-m", "c2"]);
  const baseSha = await git(repoDir, ["rev-parse", "HEAD"]);
  await git(repoDir, ["config", "extensions.worktreeConfig", "true"]);

  const wtPath = path.join(repoDir, "wt");
  await git(repoDir, ["worktree", "add", "-b", "agent/probe", wtPath, baseSha]);
  await git(wtPath, ["config", "--worktree", "user.name", "Penumbra Worker"]);
  await git(wtPath, ["config", "--worktree", "user.email", "worker@example.com"]);
  await git(wtPath, ["config", "--worktree", DISPATCH_BASE_CONFIG_KEY, baseSha]);
  return { wtPath, baseSha, firstSha };
}

async function commitInWt(wtPath: string, extraArgs: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  commitSeq += 1;
  const fileName = `change-${commitSeq}.txt`;
  fs.writeFileSync(path.join(wtPath, fileName), `change ${commitSeq}\n`);
  await git(wtPath, ["add", fileName], env);
  await git(wtPath, ["commit", ...extraArgs, "-m", "worker change"], env);
}

describe("probeCommitIntegrity", () => {
  it("reports clean evidence for a commit made with the worktree identity", async () => {
    const { wtPath, baseSha } = await setupFixture();
    await commitInWt(wtPath, []);
    const headSha = await git(wtPath, ["rev-parse", "HEAD"]);

    expect(await probeCommitIntegrity(wtPath)).toEqual({
      base_sha: baseSha,
      head_sha: headSha,
      base_is_ancestor: true,
      identity: { name: "Penumbra Worker", email: "worker@example.com" },
      mismatched_commits: [],
    });
  });

  it("flags a commit authored by someone else", async () => {
    const { wtPath } = await setupFixture();
    await commitInWt(wtPath, ["--author=Human Operator <human@example.com>"]);
    const headSha = await git(wtPath, ["rev-parse", "HEAD"]);

    const evidence = await probeCommitIntegrity(wtPath);
    expect(evidence?.mismatched_commits).toEqual([headSha]);
  });

  it("flags a commit committed by someone else while the author matches", async () => {
    const { wtPath } = await setupFixture();
    await commitInWt(wtPath, [], {
      ...process.env,
      GIT_COMMITTER_NAME: "Human Operator",
      GIT_COMMITTER_EMAIL: "human@example.com",
    });
    const headSha = await git(wtPath, ["rev-parse", "HEAD"]);

    const evidence = await probeCommitIntegrity(wtPath);
    expect(evidence?.mismatched_commits).toEqual([headSha]);
  });

  it("reports base_is_ancestor false after a reset rewrites below the base", async () => {
    const { wtPath, firstSha } = await setupFixture();
    await git(wtPath, ["reset", "--hard", firstSha]);
    await commitInWt(wtPath, []);

    const evidence = await probeCommitIntegrity(wtPath);
    expect(evidence?.base_is_ancestor).toBe(false);
    expect(evidence?.mismatched_commits).toEqual([]);
  });

  it("returns null when the dispatch base config is unset", async () => {
    const { wtPath } = await setupFixture();
    await git(wtPath, ["config", "--worktree", "--unset", DISPATCH_BASE_CONFIG_KEY]);

    expect(await probeCommitIntegrity(wtPath)).toBeNull();
  });

  it("returns null outside a git repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-commit-integrity-nogit-"));
    tempDirs.push(dir);

    expect(await probeCommitIntegrity(dir)).toBeNull();
  });
});
