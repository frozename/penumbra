import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { executeGlob, executeGrep, type GrepResult } from "../src/fs-search.js";

const originalGlobScan = Object.getOwnPropertyDescriptor(Bun.Glob.prototype, "scan");
const originalGlobScanSync = Object.getOwnPropertyDescriptor(Bun.Glob.prototype, "scanSync");

function restoreGlobPrototype(): void {
  if (originalGlobScan) Object.defineProperty(Bun.Glob.prototype, "scan", originalGlobScan);
  if (originalGlobScanSync)
    Object.defineProperty(Bun.Glob.prototype, "scanSync", originalGlobScanSync);
}

function restoreEnv(key: "PENUMBRA_RG_BINARY" | "ARGS_FILE", value: string | undefined): void {
  if (key === "PENUMBRA_RG_BINARY") {
    if (value === undefined) {
      delete process.env.PENUMBRA_RG_BINARY;
    } else {
      process.env.PENUMBRA_RG_BINARY = value;
    }
    return;
  }

  if (value === undefined) {
    delete process.env.ARGS_FILE;
  } else {
    process.env.ARGS_FILE = value;
  }
}

function resultPaths(r: GrepResult): string[] {
  return r.results.map((x) => (typeof x === "string" ? x : x.path)).sort();
}

describe("executeGlob", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-glob-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreGlobPrototype();
  });

  it("returns paths matching a simple pattern, relative to worktree", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "x");
    fs.writeFileSync(path.join(tmp, "b.md"), "y");
    const r = await executeGlob({ pattern: "*.ts" }, tmp);
    expect(r.results).toEqual(["a.ts"]);
    expect(r.truncated).toBe(false);
  });

  it("uses async glob scanning and still returns matching files", async () => {
    fs.writeFileSync(path.join(tmp, "async.ts"), "x");
    fs.writeFileSync(path.join(tmp, "skip.md"), "y");

    const originalScanSync = Object.getOwnPropertyDescriptor(Bun.Glob.prototype, "scanSync");
    const originalScan = Object.getOwnPropertyDescriptor(Bun.Glob.prototype, "scan");
    Object.defineProperty(Bun.Glob.prototype, "scanSync", {
      configurable: true,
      value: (): never => {
        throw new Error("scanSync should not be called");
      },
      writable: true,
    });
    Object.defineProperty(Bun.Glob.prototype, "scan", {
      configurable: true,
      value: async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "async.ts";
      },
      writable: true,
    });

    try {
      const r = await executeGlob({ pattern: "*.ts" }, tmp);
      expect(r.results).toEqual(["async.ts"]);
    } finally {
      if (originalScanSync) Object.defineProperty(Bun.Glob.prototype, "scanSync", originalScanSync);
      if (originalScan) Object.defineProperty(Bun.Glob.prototype, "scan", originalScan);
    }
  });

  it("leaves Bun.Glob scan usable after prototype override tests", async () => {
    fs.writeFileSync(path.join(tmp, "usable.ts"), "x");
    const glob = new Bun.Glob("*.ts");
    const results: string[] = [];

    for await (const rel of glob.scan({ cwd: tmp, onlyFiles: true })) {
      results.push(rel);
    }

    expect(results).toEqual(["usable.ts"]);
  });

  it("matches recursive ** patterns", async () => {
    fs.mkdirSync(path.join(tmp, "nested"));
    fs.writeFileSync(path.join(tmp, "nested/c.ts"), "x");
    fs.writeFileSync(path.join(tmp, "d.ts"), "y");
    const r = await executeGlob({ pattern: "**/*.ts" }, tmp);
    expect(r.results.sort()).toEqual(["d.ts", "nested/c.ts"]);
  });

  it("sorts results by mtime descending", async () => {
    fs.writeFileSync(path.join(tmp, "old.ts"), "x");
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmp, "old.ts"), oldTime, oldTime);
    fs.writeFileSync(path.join(tmp, "new.ts"), "y");
    const r = await executeGlob({ pattern: "*.ts" }, tmp);
    expect(r.results).toEqual(["new.ts", "old.ts"]);
  });

  it("honors .gitignore by default", async () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "ignored.ts\n");
    fs.writeFileSync(path.join(tmp, "kept.ts"), "x");
    fs.writeFileSync(path.join(tmp, "ignored.ts"), "y");
    const r = await executeGlob({ pattern: "*.ts" }, tmp);
    expect(r.results).toEqual(["kept.ts"]);
  });

  it("honors nested .gitignore files", async () => {
    fs.mkdirSync(path.join(tmp, "subdir"));
    fs.writeFileSync(path.join(tmp, ".gitignore"), "*.log\n");
    fs.writeFileSync(path.join(tmp, "kept.txt"), "x");
    fs.writeFileSync(path.join(tmp, "ignored.log"), "y");
    fs.writeFileSync(path.join(tmp, "subdir", ".gitignore"), "*.tmp\n");
    fs.writeFileSync(path.join(tmp, "subdir", "kept.txt"), "z");
    fs.writeFileSync(path.join(tmp, "subdir", "ignored.tmp"), "w");

    const r = await executeGlob({ pattern: "**/*" }, tmp);
    expect(r.results.sort()).toEqual(["kept.txt", "subdir/kept.txt"]);
  });

  it("respects negated patterns in .gitignore", async () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "*.log\n!important.log\n");
    fs.writeFileSync(path.join(tmp, "important.log"), "x");
    fs.writeFileSync(path.join(tmp, "other.log"), "y");

    const r = await executeGlob({ pattern: "*.log" }, tmp);
    expect(r.results).toEqual(["important.log"]);
  });

  it("ignores files under a gitignored directory without descending into it", async () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "vendor/\n");
    fs.mkdirSync(path.join(tmp, "vendor", "deep"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "vendor", "deep", "x.ts"), "x");
    fs.writeFileSync(path.join(tmp, "kept.ts"), "y");

    const spy = spyOn(fsp, "readdir");
    try {
      const r = await executeGlob({ pattern: "**/*.ts" }, tmp);
      expect(r.results).toEqual(["kept.ts"]);
      const visited = spy.mock.calls.map((call) => String(call[0]));
      expect(visited.length).toBeGreaterThan(0);
      expect(visited.some((d) => d.includes(path.join("vendor", "deep")))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("applies .gitignore files inside dot-directories", async () => {
    fs.mkdirSync(path.join(tmp, ".husky", "_"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".husky", "_", ".gitignore"), "*\n");
    fs.writeFileSync(path.join(tmp, ".husky", "_", "husky.sh"), "x");
    fs.writeFileSync(path.join(tmp, ".husky", "pre-commit"), "y");

    const r = await executeGlob({ pattern: ".husky/**" }, tmp);
    expect(r.results).toEqual([".husky/pre-commit"]);
  });

  it("does not descend into .git while collecting .gitignore files", async () => {
    fs.mkdirSync(path.join(tmp, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "kept.ts"), "y");

    const spy = spyOn(fsp, "readdir");
    try {
      const r = await executeGlob({ pattern: "*.ts" }, tmp);
      expect(r.results).toEqual(["kept.ts"]);
      const visited = spy.mock.calls.map((call) => String(call[0]));
      expect(visited.some((d) => d.includes(".git"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("applies ancestor .gitignore rules when scoped to a subdirectory", async () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "*.log\n");
    fs.mkdirSync(path.join(tmp, "sub"));
    fs.writeFileSync(path.join(tmp, "sub", "kept.ts"), "x");
    fs.writeFileSync(path.join(tmp, "sub", "ignored.log"), "y");
    const r = await executeGlob({ pattern: "*", path: "sub" }, tmp);
    expect(r.results).toEqual(["sub/kept.ts"]);
  });

  it("include_ignored=true overrides .gitignore", async () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "ignored.ts\n");
    fs.writeFileSync(path.join(tmp, "kept.ts"), "x");
    fs.writeFileSync(path.join(tmp, "ignored.ts"), "y");
    const r = await executeGlob({ pattern: "*.ts", include_ignored: true }, tmp);
    expect(r.results.sort()).toEqual(["ignored.ts", "kept.ts"]);
  });

  it("caps at default 1000 and sets truncated=true when more matches exist", async () => {
    for (let i = 0; i < 1005; i++) {
      fs.writeFileSync(path.join(tmp, `f${String(i)}.txt`), "x");
    }
    const r = await executeGlob({ pattern: "*.txt" }, tmp);
    expect(r.results.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it("respects a smaller max_results override", async () => {
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(tmp, `f${String(i)}.txt`), "x");
    }
    const r = await executeGlob({ pattern: "*.txt", max_results: 10 }, tmp);
    expect(r.results.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it("skips broken symlinks silently", async () => {
    fs.symlinkSync("/nonexistent/path", path.join(tmp, "broken"));
    fs.writeFileSync(path.join(tmp, "real.txt"), "x");
    const r = await executeGlob({ pattern: "*" }, tmp);
    expect(r.results).toContain("real.txt");
  });

  it("returns empty results for non-matching pattern", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "x");
    const r = await executeGlob({ pattern: "*.py" }, tmp);
    expect(r.results).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("does not escape the worktree via ../ glob pattern", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "fs-glob-parent-"));
    const wt = path.join(parent, "wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(parent, "secret.txt"), "x");
    try {
      const r = await executeGlob({ pattern: "../*.txt" }, wt);
      expect(r.results).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not leak sibling-worktree files via a ../** glob", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "fs-glob-parent-"));
    const wt = path.join(parent, "wt");
    const sibling = path.join(parent, "sibling");
    fs.mkdirSync(wt);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "leaked.txt"), "y");
    fs.writeFileSync(path.join(wt, "kept.txt"), "z");
    try {
      const r = await executeGlob({ pattern: "../**/*.txt" }, wt);
      expect(r.results.some((p) => p.startsWith("..") || path.isAbsolute(p))).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("executeGrep", () => {
  let tmp: string;
  let originalRgBinary: string | undefined;
  let originalArgsFile: string | undefined;

  beforeEach(() => {
    originalRgBinary = process.env.PENUMBRA_RG_BINARY;
    originalArgsFile = process.env.ARGS_FILE;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-grep-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv("PENUMBRA_RG_BINARY", originalRgBinary);
    restoreEnv("ARGS_FILE", originalArgsFile);
  });

  it("content mode: returns {path, line, text} rows for each match", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "foo\nTODO bar\nbaz\n");
    fs.writeFileSync(path.join(tmp, "b.ts"), "no match\n");
    const r = await executeGrep({ pattern: "TODO", output_mode: "content" }, tmp);
    expect(r.results).toEqual([{ path: "a.ts", line: 2, text: "TODO bar" }]);
    expect(r.truncated).toBe(false);
  });

  it("strips CRLF line endings from grep content rows", async () => {
    fs.writeFileSync(path.join(tmp, "crlf.txt"), "TODO\r\n");
    const r = await executeGrep({ pattern: "TODO", output_mode: "content" }, tmp);
    expect(r.results).toEqual([{ path: "crlf.txt", line: 1, text: "TODO" }]);
  });

  it("respects glob filter", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "TODO\n");
    fs.writeFileSync(path.join(tmp, "a.md"), "TODO\n");
    const r = await executeGrep({ pattern: "TODO", glob: "*.ts", output_mode: "content" }, tmp);
    expect(r.results.map((x) => (typeof x === "string" ? x : x.path))).toEqual(["a.ts"]);
  });

  it("case_insensitive=true matches mixed case", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "todo lower\nTODO upper\n");
    const r = await executeGrep(
      { pattern: "todo", case_insensitive: true, output_mode: "content" },
      tmp,
    );
    expect(r.results.length).toBe(2);
  });

  it("truncates content mode at default 50 and sets truncated=true", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push("TODO line " + String(i));
    fs.writeFileSync(path.join(tmp, "big.ts"), lines.join("\n") + "\n");
    const r = await executeGrep({ pattern: "TODO", output_mode: "content" }, tmp);
    expect(r.results.length).toBe(50);
    expect(r.truncated).toBe(true);
  });

  it("per-line text capped at 1KB with ellipsis suffix", async () => {
    const long = "TODO " + "x".repeat(2000);
    fs.writeFileSync(path.join(tmp, "big.ts"), long + "\n");
    const r = await executeGrep({ pattern: "TODO", output_mode: "content" }, tmp);
    const first = r.results[0];
    if (typeof first === "string") throw new Error("expected content mode");
    expect(first.text.length).toBeLessThanOrEqual(1024);
    expect(first.text.endsWith("…")).toBe(true);
  });

  it("keeps capped text valid at a multi-byte boundary", async () => {
    const long = "a".repeat(1021) + "💩" + "b";
    fs.writeFileSync(path.join(tmp, "emoji.ts"), long + "\n");
    const r = await executeGrep({ pattern: "a", output_mode: "content" }, tmp);
    const first = r.results[0];
    if (typeof first === "string") throw new Error("expected content mode");
    expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(1024);
    expect(first.text).not.toContain("\uFFFD");
  });

  it("files_with_matches mode returns deduped paths", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "TODO\nTODO again\n");
    fs.writeFileSync(path.join(tmp, "b.ts"), "no\n");
    const r = await executeGrep({ pattern: "TODO", output_mode: "files_with_matches" }, tmp);
    expect(r.results).toEqual(["a.ts"]);
    expect(r.truncated).toBe(false);
  });

  it("returns engine_unavailable error when rg binary missing", async () => {
    process.env.PENUMBRA_RG_BINARY = "/nonexistent/rg";
    try {
      await executeGrep({ pattern: "TODO", output_mode: "content" }, tmp);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe("engine_unavailable");
    }
  });

  it("returns bad_pattern error for an invalid regex", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "x\n");
    try {
      await executeGrep({ pattern: "[invalid", output_mode: "content" }, tmp);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe("bad_pattern");
    }
  });

  it("include_ignored=true passes --no-ignore to rg", async () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "ignored.ts\n");
    fs.writeFileSync(path.join(tmp, "ignored.ts"), "TODO\n");
    fs.writeFileSync(path.join(tmp, "kept.ts"), "TODO\n");
    const without = await executeGrep({ pattern: "TODO", output_mode: "content" }, tmp);
    expect(without.results.map((x) => (typeof x === "string" ? x : x.path)).sort()).toEqual([
      "kept.ts",
    ]);
    const withIgnored = await executeGrep(
      { pattern: "TODO", output_mode: "content", include_ignored: true },
      tmp,
    );
    expect(withIgnored.results.map((x) => (typeof x === "string" ? x : x.path)).sort()).toEqual([
      "ignored.ts",
      "kept.ts",
    ]);
  });

  it("applies nested and ancestor .gitignore files to a scoped path", async () => {
    fs.writeFileSync(path.join(tmp, ".git"), "gitdir: /nonexistent/worktrees/wt\n");
    fs.writeFileSync(path.join(tmp, ".gitignore"), "*.log\n");
    fs.mkdirSync(path.join(tmp, "pkg", "gen"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "pkg", "src", "gen"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "pkg", ".gitignore"), "/gen/\n");
    for (const rel of ["pkg/gen/a.ts", "pkg/src/gen/b.ts", "pkg/x.log", "pkg/y.ts", "other.ts"]) {
      fs.writeFileSync(path.join(tmp, rel), "TODO\n");
    }

    const r = await executeGrep(
      { pattern: "TODO", path: "pkg", output_mode: "files_with_matches" },
      tmp,
    );
    expect(resultPaths(r)).toEqual(["pkg/src/gen/b.ts", "pkg/y.ts"]);
  });

  it("passes --no-config as the first rg flag", async () => {
    const argsFile = path.join(tmp, "rg-args.txt");
    const shim = path.join(tmp, "rg-shim.sh");
    fs.writeFileSync(
      shim,
      `#!/bin/sh
printf '%s\n' "$@" > "$ARGS_FILE"
printf '%s\n' '{"type":"match","data":{"path":{"text":"a.txt"},"line_number":1,"lines":{"text":"TODO\\n"}}}'
`,
    );
    fs.chmodSync(shim, 0o755);
    fs.writeFileSync(path.join(tmp, "a.txt"), "TODO\n");
    process.env.PENUMBRA_RG_BINARY = shim;
    process.env.ARGS_FILE = argsFile;

    const r = await executeGrep({ pattern: "TODO", output_mode: "content" }, tmp);
    expect(r.results).toEqual([{ path: "a.txt", line: 1, text: "TODO" }]);
    expect(fs.readFileSync(argsFile, "utf8").split("\n").find(Boolean)).toBe("--no-config");
  });
});

