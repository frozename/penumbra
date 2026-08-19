import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { executeReadTextFile, ReadTextFileError } from "../../src/adapters/acp-fs.js";
import { expectRejection } from "../helpers/cli-spawn-fixtures.js";

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
    const err = await expectRejection(executeReadTextFile({ path: "/etc/passwd" }, tmp));
    expect(err).toBeInstanceOf(ReadTextFileError);
    expect(err.message).toContain("outside the worktree");
  });

  it("rejects a relative path with .. that resolves outside the worktree", async () => {
    const escape = path.join(tmp, "..", "something.txt");
    await expectRejection(executeReadTextFile({ path: escape }, tmp), "outside the worktree");
  });

  it("rejects a symlink whose realpath is outside the worktree", async () => {
    fs.writeFileSync("/tmp/acp-fs-target.txt", "secret");
    fs.symlinkSync("/tmp/acp-fs-target.txt", path.join(tmp, "link"));
    await expectRejection(
      executeReadTextFile({ path: path.join(tmp, "link") }, tmp),
      "outside the worktree",
    );
    fs.unlinkSync("/tmp/acp-fs-target.txt");
  });

  it('throws ReadTextFileError with code "not_found" for missing file', async () => {
    const err = await expectRejection(
      executeReadTextFile({ path: path.join(tmp, "missing.txt") }, tmp),
    );
    expect(err).toBeInstanceOf(ReadTextFileError);
    if (err instanceof ReadTextFileError) {
      expect(err.code).toBe("not_found");
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
