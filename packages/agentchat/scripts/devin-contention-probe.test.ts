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
    expect(round.postDb.sessionsRowCount).toBe(4);
    expect(countSessions(dbPath)).toBe(4);

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

    expect(result.ok).toBe(false);
    expect(requireRound(result).classifications).toContain("sqlite_busy");
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

    expect(result.ok).toBe(false);
    expect(requireRound(result).classifications).toContain("missing_session_rows");
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
});
