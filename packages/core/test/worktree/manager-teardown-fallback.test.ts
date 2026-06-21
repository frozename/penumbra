import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Logger } from "../../src/logger.js";

import { type WorktreeHandle, WorktreeManager } from "../../src/worktree/manager.js";

interface WarnEntry {
  obj: unknown;
  msg: string;
}

describe("WorktreeManager teardown fallback", () => {
  let rootDir: string;
  let repoDir: string;
  let fakeBinDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-fallback-root-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-fallback-repo-"));
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-fallback-bin-"));
    originalPath = process.env.PATH;
    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ workspaces: [] }, null, 2),
    );

    const gitScript = [
      "#!/bin/sh",
      'cmd="$*"',
      'case "$cmd" in',
      '  *"checkout bun.lock"*)',
      "    exit 1",
      "    ;;",
      '  *"worktree remove --force "*)',
      "    target=${cmd##*worktree remove --force }",
      '    target=${target%\\"}',
      '    target=${target#\\"}',
      '    rm -rf "$target"',
      "    exit 0",
      "    ;;",
      '  *"worktree remove "*)',
      "    exit 1",
      "    ;;",
      '  *"branch -D "*)',
      "    exit 0",
      "    ;;",
      '  *"rev-parse --verify --quiet "*)',
      "    exit 1",
      "    ;;",
      "  *)",
      "    exit 0",
      "    ;;",
      "esac",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(fakeBinDir, "git"), gitScript, { mode: 0o755 });
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });

  test("logs checkout failure and retries worktree remove with --force", async () => {
    const warns: WarnEntry[] = [];
    // The test only needs warn() to capture observations; info/debug/etc. are
    // unused by teardown's instrumentation but pino's Logger surface is wide.
    const stubLogger = {
      warn: (obj: unknown, msg: string): void => {
        warns.push({ obj, msg });
      },
      info: (): void => {
        /* unused */
      },
      debug: (): void => {
        /* unused */
      },
    } as unknown as Logger;
    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
      log: stubLogger,
    });
    const handoffId = "11111111-1111-4111-8111-111111111111";
    const worktreePath = path.join(rootDir, handoffId);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, ".git"), "gitdir: /tmp/fake.git\n");
    fs.writeFileSync(path.join(worktreePath, "bun.lock"), "tracked\n");
    fs.mkdirSync(path.join(worktreePath, ".test-storage"), { recursive: true });
    // worktrees is private; the test seeds an entry to exercise the teardown
    // path that runs against an already-tracked worktree.
    (manager as unknown as { worktrees: Map<string, WorktreeHandle> }).worktrees.set(handoffId, {
      handoffId,
      path: worktreePath,
      branchName: `agent/${handoffId}`,
      storageRoot: path.join(worktreePath, ".test-storage"),
      createdAt: new Date().toISOString(),
      status: "created",
      worktreeMode: "symlink_mirror",
    });

    const result = await manager.teardownWorktree(handoffId, false);

    expect(result).toEqual({ worktreeRemoved: true, branchDeleted: true });
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      warns.some(({ msg }) => msg === "failed to restore bun.lock before worktree removal"),
    ).toBe(true);
    expect(
      warns.some(
        ({ msg }) => msg === "worktree remove failed without force; retrying with --force",
      ),
    ).toBe(true);
  });
});
