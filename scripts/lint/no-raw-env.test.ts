import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("no-raw-env lint", () => {
  const SCRIPT = join(import.meta.dir, "no-raw-env.ts");
  const fixtureRoot = join(tmpdir(), `no-raw-env-${crypto.randomUUID()}`);

  function run(
    paths: string,
    extraArgs: string[] = [],
  ): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT, "--paths", paths, ...extraArgs],
      env: {
        ...process.env,
        PENUMBRA_LINT_NO_RAW_ENV_ROOT: fixtureRoot,
        PENUMBRA_LINT_NO_RAW_ENV_STRICT: "1",
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

  test("flags raw PENUMBRA env reads outside packages/config", async () => {
    const file = join(fixtureRoot, "packages", "feature", "src", "index.ts");
    mkdirSync(join(fixtureRoot, "packages", "feature", "src"), {
      recursive: true,
    });
    await Bun.write(file, "const token = process.env.PENUMBRA_TEST_TOKEN;\nconsole.log(token);\n");

    const result = run("packages/**/*.ts");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packages/feature/src/index.ts:1");
    expect(result.stderr).toContain("process.env.PENUMBRA_TEST_TOKEN");
  });

  test("allowlist matches nested paths under packages/config/**", async () => {
    const file = join(fixtureRoot, "packages", "config", "test", "nested", "deep.test.ts");
    mkdirSync(join(fixtureRoot, "packages", "config", "test", "nested"), {
      recursive: true,
    });
    await Bun.write(file, "const token = process.env.PENUMBRA_TEST_TOKEN;\nconsole.log(token);\n");

    const result = run("packages/**/*.ts");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no raw PENUMBRA env reads found");
  });

  test("allows clean fixture trees", async () => {
    const file = join(fixtureRoot, "packages", "feature", "src", "index.ts");
    mkdirSync(join(fixtureRoot, "packages", "feature", "src"), {
      recursive: true,
    });
    await Bun.write(file, "export const ok = true;\n");

    const result = run("packages/**/*.ts");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no raw PENUMBRA env reads found");
  });
});
