import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
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
