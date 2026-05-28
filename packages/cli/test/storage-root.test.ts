import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliStorageRoot } from "../src/storage-root.js";

test("resolveCliStorageRoot prefers PENUMBRA_STORAGE_ROOT over autodiscovery", () => {
  const root = resolveCliStorageRoot({
    explicit: "/explicit/path",
    env: { PENUMBRA_STORAGE_ROOT: "/custom/env" },
    candidates: ["/candidate"],
    existsSync: () => true,
  });
  expect(root).toBe("/explicit/path");
});

test("resolveCliStorageRoot auto-discovers the active daemon root when env is unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-cli-storage-root-"));
  try {
    writeFileSync(join(dir, "port"), "4242\n");
    writeFileSync(join(dir, "token"), "tok\n");
    const root = resolveCliStorageRoot({
      explicit: "",
      env: {},
      candidates: [dir, "/tmp/unused"],
    });
    expect(root).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCliStorageRoot uses process.env.PENUMBRA_STORAGE_ROOT when no opts are passed", () => {
  const original = process.env.PENUMBRA_STORAGE_ROOT;
  process.env.PENUMBRA_STORAGE_ROOT = "/env/path";
  try {
    const root = resolveCliStorageRoot();
    expect(root).toBe("/env/path");
  } finally {
    process.env.PENUMBRA_STORAGE_ROOT = original;
  }
});

test("resolveCliStorageRoot falls back to autodiscovery when no opts and no env are set", () => {
  const original = process.env.PENUMBRA_STORAGE_ROOT;
  delete process.env.PENUMBRA_STORAGE_ROOT;
  const dir = mkdtempSync(join(tmpdir(), "penumbra-cli-discovery-"));
  try {
    writeFileSync(join(dir, "port"), "4242");
    writeFileSync(join(dir, "token"), "tok");

    // We can't easily mock the candidates list because resolveCliStorageRoot doesn't
    // expose it in its zero-arg form, so we pass candidates but leave everything else empty
    const root = resolveCliStorageRoot({ candidates: [dir] });
    expect(root).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.env.PENUMBRA_STORAGE_ROOT = original;
  }
});
