import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { canonicalizePathForWrite, resolveOutDir, sanitizeFileStem } from "./io.js";

test("sanitizeFileStem normalizes input and falls back to persona", () => {
  expect(sanitizeFileStem("  Foo Bar  ")).toBe("foo-bar");
  expect(sanitizeFileStem("!!!")).toBe("persona");
});

test("canonicalizePathForWrite resolves missing leaf paths from an existing parent", () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-io-"));
  mkdirSync(join(root, "nested"), { recursive: true });

  const expected = resolve(realpathSync(root), "nested", "child", "file.txt");
  expect(canonicalizePathForWrite(join(root, "nested", "child", "file.txt"))).toBe(expected);

  rmSync(root, { recursive: true, force: true });
});

test("resolveOutDir accepts paths inside cwd and rejects traversal or symlink escapes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "penumbra-workspace-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-storage-"));
  const external = mkdtempSync(join(tmpdir(), "penumbra-external-"));

  mkdirSync(join(workspace, ".penumbra", "reviews"), { recursive: true });
  symlinkSync(external, join(workspace, ".penumbra", "reviews", "escape"));

  expect(resolveOutDir({ cwd: workspace, storageRoot } as any, "reports/run-1")).toEqual({
    ok: true,
    path: canonicalizePathForWrite(resolve(workspace, "reports/run-1")),
  });
  expect(resolveOutDir({ cwd: workspace, storageRoot } as any, "../outside")).toEqual({
    ok: false,
  });
  expect(
    resolveOutDir({ cwd: workspace, storageRoot } as any, ".penumbra/reviews/escape/run-1"),
  ).toEqual({
    ok: false,
  });

  rmSync(workspace, { recursive: true, force: true });
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

test("resolveOutDir returns the canonical path for writes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "penumbra-workspace-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-storage-"));
  mkdirSync(join(workspace, "nested"), { recursive: true });
  const result = resolveOutDir({ cwd: workspace, storageRoot } as any, "./nested/../nested/run-1");
  expect(result).toEqual({
    ok: true,
    path: canonicalizePathForWrite(join(workspace, "nested", "run-1")),
  });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(storageRoot, { recursive: true, force: true });
});
