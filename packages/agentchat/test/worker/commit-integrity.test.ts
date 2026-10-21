import { DISPATCH_BASE_CONFIG_KEY, type WorktreeCommandRunner } from "@penumbra/core";
import { afterEach, describe, expect, it } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  IDENTITY_FIELD_MAX,
  LOG_SCAN_LIMIT,
  MISMATCHED_COMMITS_CAP,
  probeCommitIntegrity,
} from "@src/worker/commit-integrity.js";

const execFile = promisify(execFileCb);

const BRANCH = "agent/probe";
const WORKER = { name: "Penumbra Worker", email: "worker@example.com" };

// No global/system config (gpgsign, author.* overrides) and no inherited
// GIT_* variables (GIT_DIR from a hook, identity overrides) reach the fixture.
const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const res = await execFile("git", args, {
    cwd,
    env: { ...FIXTURE_ENV, ...extraEnv },
    encoding: "utf8",
  });
  return res.stdout.trim();
}

function probe(
  wtPath: string,
  branchName = BRANCH,
  runner?: WorktreeCommandRunner,
): ReturnType<typeof probeCommitIntegrity> {
  return probeCommitIntegrity(wtPath, branchName, { env: FIXTURE_ENV, runner });
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let commitSeq = 0;

interface Fixture {
  repoDir: string;
  wtPath: string;
  baseSha: string;
  firstSha: string;
}

async function setupFixture(
  workerName = WORKER.name,
  objectFormat: "sha1" | "sha256" = "sha1",
): Promise<Fixture> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-commit-integrity-"));
  tempDirs.push(repoDir);
  await git(repoDir, ["init", `--object-format=${objectFormat}`, "-b", "main"]);
  await git(repoDir, ["config", "user.name", "Repo Owner"]);
  await git(repoDir, ["config", "user.email", "owner@example.com"]);
  await git(repoDir, ["config", "commit.gpgsign", "false"]);
  await git(repoDir, ["commit", "--allow-empty", "-m", "c1"]);
  const firstSha = await git(repoDir, ["rev-parse", "HEAD"]);
  await git(repoDir, ["commit", "--allow-empty", "-m", "c2"]);
  const baseSha = await git(repoDir, ["rev-parse", "HEAD"]);
  await git(repoDir, ["config", "extensions.worktreeConfig", "true"]);

  const wtPath = path.join(repoDir, "wt");
  await git(repoDir, ["worktree", "add", "-b", BRANCH, wtPath, baseSha]);
  await git(wtPath, ["config", "--worktree", "user.name", workerName]);
  await git(wtPath, ["config", "--worktree", "user.email", WORKER.email]);
  await git(wtPath, ["config", "--worktree", DISPATCH_BASE_CONFIG_KEY, baseSha]);
  return { repoDir, wtPath, baseSha, firstSha };
}

