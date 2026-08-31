import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { emitFileOutput } from "@src/outputs/file.js";

test("emitFileOutput rejects absolute path outside repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-abs-"));
  try {
    const repoRoot = join(root, "repo");
    const outsidePath = join(root, "outside.txt");
    const result = await emitFileOutput({ path: outsidePath, body: "should-not-write", repoRoot });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.path).toBeUndefined();
    expect(fs.existsSync(outsidePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput allows absolute path that is inside repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-abs-in-"));
  try {
    const repoRoot = join(root, "repo");
    await mkdir(repoRoot, { recursive: true });
    const insidePath = join(repoRoot, "docs", "out.txt");
    const result = await emitFileOutput({ path: insidePath, body: "inside", repoRoot });
    expect(result.warnings).toEqual([]);
    expect(result.path).toBe(insidePath);
    expect(readFileSync(insidePath, "utf8")).toBe("inside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput rejects writing through a symlink that resolves outside repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-symlink-out-"));
  try {
    const repoRoot = join(root, "repo");
    const outside = join(root, "outside");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    symlinkSync(outside, join(repoRoot, "escape"));

    const result = await emitFileOutput({
      path: "escape/out.txt",
      body: "should-not-write",
      repoRoot,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.path).toBeUndefined();
    expect(fs.existsSync(join(outside, "out.txt"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput allows writing through a symlink that resolves inside repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-symlink-in-"));
  try {
    const repoRoot = join(root, "repo");
    const target = join(repoRoot, "inside-target");
    await mkdir(target, { recursive: true });
    symlinkSync(target, join(repoRoot, "inside-link"));

    const result = await emitFileOutput({
      path: "inside-link/out.txt",
      body: "inside",
      repoRoot,
    });

    expect(result.warnings).toEqual([]);
    expect(result.path).toBe(join(repoRoot, "inside-link", "out.txt"));
    expect(readFileSync(join(target, "out.txt"), "utf8")).toBe("inside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput resolves relative paths against repoRoot when provided", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-root-"));
  try {
    const repoRoot = join(root, "repo");
    const result = await emitFileOutput({ path: "docs/out.txt", body: "repo", repoRoot });
    const expected = resolve(repoRoot, "docs/out.txt");
    expect(result.path).toBe(expected);
    expect(readFileSync(expected, "utf8")).toBe("repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput keeps legacy cwd-relative behavior without repoRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-cwd-"));
  try {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const result = await emitFileOutput({ path: "docs/out.txt", body: "cwd" });
      const expected = resolve(realpathSync(root), "docs/out.txt");
      expect(result.path).toBe(expected);
      expect(readFileSync(expected, "utf8")).toBe("cwd");
    } finally {
      process.chdir(cwd);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=skip-if-exists writes when target does not exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-skip-absent-"));
  try {
    const target = join(root, "out.md");
    const result = await emitFileOutput({ path: target, body: "b", mode: "skip-if-exists" });
    expect(result.warnings).toEqual([]);
    expect(result.path).toBe(target);
    expect(result.skipped).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=skip-if-exists does not clobber an existing file under a TOCTOU race", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-skip-race-"));
  try {
    const target = join(root, "out.md");
    await Bun.write(target, "original");
    const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);

    try {
      const result = await emitFileOutput({
        path: target,
        body: "new-body",
        mode: "skip-if-exists",
      });

      expect(result.warnings).toEqual([]);
      expect(result.path).toBe(target);
      expect(result.skipped).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("original");
    } finally {
      existsSpy.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=append preserves interleaved concurrent writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-append-race-"));
  try {
    const target = join(root, "out.md");
    await Bun.write(target, "base\n");

    const originalReadFile = fsPromises.readFile;
    let targetReads = 0;
    let releaseReads!: () => void;
    const bothReadsStarted = new Promise<void>((resolvePromise) => {
      releaseReads = resolvePromise;
    });
    const readSpy = spyOn(fsPromises, "readFile").mockImplementation((path, options) => {
      if (path === target) {
        targetReads += 1;
        if (targetReads === 2) releaseReads();
        return bothReadsStarted.then(() => "base\n");
      }
      return originalReadFile(path, options);
    });

    try {
      const [first, second] = await Promise.all([
        emitFileOutput({ path: target, body: "first\n", mode: "append" }),
        emitFileOutput({ path: target, body: "second\n", mode: "append" }),
      ]);

      expect(first.warnings).toEqual([]);
      expect(second.warnings).toEqual([]);
      const body = readFileSync(target, "utf8");
      expect(body).toContain("base\n");
      expect(body).toContain("first\n");
      expect(body).toContain("second\n");
    } finally {
      readSpy.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=unique-suffix leaves an existing target untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-unique-existing-"));
  try {
    const target = join(root, "out.md");
    await Bun.write(target, "original");

    const result = await emitFileOutput({
      path: target,
      body: "new-body",
      mode: "unique-suffix",
    });

    expect(result.warnings).toEqual([]);
    expect(result.path).toBe(join(root, "out-2.md"));
    expect(result.skipped).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(readFileSync(join(root, "out-2.md"), "utf8")).toBe("new-body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=unique-suffix creates an absent target without reserving the final path", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-unique-no-reserve-"));
  try {
    const target = join(root, "out.md");
    const opened: [unknown, unknown][] = [];
    const originalOpen = fsPromises.open;
    const openSpy = spyOn(fsPromises, "open").mockImplementation((path, flags, mode) => {
      opened.push([path, flags]);
      return originalOpen(path, flags, mode);
    });

    try {
      const result = await emitFileOutput({
        path: target,
        body: "complete",
        mode: "unique-suffix",
      });

      expect(result.warnings).toEqual([]);
      expect(result.path).toBe(target);
      expect(result.skipped).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("complete");
      expect(opened).not.toContainEqual([target, "wx"]);
    } finally {
      openSpy.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput removes temp files when a temp write fails after creating the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-temp-cleanup-"));
  try {
    const target = join(root, "out.md");
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation((path) => {
      if (typeof path === "string" && path.endsWith(".tmp")) {
        fs.writeFileSync(path, "partial");
      }
      const err = new Error("no space left");
      Object.defineProperty(err, "code", { value: "ENOSPC" });
      return Promise.reject(err);
    });

    try {
      const result = await emitFileOutput({ path: target, body: "body" });

      expect(result.path).toBeUndefined();
      expect(result.warnings).toEqual(["output file: no space left"]);
      expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      writeSpy.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput writes through a tmp path then rename", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-atomic-"));
  try {
    const target = join(root, "out.md");
    const writes: string[] = [];
    const renames: [string, string][] = [];
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation((path, body) => {
      writes.push(path);
      expect(body).toBe("atomic");
      return Promise.resolve();
    });
    const renameSpy = spyOn(fsPromises, "rename").mockImplementation((from, to) => {
      renames.push([from, to]);
      return Promise.resolve();
    });

    try {
      const result = await emitFileOutput({ path: target, body: "atomic" });

      expect(result.warnings).toEqual([]);
      expect(result.path).toBe(target);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(/\.tmp$/);
      expect(renames).toEqual([[writes[0]!, target]]);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitFileOutput mode=unique-suffix writes through a tmp path then link", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-atomic-unique-"));
  try {
    const target = join(root, "out.md");
    const writes: string[] = [];
    const links: [string, string][] = [];
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation((path, body) => {
      writes.push(path);
      expect(body).toBe("atomic-unique");
      return Promise.resolve();
    });
    const linkSpy = spyOn(fsPromises, "link").mockImplementation((from, to) => {
      links.push([from, to]);
      return Promise.resolve();
    });

    try {
      const result = await emitFileOutput({
        path: target,
        body: "atomic-unique",
        mode: "unique-suffix",
      });

      expect(result.warnings).toEqual([]);
      expect(result.path).toBe(target);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(/\.tmp$/);
      expect(links).toEqual([[writes[0]!, target]]);
    } finally {
      writeSpy.mockRestore();
      linkSpy.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
