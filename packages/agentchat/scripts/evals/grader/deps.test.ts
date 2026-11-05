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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  createDefaultDependencyProvider,
  type EnsureResult,
  linkDeps,
  readBaseDepsInput,
} from "./deps.js";
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
// leave the cache unmarked AND must never rename the unmarked staged dir
// into place — the cacheDir slot stays empty (so a later ensure() refuses
// it). Asserting only the missing marker is vacuous: it holds even if a
// mutant commits the unmarked staged tree. Moving the marker write before
// freezeTree/onAfterFreeze, or renaming the staged dir on the throw path,
// makes this fail.
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
  expect(existsSync(cacheDir)).toBe(false);
  expect(readdirSync(cacheRoot)).toEqual([]);

  const reader = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: false,
    runCommand: fakeInstall(),
  });
  const res = await reader.ensure({ lockSha256, lockfileBytes, manifests: [] });
  expect(res).toEqual({ ok: false, reason: "deps_cache_missing" });
});

// A throwing install must remove ONLY its own staging dir. A sibling
// ensure() for the same lockSha installs concurrently under the same
// <lockSha>.install-* prefix, so the old cross-call sweep of
// .install-*/.stale-* deleted the sibling's live staging dir mid-install.
// Leftovers from earlier crashed runs survive until a future owner decides
// what to do with them.
test("a throwing install removes only its own staging dir, not a sibling's", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const installLeftover = join(cacheRoot, `${lockSha256}.install-crashed`);
  mkdirSync(join(installLeftover, "node_modules"), { recursive: true });
  writeFileSync(join(installLeftover, "node_modules", "partial.txt"), "partial\n", "utf8");
  const staleLeftover = join(cacheRoot, `${lockSha256}.stale-crashed`);
  mkdirSync(staleLeftover, { recursive: true });
  writeFileSync(join(staleLeftover, "old.txt"), "old\n", "utf8");

  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
    onAfterFreeze: () => {
      throw new Error("injected crash");
    },
  });

  let rejection: unknown = null;
  try {
    await provider.ensure({ lockSha256, lockfileBytes, manifests: [] });
  } catch (err) {
    rejection = err;
  }
  expect((rejection as Error | null)?.message).toBe("injected crash");

  expect(existsSync(join(cacheRoot, lockSha256))).toBe(false);
  expect(existsSync(installLeftover)).toBe(true);
  expect(existsSync(staleLeftover)).toBe(true);
  expect(readdirSync(cacheRoot).sort()).toEqual([
    `${lockSha256}.install-crashed`,
    `${lockSha256}.stale-crashed`,
  ]);
});

