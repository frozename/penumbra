import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import type { HandoffRow } from "@src/schemas/handoff.js";
import {
  CURRENT_ATTEMPT_EVENT_BOUND_SQL,
  currentAttempt,
  isStaleAttempt,
  resolveWorkerHeadSha,
} from "@src/services/agent-performance-identity.js";
import type { CommitIntegrityEvidence } from "@src/services/dispatch-reliability.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

function handoffWith(dispatchAttempts: unknown): HandoffRow {
  return { dispatch_attempts: dispatchAttempts } as unknown as HandoffRow;
}

describe("currentAttempt (#342)", () => {
  it("returns the attempt for non-negative integers", () => {
    expect(currentAttempt(handoffWith(0))).toBe(0);
    expect(currentAttempt(handoffWith(1))).toBe(1);
    expect(currentAttempt(handoffWith(3))).toBe(3);
  });

  it("returns null for non-integers, negatives, and non-numbers", () => {
    expect(currentAttempt(handoffWith(-1))).toBeNull();
    expect(currentAttempt(handoffWith(1.5))).toBeNull();
    expect(currentAttempt(handoffWith(NaN))).toBeNull();
    expect(currentAttempt({} as unknown as HandoffRow)).toBeNull();
    expect(currentAttempt(handoffWith(null))).toBeNull();
    expect(currentAttempt(handoffWith("2"))).toBeNull();
  });
});

describe("isStaleAttempt (#342)", () => {
  it("returns false when the attempt is null, whatever the input holds", () => {
    expect(isStaleAttempt({ dispatch_attempt: 0 }, null)).toBe(false);
    expect(isStaleAttempt({ dispatch_attempt: 5 }, null)).toBe(false);
  });

  it("returns false when the input carries no dispatch_attempt", () => {
    expect(isStaleAttempt({}, 2)).toBe(false);
  });

  it("returns true when the input attempt is behind the current attempt", () => {
    expect(isStaleAttempt({ dispatch_attempt: 1 }, 2)).toBe(true);
    expect(isStaleAttempt({ dispatch_attempt: 0 }, 1)).toBe(true);
  });

  it("returns false when the input attempt matches or leads the current attempt", () => {
    expect(isStaleAttempt({ dispatch_attempt: 2 }, 2)).toBe(false);
    expect(isStaleAttempt({ dispatch_attempt: 3 }, 2)).toBe(false);
  });
});

describe("resolveWorkerHeadSha (#342)", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const SHA256 = "c".repeat(64);

  const CLEAN: CommitIntegrityEvidence = {
    base_sha: SHA_A,
    head_sha: SHA_B,
    base_is_ancestor: true,
    identity: { name: "w", email: "w@x" },
    mismatched_commits: [],
  };
  const { base_is_ancestor: _omit, ...noAncestor } = CLEAN;

  it("returns null for null meta and an empty meta", () => {
    expect(resolveWorkerHeadSha(null)).toBeNull();
    expect(resolveWorkerHeadSha({})).toBeNull();
  });

  it("returns the commit_integrity head for clean evidence", () => {
    expect(resolveWorkerHeadSha({ commit_integrity: CLEAN })).toBe(SHA_B);
  });

  it("accepts a 64-hex head sha", () => {
    expect(resolveWorkerHeadSha({ commit_integrity: { ...CLEAN, head_sha: SHA256 } })).toBe(SHA256);
  });

  it("returns null when the schema rejects the evidence", () => {
    expect(
      resolveWorkerHeadSha({ commit_integrity: { ...CLEAN, head_sha: "B".repeat(40) } }),
    ).toBeNull();
    expect(
      resolveWorkerHeadSha({ commit_integrity: { ...CLEAN, head_sha: "b".repeat(39) } }),
    ).toBeNull();
    expect(resolveWorkerHeadSha({ commit_integrity: noAncestor })).toBeNull();
  });

  it("prefers the autocommit sha over commit_integrity", () => {
    expect(
      resolveWorkerHeadSha({ autocommitted: true, autocommit_sha: SHA_A, commit_integrity: CLEAN }),
    ).toBe(SHA_A);
  });

  it("returns null when autocommitted is true and the autocommit sha is invalid — no fallback", () => {
    expect(
      resolveWorkerHeadSha({
        autocommitted: true,
        autocommit_sha: "deadbeef",
        commit_integrity: CLEAN,
      }),
    ).toBeNull();
  });

  it("returns null when autocommitted is true and the autocommit sha is missing or non-string", () => {
    expect(resolveWorkerHeadSha({ autocommitted: true, commit_integrity: CLEAN })).toBeNull();
    expect(
      resolveWorkerHeadSha({
        autocommitted: true,
        autocommit_sha: 123,
        commit_integrity: CLEAN,
      }),
    ).toBeNull();
  });

  it("requires autocommitted to be strictly boolean true", () => {
    expect(
      resolveWorkerHeadSha({
        autocommitted: "true",
        autocommit_sha: SHA_A,
        commit_integrity: CLEAN,
      }),
    ).toBe(SHA_B);
  });
});

describe("CURRENT_ATTEMPT_EVENT_BOUND_SQL (#342)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  function insertEvent(hid: string, kind: string): number {
    const row = db
      .prepare(
        `INSERT INTO dispatch_events (handoff_id, source, kind, ts, meta_json)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(hid, "worker", kind, "2026-04-30T12:00:00Z");
    return Number(row.lastInsertRowid);
  }

  function boundedIds(hid: string): number[] {
    const stmt = db.query<{ id: number }, [string, string]>(
      `SELECT id FROM dispatch_events WHERE handoff_id = ? AND ${CURRENT_ATTEMPT_EVENT_BOUND_SQL} ORDER BY id`,
    );
    return stmt.all(hid, hid).map((r) => r.id);
  }

  it("returns every row for the handoff when there is no claim event", () => {
    const r1 = insertEvent("h1", "dispatch.start");
    const r2 = insertEvent("h1", "dispatch.end");
    expect(boundedIds("h1")).toEqual([r1, r2]);
  });

  it("returns only rows after the last claim, excluding the claim itself", () => {
    insertEvent("h1", "dispatch.start");
    insertEvent("h1", "claim");
    insertEvent("h1", "dispatch.end");
    insertEvent("h1", "claim");
    const r3 = insertEvent("h1", "dispatch.end");
    expect(boundedIds("h1")).toEqual([r3]);
  });

  it("scopes the claim bound to the same handoff", () => {
    const r1 = insertEvent("h1", "dispatch.start");
    const r2 = insertEvent("h1", "dispatch.end");
    insertEvent("h2", "claim");
    const r4 = insertEvent("h1", "dispatch.note");
    expect(boundedIds("h1")).toEqual([r1, r2, r4]);
  });
});
