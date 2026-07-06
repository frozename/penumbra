import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonHandle } from "../../daemon/src/serve.js";

import { runStop } from "../src/commands/stop.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-stop-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("pid and port files are removed even when handle.stop() throws", async () => {
  const pidPath = join(dir, "pid");
  const portPath = join(dir, "port");
  writeFileSync(pidPath, "99999\n");
  writeFileSync(portPath, "12345\n");

  const throwingHandle: DaemonHandle = {
    port: 12345,
    stop: () => {
      throw new Error("supervisor exploded");
    },
  };

  // runStop should propagate the throw but still clean up the files.
  let err: unknown;
  try {
    await runStop({ storageRoot: dir, handle: throwingHandle });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect(String(err)).toContain("supervisor exploded");

  expect(existsSync(pidPath)).toBe(false);
  expect(existsSync(portPath)).toBe(false);
});

test("runStop awaits handle.stop() before resolving", async () => {
  let teardownComplete = false;
  const handle: DaemonHandle = {
    port: 12345,
    stop: async () => {
      await new Promise((r) => setTimeout(r, 50));
      teardownComplete = true;
    },
  };

  await runStop({ storageRoot: dir, handle });
  expect(teardownComplete).toBe(true);
});

test("pid and port files are removed when handle is absent", async () => {
  const pidPath = join(dir, "pid");
  const portPath = join(dir, "port");
  // Use a near-impossible pid so kill() throws ESRCH and is swallowed.
  writeFileSync(pidPath, "2147483640\n");
  writeFileSync(portPath, "12345\n");

  const result = await runStop({ storageRoot: dir });
  expect(result).toBe(0);
  expect(existsSync(pidPath)).toBe(false);
  expect(existsSync(portPath)).toBe(false);
});
