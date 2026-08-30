import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WorktreeManager } from "@src/worktree/manager.js";

test("WorktreeManager exposes its configured mainRepoDir via a public accessor", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-mainrepodir-"));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-root-"));
  try {
    const manager = new WorktreeManager({ rootDir, mainRepoDir: repoDir });
    expect(manager.mainRepoDir).toBe(repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("WorktreeManager.mainRepoDir defaults to process.cwd() when unset", () => {
  // Pass an explicit rootDir so construction does not scan the real
  // <cwd>-worktrees tree while we assert the default.
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-root-default-"));
  try {
    const manager = new WorktreeManager({ rootDir });
    expect(manager.mainRepoDir).toBe(process.cwd());
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
