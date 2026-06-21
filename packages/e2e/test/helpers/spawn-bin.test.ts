import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeSandbox } from "./sandbox.js";
import { captureOutput, spawnBun, waitForPortFile } from "./spawn-bin.js";

test("spawnBun runs an inline bun script and exits cleanly", async () => {
  const proc = spawnBun(["-e", "process.exit(0)"]);
  const code = await proc.exited;
  expect(code).toBe(0);
});

test("captureOutput collects stdout from a bun -e script", async () => {
  const proc = spawnBun(["-e", 'console.log("hello"); process.exit(0)']);
  const { stdout } = await captureOutput(proc);
  expect(stdout).toContain("hello");
});

test("waitForPortFile resolves when the file appears with a valid port", async () => {
  const sb = makeSandbox();
  try {
    setTimeout(() => {
      writeFileSync(join(sb.dir, "port"), "54321\n");
    }, 100);
    const port = await waitForPortFile(sb.dir, 2000);
    expect(port).toBe(54321);
  } finally {
    sb.cleanup();
  }
});

test("waitForPortFile rejects after timeout if no file appears", async () => {
  const sb = makeSandbox();
  try {
    let caught: Error | undefined;
    try {
      await waitForPortFile(sb.dir, 200);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/timeout/i);
  } finally {
    sb.cleanup();
  }
});
