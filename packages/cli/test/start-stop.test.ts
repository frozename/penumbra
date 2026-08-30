import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../src/commands/init.js";
import { runStart } from "../src/commands/start.js";
import { runStop } from "../src/commands/stop.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

let dir = "";
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-ss-"));
  // claudeUserDir under the temp storage root so runInit's CLAUDE.md install never writes the real ~/.claude.
  await runInit({ storageRoot: dir, uuid: () => "tok", claudeUserDir: join(dir, "claude-user") });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("start writes port + pid files; stop removes them", async () => {
  const handle = await runStart({ storageRoot: dir, port: 51379 });
  try {
    expect(existsSync(join(dir, "port"))).toBe(true);
    expect(existsSync(join(dir, "pid"))).toBe(true);
    const port = Number(readFileSync(join(dir, "port"), "utf8"));
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://localhost:${String(port)}/health`);
    expect(res.status).toBe(200);
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
  expect(existsSync(join(dir, "port"))).toBe(false);
  expect(existsSync(join(dir, "pid"))).toBe(false);
});

test("start refuses if a live daemon is already running", async () => {
  const handle = await runStart({ storageRoot: dir });
  try {
    let err: unknown;
    try {
      await runStart({ storageRoot: dir });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/already running/);
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
});

test("start retries pid claim after a stale takeover loses the race", async () => {
  const pidPath = join(dir, "pid");
  const stalePid = 2147483640;
  const port = 51381;
  writeFileSync(pidPath, `${String(stalePid)}\n`);

  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  const originalUnlinkSync = fs.unlinkSync;

  let wxCalls = 0;
  const openSpy = spyOn(fs, "openSync").mockImplementation(
    (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (path === pidPath && flags === "wx") {
        wxCalls += 1;
        if (wxCalls <= 2) {
          const err = new Error("EEXIST") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        }
      }
      return originalOpenSync(path, flags, mode);
    },
  );

  type ReadFileSyncOpts = Parameters<typeof originalReadFileSync>[1];
  const readSpy = spyOn(fs, "readFileSync").mockImplementation(
    (path: fs.PathLike, options?: BufferEncoding | { encoding?: BufferEncoding | null }) => {
      if (path === pidPath) return `${String(stalePid)}\n`;
      return originalReadFileSync(path, options as ReadFileSyncOpts);
    },
  );

  const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((path: fs.PathLike) => {
    originalUnlinkSync(path);
  });

  try {
    const handle = await runStart({ storageRoot: dir, port });
    try {
      expect(wxCalls).toBe(3);
      expect(readSpy).toHaveBeenCalled();
      expect(existsSync(pidPath)).toBe(true);
      expect(Number(originalReadFileSync(pidPath, "utf8").trim())).toBe(process.pid);
    } finally {
      await runStop({ storageRoot: dir, handle });
    }
  } finally {
    openSpy.mockRestore();
    readSpy.mockRestore();
    unlinkSpy.mockRestore();
  }
});

test("stop without handle calls process.kill on recorded pid and unlinks files", async () => {
  // Synthetic pid file pointing at a known-dead pid. We can't safely test
  // SIGTERM against a real process from inside the test runner — that would
  // kill the runner. We test the cleanup invariants that runStop guarantees:
  // - file unlink runs
  // - bad pid throws are swallowed
  const fakePid = 2147483640; // near INT_MAX, very unlikely to be a real pid
  writeFileSync(join(dir, "pid"), `${String(fakePid)}\n`);
  writeFileSync(join(dir, "port"), "12345\n");

  const result = await runStop({ storageRoot: dir });
  expect(result).toBe(0);
  expect(existsSync(join(dir, "pid"))).toBe(false);
  expect(existsSync(join(dir, "port"))).toBe(false);
});

test("start binds to an explicit port when one is provided", async () => {
  // Pick a port that's almost certainly free: well above macOS service range
  // and above the ephemeral default. If something else grabs it, the test
  // will fail loudly rather than silently random-rebind.
  const port = 51380;
  const handle = await runStart({ storageRoot: dir, port });
  try {
    expect(handle.port).toBe(port);
    const portFile = Number(readFileSync(join(dir, "port"), "utf8").trim());
    expect(portFile).toBe(port);
    const res = await fetch(`http://localhost:${String(port)}/health`);
    expect(res.status).toBe(200);
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
});

test("start migrates using the resolved embedder dim, not a hardcoded 384", async () => {
  // Regression test for the boot-time hardcoded-384 defect. Before the fix,
  // runStart() ran migrate(db, { embeddingDim: 384 }) unconditionally, so a
  // non-384 corpus (e.g. a 1536-dim OpenAI-compatible embedder) tripped the
  // "embedding_dim mismatch" throw inside migrate() itself on every boot. The
  // fix resolves the embedder first and passes embedder.dim to migrate().
  const nonDefaultDim = 768;
  const isolated = mkdtempSync(join(tmpdir(), "penumbra-cli-dim-"));
  await runInit({
    storageRoot: isolated,
    uuid: () => "tok",
    claudeUserDir: join(isolated, "claude-user"),
    embeddingDim: nonDefaultDim,
  });

  const priorEnv = {
    mode: process.env.PENUMBRA_EMBEDDINGS_MODE,
    baseUrl: process.env.PENUMBRA_EMBEDDINGS_BASE_URL,
    model: process.env.PENUMBRA_EMBEDDINGS_MODEL,
    dim: process.env.PENUMBRA_EMBEDDINGS_DIM,
    healthPath: process.env.PENUMBRA_EMBEDDINGS_HEALTH_PATH,
  };
  process.env.PENUMBRA_EMBEDDINGS_MODE = "remote";
  process.env.PENUMBRA_EMBEDDINGS_BASE_URL = "http://127.0.0.1:1";
  process.env.PENUMBRA_EMBEDDINGS_MODEL = "test-model";
  process.env.PENUMBRA_EMBEDDINGS_DIM = String(nonDefaultDim);
  // Empty health path skips the liveness probe so the unreachable baseUrl
  // never has to answer — the OpenAICompatEmbedder ctor is inert.
  process.env.PENUMBRA_EMBEDDINGS_HEALTH_PATH = "";

  try {
    const handle = await runStart({ storageRoot: isolated, port: 51382 });
    try {
      const check = new Database(join(isolated, "db.sqlite"));
      try {
        const row = check
          .query<{ value: string }, []>("SELECT value FROM db_meta WHERE key='embedding_dim'")
          .get();
        expect(row?.value).toBe(String(nonDefaultDim));
      } finally {
        check.close();
      }
    } finally {
      await runStop({ storageRoot: isolated, handle });
    }
  } finally {
    for (const [key, value] of Object.entries(priorEnv)) {
      const envKey = `PENUMBRA_EMBEDDINGS_${key === "baseUrl" ? "BASE_URL" : key === "healthPath" ? "HEALTH_PATH" : key.toUpperCase()}`;
      if (value === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = value;
    }
    rmSync(isolated, { recursive: true, force: true });
  }
});

test("concurrent runStart calls — exactly one wins, the other rejects", async () => {
  // Race two starts. One should claim the pid file via O_EXCL; the other
  // should reject with "already running" (or fail the EEXIST liveness check).
  const results = await Promise.allSettled([
    runStart({ storageRoot: dir }),
    runStart({ storageRoot: dir }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);

  // Clean up the winner.
  const winner = fulfilled[0]!.value;
  await runStop({ storageRoot: dir, handle: winner });
});