async function commitIn(
  cwd: string,
  opts: { args?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  commitSeq += 1;
  const fileName = `change-${String(commitSeq)}.txt`;
  fs.writeFileSync(path.join(cwd, fileName), `change ${String(commitSeq)}\n`);
  await git(cwd, ["add", fileName], opts.env);
  await git(cwd, ["commit", ...(opts.args ?? []), "-m", "worker change"], opts.env);
  return await git(cwd, ["rev-parse", "HEAD"]);
}

const FOREIGN_AUTHOR = ["--author=Human Operator <human@example.com>"];

describe("probeCommitIntegrity", () => {
  it("reports clean evidence for a commit made with the worktree identity", async () => {
    const { wtPath, baseSha } = await setupFixture();
    const headSha = await commitIn(wtPath);

    expect(await probe(wtPath)).toEqual({
      base_sha: baseSha,
      head_sha: headSha,
      base_is_ancestor: true,
      identity: WORKER,
      mismatched_commits: [],
      mismatched_total: 0,
    });
  });

  it.each([
    ["author name", { GIT_AUTHOR_NAME: "Human Operator" }],
    ["author email", { GIT_AUTHOR_EMAIL: "human@example.com" }],
    ["committer name", { GIT_COMMITTER_NAME: "Human Operator" }],
    ["committer email", { GIT_COMMITTER_EMAIL: "human@example.com" }],
  ])("flags a commit whose %s alone differs", async (_field, env) => {
    const { wtPath } = await setupFixture();
    const headSha = await commitIn(wtPath, { env });

    const evidence = await probe(wtPath);
    expect(evidence?.mismatched_commits).toEqual([headSha]);
    expect(evidence?.mismatched_total).toBe(1);
  });

  it("does not let identity variables in the probe's environment redefine the expected identity", async () => {
    const { wtPath } = await setupFixture();
    const spoofEnv = { GIT_AUTHOR_NAME: "Human Operator", GIT_COMMITTER_NAME: "Human Operator" };
    const headSha = await commitIn(wtPath, { env: spoofEnv });

    const evidence = await probeCommitIntegrity(wtPath, BRANCH, {
      env: { ...FIXTURE_ENV, ...spoofEnv },
    });
    expect(evidence?.identity).toEqual(WORKER);
    expect(evidence?.mismatched_commits).toEqual([headSha]);
  });

  it.each([
    ["GIT_AUTHOR_NAME", "Human Operator"],
    ["GIT_AUTHOR_EMAIL", "human@example.com"],
    ["GIT_COMMITTER_NAME", "Human Operator"],
    ["GIT_COMMITTER_EMAIL", "human@example.com"],
  ])("ignores %s in the probe's environment for an honest commit", async (key, value) => {
    const { wtPath } = await setupFixture();
    await commitIn(wtPath);

    const evidence = await probeCommitIntegrity(wtPath, BRANCH, {
      env: { ...FIXTURE_ENV, [key]: value },
    });
    expect(evidence?.identity).toEqual(WORKER);
    expect(evidence?.mismatched_total).toBe(0);
  });

  it("does not flag a configured name that git normalises when it writes the commit", async () => {
    const { wtPath } = await setupFixture(`${WORKER.name},`);
    await commitIn(wtPath);

    const evidence = await probe(wtPath);
    expect(evidence?.identity).toEqual(WORKER);
    expect(evidence?.mismatched_commits).toEqual([]);
    expect(evidence?.mismatched_total).toBe(0);
  });

  it("flags only the foreign commit of a two-commit range", async () => {
    const { wtPath } = await setupFixture();
    const foreignSha = await commitIn(wtPath, { args: FOREIGN_AUTHOR });
    await commitIn(wtPath);

    const evidence = await probe(wtPath);
    expect(evidence?.mismatched_commits).toEqual([foreignSha]);
    expect(evidence?.mismatched_total).toBe(1);
  });

  it("reads the dispatch branch, not HEAD, when the branch moved to a foreign commit", async () => {
    const { wtPath, baseSha } = await setupFixture();
    await git(wtPath, ["checkout", "-q", "--detach"]);
    const foreignSha = await commitIn(wtPath, { args: FOREIGN_AUTHOR });
    await git(wtPath, ["branch", "-f", BRANCH, foreignSha]);
    await git(wtPath, ["checkout", "-q", "--detach", baseSha]);
    await commitIn(wtPath);

    const evidence = await probe(wtPath);
    expect(evidence?.head_sha).toBe(foreignSha);
    expect(evidence?.mismatched_commits).toEqual([foreignSha]);
  });

  it("reads the dispatch branch, not HEAD, when a detached HEAD holds a foreign commit", async () => {
    const { wtPath } = await setupFixture();
    const branchSha = await commitIn(wtPath);
    await git(wtPath, ["checkout", "-q", "--detach"]);
    await commitIn(wtPath, { args: FOREIGN_AUTHOR });

    const evidence = await probe(wtPath);
    expect(evidence?.head_sha).toBe(branchSha);
    expect(evidence?.mismatched_commits).toEqual([]);
  });

  it("does not flag upstream commits after a rebase onto a newer main", async () => {
    const { repoDir, wtPath, baseSha } = await setupFixture();
    await commitIn(wtPath);
    await commitIn(repoDir, {
      env: { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" },
    });
    await git(wtPath, ["rebase", "-q", "main"]);
    const headSha = await git(wtPath, ["rev-parse", "HEAD"]);

    const evidence = await probe(wtPath);
    expect(evidence?.base_sha).toBe(baseSha);
    expect(evidence?.head_sha).toBe(headSha);
    expect(evidence?.base_is_ancestor).toBe(true);
    expect(evidence?.mismatched_commits).toEqual([]);
    expect(evidence?.mismatched_total).toBe(0);
  });

  it("does not flag commits of a stacked dispatch's parent branch", async () => {
    const { repoDir, wtPath } = await setupFixture();
    await git(repoDir, ["branch", "agent/parent", "main"]);
    const parentWt = path.join(repoDir, "parent-wt");
    await git(repoDir, ["worktree", "add", "-q", parentWt, "agent/parent"]);
    await commitIn(parentWt, { args: FOREIGN_AUTHOR });
    await git(wtPath, ["rebase", "-q", "agent/parent"]);

    const evidence = await probe(wtPath);
    expect(evidence?.base_is_ancestor).toBe(true);
    expect(evidence?.mismatched_commits).toEqual([]);
  });

  it("still flags a foreign commit pushed to the branch's own remote-tracking ref", async () => {
    const { wtPath } = await setupFixture();
    const foreignSha = await commitIn(wtPath, { args: FOREIGN_AUTHOR });
    await git(wtPath, ["update-ref", `refs/remotes/origin/${BRANCH}`, foreignSha]);

    const evidence = await probe(wtPath);
    expect(evidence?.mismatched_commits).toEqual([foreignSha]);
  });

  it("checks the merge commit but not the second-parent history it brings in", async () => {
    const { wtPath } = await setupFixture();
    await git(wtPath, ["checkout", "-q", "-b", "side"]);
    await commitIn(wtPath, { args: FOREIGN_AUTHOR });
    await git(wtPath, ["checkout", "-q", BRANCH]);
    await git(wtPath, ["merge", "-q", "--no-ff", "-m", "merge side", "side"], {
      GIT_COMMITTER_NAME: "Human Operator",
    });
    await git(wtPath, ["branch", "-q", "-D", "side"]);
    const mergeSha = await git(wtPath, ["rev-parse", "HEAD"]);

    const evidence = await probe(wtPath);
    expect(evidence?.mismatched_commits).toEqual([mergeSha]);
    expect(evidence?.mismatched_total).toBe(1);
  });

  it("caps the listed commits and reports the full mismatch count", async () => {
    const { wtPath } = await setupFixture();
    const total = MISMATCHED_COMMITS_CAP + 2;
    for (let i = 0; i < total; i += 1) {
      await git(wtPath, [
        "commit",
        "--allow-empty",
        ...FOREIGN_AUTHOR,
        "-m",
        `foreign ${String(i)}`,
      ]);
    }
    const newest = (
      await git(wtPath, ["rev-list", `--max-count=${String(MISMATCHED_COMMITS_CAP)}`, "HEAD"])
    ).split("\n");

    const evidence = await probe(wtPath);
    expect(evidence?.mismatched_commits).toEqual(newest);
    expect(evidence?.mismatched_total).toBe(total);
  });

  it("sizes the caps so worst-case SHA-256 evidence leaves room in dispatch.end meta", () => {
    const sha256 = "f".repeat(64);
    // Control characters are the worst case: JSON escapes each as \u00XX.
    const escaped = "\u0001".repeat(IDENTITY_FIELD_MAX);
    const worst = {
      base_sha: sha256,
      head_sha: sha256,
      base_is_ancestor: false,
      identity: { name: escaped, email: escaped },
      mismatched_commits: Array.from({ length: MISMATCHED_COMMITS_CAP }, () => sha256),
      mismatched_total: Number.MAX_SAFE_INTEGER,
    };
    // dispatch.end meta is rejected past 4096 chars; keep 1024 for the rest.
    expect(JSON.stringify(worst).length).toBeLessThanOrEqual(3072);
  });

  it("handles a SHA-256 repository", async () => {
    const { wtPath, baseSha } = await setupFixture(WORKER.name, "sha256");
    const foreignSha = await commitIn(wtPath, { args: FOREIGN_AUTHOR });

    const evidence = await probe(wtPath);
    expect(baseSha).toHaveLength(64);
    expect(evidence?.base_sha).toBe(baseSha);
    expect(evidence?.mismatched_commits).toEqual([foreignSha]);
  });

  it("bounds the git log scan with --max-count", async () => {
    const { wtPath } = await setupFixture();
    await commitIn(wtPath);
    const logArgs: string[][] = [];
    const spy: WorktreeCommandRunner = async (cmd, args, opts) => {
      if (args[0] === "log") logArgs.push(args);
      const res = await execFile(cmd, args, { ...opts, encoding: "utf8" });
      return { stdout: res.stdout, stderr: res.stderr };
    };

    await probe(wtPath, BRANCH, spy);
    expect(logArgs).toHaveLength(1);
    expect(logArgs[0]).toContain(`--max-count=${String(LOG_SCAN_LIMIT)}`);
  });

  it("runs every git call, the ancestry check included, with the probe's environment", async () => {
    const { wtPath } = await setupFixture();
    await commitIn(wtPath);
    const calls: string[] = [];
    const spy: WorktreeCommandRunner = async (cmd, args, opts) => {
      calls.push(`${args[0] ?? ""}:${opts?.env?.PROBE_SENTINEL ?? "missing"}`);
      const res = await execFile(cmd, args, { ...opts, encoding: "utf8" });
      return { stdout: res.stdout, stderr: res.stderr };
    };

    await probeCommitIntegrity(wtPath, BRANCH, {
      env: { ...FIXTURE_ENV, PROBE_SENTINEL: "set" },
      runner: spy,
    });
    expect(calls).toContain("merge-base:set");
    expect(calls.filter((call) => !call.endsWith(":set"))).toEqual([]);
  });

  it("truncates an oversized configured identity in the evidence", async () => {
    const { wtPath } = await setupFixture("W".repeat(IDENTITY_FIELD_MAX * 4));
    await commitIn(wtPath);

    const evidence = await probe(wtPath);
    expect(evidence?.identity.name).toBe("W".repeat(IDENTITY_FIELD_MAX));
    expect(evidence?.mismatched_commits).toEqual([]);
  });

  it("reports base_is_ancestor false after a reset rewrites below the base", async () => {
    const { wtPath, firstSha } = await setupFixture();
    await git(wtPath, ["reset", "-q", "--hard", firstSha]);
    await commitIn(wtPath);

    const evidence = await probe(wtPath);
    expect(evidence?.base_is_ancestor).toBe(false);
    expect(evidence?.mismatched_commits).toEqual([]);
  });

  it("keeps the base verdict and leaves the total null when git log fails", async () => {
    const { wtPath, firstSha } = await setupFixture();
    await git(wtPath, ["reset", "-q", "--hard", firstSha]);
    await commitIn(wtPath, { args: FOREIGN_AUTHOR });
    const failingLog: WorktreeCommandRunner = async (cmd, args, opts) => {
      if (args[0] === "log") throw new Error("log failed");
      const res = await execFile(cmd, args, { ...opts, encoding: "utf8" });
      return { stdout: res.stdout, stderr: res.stderr };
    };

    const evidence = await probe(wtPath, BRANCH, failingLog);
    expect(evidence?.base_is_ancestor).toBe(false);
    expect(evidence?.identity).toEqual(WORKER);
    expect(evidence?.mismatched_commits).toEqual([]);
    expect(evidence?.mismatched_total).toBeNull();
  });

  it("returns null when the dispatch base config is unset", async () => {
    const { wtPath } = await setupFixture();
    await git(wtPath, ["config", "--worktree", "--unset", DISPATCH_BASE_CONFIG_KEY]);

    expect(await probe(wtPath)).toBeNull();
  });

  it("returns null when the dispatch base config is not a commit sha", async () => {
    const { wtPath } = await setupFixture();
    await git(wtPath, ["config", "--worktree", DISPATCH_BASE_CONFIG_KEY, "main"]);

    expect(await probe(wtPath)).toBeNull();
  });

  it("returns null when the dispatch branch does not exist", async () => {
    const { wtPath } = await setupFixture();

    expect(await probe(wtPath, "agent/missing")).toBeNull();
  });

  it("returns null outside a git repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-commit-integrity-nogit-"));
    tempDirs.push(dir);

    expect(await probe(dir)).toBeNull();
  });
});
