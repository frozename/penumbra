import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAgentSession } from "@src/commands/update/agent-sessions.js";
import { createDefaultHost, defaultExec, defaultFs } from "@src/commands/update/deps.js";
import type { Exec, ExecResult } from "@src/commands/update/types.js";

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

function fakeExec(handlers: Record<string, (argv: readonly string[]) => ExecResult>): Exec {
  return (argv) => {
    const handler = handlers[argv[0] ?? ""];
    if (handler === undefined)
      return Promise.reject(new Error(`unexpected exec ${argv.join(" ")}`));
    return Promise.resolve(handler(argv));
  };
}

describe("createDefaultHost().childProcesses", () => {
  const pids = "111\n222\n";

  test("a failing ps still reports the listed pids so they block", async () => {
    const host = createDefaultHost(
      fakeExec({
        pgrep: () => ({ code: 0, stdout: pids, stderr: "" }),
        ps: () => ({ code: 1, stdout: "", stderr: "ps: operation not permitted" }),
      }),
    );
    const children = await host.childProcesses(999);
    expect(children.map((c) => c.pid).sort()).toEqual([111, 222]);
    expect(children.every((c) => c.ageS === null)).toBe(true);
    const names = new Set(["claude-agent-acp", "codex-acp"]);
    expect(children.every((c) => !isAgentSession(c.argv, names))).toBe(true);
  });

  test("a timed-out ps still reports the listed pids so they block", async () => {
    const host = createDefaultHost(
      fakeExec({
        pgrep: () => ({ code: 0, stdout: pids, stderr: "" }),
        ps: () => ({ code: 124, stdout: "", stderr: "" }),
      }),
    );
    const children = await host.childProcesses(999);
    expect(children.map((c) => c.pid).sort()).toEqual([111, 222]);
  });

  test("a successful ps parses age and argv", async () => {
    const host = createDefaultHost(
      fakeExec({
        pgrep: () => ({ code: 0, stdout: "111\n", stderr: "" }),
        ps: () => ({
          code: 0,
          stdout: " 111 05:07 node /Users/u/.local/bin/claude-agent-acp\n",
          stderr: "",
        }),
      }),
    );
    expect(await host.childProcesses(999)).toEqual([
      { pid: 111, ageS: 307, argv: ["node", "/Users/u/.local/bin/claude-agent-acp"] },
    ]);
  });

  test("no children and a failing pgrep give an empty list", async () => {
    const empty = createDefaultHost(
      fakeExec({
        pgrep: () => ({ code: 1, stdout: "", stderr: "" }),
        ps: () => ({ code: 0, stdout: "", stderr: "" }),
      }),
    );
    expect(await empty.childProcesses(999)).toEqual([]);
    const noKids = createDefaultHost(
      fakeExec({
        pgrep: () => ({ code: 0, stdout: "", stderr: "" }),
        ps: () => ({ code: 0, stdout: "", stderr: "" }),
      }),
    );
    expect(await noKids.childProcesses(999)).toEqual([]);
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
