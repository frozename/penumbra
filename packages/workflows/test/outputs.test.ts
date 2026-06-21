import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitFileOutput } from "../src/outputs/file.js";
import { emitNextSessionPromptOutput } from "../src/outputs/next-session-prompt.js";

test("emitFileOutput writes path with body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "subdir", "out.md");
    const r = await emitFileOutput({ path: target, body: "hello\n" });
    expect(r.warnings).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("hello\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput defaults to overwrite when mode unspecified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "out.md");
    await Bun.write(target, "first");
    const r = await emitFileOutput({ path: target, body: "second" });
    expect(r.warnings).toEqual([]);
    expect(r.path).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("second");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=overwrite explicitly replaces content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "out.md");
    await Bun.write(target, "first");
    const r = await emitFileOutput({ path: target, body: "second", mode: "overwrite" });
    expect(r.warnings).toEqual([]);
    expect(r.path).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("second");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=append concatenates onto existing content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "out.md");
    await Bun.write(target, "a");
    const r = await emitFileOutput({ path: target, body: "b", mode: "append" });
    expect(r.warnings).toEqual([]);
    expect(r.path).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("ab");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=skip-if-exists is a no-op when target already exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "out.md");
    await Bun.write(target, "a");
    const r = await emitFileOutput({ path: target, body: "b", mode: "skip-if-exists" });
    expect(r.warnings).toEqual([]);
    expect(r.path).toBe(target);
    expect(r.skipped).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=skip-if-exists writes when target does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "out.md");
    const r = await emitFileOutput({ path: target, body: "b", mode: "skip-if-exists" });
    expect(r.warnings).toEqual([]);
    expect(r.path).toBe(target);
    expect(r.skipped).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=unique-suffix writes to base path when target does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "out.md");
    const r = await emitFileOutput({ path: target, body: "b", mode: "unique-suffix" });
    expect(r.warnings).toEqual([]);
    expect(r.path).toBe(target);
    expect(r.skipped).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=unique-suffix writes to -2 when base path exists and preserves extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "out.md");
    await Bun.write(target, "a");
    const r = await emitFileOutput({ path: target, body: "b", mode: "unique-suffix" });
    expect(r.warnings).toEqual([]);

    const expectedPath = join(dir, "out-2.md");
    expect(r.path).toBe(expectedPath);
    expect(r.skipped).toBe(false);

    // Original file untouched
    expect(readFileSync(target, "utf8")).toBe("a");
    // New file created
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf8")).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=unique-suffix writes to -3 when base and -2 exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "out.md");
    const target2 = join(dir, "out-2.md");
    await Bun.write(target, "a");
    await Bun.write(target2, "a2");

    const r = await emitFileOutput({ path: target, body: "b", mode: "unique-suffix" });
    expect(r.warnings).toEqual([]);

    const expectedPath = join(dir, "out-3.md");
    expect(r.path).toBe(expectedPath);
    expect(r.skipped).toBe(false);

    // Original files untouched
    expect(readFileSync(target, "utf8")).toBe("a");
    expect(readFileSync(target2, "utf8")).toBe("a2");
    // New file created
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf8")).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=unique-suffix with NO extension (e.g. NOTES)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "NOTES");
    await Bun.write(target, "a");
    const r = await emitFileOutput({ path: target, body: "b", mode: "unique-suffix" });
    expect(r.warnings).toEqual([]);

    const expectedPath = join(dir, "NOTES-2");
    expect(r.path).toBe(expectedPath);
    expect(r.skipped).toBe(false);

    expect(readFileSync(target, "utf8")).toBe("a");
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf8")).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=unique-suffix with multi-dot filename (e.g. report.v2.md)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "report.v2.md");
    await Bun.write(target, "a");
    const r = await emitFileOutput({ path: target, body: "b", mode: "unique-suffix" });
    expect(r.warnings).toEqual([]);

    const expectedPath = join(dir, "report.v2-2.md");
    expect(r.path).toBe(expectedPath);
    expect(r.skipped).toBe(false);

    expect(readFileSync(target, "utf8")).toBe("a");
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf8")).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=unique-suffix is atomic during a write storm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "out-"));
  try {
    const target = join(dir, "storm.log");
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        emitFileOutput({ path: target, body: `content-${String(i)}`, mode: "unique-suffix" }),
      );
    }
    const results = await Promise.all(promises);

    const paths = results.map((r) => r.path).sort();
    const contents = paths.map((p) => readFileSync(p, "utf8")).sort();

    expect(paths.length).toBe(10);
    expect(new Set(paths).size).toBe(10);
    expect(contents.length).toBe(10);
    expect(new Set(contents).size).toBe(10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitFileOutput on unwritable parent returns warning", async () => {
  const r = await emitFileOutput({ path: "/dev/null/cannot-write/here.md", body: "x" });
  expect(r.warnings.length).toBeGreaterThan(0);
});

test("emitNextSessionPromptOutput writes to ~/.penumbra/pending-handoff.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penum-"));
  try {
    const r = await emitNextSessionPromptOutput({ body: "next prompt body", storageRoot: dir });
    const target = join(dir, "pending-handoff.md");
    expect(r.warnings).toEqual([]);
    expect(r.path).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("next prompt body");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitNextSessionPromptOutput skips write and returns warning when body is empty or whitespace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penum-"));
  try {
    const target = join(dir, "pending-handoff.md");
    await Bun.write(target, "existing content");

    const r1 = await emitNextSessionPromptOutput({ body: "", storageRoot: dir });
    expect(r1.warnings).toEqual([
      "output next-session-prompt: empty body — skipped write to preserve existing artifact",
    ]);
    expect(r1.path).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe("existing content");

    const r2 = await emitNextSessionPromptOutput({ body: "   \n  \t ", storageRoot: dir });
    expect(r2.warnings).toEqual([
      "output next-session-prompt: empty body — skipped write to preserve existing artifact",
    ]);
    expect(r2.path).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe("existing content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
