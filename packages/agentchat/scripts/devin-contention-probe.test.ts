import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseProbeArgs,
  type ProbeResult,
  runDevinContentionProbe,
} from "./devin-contention-probe.js";

const FAKE_ACP = join(import.meta.dirname, "fixtures", "devin-contention-fake.ts");

const tempRoots: string[] = [];

async function freshTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devin-contention-probe-"));
  tempRoots.push(root);
  return root;
}

function fakeArgs(mode: string, dbPath: string, extra: string[] = []): string[] {
  return [FAKE_ACP, "--mode", mode, "--db", dbPath, ...extra];
}

function requireRound(result: ProbeResult): ProbeResult["rounds"][number] {
  const round = result.rounds[0];
  if (round === undefined) {
    throw new Error("expected one probe round");
  }
  return round;
}

function countSessions(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get();
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

// bun:test's `.rejects.toThrow(...)` is typed as returning void even though
// at runtime it awaits the underlying promise; keep the await lint-clean.
async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(message).toMatch(pattern);
}

describe("devin-contention-probe", () => {
  afterEach(async () => {
    const roots = tempRoots.splice(0);
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  });

  test("proves barrier sends land inside a held SQLite lock window", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("normal", dbPath),
      binary: process.execPath,
      concurrency: 4,
      dbPath,
      minOverlap: 4,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 250,
    });

    expect(result.ok).toBe(true);
    const round = requireRound(result);
    expect(round.maxSendSkewMs).toBeLessThanOrEqual(25);
    expect(round.postDb.integrityCheck).toBe("ok");
    expect(round.postDb.sessionsRowCount).toBe(8);
    expect(countSessions(dbPath)).toBe(8);

    const lock = round.lockControl;
    expect(lock).not.toBeNull();
    if (lock === null) {
      throw new Error("expected lock control evidence");
    }
    expect(lock.lockAcquiredWallMs).toBeGreaterThan(0);
    expect(lock.lockReleasedWallMs).toBeGreaterThanOrEqual(lock.lockAcquiredWallMs);
    expect(round.lockFreeControl?.processes).toHaveLength(4);
    expect(round.lockWindow.satisfied).toBe(true);
    expect(round.lockWindow.baselineExceededHold).toBe(false);
    expect(round.runtime.bunVersion).toBe(Bun.version);
    expect(round.runtime.platform).toBe(process.platform);
    expect(round.runtime.sqliteVersion).not.toBe("");

    for (const processResult of round.processes) {
      expect(processResult.sessionNewSendAt).toBeGreaterThanOrEqual(lock.lockAcquiredAt);
      expect(processResult.sessionNewSendAt).toBeLessThanOrEqual(lock.lockReleasedAt);
      expect(processResult.sessionNewResponseAt).toBeGreaterThanOrEqual(lock.lockReleasedAt);
      expect(processResult.sessionId).toStartWith("fake-session-");
    }
  });

  test("keeps a healthy round green when child starts are heavily staggered", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("normal", dbPath),
      binary: process.execPath,
      concurrency: 4,
      dbPath,
      minOverlap: 4,
      requireOverlap: true,
      rounds: 1,
      spawnStaggerMs: 80,
      sqliteLockControlMs: 250,
    });

    expect(result.ok).toBe(true);
    const round = requireRound(result);
    expect(round.classifications).not.toContain("serialized_dispatch");
    expect(round.maxSendSkewMs).toBeLessThanOrEqual(25);
    expect(round.postDb.sessionsRowCount).toBe(8);
    const lock = round.lockControl;
    expect(lock).not.toBeNull();
    if (lock === null) {
      throw new Error("expected lock control evidence");
    }
    for (const processResult of round.processes) {
      expect(processResult.sessionNewSendAt).toBeGreaterThanOrEqual(lock.lockAcquiredAt);
      expect(processResult.sessionNewSendAt).toBeLessThanOrEqual(lock.lockReleasedAt);
      expect(processResult.sessionNewResponseAt).toBeGreaterThanOrEqual(lock.lockReleasedAt);
      expect(processResult.sessionId).toStartWith("fake-session-");
    }
  });

  test("fails the round when the target never contends on the held lock", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("no-db", dbPath),
      binary: process.execPath,
      concurrency: 2,
      dbPath,
      minOverlap: 2,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 250,
    });

    expect(requireRound(result).classifications).toContain("lock_window_unverified");
    expect(result.ok).toBe(false);
  });

  test("restores the journal mode it switched for lock control", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("normal", dbPath),
      binary: process.execPath,
      concurrency: 2,
      dbPath,
      minOverlap: 2,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 150,
    });

    expect(result.ok).toBe(true);
    expect(requireRound(result).postDb.journalMode).toBe("delete");
  });

  test("rejects the fake forced-serialization mode even when children coexist", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("serialized", dbPath),
      binary: process.execPath,
      concurrency: 3,
      dbPath,
      minOverlap: 3,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(requireRound(result).classifications).toContain("serialized_dispatch");
  });

  test("isolates responding skew as the only serialized_dispatch predicate", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("serialized-late", dbPath),
      binary: process.execPath,
      concurrency: 3,
      dbPath,
      minOverlap: 3,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 0,
    });

    const round = requireRound(result);
    expect(round.classifications).toContain("serialized_dispatch");
    expect(result.ok).toBe(false);
    expect(round.serializedDispatch.respondingSkew.fired).toBe(true);
    expect(round.serializedDispatch.respondingSkew.measurement).toBeGreaterThan(100);
    expect(round.serializedDispatch.sendSkew.fired).toBe(false);
    expect(round.serializedDispatch.intervalOverlap.fired).toBe(false);
    expect(round.serializedDispatch.receivedSkew.fired).toBe(false);
  });

  test("rejects forced serialization at the CLI default lock hold", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");
    const options = parseProbeArgs([
      "--binary",
      process.execPath,
      "--args",
      JSON.stringify(fakeArgs("serialized", dbPath)),
      "--db",
      dbPath,
      "--concurrency",
      "3",
      "--min-overlap",
      "3",
    ]);

    const result = await runDevinContentionProbe(options);

    const round = requireRound(result);
    expect(round.classifications).toContain("serialized_dispatch");
    expect(result.ok).toBe(false);
    expect(round.serializedDispatch.respondingSkew.fired).toBe(true);
    expect(round.serializedDispatch.respondingSkew.measurement).toBeGreaterThan(100);
  });

  test("reads responding skew from control events when the lock masks serialization", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("serialized", dbPath),
      binary: process.execPath,
      concurrency: 3,
      dbPath,
      minOverlap: 3,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 1500,
    });

    const round = requireRound(result);
    expect(round.classifications).toContain("serialized_dispatch");
    expect(result.ok).toBe(false);

    const lockedResponding = round.fixtureEvents
      .filter((event) => event.kind === "session_new_responding")
      .map((event) => event.atMs);
    expect(lockedResponding).toHaveLength(3);
    expect(Math.max(...lockedResponding) - Math.min(...lockedResponding)).toBeLessThanOrEqual(100);

    expect(round.serializedDispatch.respondingSkew.fired).toBe(true);
    expect(round.serializedDispatch.respondingSkew.measurement).toBeGreaterThan(100);
    expect(round.serializedDispatch.sendSkew.fired).toBe(false);
    expect(round.serializedDispatch.intervalOverlap.fired).toBe(false);
    expect(round.serializedDispatch.receivedSkew.fired).toBe(false);
  }, 15_000);

  test("rejects lock evidence when baseline latency already exceeds the hold", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("slow-normal", dbPath),
      binary: process.execPath,
      concurrency: 2,
      dbPath,
      minOverlap: 2,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 250,
    });

    expect(requireRound(result).classifications).toContain("lock_window_unverified");
    expect(result.ok).toBe(false);
  });

  test("attributes lock_window_unverified to the baseline-exceeds-hold guard", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("slow-respond", dbPath),
      binary: process.execPath,
      concurrency: 2,
      dbPath,
      minOverlap: 2,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 250,
    });

    const round = requireRound(result);
    expect(round.classifications).toContain("lock_window_unverified");
    expect(round.classifications).not.toContain("serialized_dispatch");
    expect(result.ok).toBe(false);
    expect(round.lockWindow.baselineExceededHold).toBe(true);
    expect(round.lockWindow.satisfied).toBe(false);
    expect(round.lockWindow.pairsEvaluated).toBe(2);
  });

  test("classifies absent target instrumentation instead of treating missing events as zero skew", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("no-events", dbPath),
      binary: process.execPath,
      concurrency: 2,
      dbPath,
      minOverlap: 2,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 0,
    });

    expect(requireRound(result).classifications).toContain("target_instrumentation_absent");
    expect(result.ok).toBe(false);
  });

  test("reports null skew measurements when only one sample exists per event kind", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("normal", dbPath),
      binary: process.execPath,
      concurrency: 1,
      dbPath,
      minOverlap: 1,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 0,
    });

    expect(result.ok).toBe(true);
    const round = requireRound(result);
    expect(round.classifications).toEqual([]);
    expect(round.serializedDispatch.receivedSkew.measurement).toBeNull();
    expect(round.serializedDispatch.receivedSkew.fired).toBe(false);
    expect(round.serializedDispatch.respondingSkew.measurement).toBeNull();
    expect(round.serializedDispatch.respondingSkew.fired).toBe(false);
  });

  test("classifies a round where all session creation requests time out", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("timeout", dbPath),
      binary: process.execPath,
      concurrency: 2,
      dbPath,
      minOverlap: 2,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 0,
    });

    expect(requireRound(result).classifications).toContain("zero_sessions_created");
    expect(result.ok).toBe(false);
  }, 12_000);

  test("classifies SQLITE_BUSY fixture failures", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("busy", dbPath),
      binary: process.execPath,
      concurrency: 3,
      dbPath,
      minOverlap: 3,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 0,
    });

    expect(requireRound(result).classifications).toContain("sqlite_busy");
    expect(result.ok).toBe(false);
  });

  test("fails when session/new succeeds but the DB row is missing", async () => {
    const root = await freshTempRoot();
    const dbPath = join(root, "sessions.sqlite");

    const result = await runDevinContentionProbe({
      args: fakeArgs("missing-row", dbPath),
      binary: process.execPath,
      concurrency: 2,
      dbPath,
      minOverlap: 2,
      requireOverlap: true,
      rounds: 1,
      sqliteLockControlMs: 0,
    });

    expect(requireRound(result).classifications).toContain("missing_session_rows");
    expect(result.ok).toBe(false);
  });

  test("rejects artificial per-agent sleeps before session/new", () => {
    expect(() =>
      parseProbeArgs([
        "--binary",
        process.execPath,
        "--args",
        JSON.stringify(fakeArgs("normal", "/tmp/fake.sqlite")),
        "--db",
        "/tmp/fake.sqlite",
        "--pre-session-sleep-ms",
        "35",
      ]),
    ).toThrow(/artificial per-agent sleep/i);
  });

  test("refuses a real-store db path without explicit opt-in", () => {
    const storePath = join("/home/operator", ".local", "share", "devin", "cli", "sessions.db");
    expect(() =>
      parseProbeArgs([
        "--binary",
        process.execPath,
        "--args",
        JSON.stringify(fakeArgs("normal", storePath)),
        "--db",
        storePath,
      ]),
    ).toThrow(/allow-real-store/);
  });

  test("accepts a real-store db path only with --allow-real-store", () => {
    const storePath = join("/home/operator", ".local", "share", "devin", "cli", "sessions.db");
    const options = parseProbeArgs([
      "--binary",
      process.execPath,
      "--args",
      JSON.stringify(fakeArgs("normal", storePath)),
      "--db",
      storePath,
      "--allow-real-store",
    ]);
    expect(options.allowRealStore).toBe(true);
  });

  test("runDevinContentionProbe refuses real-store paths without opt-in", async () => {
    await expectRejection(
      runDevinContentionProbe({
        args: [],
        binary: process.execPath,
        concurrency: 2,
        dbPath: "/home/operator/.local/share/devin/cli/sessions.db",
        minOverlap: 2,
        requireOverlap: true,
        rounds: 1,
        sqliteLockControlMs: 0,
      }),
      /allow-real-store/,
    );
  });

  test("caps concurrency and rounds", async () => {
    await expectRejection(
      runDevinContentionProbe({
        args: [],
        binary: process.execPath,
        concurrency: 17,
        dbPath: "/tmp/never-created.sqlite",
        minOverlap: 2,
        requireOverlap: true,
        rounds: 1,
        sqliteLockControlMs: 0,
      }),
      /concurrency/,
    );
    await expectRejection(
      runDevinContentionProbe({
        args: [],
        binary: process.execPath,
        concurrency: 2,
        dbPath: "/tmp/never-created.sqlite",
        minOverlap: 2,
        requireOverlap: true,
        rounds: 11,
        sqliteLockControlMs: 0,
      }),
      /rounds/,
    );
  });
});