// The provider A / provider B interleave the regression needs: A throws
// after freeze while B is still installing. A must not touch B's staging
// dir; B's committed cache carries B's install output and the marker, and
// A's own staging dir is gone. With the old cross-call sweep in ensure()'s
// finally, B's staging dir (and its sentinel) vanish mid-install and B
// fails deps_install_failed.
test("a throwing ensure() does not destroy a concurrent ensure()'s staging dir", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const finalDir = join(cacheRoot, lockSha256);

  const failingRun: RunCommand = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      }, 5);
    });
  const slowRun: RunCommand = (_cmd, _args, opts) => {
    const cwd = opts?.cwd ?? "";
    writeFileSync(join(cwd, "b-sentinel"), "sentinel\n", "utf8");
    return new Promise((resolve) => {
      setTimeout(() => {
        if (!existsSync(join(cwd, "b-sentinel"))) {
          resolve({
            code: 1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("staging dir deleted mid-install\n"),
          });
          return;
        }
        mkdirSync(join(cwd, "node_modules"), { recursive: true });
        writeFileSync(join(cwd, "install-id"), "B\n", "utf8");
        resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      }, 60);
    });
  };

  const failing = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: failingRun,
    onAfterFreeze: () => {
      throw new Error("injected crash");
    },
  });
  const slow = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: slowRun,
  });

  const input = { lockSha256, lockfileBytes, manifests: [] };
  const [a, b] = await Promise.allSettled([failing.ensure(input), slow.ensure(input)]);

  expect(a.status).toBe("rejected");
  if (a.status === "rejected") {
    expect((a.reason as Error).message).toBe("injected crash");
  }
  expect(b.status).toBe("fulfilled");
  if (b.status === "fulfilled") {
    expect(b.value).toEqual({ ok: true, cacheDir: finalDir });
  }
  expect(readFileSync(join(finalDir, "install-id"), "utf8")).toBe("B\n");
  expect(readFileSync(join(finalDir, ".penumbra-deps-cache-ok"), "utf8")).toBe(`${lockSha256}\n`);
  expect(readdirSync(cacheRoot)).toEqual([lockSha256]);
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
  expect(statSync(staleDir).mode & 0o777).toBe(0o555);
  expect(readFileSync(join(staleDir, "bun.lock"), "utf8")).toBe("lock\n");
  expect(existsSync(join(staleDir, "node_modules", "partial"))).toBe(false);
  expect(existsSync(join(staleDir, "node_modules", ".bin", "tool"))).toBe(true);
  expect(existsSync(join(staleDir, ".penumbra-deps-cache-ok"))).toBe(true);
});

// The stale slot can hold arbitrary cruft, not just a frozen dir. It is
// renamed aside atomically and deleted there, so a stray file left by a
// crashed write is recovered the same way — an in-place chmodTreeWritable
// used to throw ENOTDIR on readdirSync and kill the whole ensure().
test("a stray file at the cache slot is moved aside and replaced", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const cacheDir = join(cacheRoot, lockSha256);
  writeFileSync(cacheDir, "partial-write\n", "utf8");

  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
  });
  const res = await provider.ensure({ lockSha256, lockfileBytes, manifests: [] });

  expect(res).toEqual({ ok: true, cacheDir });
  expect(statSync(cacheDir).isDirectory()).toBe(true);
  expect(readFileSync(join(cacheDir, "bun.lock"), "utf8")).toBe("lock\n");
  expect(existsSync(join(cacheDir, ".penumbra-deps-cache-ok"))).toBe(true);
  expect(readdirSync(cacheRoot)).toEqual([lockSha256]);
});

// The rename-aside moves the slot entry itself: a symlink at cacheDir is
// unlinked without its target being walked or chmodded — an in-place
// removeStaleCacheDir followed the link and made the target writable.
test("a symlink at the cache slot is moved aside without touching its target", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const target = mkScratchDir("penumbra-deps-link-target-");
  const targetFile = join(target, "victim.txt");
  writeFileSync(targetFile, "keep\n", "utf8");
  chmodSync(targetFile, 0o444);
  chmodSync(target, 0o555);
  const cacheDir = join(cacheRoot, lockSha256);
  symlinkSync(target, cacheDir, "dir");

  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
  });
  const res = await provider.ensure({ lockSha256, lockfileBytes, manifests: [] });

  expect(res).toEqual({ ok: true, cacheDir });
  expect(statSync(target).mode & 0o777).toBe(0o555);
  expect(statSync(targetFile).mode & 0o777).toBe(0o444);
  expect(readFileSync(targetFile, "utf8")).toBe("keep\n");
  expect(readFileSync(join(cacheDir, "bun.lock"), "utf8")).toBe("lock\n");
  expect(readdirSync(cacheRoot)).toEqual([lockSha256]);
});

