import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("no-sync-exec lint", () => {
  const SCRIPT = join(import.meta.dir, "no-sync-exec.ts");
  const fixtureRoot = join(tmpdir(), `no-sync-exec-${crypto.randomUUID()}`);

  function run() {
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
      exitCode: result.exitCode ?? -1,
      stdout: new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim(),
      stderr: new TextDecoder().decode(result.stderr ?? new Uint8Array()).trim(),
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
