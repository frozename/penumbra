import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultDependencyProvider, linkDeps, readBaseDepsInput } from "./deps.js";
import { defaultRunCommand, isSafeRelativePath, type RunCommand } from "./materialize.js";

const tempDirs: string[] = [];

// The frozen cache is a-w; restore u+w before rm -rf so cleanup never fails.
function chmodTree(dir: string): void {
  chmodSync(dir, statSync(dir).mode | 0o700);
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      continue;
    }
    if (ent.isDirectory()) {
      chmodTree(p);
    } else {
      chmodSync(p, statSync(p).mode | 0o700);
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    chmodTree(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mkCacheRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-deps-cache-"));
  tempDirs.push(dir);
  return dir;
}

function mkScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Stands in for `bun install`: seeds node_modules with one executable and one
// plain file so the freeze step has something to preserve (or not).
function fakeInstall(): RunCommand {
  return (_cmd, _args, opts) => {
    const cwd = opts?.cwd ?? "";
    mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
    const exe = join(cwd, "node_modules", ".bin", "tool");
    writeFileSync(exe, "#!/bin/sh\necho ran\n", "utf8");
    chmodSync(exe, 0o755);
    const plain = join(cwd, "node_modules", "plain.txt");
    writeFileSync(plain, "data\n", "utf8");
    chmodSync(plain, 0o644);
    return Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };
}

test("freeze strips write bits but keeps execute bits on cached binaries", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("fake-lock\n", "utf8");
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
  });

  const res = await provider.ensure({
    lockSha256: sha256Hex(lockfileBytes),
    lockfileBytes,
    manifests: [],
  });

  expect(res.ok).toBe(true);
  if (!res.ok) {
    return;
  }
  const exe = join(res.cacheDir, "node_modules", ".bin", "tool");
  const plain = join(res.cacheDir, "node_modules", "plain.txt");
  expect(statSync(exe).mode & 0o777).toBe(0o555);
  expect(statSync(plain).mode & 0o777).toBe(0o444);
  expect(statSync(join(res.cacheDir, "node_modules")).mode & 0o777).toBe(0o555);
});

test("frozen executable in the dependency cache still runs", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("fake-lock\n", "utf8");
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
  });

  const res = await provider.ensure({
    lockSha256: sha256Hex(lockfileBytes),
    lockfileBytes,
    manifests: [],
  });

  expect(res.ok).toBe(true);
  if (!res.ok) {
    return;
  }
  const exe = join(res.cacheDir, "node_modules", ".bin", "tool");
  const ran = await defaultRunCommand(exe, []);
  expect(ran.code).toBe(0);
  expect(ran.stdout.toString("utf8").trim()).toBe("ran");
});

test("isSafeRelativePath rejects traversal, empty, dot, .git and absolute paths", () => {
  expect(isSafeRelativePath("package.json")).toBe(true);
  expect(isSafeRelativePath("packages/a/package.json")).toBe(true);
  expect(isSafeRelativePath("")).toBe(false);
  expect(isSafeRelativePath("../evil/package.json")).toBe(false);
  expect(isSafeRelativePath("packages/../evil/package.json")).toBe(false);
  expect(isSafeRelativePath("./x/package.json")).toBe(false);
  expect(isSafeRelativePath(".git/package.json")).toBe(false);
  expect(isSafeRelativePath("packages//pkg/package.json")).toBe(false);
  expect(isSafeRelativePath("/abs/package.json")).toBe(false);
});

test("manifest with an unsafe path returns deps_input_unsafe without installing", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  let calls = 0;
  const run: RunCommand = () => {
    calls += 1;
    return Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: run,
  });

  for (const bad of [
    "../evil/package.json",
    "packages/../evil/package.json",
    ".git/package.json",
    "packages//pkg/package.json",
  ]) {
    const res = await provider.ensure({
      lockSha256,
      lockfileBytes,
      manifests: [{ path: bad, bytes: Buffer.from('{"name":"x"}\n', "utf8") }],
    });
    expect(res).toEqual({ ok: false, reason: "deps_input_unsafe" });
  }

  expect(calls).toBe(0);
  expect(readdirSync(cacheRoot)).toEqual([]);
});

