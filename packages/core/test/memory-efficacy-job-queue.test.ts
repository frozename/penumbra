import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JudgeChatFn } from "../src/services/judge-chat.js";

import { applySchema } from "../src/db/schema.js";
import { loadSqliteVec } from "../src/db/sqlite-vec.js";
import {
  claimNextJob,
  completeJob,
  enqueueMemoryEfficacyJob,
  getJobStatus,
  heartbeatJob,
  listRecentJobs,
  sweepStaleJobs,
} from "../src/readers/memory-efficacy-jobs.js";
import { buildMemoryEfficacyCache } from "../src/readers/memory-efficacy.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

test("enqueue, claim, complete cycle via memory-efficacy-jobs reader/writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-jobqueue-"));
  const reviewDir = join(root, ".penumbra", "reviews", "2026-05-01T12-00-00");
  mkdirSync(reviewDir, { recursive: true });

  const synthesis = `# Synthesis

## Severity-ranked findings

1. **High — Database schema change was deployed without rollback plan** (architect).
2. **Medium — Missing test coverage for the new recall endpoint** (architect).

`;

  writeFileSync(join(reviewDir, "synthesis.md"), synthesis, "utf8");

  const stubChat: JudgeChatFn = () =>
    Promise.resolve(
      JSON.stringify([
        { findingId: "f0", classification: "missed_registration", reason: "No memory entry found" },
        {
          findingId: "f1",
          classification: "memory_ignored",
          reason: "Memory existed but was ignored",
        },
      ]),
    );

  const db = freshDb();
  const now = new Date("2026-05-01T13:00:00Z").toISOString();

  // 1. Enqueue
  const enqueued = enqueueMemoryEfficacyJob(db, {
    reviewsDir: join(root, ".penumbra", "reviews"),
    enqueuedBy: "test",
  });
  expect(typeof enqueued.job_id).toBe("string");
  expect(enqueued.job_id.length).toBeGreaterThan(0);

  let status = getJobStatus(db, enqueued.job_id);
  expect(status).not.toBeNull();
  expect(status!.status).toBe("queued");
  expect(status!.scanned).toBeNull();
  expect(status!.classified).toBeNull();
  expect(status!.skipped).toBeNull();

  // 2. Claim
  const claimed = claimNextJob(db, now, {
    workerId: "test-worker",
    leaseTtlMs: 5 * 60 * 1000,
  });
  expect(claimed).not.toBeNull();
  expect(claimed!.job_id).toBe(enqueued.job_id);
  expect(claimed!.reviews_dir).toBe(join(root, ".penumbra", "reviews"));
  expect(claimed!.since_iso).toBeNull();

  status = getJobStatus(db, enqueued.job_id);
  expect(status!.status).toBe("running");
  expect(status!.ts_started).toBe("2026-05-01T13:00:00.000Z");
  expect(status!.claimed_at).toBe("2026-05-01T13:00:00.000Z");
  expect(status!.claimed_by).toBe("test-worker");
  expect(status!.heartbeat_at).toBe("2026-05-01T13:00:00.000Z");
  expect(status!.lease_expires_at).toBe("2026-05-01T13:05:00.000Z");

  // 3. ClaimNothing – no more pending
  const empty = claimNextJob(db, now, {
    workerId: "test-worker",
    leaseTtlMs: 5 * 60 * 1000,
  });
  expect(empty).toBeNull();

  // 4. Run buildMemoryEfficacyCache
  const result = await buildMemoryEfficacyCache(db, {
    reviewsDir: join(root, ".penumbra", "reviews"),
    judgeChat: stubChat,
    model: "test",
  });

  // 5. Complete
  completeJob(db, claimed!.job_id, result, now);
  status = getJobStatus(db, enqueued.job_id);
  expect(status!.status).toBe("completed");
  expect(status!.ts_finished).toBe("2026-05-01T13:00:00.000Z");
  expect(status!.claimed_at).toBeNull();
  expect(status!.claimed_by).toBeNull();
  expect(status!.heartbeat_at).toBeNull();
  expect(status!.lease_expires_at).toBeNull();
  expect(status!.scanned).toBe(2);
  expect(status!.classified).toBe(2);
  expect(status!.skipped).toBe(0);

  // 6. List – filter by status
  const completedJobs = listRecentJobs(db, { status: "completed" });
  expect(completedJobs).toHaveLength(1);
  expect(completedJobs[0]!.job_id).toBe(enqueued.job_id);

  const queuedJobs = listRecentJobs(db, { status: "queued" });
  expect(queuedJobs).toHaveLength(0);

  const allJobs = listRecentJobs(db, {});
  expect(allJobs).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("stale running job is reclaimed after lease expiry and can be claimed again", () => {
  const db = freshDb();
  const enqueued = enqueueMemoryEfficacyJob(db, {
    reviewsDir: "/tmp/reviews",
    enqueuedBy: "test",
  });

  const claimedAt = "2026-05-01T13:00:00.000Z";
  const claimed = claimNextJob(db, claimedAt, {
    workerId: "worker-a",
    leaseTtlMs: 5 * 60 * 1000,
  });
  expect(claimed?.job_id).toBe(enqueued.job_id);

  const heartbeated = heartbeatJob(db, enqueued.job_id, "worker-a", "2026-05-01T13:02:00.000Z", {
    leaseTtlMs: 5 * 60 * 1000,
  });
  expect(heartbeated).toBeTrue();

  const reclaimed = sweepStaleJobs(db, "2026-05-01T13:08:01.000Z", { leaseTtlMs: 5 * 60 * 1000 });
  expect(reclaimed).toContain(enqueued.job_id);

  const status = getJobStatus(db, enqueued.job_id);
  expect(status!.status).toBe("queued");
  expect(status!.claimed_at).toBeNull();
  expect(status!.claimed_by).toBeNull();
  expect(status!.heartbeat_at).toBeNull();
  expect(status!.lease_expires_at).toBeNull();

  const reclaimedClaim = claimNextJob(db, "2026-05-01T13:08:02.000Z", {
    workerId: "worker-b",
    leaseTtlMs: 5 * 60 * 1000,
  });
  expect(reclaimedClaim?.job_id).toBe(enqueued.job_id);
  expect(getJobStatus(db, enqueued.job_id)!.claimed_by).toBe("worker-b");
});

