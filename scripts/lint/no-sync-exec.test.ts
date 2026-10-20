import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("no-sync-exec lint", () => {
  const SCRIPT = join(import.meta.dir, "no-sync-exec.ts");
  const fixtureRoot = join(tmpdir(), `no-sync-exec-${crypto.randomUUID()}`);

  function run(): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT],
      env: {
        ...process.env,
        PENUMBRA_LINT_NO_SYNC_EXEC_ROOT: fixtureRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
    };
  }

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("flags synchronous subprocess calls in packages/daemon/src", async () => {
    const dir = join(fixtureRoot, "packages", "daemon", "src");
    mkdirSync(dir, { recursive: true });
    await Bun.write(
      join(dir, "index.ts"),
      [
        'import { execSync, spawnSync } from "child_process";',
        'const first = Bun.spawnSync(["sh", ["-c", "true"]]);',
        'const second = execSync("true");',
        'const third = spawnSync("true");',
        'await Bun.spawn(["sh", ["-c", "true"]]);',
      ].join("\n"),
    );

    const result = run();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packages/daemon/src/index.ts:1");
    expect(result.stderr).toContain("packages/daemon/src/index.ts:2");
    expect(result.stderr).toContain("packages/daemon/src/index.ts:3");
    expect(result.stderr).toContain("packages/daemon/src/index.ts:4");
  });

  function flaggedLines(stderr: string): number[] {
    const lines = stderr
      .split("\n")
      .map((entry) => /^packages\/daemon\/src\/index\.ts:(\d+) /.exec(entry)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    return [...new Set(lines)].toSorted((a, b) => a - b);
  }

  test("flags sync child_process calls from either specifier in every import style", async () => {
    const dir = join(fixtureRoot, "packages", "daemon", "src");
    mkdirSync(dir, { recursive: true });
    await Bun.write(
      join(dir, "index.ts"),
      [
        'import { execFileSync } from "node:child_process";',
        'import { execFileSync as runSync } from "node:child_process";',
        'import * as cp from "node:child_process";',
        'cp.execFileSync("git", ["status"]);',
        'import childProcess from "node:child_process";',
        'childProcess.execSync("true");',
        'const { execFileSync: required } = require("child_process");',
        'const { spawnSync: dynamicSpawn } = await import("node:child_process");',
        "import {",
        "  execFileSync as multiLine,",
        '} from "child_process";',
        'cp["execFileSync"]("git", ["status"]);',
      ].join("\n"),
    );

    const result = run();

    expect(result.exitCode).toBe(1);
    expect(flaggedLines(result.stderr)).toEqual([1, 2, 4, 6, 7, 8, 10, 12]);
  });

  test("allows async child_process imports from node:child_process", async () => {
    const dir = join(fixtureRoot, "packages", "daemon", "src");
    mkdirSync(dir, { recursive: true });
    await Bun.write(
      join(dir, "index.ts"),
      [
        'import { execFile as execFileCb, spawn } from "node:child_process";',
        'import { promisify } from "node:util";',
        "const execFile = promisify(execFileCb);",
        'await execFile("git", ["status"]);',
        'spawn("true");',
      ].join("\n"),
    );

    const result = run();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no sync exec violations found");
  });

  test("ignores files outside packages/daemon/src", async () => {
    const dir = join(fixtureRoot, "scripts", "lint");
    mkdirSync(dir, { recursive: true });
    await Bun.write(
      join(dir, "index.ts"),
      [
        'import { execSync } from "child_process";',
        'const value = Bun.spawnSync(["sh", ["-c", "true"]]);',
        'const other = execSync("true");',
      ].join("\n"),
    );

    const result = run();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no sync exec violations found");
  });
});
