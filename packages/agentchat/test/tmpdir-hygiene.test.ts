import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dir, "..");

async function runIsolated(relFile: string): Promise<{ leftovers: string[]; output: string }> {
  const fresh = mkdtempSync(join(tmpdir(), "agentchat-hygiene-"));
  try {
    const proc = Bun.spawn([process.execPath, "test", relFile], {
      cwd: PKG_ROOT,
      env: { ...process.env, TMPDIR: fresh },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = out + err;
    const leftovers = readdirSync(fresh).sort();
    return { leftovers, output };
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

async function expectTmpdirEmptyAfterRun(relFile: string): Promise<void> {
  const { leftovers, output } = await runIsolated(relFile);
  expect(output).toMatch(/\b[1-9]\d* pass\b/);
  if (leftovers.length > 0) {
    console.error(`child output tail:\n${output.slice(-2000)}`);
  }
  expect(leftovers).toEqual([]);
}

describe("agentchat TMPDIR hygiene", () => {
  test("config/load.test.ts leaves TMPDIR empty", async () => {
    await expectTmpdirEmptyAfterRun("./test/config/load.test.ts");
  }, 60_000);

  test("config/long-lived-config.test.ts leaves TMPDIR empty", async () => {
    await expectTmpdirEmptyAfterRun("./test/config/long-lived-config.test.ts");
  }, 60_000);

  test("in-process-daemon setup failure leaves TMPDIR empty", async () => {
    await expectTmpdirEmptyAfterRun("./test/fixtures/daemon-setup-throws.fixture.ts");
  }, 60_000);
});