test("failed install removes the cache dir", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  let ranInstall = false;
  const run: RunCommand = (_cmd, _args, opts) => {
    ranInstall = true;
    mkdirSync(join(opts?.cwd ?? "", "partial"), { recursive: true });
    return Promise.resolve({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("boom\n") });
  };
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: run,
  });

  const res = await provider.ensure({
    lockSha256,
    lockfileBytes,
    manifests: [{ path: "package.json", bytes: Buffer.from('{"name":"x"}\n', "utf8") }],
  });

  expect(res).toEqual({ ok: false, reason: "deps_install_failed" });
  expect(ranInstall).toBe(true);
  expect(existsSync(join(cacheRoot, lockSha256))).toBe(false);
});

test("cache dir without CACHE_MARKER is not treated as valid", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const crashedDir = join(cacheRoot, lockSha256);
  mkdirSync(join(crashedDir, "node_modules", "leftover"), { recursive: true });

  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: false,
    runCommand: fakeInstall(),
  });
  const res = await provider.ensure({
    lockSha256,
    lockfileBytes,
    manifests: [],
  });

  expect(res).toEqual({ ok: false, reason: "deps_cache_missing" });
});

test("CACHE_MARKER is committed last so an accepted cache is always frozen and sealed", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("fake-lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
  });

  const res = await provider.ensure({
    lockSha256,
    lockfileBytes,
    manifests: [],
  });

  expect(res.ok).toBe(true);
  if (!res.ok) {
    return;
  }
  expect(readFileSync(join(res.cacheDir, ".penumbra-deps-cache-ok"), "utf8")).toBe(
    `${lockSha256}\n`,
  );
  expect(statSync(res.cacheDir).mode & 0o777).toBe(0o555);
  let sealed = false;
  try {
    writeFileSync(join(res.cacheDir, "late-write.txt"), "x\n", "utf8");
  } catch (err) {
    sealed = true;
    expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
  }
  expect(sealed).toBe(true);
});

// Pins the freeze -> hook -> marker -> seal order: a crash at the seam must
// leave the cache unmarked (so a later ensure() refuses it). Moving the
// marker write before freezeTree/onAfterFreeze makes this fail.
test("a crash after freeze but before the marker write rejects the cache", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("fake-lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const crashProvider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
    onAfterFreeze: () => {
      throw new Error("injected crash");
    },
  });

  let rejection: unknown = null;
  try {
    await crashProvider.ensure({
      lockSha256,
      lockfileBytes,
      manifests: [{ path: "package.json", bytes: Buffer.from('{"name":"x"}\n', "utf8") }],
    });
  } catch (err) {
    rejection = err;
  }
  expect((rejection as Error | null)?.message).toBe("injected crash");

  const cacheDir = join(cacheRoot, lockSha256);
  expect(existsSync(join(cacheDir, ".penumbra-deps-cache-ok"))).toBe(false);

  const reader = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: false,
    runCommand: fakeInstall(),
  });
  const res = await reader.ensure({ lockSha256, lockfileBytes, manifests: [] });
  expect(res).toEqual({ ok: false, reason: "deps_cache_missing" });
});

