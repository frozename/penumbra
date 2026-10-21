import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultExec, defaultFs } from "@src/commands/update/deps.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-update-"));
  dirs.push(dir);
  return dir;
}

describe("defaultExec", () => {
  test("captures exit code, stdout and stderr", async () => {
    expect(await defaultExec(["sh", "-c", "echo out; echo err >&2; exit 3"])).toEqual({
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  test("aborting the signal terminates the child", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => {
      controller.abort("SIGINT");
    }, 50);
    const res = await defaultExec(["sleep", "5"], { signal: controller.signal });
    expect(res.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a missing binary is exit 127, a timeout is exit 124", async () => {
    expect((await defaultExec(["penumbra-update-no-such-binary"])).code).toBe(127);
    expect((await defaultExec(["sleep", "5"], { timeoutMs: 50 })).code).toBe(124);
  });
});

describe("defaultFs", () => {
  test("appends with parent directories and reads from a byte offset", async () => {
    const dir = tempDir();
    const path = join(dir, "nested", "update-history.log");
    await defaultFs.appendText(path, "one\n");
    await defaultFs.appendText(path, "two\n");
    expect(await defaultFs.readText(path)).toBe("one\ntwo\n");
    expect(await defaultFs.size(path)).toBe(8);
    expect(await defaultFs.readFrom(path, 4)).toBe("two\n");
  });

  test("missing files read as null / empty", async () => {
    const dir = tempDir();
    expect(await defaultFs.readText(join(dir, "nope"))).toBeNull();
    expect(await defaultFs.size(join(dir, "nope"))).toBeNull();
    expect(await defaultFs.readFrom(join(dir, "nope"), 0)).toBe("");
    writeFileSync(join(dir, "port"), "1234\n");
    expect(await defaultFs.realpath(join(dir, ".", "port"))).toBe(
      join(await defaultFs.realpath(dir), "port"),
    );
  });
});
