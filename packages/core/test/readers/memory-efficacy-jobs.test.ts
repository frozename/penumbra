import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import {
  claimNextJob,
  completeJob,
  enqueueMemoryEfficacyJob,
  getJobStatus,
  heartbeatJob,
  listRecentJobs,
  sweepStaleJobs,
} from "@src/readers/memory-efficacy-jobs.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

const LEASE_TTL_MS = 5 * 60 * 1000;

describe("enqueueMemoryEfficacyJob + getJobStatus — optional fields persist", () => {
  it("mutation: insert null instead of opts.sinceISO", () => {
    const db = freshDb();

    const A = enqueueMemoryEfficacyJob(db, {
      reviewsDir: "/tmp/reviews",
      sinceISO: "2026-04-01T00:00:00.000Z",
      enqueuedBy: "operator-1",
    });
    expect(typeof A.job_id).toBe("string");

    const claimed = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.job_id).toBe(A.job_id);
    expect(claimed!.since_iso).toBe("2026-04-01T00:00:00.000Z");

    const statusA = getJobStatus(db, A.job_id);
    expect(statusA!.since_iso).toBe("2026-04-01T00:00:00.000Z");
    expect(statusA!.enqueued_by).toBe("operator-1");

    const B = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const statusB = getJobStatus(db, B.job_id);
    expect(statusB!.since_iso).toBeNull();
    expect(statusB!.enqueued_by).toBeNull();
    expect(statusB!.status).toBe("queued");
  });
});

describe("claimNextJob — FIFO order", () => {
  it("mutation: ORDER BY ts_enqueued DESC", () => {
    const db = freshDb();

    const A = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const B = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    db.run(
      "UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?",
      ["2026-05-01T10:00:00.000Z", A.job_id],
    );
    db.run(
      "UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?",
      ["2026-05-01T09:00:00.000Z", B.job_id],
    );

    const first = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(first!.job_id).toBe(B.job_id);

    const second = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(second!.job_id).toBe(A.job_id);
  });
});

describe("claimNextJob — skips terminal jobs ahead of queued", () => {
  it("mutation: change `status = 'queued'` to `status != 'running'` in the claimNextJob SELECT only. The oldest terminal row is selected, the UPDATE guard rejects it, and the claim returns null instead of Q.", () => {
    const db = freshDb();

    const T1 = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const T2 = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const Q = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    db.run(
      "UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?",
      ["2026-05-01T09:00:00.000Z", T1.job_id],
    );
    db.run(
      "UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?",
      ["2026-05-01T09:30:00.000Z", T2.job_id],
    );
    db.run(
      "UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?",
      ["2026-05-01T10:00:00.000Z", Q.job_id],
    );

    // Mark T1 completed, T2 failed (no workerId)
    completeJob(db, T1.job_id, { scanned: 1, classified: 1, skipped: 0 }, "2026-05-01T12:00:00.000Z");
    completeJob(db, T2.job_id, { error: "something broke" }, "2026-05-01T12:00:00.000Z");

    const result = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(result).not.toBeNull();
    expect(result!.job_id).toBe(Q.job_id);
    expect(getJobStatus(db, Q.job_id)!.status).toBe("running");

    // Second claim returns null — only terminal + one live running left
    const next = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(next).toBeNull();
  });
});

