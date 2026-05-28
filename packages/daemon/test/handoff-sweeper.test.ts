import { expect, test } from "bun:test";
import { makeTempDaemon } from "./helpers.js";
import { createHandoffSweeperWorker } from "../src/workers/handoff-sweeper.js";

function insertHandoff(d: any, id: string, status: string, ts: string, error?: string) {
  d.services.db.run(
    `INSERT INTO handoffs(handoff_id, ts, conversation_id, from_agent, to_agent, message, status, error_message)
     VALUES(?, ?, 'c1', 'a', 'b', 'msg', ?, ?)`,
    [id, ts, status, error ?? null],
  );
}

test("handoff sweeper marks stale pending handoffs as expired", async () => {
  const d = makeTempDaemon();
  try {
    const now = new Date("2026-04-23T12:00:00Z");
    // pending 61 min ago (TTL 60 min = 3600000ms)
    const oldTs = new Date(now.getTime() - 61 * 60 * 1000).toISOString();
    // pending 59 min ago
    const recentTs = new Date(now.getTime() - 59 * 60 * 1000).toISOString();

    insertHandoff(d, "h1", "pending", oldTs);
    insertHandoff(d, "h2", "pending", recentTs);

    const worker = createHandoffSweeperWorker({ services: d.services });
    await worker.tick();

    const h1: any = d.services.db.query('SELECT * FROM handoffs WHERE handoff_id="h1"').get();
    const h2: any = d.services.db.query('SELECT * FROM handoffs WHERE handoff_id="h2"').get();

    expect(h1.status).toBe("expired");
    expect(h1.resolution_reason).toContain("expired by sweeper after 3600000ms in pending");
    expect(h1.resolved_at).toBe(now.toISOString());

    expect(h2.status).toBe("pending");
  } finally {
    d.stop();
  }
});

test("handoff sweeper marks stale dispatched handoffs as expired and preserves error_message", async () => {
  const d = makeTempDaemon();
  try {
    const now = new Date("2026-04-23T12:00:00Z");
    // dispatched 31 min ago (TTL 30 min = 1800000ms)
    const oldTs = new Date(now.getTime() - 31 * 60 * 1000).toISOString();
    // dispatched 29 min ago
    const recentTs = new Date(now.getTime() - 29 * 60 * 1000).toISOString();

    insertHandoff(d, "h3", "dispatched", oldTs, "some error");
    insertHandoff(d, "h4", "dispatched", recentTs);

    const worker = createHandoffSweeperWorker({ services: d.services });
    await worker.tick();

    const h3: any = d.services.db.query('SELECT * FROM handoffs WHERE handoff_id="h3"').get();
    const h4: any = d.services.db.query('SELECT * FROM handoffs WHERE handoff_id="h4"').get();

    expect(h3.status).toBe("expired");
    expect(h3.resolution_reason).toContain("expired by sweeper after 1800000ms in dispatched");
    expect(h3.error_message).toBe("some error");

    expect(h4.status).toBe("dispatched");
  } finally {
    d.stop();
  }
});

test("handoff sweeper ignores completed or failed handoffs", async () => {
  const d = makeTempDaemon();
  try {
    const now = new Date("2026-04-23T12:00:00Z");
    const oldTs = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    insertHandoff(d, "h5", "completed", oldTs);
    insertHandoff(d, "h6", "failed", oldTs);

    const worker = createHandoffSweeperWorker({ services: d.services });
    await worker.tick();

    const h5: any = d.services.db.query('SELECT status FROM handoffs WHERE handoff_id="h5"').get();
    const h6: any = d.services.db.query('SELECT status FROM handoffs WHERE handoff_id="h6"').get();

    expect(h5.status).toBe("completed");
    expect(h6.status).toBe("failed");
  } finally {
    d.stop();
  }
});
