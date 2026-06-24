import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFsGlob } from "../../src/recall-sources/fs.js";

test("fs.glob lists files matching a pattern", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsg-"));
  try {
    mkdirSync(join(dir, "docs/superpowers/specs"), { recursive: true });
    writeFileSync(join(dir, "docs/superpowers/specs/a.md"), "a");
    writeFileSync(join(dir, "docs/superpowers/specs/b.md"), "b");
    const out = await runFsGlob({ cwd: dir, args: { pattern: "docs/superpowers/specs/*.md" } });
    expect(out.matches.sort()).toEqual([
      "docs/superpowers/specs/a.md",
      "docs/superpowers/specs/b.md",
    ]);
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fs.glob with no matches returns empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsg-"));
  try {
    const out = await runFsGlob({ cwd: dir, args: { pattern: "nope/*.x" } });
    expect(out.matches).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fs.glob stops scanning once max_matches is reached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsg-"));
  try {
    let yielded = 0;
    async function* scan(): AsyncIterable<string> {
      for (const path of ["a.md", "b.md", "c.md", "d.md"]) {
        await Promise.resolve();
        yielded += 1;
        yield path;
      }
    }

    const out = await runFsGlob({
      cwd: dir,
      args: { pattern: "*.md", max_matches: 2 },
      scan,
    });

    expect(out.matches).toEqual(["a.md", "b.md"]);
    expect(yielded).toBe(2);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain("fs.glob");
    expect(out.warnings[0]).toContain("truncated");
    expect(out.warnings[0]).toContain("2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fs.glob applies a default max_matches cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsg-"));
  try {
    let yielded = 0;
    async function* scan(): AsyncIterable<string> {
      for (let i = 0; i < 201; i += 1) {
        await Promise.resolve();
        yielded += 1;
        yield `file-${String(i).padStart(3, "0")}.md`;
      }
    }

    const out = await runFsGlob({ cwd: dir, args: { pattern: "*.md" }, scan });

    expect(out.matches).toHaveLength(200);
    expect(yielded).toBe(200);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain("200");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