describe("claimNextJob — expired lease takeover", () => {
  it("mutation: `ts_started = COALESCE(ts_started, ?)` -> `ts_started = ?`", () => {
    const db = freshDb();

    const A = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    const reClaimed = claimNextJob(db, "2026-05-01T13:05:00.001Z", {
      workerId: "worker-b",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(reClaimed).not.toBeNull();
    expect(reClaimed!.job_id).toBe(A.job_id);

    const status = getJobStatus(db, A.job_id);
    expect(status!.claimed_by).toBe("worker-b");
    expect(status!.claimed_at).toBe("2026-05-01T13:05:00.001Z");
    expect(status!.heartbeat_at).toBe("2026-05-01T13:05:00.001Z");
    expect(status!.lease_expires_at).toBe("2026-05-01T13:10:00.001Z");
    expect(status!.ts_started).toBe("2026-05-01T13:00:00.000Z");
  });
});

describe("claimNextJob — strict lease boundary", () => {
  it("mutation: `lease_expires_at < ?` -> `<= ?` in BOTH the SELECT and the UPDATE of claimNextJob. The claim returns null and claimed_by stays worker-a.", () => {
    const db = freshDb();

    const A = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    // Exactly at the boundary — the claim should return null
    const boundary = claimNextJob(db, "2026-05-01T13:05:00.000Z", {
      workerId: "worker-b",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(boundary).toBeNull();
    expect(getJobStatus(db, A.job_id)!.claimed_by).toBe("worker-a");
  });
});

describe("heartbeatJob — worker check", () => {
  it("mutation: drop `AND claimed_by = ?` and its param", () => {
    const db = freshDb();

    const A = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    // Wrong worker — should return false, leave fields unchanged
    const wrong = heartbeatJob(db, A.job_id, "worker-b", "2026-05-01T13:02:00.000Z", {
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(wrong).toBe(false);
    const statusWrong = getJobStatus(db, A.job_id);
    const hbBefore = statusWrong!.heartbeat_at;
    const leBefore = statusWrong!.lease_expires_at;
    expect(statusWrong!.heartbeat_at).toBe("2026-05-01T13:00:00.000Z");
    expect(statusWrong!.lease_expires_at).toBe("2026-05-01T13:05:00.000Z");

    // Correct worker — should succeed
    const ok = heartbeatJob(db, A.job_id, "worker-a", "2026-05-01T13:02:00.000Z", {
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(ok).toBe(true);
    const statusOk = getJobStatus(db, A.job_id);
    expect(statusOk!.heartbeat_at).toBe("2026-05-01T13:02:00.000Z");
    expect(statusOk!.lease_expires_at).toBe("2026-05-01T13:07:00.000Z");
  });
});

describe("sweepStaleJobs — only requeues expired leases", () => {
  it("mutation: drop the `lease_expires_at < ?` predicate", () => {
    const db = freshDb();

    const X = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const Y = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const Z = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    db.run(
      "UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?",
      ["2026-05-01T09:00:00.000Z", X.job_id],
    );
    db.run(
      "UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?",
      ["2026-05-01T09:30:00.000Z", Y.job_id],
    );
    db.run(
      "UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?",
      ["2026-05-01T10:00:00.000Z", Z.job_id],
    );

    // Claim X at 13:00 (lease to 13:05)
    const cX = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(cX!.job_id).toBe(X.job_id);

    // Claim Y at 13:03 (lease to 13:08)
    const cY = claimNextJob(db, "2026-05-01T13:03:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(cY!.job_id).toBe(Y.job_id);

    // Z stays queued
    expect(getJobStatus(db, Z.job_id)!.status).toBe("queued");

    // Sweep at 13:06:00.000Z — only X's lease (13:05) has expired
    const swept = sweepStaleJobs(db, "2026-05-01T13:06:00.000Z", { leaseTtlMs: LEASE_TTL_MS });
    expect(swept).toEqual([X.job_id]);

    // Y stays running with its worker and lease
    const statusY = getJobStatus(db, Y.job_id);
    expect(statusY!.status).toBe("running");
    expect(statusY!.claimed_by).toBe("worker-a");
    expect(statusY!.lease_expires_at).toBe("2026-05-01T13:08:00.000Z");

    // Z still queued
    expect(getJobStatus(db, Z.job_id)!.status).toBe("queued");
  });
});

describe("sweepStaleJobs — strict boundary", () => {
  it("mutation: `<` -> `<=` in the RETURNING branch", () => {
    const db = freshDb();

    const A = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    // Lease expires at 13:05:00.000Z, sweep exactly at that time
    const swept = sweepStaleJobs(db, "2026-05-01T13:05:00.000Z", { leaseTtlMs: LEASE_TTL_MS });
    expect(swept).toEqual([]);

    const status = getJobStatus(db, A.job_id);
    expect(status!.status).toBe("running");
  });
});

describe("completeJob — error with workerId", () => {
  it("mutation: drop `lease_expires_at = NULL` from the failed+workerId SQL", () => {
    const db = freshDb();

    const A = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    const now = "2026-05-01T13:02:00.000Z";
    const ok = completeJob(
      db,
      A.job_id,
      { error: "disk full" },
      now,
      { workerId: "worker-a" },
    );

    expect(ok).toBe(true);
    const status = getJobStatus(db, A.job_id);
    expect(status!.status).toBe("failed");
    expect(status!.ts_finished).toBe(now);
    expect(status!.error_message).toBe("disk full");
    expect(status!.claimed_at).toBeNull();
    expect(status!.claimed_by).toBeNull();
    expect(status!.heartbeat_at).toBeNull();
    expect(status!.lease_expires_at).toBeNull();
  });
});

describe("completeJob — unknown job_id", () => {
  it("mutation: `return true` in place of `update.changes > 0`", () => {
    const db = freshDb();

    const fakeId = "nonexistent-job-id";

    const success = completeJob(
      db,
      fakeId,
      { scanned: 1, classified: 1, skipped: 0 },
      "2026-05-01T13:00:00.000Z",
    );
    expect(success).toBe(false);

    const error = completeJob(
      db,
      fakeId,
      { error: "boom" },
      "2026-05-01T13:00:00.000Z",
    );
    expect(error).toBe(false);
  });
});

describe("listRecentJobs — order, limits, status filter", () => {
  it("mutation: drop the `WHERE status = ?` branch, i.e. ignore opts.status. Then (c) returns 20 rows and (d) returns C first.", () => {
    const db = freshDb();

    // (a) Enqueue 21 jobs with strictly increasing fixed ts_enqueued
    const jobIds: string[] = [];
    for (let i = 0; i < 21; i++) {
      const j = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
      jobIds.push(j.job_id);
      const ts = `2026-05-01T${String(9 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00.000Z`;
      db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [ts, j.job_id]);
    }

    // listRecentJobs returns 20 rows, newest first
    const all20 = listRecentJobs(db);
    expect(all20).toHaveLength(20);

    // {limit: 3} returns 3 newest
    const limit3 = listRecentJobs(db, { limit: 3 });
    expect(limit3).toHaveLength(3);

    // (b) Claim the oldest (first enqueued)
    const oldestId = jobIds[0]!;
    const claimed = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(claimed).not.toBeNull();
    const C = (claimed as { job_id: string; reviews_dir: string; since_iso: string | null }).job_id;
    expect(C).toBe(oldestId);

    // Move C's ts_enqueued to be the newest
    db.run(
      "UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?",
      ["2026-05-01T14:00:00.000Z", C],
    );

    // (c) listRecentJobs(db, {status:'running'}) returns exactly one row, C
    const running = listRecentJobs(db, { status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0]!.job_id).toBe(C);
    expect(running[0]!.status).toBe("running");

    // (d) listRecentJobs(db, {status:'queued', limit: 2}) returns 2 rows, none of them C
    const queued = listRecentJobs(db, { status: "queued", limit: 2 });
    expect(queued).toHaveLength(2);
    for (const row of queued) {
      expect(row.job_id).not.toBe(C);
      expect(row.status).toBeDefined();
      expect(row.status).toBe("queued");
    }
  });
});
