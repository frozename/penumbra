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

describe("memory-efficacy-jobs — enqueue + claim + status", () => {
  it("mutation: insert null instead of opts.sinceISO — enqueue persists optional fields", () => {
    const db = freshDb();
    const jobA = enqueueMemoryEfficacyJob(db, {
      reviewsDir: "/tmp/reviews",
      sinceISO: "2026-04-01T00:00:00.000Z",
      enqueuedBy: "test-enqueuer",
    });
    const claimed = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.job_id).toBe(jobA.job_id);
    expect(claimed!.since_iso).toBe("2026-04-01T00:00:00.000Z");

    const statusA = getJobStatus(db, jobA.job_id);
    expect(statusA?.since_iso).toBe("2026-04-01T00:00:00.000Z");
    expect(statusA?.enqueued_by).toBe("test-enqueuer");

    const jobB = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const statusB = getJobStatus(db, jobB.job_id);
    expect(statusB?.since_iso).toBeNull();
    expect(statusB?.enqueued_by).toBeNull();
    expect(statusB?.status).toBe("queued");
    db.close();
  });
});

describe("memory-efficacy-jobs — claimNextJob FIFO", () => {
  it("mutation: ORDER BY ts_enqueued DESC — claimNextJob is FIFO", () => {
    const db = freshDb();
    const jobA = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const jobB = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [
      "2026-05-01T10:00:00.000Z",
      jobA.job_id,
    ]);
    db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [
      "2026-05-01T09:00:00.000Z",
      jobB.job_id,
    ]);

    const first = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(first?.job_id).toBe(jobB.job_id);

    const second = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(second?.job_id).toBe(jobA.job_id);
    db.close();
  });
});

describe("memory-efficacy-jobs — claimNextJob skips terminal", () => {
  it("mutation: change `status = 'queued'` to `status != 'running'` in claimNextJob SELECT — claimNextJob skips terminal jobs ahead of a queued one", () => {
    const db = freshDb();
    const t1 = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const t2 = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const q = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [
      "2026-05-01T09:00:00.000Z",
      t1.job_id,
    ]);
    db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [
      "2026-05-01T09:30:00.000Z",
      t2.job_id,
    ]);
    db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [
      "2026-05-01T10:00:00.000Z",
      q.job_id,
    ]);

    completeJob(
      db,
      t1.job_id,
      { scanned: 1, classified: 1, skipped: 0 },
      "2026-05-01T10:00:00.000Z",
    );
    completeJob(db, t2.job_id, { error: "fail" }, "2026-05-01T10:00:00.000Z");

    const result = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(result?.job_id).toBe(q.job_id);
    expect(getJobStatus(db, q.job_id)!.status).toBe("running");

    const nullClaim = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(nullClaim).toBeNull();
    db.close();
  });
});

