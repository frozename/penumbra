import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { availableBranchNameBestEffort } from "@src/routes/chains-branch-precheck.js";

const REQUESTED = "feat/full-task-pool_d34db33f";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-branch-precheck-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("returns the requested name when the root is not a git repository", async () => {
  expect(await availableBranchNameBestEffort(tempDir(), REQUESTED)).toBe(REQUESTED);
});

test("returns the requested name when no project root is known", async () => {
  expect(await availableBranchNameBestEffort(undefined, REQUESTED)).toBe(REQUESTED);
});
