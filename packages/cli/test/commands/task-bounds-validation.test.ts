import { describe, expect, test } from "bun:test";

async function runTaskNew(args: string[]) {
  const proc = Bun.spawn(
    ["bun", "packages/cli/bin/penumbra.ts", "task", "new", "--prompt", "x", ...args],
    {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("penumbra task new bounds validation", () => {
  test("invalid --bounds-wall-clock-min exits non-zero with a clear error (not silently dropped)", async () => {
    const result = await runTaskNew(["--bounds-wall-clock-min", "abc"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--bounds-wall-clock-min");
    expect(result.stderr).toContain("positive integer");
    expect(result.stderr).toContain("abc");
  });

  test("invalid --bounds-cost-cents exits non-zero with a clear error", async () => {
    const result = await runTaskNew(["--bounds-cost-cents", "notanumber"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--bounds-cost-cents");
    expect(result.stderr).toContain("non-negative integer");
    expect(result.stderr).toContain("notanumber");
  });

  test("invalid --bounds-sub-dispatches exits non-zero with a clear error", async () => {
    const result = await runTaskNew(["--bounds-sub-dispatches", "1.5"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--bounds-sub-dispatches");
    expect(result.stderr).toContain("positive integer");
    expect(result.stderr).toContain("1.5");
  });

  test("non-positive --bounds-wall-clock-min is rejected (zero is below minimum)", async () => {
    const result = await runTaskNew(["--bounds-wall-clock-min", "0"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--bounds-wall-clock-min");
  });
});