describe("memory-efficacy-jobs — claimNextJob expired lease takeover", () => {
  it("mutation: `ts_started = COALESCE(ts_started, ?)` -> `ts_started = ?` — claimNextJob takes over expired running lease directly", () => {
    const db = freshDb();
    const job = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    const takeover = claimNextJob(db, "2026-05-01T13:05:00.001Z", {
      workerId: "worker-b",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(takeover).not.toBeNull();
    expect(takeover!.job_id).toBe(job.job_id);

    const status = getJobStatus(db, job.job_id);
    expect(status!.claimed_by).toBe("worker-b");
    expect(status!.claimed_at).toBe("2026-05-01T13:05:00.001Z");
    expect(status!.heartbeat_at).toBe("2026-05-01T13:05:00.001Z");
    expect(status!.lease_expires_at).toBe("2026-05-01T13:10:00.001Z");
    expect(status!.ts_started).toBe("2026-05-01T13:00:00.000Z");
    db.close();
  });
});

describe("memory-efficacy-jobs — claim boundary strict", () => {
  it("mutation: `lease_expires_at < ?` -> `<= ?` in BOTH the SELECT and the UPDATE of claimNextJob — the claim boundary is strict", () => {
    const db = freshDb();
    const job = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    const boundaryClaim = claimNextJob(db, "2026-05-01T13:05:00.000Z", {
      workerId: "worker-b",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(boundaryClaim).toBeNull();

    const status = getJobStatus(db, job.job_id);
    expect(status!.claimed_by).toBe("worker-a");
    db.close();
  });
});

describe("memory-efficacy-jobs — heartbeatJob", () => {
  it("mutation: drop `AND claimed_by = ?` and its param — heartbeatJob checks the worker", () => {
    const db = freshDb();
    const job = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    const wrongWorker = heartbeatJob(db, job.job_id, "worker-b", "2026-05-01T13:02:00.000Z", {
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(wrongWorker).toBeFalse();

    const statusBefore = getJobStatus(db, job.job_id);
    const origHeartbeat = statusBefore!.heartbeat_at;
    const origLease = statusBefore!.lease_expires_at;

    const correctHeartbeat = heartbeatJob(db, job.job_id, "worker-a", "2026-05-01T13:02:00.000Z", {
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(correctHeartbeat).toBeTrue();

    const statusAfter = getJobStatus(db, job.job_id);
    expect(statusAfter!.heartbeat_at).toBe("2026-05-01T13:02:00.000Z");
    expect(statusAfter!.lease_expires_at).toBe("2026-05-01T13:07:00.000Z");
    expect(statusAfter!.heartbeat_at).not.toBe(origHeartbeat);
    expect(statusAfter!.lease_expires_at).not.toBe(origLease);
    db.close();
  });
});

describe("memory-efficacy-jobs — sweepStaleJobs", () => {
  it("mutation: drop the `lease_expires_at < ?` predicate — sweepStaleJobs only requeues expired leases", () => {
    const db = freshDb();
    const x = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const y = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
    const z = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [
      "2026-05-01T09:00:00.000Z",
      x.job_id,
    ]);
    db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [
      "2026-05-01T09:30:00.000Z",
      y.job_id,
    ]);
    db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [
      "2026-05-01T10:00:00.000Z",
      z.job_id,
    ]);

    const claimX = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(claimX?.job_id).toBe(x.job_id);

    const claimY = claimNextJob(db, "2026-05-01T13:03:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(claimY?.job_id).toBe(y.job_id);

    const statusZ = getJobStatus(db, z.job_id);
    expect(statusZ!.status).toBe("queued");

    const swept = sweepStaleJobs(db, "2026-05-01T13:06:00.000Z", { leaseTtlMs: LEASE_TTL_MS });
    expect(swept).toEqual([x.job_id]);

    const statusY = getJobStatus(db, y.job_id);
    expect(statusY!.status).toBe("running");
    expect(statusY!.claimed_by).toBe("worker-a");

    const statusZAfter = getJobStatus(db, z.job_id);
    expect(statusZAfter!.status).toBe("queued");
    db.close();
  });
});

describe("memory-efficacy-jobs — sweep boundary", () => {
  it("mutation: `<` -> `<=` in the RETURNING branch — the sweep boundary is strict", () => {
    const db = freshDb();
    const job = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    const swept = sweepStaleJobs(db, "2026-05-01T13:05:00.000Z", { leaseTtlMs: LEASE_TTL_MS });
    expect(swept).toEqual([]);

    const status = getJobStatus(db, job.job_id);
    expect(status!.status).toBe("running");
    db.close();
  });
});

describe("memory-efficacy-jobs — completeJob with error", () => {
  it("mutation: drop `lease_expires_at = NULL` from the failed+workerId SQL — completeJob with an error and the owning workerId", () => {
    const db = freshDb();
    const job = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });

    claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });

    const now = "2026-05-01T13:02:00.000Z";
    const result = completeJob(db, job.job_id, { error: "something broke" }, now, {
      workerId: "worker-a",
    });
    expect(result).toBeTrue();

    const status = getJobStatus(db, job.job_id);
    expect(status!.status).toBe("failed");
    expect(status!.ts_finished).toBe(now);
    expect(status!.error_message).toBe("something broke");
    expect(status!.claimed_at).toBeNull();
    expect(status!.claimed_by).toBeNull();
    expect(status!.heartbeat_at).toBeNull();
    expect(status!.lease_expires_at).toBeNull();
    db.close();
  });
});

describe("memory-efficacy-jobs — completeJob unknown job", () => {
  it("mutation: `return true` in place of `update.changes > 0` — completeJob on an unknown job_id returns false", () => {
    const db = freshDb();
    const fakeId = "nonexistent-job-id";
    const now = "2026-05-01T13:02:00.000Z";

    const successResult = completeJob(db, fakeId, { scanned: 1, classified: 1, skipped: 0 }, now);
    expect(successResult).toBeFalse();

    const errorResult = completeJob(db, fakeId, { error: "error" }, now);
    expect(errorResult).toBeFalse();
    db.close();
  });
});

describe("memory-efficacy-jobs — listRecentJobs", () => {
  it("mutation: drop the `WHERE status = ?` branch, i.e. ignore opts.status — listRecentJobs order, limits and status filter", () => {
    const db = freshDb();

    // Enqueue 21 jobs with strictly increasing fixed ts_enqueued
    const jobIds: string[] = [];
    for (let i = 0; i < 21; i++) {
      const j = enqueueMemoryEfficacyJob(db, { reviewsDir: "/tmp/reviews" });
      jobIds.push(j.job_id);
      const ts = `2026-05-01T${String(i).padStart(2, "0")}:${String((i * 3) % 60).padStart(2, "0")}:00.000Z`;
      db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [ts, j.job_id]);
    }

    // (a) Default limit returns 20 rows newest first
    const allJobs = listRecentJobs(db);
    expect(allJobs).toHaveLength(20);
    expect(Date.parse(allJobs[0]!.ts_enqueued)).toBeGreaterThan(
      Date.parse(allJobs[19]!.ts_enqueued),
    );

    // (a) limit: 3 returns 3 newest
    const limited = listRecentJobs(db, { limit: 3 });
    expect(limited).toHaveLength(3);

    // (b) claimNextJob picks the oldest (first enqueued = oldest ts_enqueued)
    const claimed = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
      workerId: "worker-a",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(claimed).not.toBeNull();
    const claimedId = claimed!.job_id;

    // Move claimed job's ts_enqueued to be the newest
    db.run("UPDATE memory_efficacy_jobs SET ts_enqueued = ? WHERE job_id = ?", [
      "2026-05-01T21:00:00.000Z",
      claimedId,
    ]);

    // (c) listRecentJobs with status:'running' returns exactly C
    const running = listRecentJobs(db, { status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0]!.job_id).toBe(claimedId);

    // (d) listRecentJobs with status:'queued', limit 2 returns 2 non-C queued jobs
    const queued = listRecentJobs(db, { status: "queued", limit: 2 });
    expect(queued).toHaveLength(2);
    for (const r of queued) {
      expect(r.job_id).not.toBe(claimedId);
      expect(r.status).toBe("queued");
    }
    db.close();
  });
});
