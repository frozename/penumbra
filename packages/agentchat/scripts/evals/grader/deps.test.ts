import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultDependencyProvider, readBaseDepsInput } from "./deps.js";
import { defaultRunCommand, type RunCommand } from "./materialize.js";

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