// Two ensures for the same lockSha must overlap: each installs into its own
// staging dir next to cacheDir (so neither removeStaleCacheDir's the other's
// in-flight work), and the loser of the atomic rename accepts the winner's
// committed cache instead of failing, deleting it, or swapping in its own.
// Distinct install ids + the slot inode pin that the first-resolved winner's
// commit is still the live cache after the loser returns — a mutant that
// drops the CACHE_MARKER check before clearing the slot fails this.
test("two concurrent ensure() calls for the same lockSha both succeed", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const finalDir = join(cacheRoot, lockSha256);
  const fakeInstallWithId =
    (id: string, delayMs: number): RunCommand =>
    (_cmd, _args, opts) => {
      const cwd = opts?.cwd ?? "";
      return new Promise((resolve) => {
        setTimeout(() => {
          mkdirSync(join(cwd, "node_modules"), { recursive: true });
          writeFileSync(join(cwd, "install-id"), `${id}\n`, "utf8");
          resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
        }, delayMs);
      });
    };
  const fast = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstallWithId("fast", 5),
  });
  const slow = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstallWithId("slow", 50),
  });

  // The first ensure() to resolve committed the winning install; record what
  // it committed (id + inode) at resolution so the loser's staged install can
  // never be observed swapped in afterwards.
  const resolved: { id: string; ino: number }[] = [];
  const observe = (pending: Promise<EnsureResult>): Promise<EnsureResult> =>
    pending.then((res) => {
      if (res.ok) {
        resolved.push({
          id: readFileSync(join(res.cacheDir, "install-id"), "utf8"),
          ino: statSync(res.cacheDir).ino,
        });
      }
      return res;
    });
  const input = { lockSha256, lockfileBytes, manifests: [] };
  const [first, second] = await Promise.all([
    observe(fast.ensure(input)),
    observe(slow.ensure(input)),
  ]);

  expect(first).toEqual({ ok: true, cacheDir: finalDir });
  expect(second).toEqual({ ok: true, cacheDir: finalDir });
  expect(resolved).toHaveLength(2);
  const winner = resolved[0]!;
  expect(winner.id).toBe("fast\n");
  expect(resolved[1]?.id).toBe(winner.id);
  expect(resolved[1]?.ino).toBe(winner.ino);
  expect(readFileSync(join(finalDir, "install-id"), "utf8")).toBe(winner.id);
  expect(statSync(finalDir).ino).toBe(winner.ino);
  expect(readFileSync(join(finalDir, ".penumbra-deps-cache-ok"), "utf8")).toBe(`${lockSha256}\n`);
  expect(readdirSync(cacheRoot)).toEqual([lockSha256]);
});

// Pins the rename-aside commit sequence: the stale slot is moved to a
// unique <lockSha>.stale-* name BEFORE anything is deleted, observed from
// inside the commit at a point where the residue is still on disk. An
// in-place removeStaleCacheDir(cacheDir) vacates the slot too and still
// ends with a marked cache in place — but nothing ever appears at
// staleAside, so the residue assertions fail only on the rename path.
test("a stale cache slot is vacated by a rename to <lockSha>.stale-* before deletion", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const cacheDir = join(cacheRoot, lockSha256);
  mkdirSync(join(cacheDir, "node_modules"), { recursive: true });
  writeFileSync(join(cacheDir, "old.txt"), "old\n", "utf8");

  const observed: { staleAside: string; slotVacated: boolean; residueAtAside: boolean }[] = [];
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
    onAfterRenameStaleAside: (staleAside) => {
      observed.push({
        staleAside,
        slotVacated: !existsSync(cacheDir),
        residueAtAside: existsSync(join(staleAside, "old.txt")),
      });
    },
  });

  const res = await provider.ensure({ lockSha256, lockfileBytes, manifests: [] });

  expect(res).toEqual({ ok: true, cacheDir });
  expect(observed).toHaveLength(1);
  const aside = observed[0]!;
  expect(basename(aside.staleAside)).toMatch(new RegExp(`^${lockSha256}\\.stale-.+$`));
  expect(dirname(aside.staleAside)).toBe(cacheRoot);
  expect(aside.slotVacated).toBe(true);
  expect(aside.residueAtAside).toBe(true);
  expect(readFileSync(join(cacheDir, ".penumbra-deps-cache-ok"), "utf8")).toBe(`${lockSha256}\n`);
  expect(existsSync(join(cacheDir, "old.txt"))).toBe(false);
  expect(readdirSync(cacheRoot)).toEqual([lockSha256]);
});

