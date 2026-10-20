import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { runFileContents } from "@src/recall-sources/file-contents.js";

test("file.contents returns text body when file exists and fits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const relPath = "notes.txt";
  const absPath = join(dir, relPath);
  writeFileSync(absPath, "hello workflow recall\n");
  try {
    const out = await runFileContents({ cwd: dir, args: { path: relPath } });
    expect(out.result.path).toBe(absPath);
    expect(out.result.body).toBe("hello workflow recall\n");
    expect(out.result.truncated).toBe(false);
    expect(out.result.byte_size).toBe(Buffer.byteLength("hello workflow recall\n"));
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file.contents truncates body at max_bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const relPath = "big.txt";
  const absPath = join(dir, relPath);
  writeFileSync(absPath, "abcdefghij");
  try {
    const out = await runFileContents({ cwd: dir, args: { path: relPath, max_bytes: 4 } });
    expect(out.result.path).toBe(absPath);
    expect(out.result.body).toBe("abcd");
    expect(out.result.truncated).toBe(true);
    expect(out.result.byte_size).toBe(10);
    expect(out.warnings.length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file.contents returns not_found error for missing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  try {
    const out = await runFileContents({ cwd: dir, args: { path: "missing.txt" } });
    expect(out.result.path).toBe(join(dir, "missing.txt"));
    expect(out.result.body).toBeNull();
    expect(out.result.error).toBe("not_found");
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file.contents returns not_found when path is empty (workflow opt-out)", async () => {
  const out = await runFileContents({ cwd: "/tmp", args: { path: "" } });
  expect(out.result.body).toBeNull();
  expect(out.result.error).toBe("not_found");
  expect(out.warnings).toEqual([]);
});

test("file.contents returns not_found when path resolves to a directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  try {
    const out = await runFileContents({ cwd: dir, args: { path: "." } });
    expect(out.result.body).toBeNull();
    expect(out.result.error).toBe("not_found");
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file.contents marks binary files with placeholder body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const relPath = "data.bin";
  const absPath = join(dir, relPath);
  writeFileSync(absPath, Buffer.from([0x00, 0xff, 0x01, 0x02, 0x03]));
  try {
    const out = await runFileContents({ cwd: dir, args: { path: relPath } });
    expect(out.result.path).toBe(absPath);
    expect(out.result.body).toBe("<binary file omitted>");
    expect(out.result.truncated).toBe(false);
    expect(out.result.byte_size).toBe(5);
    expect(out.warnings).toEqual([`file.contents: ${absPath} binary content omitted`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file.contents treats UTF-16 text as binary instead of escaping dense NULs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const lePath = join(dir, "utf16le.txt");
  const beBomPath = join(dir, "utf16be-bom.txt");
  writeFileSync(lePath, Buffer.from("hello world\n", "utf16le"));
  writeFileSync(beBomPath, Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69, 0x00, 0x0a]));
  try {
    const le = await runFileContents({ cwd: dir, args: { path: "utf16le.txt" } });
    expect(le.result.body).toBe("<binary file omitted>");
    expect(le.warnings).toEqual([`file.contents: ${lePath} binary content omitted`]);

    const beBom = await runFileContents({ cwd: dir, args: { path: "utf16be-bom.txt" } });
    expect(beBom.result.body).toBe("<binary file omitted>");
    expect(beBom.warnings).toEqual([`file.contents: ${beBomPath} binary content omitted`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file.contents escapes NUL bytes in UTF-8 text instead of omitting the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const relPath = "notes.txt";
  const absPath = join(dir, relPath);
  writeFileSync(
    absPath,
    Buffer.concat([
      Buffer.from("alpha\nbeta "),
      Buffer.from([0x00]),
      Buffer.from("gamma\ndelta "),
      Buffer.from([0x00]),
      Buffer.from("end\n"),
    ]),
  );
  try {
    const out = await runFileContents({ cwd: dir, args: { path: relPath } });
    expect(out.result.path).toBe(absPath);
    expect(out.result.body).toBe("alpha\nbeta \\0gamma\ndelta \\0end\n");
    expect(out.result.truncated).toBe(false);
    expect(out.warnings).toEqual([`file.contents: ${absPath} 2 NUL bytes escaped`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file.contents blocks paths outside cwd by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "file-contents-outside-"));
  const absPath = join(outsideDir, "outside.txt");
  writeFileSync(absPath, "nope\n");
  try {
    const out = await runFileContents({ cwd: dir, args: { path: absPath } });
    expect(out.result).toEqual({
      path: absPath,
      body: null,
      error: "path_outside_allowed_roots",
    });
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("file.contents allows paths inside storageRoot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "file-contents-storage-"));
  const absPath = join(storageRoot, "allowed.txt");
  writeFileSync(absPath, "allowed\n");
  try {
    const out = await runFileContents({ cwd: dir, storageRoot, args: { path: absPath } });
    expect(out.result.path).toBe(absPath);
    expect(out.result.body).toBe("allowed\n");
    expect(out.result.truncated).toBe(false);
    expect(out.result.byte_size).toBe(Buffer.byteLength("allowed\n"));
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("file.contents keeps ~/.penumbra literal home-dir semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "file-contents-storage-"));
  const relPath = ".penumbra/penumbra-file-contents-literal-home-test.txt";
  writeFileSync(join(storageRoot, "penumbra-file-contents-literal-home-test.txt"), "storage\n");
  try {
    const out = await runFileContents({
      cwd: dir,
      storageRoot,
      args: { path: `~/${relPath}`, allowed_roots: ["~/.penumbra"] },
    });

    expect(out.result).toEqual({
      path: join(homedir(), relPath),
      body: null,
      error: "not_found",
    });
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("file.contents supports an explicit storage-root-relative token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "file-contents-storage-"));
  const target = join(storageRoot, "pending-handoff.md");
  writeFileSync(target, "pending draft\n");
  try {
    const out = await runFileContents({
      cwd: dir,
      storageRoot,
      args: { path: "penumbra-storage:pending-handoff.md" },
    });

    expect(out.result.path).toBe(target);
    expect(out.result.body).toBe("pending draft\n");
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("file.contents allows explicit allowed roots outside cwd and storageRoot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "file-contents-storage-"));
  const allowedRoot = mkdtempSync(join(tmpdir(), "file-contents-allowed-"));
  const absPath = join(allowedRoot, "explicit.txt");
  writeFileSync(absPath, "explicit\n");
  try {
    const out = await runFileContents({
      cwd: dir,
      storageRoot,
      args: { path: absPath, allowed_roots: [allowedRoot] },
    });
    expect(out.result.path).toBe(absPath);
    expect(out.result.body).toBe("explicit\n");
    expect(out.result.truncated).toBe(false);
    expect(out.result.byte_size).toBe(Buffer.byteLength("explicit\n"));
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(allowedRoot, { recursive: true, force: true });
  }
});

test("file.contents does not leak via TOCTOU symlink swap after containment check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "file-contents-outside-"));
  const inside = join(dir, "inside.txt");
  const secret = join(outsideDir, "secret.txt");
  const safeBody = "SAFE_INSIDE_CONTENT_XXXXXXXXXXXX";
  const secretBody = "SECRET_LEAKED_CONTENT_XXXXXXXXXX";
  writeFileSync(inside, safeBody);
  writeFileSync(secret, secretBody);
  const link = join(dir, "link.txt");
  symlinkSync(inside, link);
  try {
    const promise = runFileContents({ cwd: dir, args: { path: "link.txt" } });
    // Race the swap between the sync containment check and the awaited stat/open.
    unlinkSync(link);
    symlinkSync(secret, link);
    const out = await promise;
    expect(out.result.body).toBe(safeBody);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("file.contents blocks symlink escapes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-contents-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "file-contents-outside-"));
  const target = join(outsideDir, "target.txt");
  const link = join(dir, "link.txt");
  writeFileSync(target, "secret\n");
  try {
    Bun.spawnSync(["ln", "-s", target, link]);
    const out = await runFileContents({ cwd: dir, args: { path: "link.txt" } });
    expect(out.result).toEqual({
      path: join(dir, "link.txt"),
      body: null,
      error: "path_outside_allowed_roots",
    });
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
