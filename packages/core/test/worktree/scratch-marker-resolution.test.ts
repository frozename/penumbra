import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  readScratchOwner,
  resolveCommonGitDir,
  resolveWorktreeGitDir,
  SCRATCH_OWNER_FILE,
  scratchDirName,
  validateScratchCwd,
  writeScratchOwner,
} from "@src/worktree/scratch.js";

const execFile = promisify(execFileCb);

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return stdout.trim();
}

const BASE = {
  owner_run_id: "run-7777-8888",
  sha: "0123456789abcdef0123456789abcdef01234567",
  created_at: "2026-05-19T00:00:00.000Z",
};

describe("resolveWorktreeGitDir gitdir-pointer parsing", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-resolve-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeWt(): string {
    const dir = path.join(tmp, "wt");
    fs.mkdirSync(dir);
    return dir;
  }

  test("returns null when .git is a file without a gitdir: prefix", () => {
    const dir = makeWt();
    fs.writeFileSync(path.join(dir, ".git"), "not a gitdir pointer\n");
    expect(resolveWorktreeGitDir(dir)).toBeNull();
  });

  test("resolves a relative gitdir pointer against the worktree path", () => {
    const dir = makeWt();
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: ../store/wt1\n");
    expect(resolveWorktreeGitDir(dir)).toBe(path.resolve(dir, "../store/wt1"));
  });

  test("returns an absolute gitdir pointer verbatim, trimmed", () => {
    const dir = makeWt();
    fs.writeFileSync(path.join(dir, ".git"), "gitdir:   /abs/x  \n");
    expect(resolveWorktreeGitDir(dir)).toBe("/abs/x");
  });
});

describe("resolveCommonGitDir commondir resolution", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-common-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("resolves a relative commondir file against the git dir", () => {
    const gitDir = path.join(tmp, "git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "commondir"), "../shared\n");
    expect(resolveCommonGitDir(gitDir)).toBe(path.resolve(gitDir, "../shared"));
  });

  test("returns an absolute commondir value trimmed and unchanged", () => {
    const gitDir = path.join(tmp, "git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "commondir"), "  /abs/shared  \n");
    expect(resolveCommonGitDir(gitDir)).toBe("/abs/shared");
  });
});

describe("readScratchOwner owner-marker parsing", () => {
  let tmp: string;
  let wtPath: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-owner-"));
    wtPath = path.join(tmp, "wt");
    fs.mkdirSync(path.join(wtPath, ".git"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeMarker(rec: unknown): void {
    const gitDir = resolveWorktreeGitDir(wtPath);
    expect(gitDir).not.toBeNull();
    fs.writeFileSync(path.join(gitDir!, SCRATCH_OWNER_FILE), JSON.stringify(rec));
  }

  test("keeps a well-formed daemon identity exactly", () => {
    const daemon = { daemon_id: "daemon-a", pid: 4242, boot_id: "boot-1" };
    writeMarker({ ...BASE, daemon });
    const owner = readScratchOwner(wtPath);
    expect(owner).toEqual({ ...BASE, daemon });
  });

  test("drops the daemon key when daemon_id is empty", () => {
    writeMarker({ ...BASE, daemon: { daemon_id: "", pid: 4242, boot_id: "boot-1" } });
    const owner = readScratchOwner(wtPath);
    expect(owner?.daemon).toBeUndefined();
    expect(owner).toEqual(BASE);
  });

  test("drops the daemon key when pid is a string", () => {
    writeMarker({ ...BASE, daemon: { daemon_id: "daemon-a", pid: "123", boot_id: "boot-1" } });
    const owner = readScratchOwner(wtPath);
    expect(owner?.daemon).toBeUndefined();
    expect(owner).toEqual(BASE);
  });

  test("drops the daemon key when boot_id is empty", () => {
    writeMarker({ ...BASE, daemon: { daemon_id: "daemon-a", pid: 4242, boot_id: "" } });
    const owner = readScratchOwner(wtPath);
    expect(owner?.daemon).toBeUndefined();
    expect(owner).toEqual(BASE);
  });

  test("drops keep_reason when keep_reason_at is missing", () => {
    writeMarker({ ...BASE, keep_reason: "live_dispatches_at_release" });
    expect(readScratchOwner(wtPath)).toEqual(BASE);
  });

  test("returns null when owner_run_id is an empty string", () => {
    writeMarker({ ...BASE, owner_run_id: "" });
    expect(readScratchOwner(wtPath)).toBeNull();
  });

  test("returns null when the marker is JSON null", () => {
    writeMarker(null);
    expect(readScratchOwner(wtPath)).toBeNull();
  });

  test("returns null when the marker is a JSON string", () => {
    writeMarker("just a string");
    expect(readScratchOwner(wtPath)).toBeNull();
  });
});

describe("writeScratchOwner", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-write-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("throws for a plain directory with no .git pointer", () => {
    expect(() => {
      writeScratchOwner(tmp, BASE);
    }).toThrow("missing .git pointer");
  });
});

describe("validateScratchCwd rejection reasons", () => {
  let tmp: string;
  const runId = "run-9999-0000";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-validate-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("scratch_base_missing when expected_base does not exist", () => {
    const scratchDir = path.join(tmp, scratchDirName(runId));
    fs.mkdirSync(scratchDir);
    const result = validateScratchCwd({
      cwd_override: scratchDir,
      owner_run_id: runId,
      expected_base: path.join(tmp, "no-such-base"),
    });
    expect(result).toEqual({ ok: false, reason: "scratch_base_missing" });
  });

  test("common_dir_missing when the gitdir pointer targets a nonexistent path", () => {
    const scratchDir = path.join(tmp, scratchDirName(runId));
    fs.mkdirSync(scratchDir);
    fs.writeFileSync(
      path.join(scratchDir, ".git"),
      `gitdir: ${path.join(tmp, "does-not-exist")}\n`,
    );
    const result = validateScratchCwd({ cwd_override: scratchDir, owner_run_id: runId });
    expect(result).toEqual({ ok: false, reason: "common_dir_missing" });
  });

  test("scratch_dir_name_mismatch when a symlinked scratch name resolves elsewhere", () => {
    const target = path.join(tmp, "different-basename");
    fs.mkdirSync(target);
    const link = path.join(tmp, scratchDirName(runId));
    fs.symlinkSync(target, link);
    const result = validateScratchCwd({ cwd_override: link, owner_run_id: runId });
    expect(result).toEqual({ ok: false, reason: "scratch_dir_name_mismatch" });
  });
});

describe("validateScratchCwd common_dir_mismatch on a real worktree", () => {
  let tmp: string;
  let repoDir: string;
  let sha: string;
  const runId = "run-cccc-dddd";

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-scratch-mismatch-"));
    repoDir = path.join(tmp, "repo");
    fs.mkdirSync(repoDir);
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-m", "init"]);
    sha = await git(repoDir, ["rev-parse", "HEAD"]);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("common_dir_mismatch when expected_common_dir does not exist", async () => {
    const base = path.join(tmp, "worktrees");
    fs.mkdirSync(base);
    const wtPath = path.join(base, scratchDirName(runId));
    await git(repoDir, ["worktree", "add", "--detach", wtPath, sha]);
    writeScratchOwner(wtPath, { ...BASE, owner_run_id: runId, sha });
    const result = validateScratchCwd({
      cwd_override: wtPath,
      owner_run_id: runId,
      expected_common_dir: path.join(tmp, "no-such-common.git"),
    });
    expect(result).toEqual({ ok: false, reason: "common_dir_mismatch" });
  });
});