// Cross-process TOCTOU: another process can commit a valid (marked) cache
// into the slot between our marker check and our rename-aside. After the
// rename the aside carries the marker; deleting it would destroy a sealed
// cache, so the aside must be renamed back into place and this call's
// staged install discarded. Without the post-rename marker check the
// other process's committed cache is deleted and replaced by ours.
test("a cache committed by another process mid-rename-aside is restored, not deleted", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const cacheDir = join(cacheRoot, lockSha256);
  mkdirSync(join(cacheDir, "node_modules"), { recursive: true });
  writeFileSync(join(cacheDir, "old.txt"), "old\n", "utf8");

  let simulated = false;
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: fakeInstall(),
    onBeforeRenameStaleAside: () => {
      simulated = true;
      rmSync(cacheDir, { recursive: true, force: true });
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "committed-by-other"), "other\n", "utf8");
      writeFileSync(join(cacheDir, ".penumbra-deps-cache-ok"), `${lockSha256}\n`, "utf8");
      chmodSync(cacheDir, 0o555);
    },
  });

  const res = await provider.ensure({ lockSha256, lockfileBytes, manifests: [] });

  expect(simulated).toBe(true);
  expect(res).toEqual({ ok: true, cacheDir });
  expect(readFileSync(join(cacheDir, "committed-by-other"), "utf8")).toBe("other\n");
  expect(existsSync(join(cacheDir, "old.txt"))).toBe(false);
  // This call's staged install was discarded, not committed over the sealed cache.
  expect(existsSync(join(cacheDir, "node_modules", ".bin", "tool"))).toBe(false);
  expect(statSync(cacheDir).mode & 0o777).toBe(0o555);
  expect(readdirSync(cacheRoot)).toEqual([lockSha256]);
});

// Pins the early-accept branch: a marked winner already sitting in the slot
// when commitStagedInstall runs is accepted as-is — the rename-aside hooks
// never fire, the staged install is discarded, and the winner's dir keeps
// its inode and sealed 0o555 mode. Deleting the marker check before the
// rename-aside (so the marked winner is moved aside and restored) trips the
// hook counters and the mode assertion.
test("a marked winner that committed during our install is accepted without a rename-aside", async () => {
  const cacheRoot = mkCacheRoot();
  const lockfileBytes = Buffer.from("lock\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);
  const cacheDir = join(cacheRoot, lockSha256);
  const install = fakeInstall();
  let committedIno = 0;
  const run: RunCommand = (cmd, args, opts) => {
    const pending = install(cmd, args, opts);
    mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, "committed-by-other"), "other\n", "utf8");
    writeFileSync(join(cacheDir, ".penumbra-deps-cache-ok"), `${lockSha256}\n`, "utf8");
    chmodSync(cacheDir, 0o555);
    committedIno = statSync(cacheDir).ino;
    return pending;
  };
  let beforeRenames = 0;
  let afterRenames = 0;
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: run,
    onBeforeRenameStaleAside: () => {
      beforeRenames += 1;
    },
    onAfterRenameStaleAside: () => {
      afterRenames += 1;
    },
  });

  const res = await provider.ensure({ lockSha256, lockfileBytes, manifests: [] });

  expect(res).toEqual({ ok: true, cacheDir });
  expect(beforeRenames).toBe(0);
  expect(afterRenames).toBe(0);
  expect(statSync(cacheDir).ino).toBe(committedIno);
  expect(readFileSync(join(cacheDir, "committed-by-other"), "utf8")).toBe("other\n");
  expect(existsSync(join(cacheDir, "node_modules", ".bin", "tool"))).toBe(false);
  expect(statSync(cacheDir).mode & 0o777).toBe(0o555);
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
