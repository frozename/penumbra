import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeReadTextFile, ReadTextFileError } from "../../src/adapters/acp-fs.js";

describe("executeReadTextFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-fs-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads a file inside the worktree given an absolute path", async () => {
    fs.writeFileSync(path.join(tmp, "hello.txt"), "world");
    const result = await executeReadTextFile({ path: path.join(tmp, "hello.txt") }, tmp);
    expect(result.content).toBe("world");
  });

  it("rejects an absolute path outside the worktree", async () => {
    await expect(executeReadTextFile({ path: "/etc/passwd" }, tmp)).rejects.toThrow(
      ReadTextFileError,
    );
    await expect(executeReadTextFile({ path: "/etc/passwd" }, tmp)).rejects.toThrow(
      /outside worktree/i,
    );
  });

  it("rejects a relative path with .. that resolves outside the worktree", async () => {
    const escape = path.join(tmp, "..", "something.txt");
    await expect(executeReadTextFile({ path: escape }, tmp)).rejects.toThrow(/outside worktree/i);
  });

  it("rejects a symlink whose realpath is outside the worktree", async () => {
    fs.writeFileSync("/tmp/acp-fs-target.txt", "secret");
    fs.symlinkSync("/tmp/acp-fs-target.txt", path.join(tmp, "link"));
    await expect(executeReadTextFile({ path: path.join(tmp, "link") }, tmp)).rejects.toThrow(
      /outside worktree/i,
    );
    fs.unlinkSync("/tmp/acp-fs-target.txt");
  });

  it('throws ReadTextFileError with code "not_found" for missing file', async () => {
    try {
      await executeReadTextFile({ path: path.join(tmp, "missing.txt") }, tmp);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReadTextFileError);
      expect((err as ReadTextFileError).code).toBe("not_found");
    }
  });

  it("respects line+limit slicing (1-based line, count = limit)", async () => {
    fs.writeFileSync(path.join(tmp, "multi.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const result = await executeReadTextFile(
      { path: path.join(tmp, "multi.txt"), line: 2, limit: 2 },
      tmp,
    );
    expect(result.content).toBe("two\nthree\n");
  });

  it("returns full file when line/limit absent", async () => {
    fs.writeFileSync(path.join(tmp, "all.txt"), "a\nb\nc\n");
    const result = await executeReadTextFile({ path: path.join(tmp, "all.txt") }, tmp);
    expect(result.content).toBe("a\nb\nc\n");
  });

  it("caps output at 1MB even without explicit limit", async () => {
    const big = "x".repeat(1.5 * 1024 * 1024);
    fs.writeFileSync(path.join(tmp, "big.txt"), big);
    const result = await executeReadTextFile({ path: path.join(tmp, "big.txt") }, tmp);
    expect(result.content.length).toBeLessThanOrEqual(1024 * 1024);
  });
});
