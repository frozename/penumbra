import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitFileOutput } from "../../src/outputs/file.js";

test("emitFileOutput rejects absolute path outside repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-abs-"));
  try {
    const repoRoot = join(root, "repo");
    const outsidePath = join(root, "outside.txt");
    const result = await emitFileOutput({ path: outsidePath, body: "should-not-write", repoRoot });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.path).toBeUndefined();
    expect(existsSync(outsidePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput allows absolute path that is inside repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-abs-in-"));
  try {
    const repoRoot = join(root, "repo");
    await mkdir(repoRoot, { recursive: true });
    const insidePath = join(repoRoot, "docs", "out.txt");
    const result = await emitFileOutput({ path: insidePath, body: "inside", repoRoot });
    expect(result.warnings).toEqual([]);
    expect(result.path).toBe(insidePath);
    expect(readFileSync(insidePath, "utf8")).toBe("inside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput rejects writing through a symlink that resolves outside repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-symlink-out-"));
  try {
    const repoRoot = join(root, "repo");
    const outside = join(root, "outside");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    symlinkSync(outside, join(repoRoot, "escape"));

    const result = await emitFileOutput({
      path: "escape/out.txt",
      body: "should-not-write",
      repoRoot,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.path).toBeUndefined();
    expect(existsSync(join(outside, "out.txt"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput allows writing through a symlink that resolves inside repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-symlink-in-"));
  try {
    const repoRoot = join(root, "repo");
    const target = join(repoRoot, "inside-target");
    await mkdir(target, { recursive: true });
    symlinkSync(target, join(repoRoot, "inside-link"));

    const result = await emitFileOutput({
      path: "inside-link/out.txt",
      body: "inside",
      repoRoot,
    });

    expect(result.warnings).toEqual([]);
    expect(result.path).toBe(join(repoRoot, "inside-link", "out.txt"));
    expect(readFileSync(join(target, "out.txt"), "utf8")).toBe("inside");
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