test("failure path: completeJob with error sets status=failed and error_message", () => {
  const db = freshDb();
  const now = new Date().toISOString();

  const enqueued = enqueueMemoryEfficacyJob(db, {
    reviewsDir: "/nonexistent/path",
    enqueuedBy: "test",
  });

  const claimed = claimNextJob(db, now, {
    workerId: "test-worker",
    leaseTtlMs: 5 * 60 * 1000,
  });
  expect(claimed).not.toBeNull();

  completeJob(db, claimed!.job_id, { error: "simulated failure" }, now);

  const status = getJobStatus(db, enqueued.job_id);
  expect(status!.status).toBe("failed");
  expect(status!.error_message).toBe("simulated failure");
  expect(status!.scanned).toBeNull();
});

test("stale worker loses terminal write after reclaim", () => {
  const db = freshDb();
  const enqueued = enqueueMemoryEfficacyJob(db, {
    reviewsDir: "/tmp/reviews",
    enqueuedBy: "test",
  });

  const claimed = claimNextJob(db, "2026-05-01T13:00:00.000Z", {
    workerId: "worker-a",
    leaseTtlMs: 5 * 60 * 1000,
  });
  expect(claimed?.job_id).toBe(enqueued.job_id);

  sweepStaleJobs(db, "2026-05-01T13:06:01.000Z", { leaseTtlMs: 5 * 60 * 1000 });
  const reclaimed = claimNextJob(db, "2026-05-01T13:06:02.000Z", {
    workerId: "worker-b",
    leaseTtlMs: 5 * 60 * 1000,
  });
  expect(reclaimed?.job_id).toBe(enqueued.job_id);

  const ok = completeJob(
    db,
    enqueued.job_id,
    { scanned: 1, classified: 1, skipped: 0 },
    "2026-05-01T13:06:03.000Z",
    { workerId: "worker-a" },
  );

  expect(ok).toBeFalse();
  expect(getJobStatus(db, enqueued.job_id)!.status).toBe("running");
  expect(getJobStatus(db, enqueued.job_id)!.claimed_by).toBe("worker-b");
});
