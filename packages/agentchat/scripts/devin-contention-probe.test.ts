import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProbeProcessResult } from "./devin-contention-probe-evidence.js";

import {
  effectiveHoldMs,
  parseProbeArgs,
  type ProbeResult,
  roundResponseSpanMs,
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

    // Assert on the classification array, not just ok: a bare `ok === false` prints
    // "Received: false" and discards which predicate fired, which is what made the
    // 2026-09-09 CI red cost a full investigation to attribute.
    expect(result.summary.classifications).toEqual([]);
    const round = requireRound(result);
    // Readiness is stamped before the fixture persists its rows, so a healthy round's
    // responding skew is scheduler noise rather than SQLite lock waits. If this creeps
    // back toward MAX_RECEIVE_SKEW_MS (100) the instrument is measuring itself again,
    // and the next slow runner turns it into a red CI.
    expect(round.serializedDispatch.respondingSkew.measurement ?? 0).toBeLessThanOrEqual(5);
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

  test("reads responding skew from control events under a long hold", async () => {
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
    // Readiness is now stamped before the fixture persists its events, so the locked
    // round reports the serialized fixture's own per-index stagger (0/200/400 ms)
    // instead of the instant each child cleared the released lock. The previous
    // `<= 100` here pinned that artefact: every child's stamp was dragged to the
    // release moment by the instrument's own blocked writes. The spread is ~400 ms;
    // 100 keeps 4x margin rather than re-introducing a tight timing bound.
    expect(Math.max(...lockedResponding) - Math.min(...lockedResponding)).toBeGreaterThan(100);

    expect(round.serializedDispatch.respondingSkew.fired).toBe(true);
    expect(round.serializedDispatch.respondingSkew.measurement).toBeGreaterThan(100);
    expect(round.serializedDispatch.sendSkew.fired).toBe(false);
    expect(round.serializedDispatch.intervalOverlap.fired).toBe(false);
    expect(round.serializedDispatch.receivedSkew.fired).toBe(false);
  }, 15_000);

  test("calibrated hold covers a slow-normal baseline without rejecting the lock window", async () => {
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

    const round = requireRound(result);
    expect(round.classifications).not.toContain("lock_window_unverified");
    expect(result.ok).toBe(true);
  });

  test("calibrated hold covers a slow-respond baseline and the lock window is satisfied", async () => {
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
    expect(round.classifications).not.toContain("lock_window_unverified");
    expect(round.classifications).not.toContain("serialized_dispatch");
    expect(result.ok).toBe(true);
    expect(round.lockWindow.baselineExceededHold).toBe(false);
    expect(round.lockWindow.satisfied).toBe(true);
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

  test("measures round response span excluding errored sessions", () => {
    const processes: ProbeProcessResult[] = [
      {
        endAt: null,
        error: null,
        exitCode: null,
        index: 0,
        pid: 1000,
        sessionId: "s0",
        sessionNewResponseAt: 200,
        sessionNewSendAt: 100,
        startAt: 90,
        stderrTail: "",
      },
      {
        endAt: null,
        error: null,
        exitCode: null,
        index: 1,
        pid: 1001,
        sessionId: "s1",
        sessionNewResponseAt: 240,
        sessionNewSendAt: 120,
        startAt: 110,
        stderrTail: "",
      },
    ];
    expect(roundResponseSpanMs({ processes })).toBe(140);
  });

  test("excludes a timed-out response from round response span", () => {
    const processes: ProbeProcessResult[] = [
      {
        endAt: null,
        error: null,
        exitCode: null,
        index: 0,
        pid: 1000,
        sessionId: "s0",
        sessionNewResponseAt: 200,
        sessionNewSendAt: 100,
        startAt: 90,
        stderrTail: "",
      },
      {
        endAt: null,
        error: "request timed out",
        exitCode: null,
        index: 1,
        pid: 1001,
        sessionId: null,
        sessionNewResponseAt: 5_000,
        sessionNewSendAt: 120,
        startAt: 110,
        stderrTail: "",
      },
    ];
    expect(roundResponseSpanMs({ processes })).toBe(100);
  });

  test("round response span returns 0 when all sends or responses are missing", () => {
    const missingSends: ProbeProcessResult[] = [
      {
        endAt: null,
        error: null,
        exitCode: null,
        index: 0,
        pid: 1000,
        sessionId: "s0",
        sessionNewResponseAt: 200,
        sessionNewSendAt: 0,
        startAt: 90,
        stderrTail: "",
      },
    ];
    const missingResponses: ProbeProcessResult[] = [
      {
        endAt: null,
        error: null,
        exitCode: null,
        index: 0,
        pid: 1000,
        sessionId: "s0",
        sessionNewResponseAt: 0,
        sessionNewSendAt: 100,
        startAt: 90,
        stderrTail: "",
      },
    ];
    expect(roundResponseSpanMs({ processes: missingSends })).toBe(0);
    expect(roundResponseSpanMs({ processes: missingResponses })).toBe(0);
    expect(roundResponseSpanMs({ processes: [] })).toBe(0);
  });

  test("scales effective hold with control span and caps it", () => {
    expect(effectiveHoldMs(250, 50)).toBe(325);
    expect(effectiveHoldMs(250, 0)).toBe(275);
    expect(effectiveHoldMs(1_500, 155)).toBe(1_680);
    expect(effectiveHoldMs(250, 1_000_000)).toBe(5_950);
    expect(effectiveHoldMs(6_000, 0)).toBe(5_950);
  });
});