// A crash between freezeTree and the marker write leaves a frozen, unmarked
// cacheDir; ensure({allowInstall:true}) must recover it (unseal, remove,
// reinstall) instead of throwing EACCES on the bun.lock rewrite.
test("a frozen but unmarked cache dir is recovered and reinstalled", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const staleDir = join(cacheRoot, lockSha256);
  mkdirSync(join(staleDir, "node_modules", "partial"), { recursive: true });
  writeFileSync(join(staleDir, "bun.lock"), "stale-lock\n", "utf8");
  chmodSync(join(staleDir, "bun.lock"), 0o444);
  chmodSync(join(staleDir, "node_modules", "partial"), 0o555);
  chmodSync(join(staleDir, "node_modules"), 0o555);
  chmodSync(staleDir, 0o555);

  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
  });
  const res = await provider.ensure({ lockSha256, lockfileBytes, manifests: [] });

  expect(res).toEqual({ ok: true, cacheDir: staleDir });
  expect(readFileSync(join(staleDir, "bun.lock"), "utf8")).toBe("lock\n");
  expect(existsSync(join(staleDir, "node_modules", "partial"))).toBe(false);
  expect(existsSync(join(staleDir, "node_modules", ".bin", "tool"))).toBe(true);
  expect(existsSync(join(staleDir, ".penumbra-deps-cache-ok"))).toBe(true);
});

// Two ensures for the same lockSha must overlap: each installs into its own
// staging dir next to cacheDir (so neither removeStaleCacheDir's the other's
// in-flight work), and the loser of the atomic rename accepts the winner's
// committed cache instead of failing or deleting it.
test("two concurrent ensure() calls for the same lockSha both succeed", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const slowInstall: RunCommand = (_cmd, _args, opts) => {
    const cwd = opts?.cwd ?? "";
    return new Promise((resolve) => {
      setTimeout(() => {
        mkdirSync(join(cwd, "node_modules"), { recursive: true });
        writeFileSync(join(cwd, "node_modules", "dep.txt"), "dep\n", "utf8");
        resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      }, 25);
    });
  };
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: slowInstall,
  });

  const input = { lockSha256, lockfileBytes, manifests: [] };
  const [first, second] = await Promise.all([provider.ensure(input), provider.ensure(input)]);

  const finalDir = join(cacheRoot, lockSha256);
  expect(first).toEqual({ ok: true, cacheDir: finalDir });
  expect(second).toEqual({ ok: true, cacheDir: finalDir });
  expect(readFileSync(join(finalDir, ".penumbra-deps-cache-ok"), "utf8")).toBe(`${lockSha256}\n`);
  expect(readFileSync(join(finalDir, "node_modules", "dep.txt"), "utf8")).toBe("dep\n");
  expect(readdirSync(cacheRoot)).toEqual([lockSha256]);
});

test("linkDeps links root and per-workspace node_modules and skips missing workspace targets", async () => {
  const treeDir = mkScratchDir("penumbra-deps-tree-");
  const cacheDir = mkScratchDir("penumbra-deps-src-");
  mkdirSync(join(treeDir, "packages", "a"), { recursive: true });
  mkdirSync(join(treeDir, "packages", "b"), { recursive: true });
  mkdirSync(join(cacheDir, "node_modules", "rootdep"), { recursive: true });
  writeFileSync(join(cacheDir, "node_modules", "rootdep", "index.js"), "root\n", "utf8");
  mkdirSync(join(cacheDir, "packages", "a", "node_modules", "adep"), { recursive: true });
  writeFileSync(join(cacheDir, "packages", "a", "node_modules", "adep", "index.js"), "a\n", "utf8");

  await linkDeps({ treeDir, cacheDir, workspaces: ["packages/a", "packages/b"] });

  expect(lstatSync(join(treeDir, "node_modules")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(treeDir, "node_modules", "rootdep", "index.js"), "utf8")).toBe("root\n");
  expect(lstatSync(join(treeDir, "packages", "a", "node_modules")).isSymbolicLink()).toBe(true);
  expect(
    readFileSync(join(treeDir, "packages", "a", "node_modules", "adep", "index.js"), "utf8"),
  ).toBe("a\n");
  expect(existsSync(join(treeDir, "packages", "b", "node_modules"))).toBe(false);
});

test("readBaseDepsInput reports base_missing when the base tree cannot be listed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-deps-norepo-"));
  tempDirs.push(dir);

  let thrown: unknown = null;
  try {
    await readBaseDepsInput({ repo: dir, baseSha: "0".repeat(40) });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain("base_missing");
});
