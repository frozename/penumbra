import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FsPathError, resolveInsideWorktree } from "../src/fs-paths.js";

describe("resolveInsideWorktree", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-paths-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves an absolute path inside the worktree to its realpath", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "x");
    const real = await resolveInsideWorktree(path.join(tmp, "a.txt"), tmp);
    expect(real).toBe(fs.realpathSync(path.join(tmp, "a.txt")));
  });

  it("rejects an absolute path outside the worktree", async () => {
    try {
      await resolveInsideWorktree("/etc/passwd", tmp);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe("outside_worktree");
      expect((err as FsPathError).message).toBe("path is outside the worktree");
      expect((err as FsPathError).message).not.toContain("/etc/passwd");
    }
  });

  it("rejects a missing relative-with-.. path as outside_worktree (security-first)", async () => {
    // Even when the leaf doesn't exist, a path whose textual form escapes the
    // worktree should be flagged as outside_worktree, not not_found. The helper
    // realpaths the parent dir to keep canonical platform translation working
    // (e.g. macOS /var -> /private/var) without losing escape detection.
    const escape = path.join(tmp, "..", "something.txt");
    try {
      await resolveInsideWorktree(escape, tmp);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe("outside_worktree");
      expect((err as FsPathError).message).toBe("path is outside the worktree");
    }
  });

  it("rejects a symlink whose realpath is outside the worktree", async () => {
    fs.writeFileSync("/tmp/fs-paths-target.txt", "secret");
    fs.symlinkSync("/tmp/fs-paths-target.txt", path.join(tmp, "link"));
    try {
      await resolveInsideWorktree(path.join(tmp, "link"), tmp);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe("outside_worktree");
      expect((err as FsPathError).message).toBe("path is outside the worktree");
    } finally {
      fs.unlinkSync("/tmp/fs-paths-target.txt");
    }
  });

  it("accepts a path already inside a symlinked worktree after realpath resolution", async () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-paths-real-"));
    const symlinkRoot = path.join(tmp, "alias");
    fs.symlinkSync(realRoot, symlinkRoot);
    fs.mkdirSync(path.join(realRoot, "nested"));
    fs.writeFileSync(path.join(realRoot, "nested", "file.txt"), "x");

    const resolved = await resolveInsideWorktree(
      path.join(realRoot, "nested", "file.txt"),
      symlinkRoot,
    );
    expect(resolved).toBe(fs.realpathSync(path.join(realRoot, "nested", "file.txt")));
  });

  it('throws FsPathError with code "not_found" for missing path', async () => {
    try {
      await resolveInsideWorktree(path.join(tmp, "nope.txt"), tmp);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe("not_found");
    }
  });

  it("uses the identical generic error for existing and nonexistent outside paths", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-paths-outside-"));
    const existingOutside = path.join(outsideDir, "secret.txt");
    const missingOutside = path.join(outsideDir, "missing.txt");
    fs.writeFileSync(existingOutside, "secret");

    async function capture(userPath: string): Promise<{ code: string; message: string }> {
      try {
        await resolveInsideWorktree(userPath, tmp);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(FsPathError);
        return { code: (err as FsPathError).code, message: (err as FsPathError).message };
      }
    }

    try {
      const existing = await capture(existingOutside);
      const missing = await capture(missingOutside);

      expect(existing).toEqual({
        code: "outside_worktree",
        message: "path is outside the worktree",
      });
      expect(missing).toEqual(existing);
      expect(existing.message).not.toContain(outsideDir);
      expect(missing.message).not.toContain(outsideDir);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
