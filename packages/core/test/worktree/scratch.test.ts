import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  isScratchDirName,
  listScratchDirs,
  readScratchOwner,
  resolveCommonGitDir,
  resolveWorktreeGitDir,
  scratchDirName,
  validateScratchCwd,
  writeScratchOwner,
} from "@src/worktree/scratch.js";

const execFile = promisify(execFileCb);

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return stdout.trim();
}

describe("scratch worktree helpers", () => {
  let repoDir: string;
  let base: string;
  let sha: string;
  const runId = "run-1111-2222";

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-repo-"));
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-m", "init"]);
    sha = await git(repoDir, ["rev-parse", "HEAD"]);
    base = `${repoDir}-worktrees`;
    fs.mkdirSync(base, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function addScratch(name = scratchDirName(runId)): Promise<string> {
    const wtPath = path.join(base, name);
    await git(repoDir, ["worktree", "add", "--detach", wtPath, sha]);
    return wtPath;
  }

  test("isScratchDirName / scratchDirName round-trip", () => {
    expect(isScratchDirName(".scratch-abc")).toBe(true);
    expect(isScratchDirName("scratch-abc")).toBe(false);
    expect(isScratchDirName("abc")).toBe(false);
    const name = scratchDirName("run-9");
    expect(isScratchDirName(name)).toBe(true);
    expect(name.slice(".scratch-".length)).toBe("run-9");
  });

  test("resolveWorktreeGitDir returns the .git dir for a main checkout", () => {
    expect(resolveWorktreeGitDir(repoDir)).toBe(path.join(repoDir, ".git"));
    expect(resolveWorktreeGitDir(path.join(repoDir, "nope"))).toBeNull();
  });

  test("resolveWorktreeGitDir follows a linked worktree gitdir pointer", async () => {
    const wtPath = await addScratch();
    const gitDir = resolveWorktreeGitDir(wtPath);
    expect(gitDir).not.toBeNull();
    expect(fs.statSync(gitDir!).isDirectory()).toBe(true);
    // Git sanitizes the leading dot: .scratch-run -> -scratch-run.
    expect(path.basename(gitDir!)).toContain("scratch-run-1111-2222");
    // The linked worktree's git dir lives under the main repo's worktrees store.
    expect(resolveCommonGitDir(gitDir!)).toContain(path.join(repoDir, ".git"));
  });

  test("resolveCommonGitDir returns the git dir itself when no commondir file exists", () => {
    expect(resolveCommonGitDir(path.join(repoDir, ".git"))).toBe(path.join(repoDir, ".git"));
  });

  test("readScratchOwner/writeScratchOwner round-trip and reject malformed records", async () => {
    const wtPath = await addScratch();
    expect(readScratchOwner(wtPath)).toBeNull();

    const owner = { owner_run_id: runId, sha, created_at: "2026-05-19T00:00:00.000Z" };
    writeScratchOwner(wtPath, owner);
    expect(readScratchOwner(wtPath)).toEqual(owner);

    const withKeep = {
      ...owner,
      keep_reason: "live_dispatches_at_release",
      keep_reason_at: "2026-05-19T00:01:00.000Z",
    };
    writeScratchOwner(wtPath, withKeep);
    expect(readScratchOwner(wtPath)).toEqual(withKeep);

    const gitDir = resolveWorktreeGitDir(wtPath);
    expect(gitDir).not.toBeNull();
    fs.writeFileSync(path.join(gitDir!, "penumbra-scratch.json"), '{"nope":1}\n');
    expect(readScratchOwner(wtPath)).toBeNull();
    fs.writeFileSync(path.join(gitDir!, "penumbra-scratch.json"), "not json\n");
    expect(readScratchOwner(wtPath)).toBeNull();
  });

  test("listScratchDirs returns only .scratch-* dirs that are git worktrees", async () => {
    const wtPath = await addScratch();
    fs.mkdirSync(path.join(base, ".scratch-bare")); // no .git — skipped
    fs.mkdirSync(path.join(base, "regular-wt")); // wrong prefix — skipped
    fs.writeFileSync(path.join(base, ".scratch-file"), "x"); // not a dir — skipped

    const dirs = listScratchDirs(base);
    expect(dirs).toEqual([{ path: wtPath, owner_run_id: runId }]);
    expect(listScratchDirs(path.join(base, "nonexistent"))).toEqual([]);
  });
});

describe("validateScratchCwd", () => {
  let repoDir: string;
  let base: string;
  let sha: string;
  let wtPath: string;
  const runId = "run-aaaa-bbbb";

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-val-repo-"));
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-m", "init"]);
    sha = await git(repoDir, ["rev-parse", "HEAD"]);
    base = `${repoDir}-worktrees`;
    fs.mkdirSync(base, { recursive: true });
    wtPath = path.join(base, scratchDirName(runId));
    await git(repoDir, ["worktree", "add", "--detach", wtPath, sha]);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  const commonDir = (): string => fs.realpathSync(path.join(repoDir, ".git"));

  test("accepts a well-formed daemon-owned scratch worktree", () => {
    writeScratchOwner(wtPath, {
      owner_run_id: runId,
      sha,
      created_at: new Date().toISOString(),
    });
    const result = validateScratchCwd({
      cwd_override: wtPath,
      owner_run_id: runId,
      expected_base: base,
      expected_common_dir: commonDir(),
    });
    expect(result).toEqual({
      ok: true,
      path: fs.realpathSync(wtPath),
      repo_root: fs.realpathSync(repoDir),
    });
  });

  test("rejects a relative path", () => {
    expect(validateScratchCwd({ cwd_override: "rel/path", owner_run_id: runId })).toEqual({
      ok: false,
      reason: "cwd_override_not_absolute",
    });
  });

  test("rejects a nonexistent path", () => {
    expect(
      validateScratchCwd({ cwd_override: path.join(base, ".scratch-nope"), owner_run_id: runId }),
    ).toEqual({ ok: false, reason: "cwd_override_missing" });
  });

  test("rejects when the basename does not match the owner run id", async () => {
    const other = path.join(base, ".scratch-other-run");
    await git(repoDir, ["worktree", "add", "--detach", other, sha]);
    expect(validateScratchCwd({ cwd_override: other, owner_run_id: runId })).toEqual({
      ok: false,
      reason: "scratch_dir_name_mismatch",
    });
  });

  test("rejects a scratch dir outside the expected fleet base", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-else-"));
    try {
      const foreign = path.join(elsewhere, scratchDirName(runId));
      fs.mkdirSync(foreign, { recursive: true });
      // Directory exists + basename matches but fails base containment.
      const result = validateScratchCwd({
        cwd_override: foreign,
        owner_run_id: runId,
        expected_base: base,
      });
      expect(result).toEqual({ ok: false, reason: "scratch_outside_fleet_base" });
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("rejects a directory that is not a git worktree", async () => {
    const plain = path.join(base, scratchDirName(runId));
    await git(repoDir, ["worktree", "remove", "--force", wtPath]);
    fs.mkdirSync(plain, { recursive: true });
    expect(validateScratchCwd({ cwd_override: plain, owner_run_id: runId })).toEqual({
      ok: false,
      reason: "not_a_git_worktree",
    });
  });

  test("rejects when the common dir differs from the expected repo", async () => {
    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-other-repo-"));
    try {
      await git(otherRepo, ["init", "-b", "main"]);
      await git(otherRepo, ["config", "user.email", "test@example.com"]);
      await git(otherRepo, ["config", "user.name", "test"]);
      fs.writeFileSync(path.join(otherRepo, "x"), "x\n");
      await git(otherRepo, ["add", "."]);
      await git(otherRepo, ["commit", "-m", "init"]);
      const otherSha = await git(otherRepo, ["rev-parse", "HEAD"]);
      const foreignBase = `${otherRepo}-worktrees`;
      fs.mkdirSync(foreignBase);
      const foreign = path.join(foreignBase, scratchDirName(runId));
      await git(otherRepo, ["worktree", "add", "--detach", foreign, otherSha]);
      writeScratchOwner(foreign, {
        owner_run_id: runId,
        sha: otherSha,
        created_at: new Date().toISOString(),
      });
      const result = validateScratchCwd({
        cwd_override: foreign,
        owner_run_id: runId,
        expected_common_dir: commonDir(),
      });
      expect(result).toEqual({ ok: false, reason: "common_dir_mismatch" });
    } finally {
      fs.rmSync(otherRepo, { recursive: true, force: true });
      fs.rmSync(`${otherRepo}-worktrees`, { recursive: true, force: true });
    }
  });

  test("rejects a worktree whose owner marker is missing or names another run", () => {
    expect(validateScratchCwd({ cwd_override: wtPath, owner_run_id: runId })).toEqual({
      ok: false,
      reason: "scratch_owner_mismatch",
    });
    writeScratchOwner(wtPath, {
      owner_run_id: "run-different",
      sha,
      created_at: new Date().toISOString(),
    });
    expect(validateScratchCwd({ cwd_override: wtPath, owner_run_id: runId })).toEqual({
      ok: false,
      reason: "scratch_owner_mismatch",
    });
  });
});
