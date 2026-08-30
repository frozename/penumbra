import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MachineId } from "@src/identity/machine-id.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-mid-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("reads existing machine-id file and returns its UUID", async () => {
  const idPath = join(dir, "machine-id");
  await Bun.write(idPath, "11111111-1111-4111-8111-111111111111");
  const mid = new MachineId({ storageRoot: dir });
  expect(mid.get()).toBe("11111111-1111-4111-8111-111111111111");
});

test("creates a new machine-id file on first call", () => {
  const mid = new MachineId({ storageRoot: dir, uuid: (): string => "fixed-uuid" });
  expect(mid.get()).toBe("fixed-uuid");
  expect(existsSync(join(dir, "machine-id"))).toBe(true);
  expect(readFileSync(join(dir, "machine-id"), "utf8").trim()).toBe("fixed-uuid");
});

test("subsequent calls return the cached value without re-reading", async () => {
  const mid = new MachineId({ storageRoot: dir, uuid: (): string => "a" });
  expect(mid.get()).toBe("a");
  // Overwrite the file — cache should still return 'a'.
  await Bun.write(join(dir, "machine-id"), "b");
  expect(mid.get()).toBe("a");
});