describe("gitignore scope shared by executeGlob and executeGrep", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-search-scope-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("treats a path inside a gitignored directory as ignored unless include_ignored", async () => {
    fs.writeFileSync(path.join(tmp, ".git"), "gitdir: /nonexistent/worktrees/wt\n");
    fs.writeFileSync(path.join(tmp, ".gitignore"), "dist/\n");
    fs.mkdirSync(path.join(tmp, "dist", "nested"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "dist", "nested", "out.js"), "TODO\n");

    for (const scope of ["dist", "dist/nested"]) {
      expect((await executeGlob({ pattern: "**/*", path: scope }, tmp)).results).toEqual([]);
    }
    for (const scope of ["dist", "dist/nested", "dist/nested/out.js"]) {
      expect(resultPaths(await executeGrep({ pattern: "TODO", path: scope }, tmp))).toEqual([]);
    }

    const glob = await executeGlob({ pattern: "**/*", path: "dist", include_ignored: true }, tmp);
    expect(glob.results).toEqual(["dist/nested/out.js"]);
    const grep = await executeGrep({ pattern: "TODO", path: "dist", include_ignored: true }, tmp);
    expect(resultPaths(grep)).toEqual(["dist/nested/out.js"]);
  });

  it("ignores .gitignore files above the worktree root", async () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "*.ts\n");
    for (const kind of ["git-worktree", "plain-dir"]) {
      const wt = path.join(tmp, kind);
      fs.mkdirSync(path.join(wt, "sub"), { recursive: true });
      if (kind === "git-worktree") {
        fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nonexistent/worktrees/wt\n");
      }
      fs.writeFileSync(path.join(wt, "sub", "a.ts"), "TODO\n");

      for (const scope of [undefined, "sub"]) {
        const glob = await executeGlob({ pattern: "**/*.ts", path: scope }, wt);
        expect(glob.results).toEqual(["sub/a.ts"]);
        const grep = await executeGrep({ pattern: "TODO", path: scope }, wt);
        expect(resultPaths(grep)).toEqual(["sub/a.ts"]);
      }
    }
  });
});
