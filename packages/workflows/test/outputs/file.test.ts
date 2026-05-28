import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitFileOutput } from "../../src/outputs/file.js";

test("emitFileOutput preserves absolute paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-abs-"));
  try {
    const path = join(root, "out.txt");
    const result = await emitFileOutput({ path, body: "abs", repoRoot: join(root, "repo") });
    expect(result.path).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("abs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput resolves relative paths against repoRoot when provided", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-root-"));
  try {
    const repoRoot = join(root, "repo");
    const result = await emitFileOutput({ path: "docs/out.txt", body: "repo", repoRoot });
    const expected = resolve(repoRoot, "docs/out.txt");
    expect(result.path).toBe(expected);
    expect(readFileSync(expected, "utf8")).toBe("repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput keeps legacy cwd-relative behavior without repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-cwd-"));
  try {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const result = await emitFileOutput({ path: "docs/out.txt", body: "cwd" });
      const expected = resolve(realpathSync(root), "docs/out.txt");
      expect(result.path).toBe(expected);
      expect(readFileSync(expected, "utf8")).toBe("cwd");
    } finally {
      process.chdir(cwd);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
