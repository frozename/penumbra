import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { copyLocalCacheFallback, materializeWorkspaceLinks } from "@src/worktree/manager.js";

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("workspace link creation rejects a package whose real path escapes the worktree", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-link-guard-"));
  const worktreeRoot = path.join(fixtureRoot, "worktree");
  const escapingTarget = path.join(fixtureRoot, "outside-package");
  const linkPath = path.join(worktreeRoot, "node_modules", "@penumbra", "escape");

  try {
    fs.mkdirSync(path.join(worktreeRoot, "packages"), { recursive: true });
    fs.mkdirSync(escapingTarget, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeRoot, "package.json"),
      JSON.stringify({ workspaces: ["packages/escape"] }),
    );
    fs.writeFileSync(
      path.join(escapingTarget, "package.json"),
      JSON.stringify({ name: "@penumbra/escape" }),
    );
    fs.symlinkSync(escapingTarget, path.join(worktreeRoot, "packages", "escape"), "dir");

    let message: string | undefined;
    try {
      materializeWorkspaceLinks(worktreeRoot);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(fs.existsSync(linkPath)).toBe(false);
    expect(message).toMatch(
      new RegExp(`${escapeRegExp(linkPath)}.*${escapeRegExp(escapingTarget)}`),
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("workspace link creation succeeds when the worktree root is reached through a symlink", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-symlink-root-"));
  const realRoot = path.join(fixtureRoot, "real-worktree");
  const symlinkRoot = path.join(fixtureRoot, "link-worktree");
  const linkPath = path.join(symlinkRoot, "node_modules", "@penumbra", "pkg");

  try {
    fs.mkdirSync(path.join(realRoot, "packages", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(realRoot, "package.json"),
      JSON.stringify({ workspaces: ["packages/pkg"] }),
    );
    fs.writeFileSync(
      path.join(realRoot, "packages", "pkg", "package.json"),
      JSON.stringify({ name: "@penumbra/pkg" }),
    );
    fs.symlinkSync(realRoot, symlinkRoot, "dir");

    materializeWorkspaceLinks(symlinkRoot);

    expect(fs.realpathSync.native(linkPath)).toBe(
      fs.realpathSync.native(path.join(realRoot, "packages", "pkg")),
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local cache fallback rejects a source over the byte bound without creating a destination", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-bound-"));
  const mainCachePath = path.join(fixtureRoot, "main-cache");
  const worktreeCachePath = path.join(fixtureRoot, "worktree-cache");

  try {
    fs.mkdirSync(mainCachePath);
    fs.writeFileSync(path.join(mainCachePath, "oversized.bin"), Buffer.alloc(2048));

    let message: string | undefined;
    try {
      copyLocalCacheFallback(mainCachePath, worktreeCachePath, 1024);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(fs.existsSync(worktreeCachePath)).toBe(false);
    expect(message).toMatch(new RegExp(`${escapeRegExp(mainCachePath)}.*\\d+.*1024`));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local cache fallback copies a source under the byte bound", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-copy-"));
  const mainCachePath = path.join(fixtureRoot, "main-cache");
  const worktreeCachePath = path.join(fixtureRoot, "worktree-cache");

  try {
    fs.mkdirSync(mainCachePath);
    fs.writeFileSync(path.join(mainCachePath, "seed.bin"), "seed");

    copyLocalCacheFallback(mainCachePath, worktreeCachePath, 1024);

    expect(fs.readFileSync(path.join(worktreeCachePath, "seed.bin"), "utf8")).toBe("seed");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local cache fallback counts only copied bytes at the byte bound", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-exact-"));
  const mainCachePath = path.join(fixtureRoot, "main-cache");
  const worktreeCachePath = path.join(fixtureRoot, "worktree-cache");

  try {
    fs.mkdirSync(mainCachePath);
    fs.writeFileSync(path.join(mainCachePath, "seed.bin"), "seed");

    copyLocalCacheFallback(mainCachePath, worktreeCachePath, 4);

    expect(fs.readFileSync(path.join(worktreeCachePath, "seed.bin"), "utf8")).toBe("seed");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local cache fallback rejects copied bytes over the byte bound", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-over-"));
  const mainCachePath = path.join(fixtureRoot, "main-cache");
  const worktreeCachePath = path.join(fixtureRoot, "worktree-cache");

  try {
    fs.mkdirSync(mainCachePath);
    fs.writeFileSync(path.join(mainCachePath, "seed.bin"), "seeds");

    let message: string | undefined;
    try {
      copyLocalCacheFallback(mainCachePath, worktreeCachePath, 4);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(fs.existsSync(worktreeCachePath)).toBe(false);
    expect(message).toMatch(new RegExp(`${escapeRegExp(mainCachePath)}.*\\d+.*4`));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
