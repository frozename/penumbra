import { describe, expect, test } from "bun:test";

// A handoff id that cannot resolve, so the command always fails downstream of the
// --mode check. These tests assert ONLY on the arg validator, never on a real land.
const UNRESOLVABLE_HANDOFF = "00000000-0000-0000-0000-000000000000";

async function runDispatchLand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    [
      "bun",
      "packages/cli/bin/penumbra.ts",
      "dispatch",
      "land",
      UNRESOLVABLE_HANDOFF,
      "--message",
      "test only, never lands",
      ...args,
    ],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("penumbra dispatch land --mode validation", () => {
  test("rejects an unknown mode and names every accepted value", async () => {
    const result = await runDispatchLand(["--mode", "bogus"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--mode");
    expect(result.stderr).toContain("bogus");
    // The error must enumerate gh, otherwise the CLI advertises a smaller surface
    // than the daemon accepts (packages/daemon/src/routes/dispatch-land.ts).
    expect(result.stderr).toContain("gh");
  });

  test("accepts --mode gh (the daemon and RunDispatchLandOpts both support it)", async () => {
    const result = await runDispatchLand(["--mode", "gh"]);
    // It still fails — the handoff cannot resolve — but it must NOT fail at the
    // arg validator. PR 175 added gh to the daemon route, the MCP tool and the CLI
    // type but left bin/penumbra.ts rejecting it, making the surface dead.
    expect(result.stderr).not.toContain("--mode must be");
  });

  test("still accepts the pre-existing modes", async () => {
    for (const mode of ["squash", "ff"]) {
      const result = await runDispatchLand(["--mode", mode]);
      expect(result.stderr).not.toContain("--mode must be");
    }
  });
});
