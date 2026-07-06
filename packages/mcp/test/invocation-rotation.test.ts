import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { compressStaged, pruneOldRotations, rotateIfNeeded } from "../src/invocation-rotation.js";

let dir = "";

function dayKey(deltaDays: number): string {
  const value = new Date(Date.now() - deltaDays * 86_400_000);
  return value.toISOString().slice(0, 10);
}

describe("invocation rotation", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inv-rotation-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotation produces a gzip with the date in filename and removes the live file", async () => {
    const live = join(dir, "mcp-invocations.jsonl");
    writeFileSync(live, '{"tool":"x"}\n');

    const gzPath = await rotateIfNeeded(live, new Date("2026-01-01T00:00:00.000Z"));

    expect(gzPath).toBe(join(dir, "mcp-invocations.2026-01-01.jsonl.gz"));
    expect(existsSync(gzPath!)).toBe(true);
    expect(existsSync(live)).toBe(false);
    const roundTrip = gunzipSync(readFileSync(gzPath!)).toString("utf8");
    expect(roundTrip).toBe('{"tool":"x"}\n');
  });

  it("pruneOldRotations deletes files older than retainDays", () => {
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(dir, `mcp-invocations.${dayKey(i)}.jsonl.gz`), "fake");
    }

    pruneOldRotations(dir, 14, "mcp-invocations");

    const names = readdirSync(dir);
    expect(names.length).toBe(15);
    expect(names).toContain(`mcp-invocations.${dayKey(0)}.jsonl.gz`);
    expect(names).toContain(`mcp-invocations.${dayKey(14)}.jsonl.gz`);
    expect(names).not.toContain(`mcp-invocations.${dayKey(15)}.jsonl.gz`);
  });

  it("pruneOldRotations leaves the live mcp-invocations.jsonl file untouched", () => {
    const live = join(dir, "mcp-invocations.jsonl");
    writeFileSync(live, '{"tool":"live"}\n');
    writeFileSync(join(dir, `mcp-invocations.${dayKey(99)}.jsonl.gz`), "old");

    pruneOldRotations(dir, 14, "mcp-invocations");

    expect(existsSync(live)).toBe(true);
  });

  it("pruneOldRotations leaves unrelated files untouched", () => {
    const unrelated = ["random.txt", "mcp-invocations.OTHER.gz", "notamatch.jsonl.gz"];
    for (const name of unrelated) {
      writeFileSync(join(dir, name), "keep");
    }
    writeFileSync(join(dir, `mcp-invocations.${dayKey(99)}.jsonl.gz`), "old");

    pruneOldRotations(dir, 14, "mcp-invocations");

    for (const name of unrelated) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
  });

  it("rotateIfNeeded returns null when live path does not exist", async () => {
    const missing = join(dir, "mcp-invocations.jsonl");
    expect(await rotateIfNeeded(missing)).toBeNull();
  });

  it("rotateIfNeeded writes gzip file with 0o600 mode", async () => {
    const live = join(dir, "mcp-invocations.jsonl");
    writeFileSync(live, '{"tool":"x"}\n');

    const gzPath = await rotateIfNeeded(live, new Date("2026-02-02T00:00:00.000Z"));
    expect(readFileSync(gzPath!).byteLength).toBeGreaterThan(0);
    expect(statSync(gzPath!).mode & 0o777).toBe(0o600);
  });

  it("pruneOldRotations keeps the exact retention boundary day", () => {
    const boundary = `mcp-invocations.${dayKey(14)}.jsonl.gz`;
    const old = `mcp-invocations.${dayKey(15)}.jsonl.gz`;
    writeFileSync(join(dir, boundary), "keep");
    writeFileSync(join(dir, old), "drop");

    pruneOldRotations(dir, 14, "mcp-invocations");

    expect(existsSync(join(dir, boundary))).toBe(true);
    expect(existsSync(join(dir, old))).toBe(false);
  });

  it("pruneOldRotations also prunes orphaned dated .jsonl files", () => {
    const keepGz = `mcp-invocations.${dayKey(0)}.jsonl.gz`;
    const oldGz = `mcp-invocations.${dayKey(40)}.jsonl.gz`;
    const oldJsonl = `mcp-invocations.${dayKey(41)}.jsonl`;
    writeFileSync(join(dir, keepGz), "keep");
    writeFileSync(join(dir, oldGz), "drop");
    writeFileSync(join(dir, oldJsonl), "drop");

    pruneOldRotations(dir, 14, "mcp-invocations");

    expect(existsSync(join(dir, keepGz))).toBe(true);
    expect(existsSync(join(dir, oldGz))).toBe(false);
    expect(existsSync(join(dir, oldJsonl))).toBe(false);
  });

  it("rotation/prune derive names from the live basename (non-default path)", async () => {
    const live = join(dir, "custom-invocations.jsonl");
    writeFileSync(live, '{"tool":"x"}\n');

    const gzPath = await rotateIfNeeded(live, new Date("2026-02-03T00:00:00.000Z"));
    expect(gzPath).toBe(join(dir, "custom-invocations.2026-02-03.jsonl.gz"));
    expect(existsSync(gzPath!)).toBe(true);

    writeFileSync(join(dir, `custom-invocations.${dayKey(40)}.jsonl.gz`), "drop");
    writeFileSync(join(dir, `mcp-invocations.${dayKey(40)}.jsonl.gz`), "keep-other-family");
    pruneOldRotations(dir, 14, "custom-invocations");

    expect(existsSync(join(dir, `custom-invocations.${dayKey(40)}.jsonl.gz`))).toBe(false);
    expect(existsSync(join(dir, `mcp-invocations.${dayKey(40)}.jsonl.gz`))).toBe(true);
  });

  it("compressStaged falls back to a uniquely-suffixed name when the primary .gz already exists", async () => {
    const staged = join(dir, "mcp-invocations.2026-05-27.7777.jsonl");
    writeFileSync(staged, '{"tool":"raced"}\n');
    // Simulate a prior rotator having already produced the primary archive.
    const primary = `${staged}.gz`;
    writeFileSync(primary, "prior-archive");

    const gzPath = await compressStaged(staged);

    expect(gzPath).not.toBe(primary);
    expect(gzPath).toMatch(/^.*mcp-invocations\.2026-05-27\.7777-\d+\.jsonl\.gz$/);
    expect(existsSync(gzPath)).toBe(true);
    expect(existsSync(primary)).toBe(true);
    expect(readFileSync(primary, "utf8")).toBe("prior-archive");
    expect(existsSync(staged)).toBe(false);
  });

  it("compressStaged writes a 0o600 gzip and removes the staged file", async () => {
    const staged = join(dir, "mcp-invocations.2026-05-26.jsonl");
    writeFileSync(staged, '{"tool":"x"}\n');

    const gzPath = await compressStaged(staged);
    expect(gzPath).toBe(`${staged}.gz`);
    expect(existsSync(gzPath)).toBe(true);
    expect(existsSync(staged)).toBe(false);
    expect(statSync(gzPath).mode & 0o777).toBe(0o600);
  });
});
