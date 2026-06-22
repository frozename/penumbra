import { expect } from "bun:test";

import { createHandoffSweeperWorker } from "../src/workers/handoff-sweeper.js";
import { makeTempDaemon, type TempDaemon } from "./helpers.js";
import { serviceTest } from "./helpers/service-gates.js";

interface HandoffRow {
  error_message: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  status: string;
}

function insertHandoff(
  d: TempDaemon,
  id: string,
  status: string,
  ts: string,
  error?: string,
): void {
  d.services.db.run(
    `INSERT INTO handoffs(handoff_id, ts, conversation_id, from_agent, to_agent, message, status, error_message)
     VALUES(?, ?, 'c1', 'a', 'b', 'msg', ?, ?)`,
    [id, ts, status, error ?? null],
  );
}

function getHandoff(d: TempDaemon, id: string): HandoffRow {
  const row = d.services.db
    .query<
      HandoffRow,
      [string]
    >("SELECT status, resolution_reason, resolved_at, error_message FROM handoffs WHERE handoff_id=?")
    .get(id);
  if (row === null) {
    throw new Error(`missing handoff row ${id}`);
  }
  return row;
}

serviceTest("handoff sweeper marks stale pending handoffs as expired", async () => {
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

    const h1 = getHandoff(d, "h1");
    const h2 = getHandoff(d, "h2");

    expect(h1.status).toBe("expired");
    expect(h1.resolution_reason).toContain("expired by sweeper after 3600000ms in pending");
    expect(h1.resolved_at).toBe(now.toISOString());

    expect(h2.status).toBe("pending");
  } finally {
    d.stop();
  }
});

serviceTest(
  "handoff sweeper marks stale dispatched handoffs as expired and preserves error_message",
  async () => {
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

      const h3 = getHandoff(d, "h3");
      const h4 = getHandoff(d, "h4");

      expect(h3.status).toBe("expired");
      expect(h3.resolution_reason).toContain("expired by sweeper after 1800000ms in dispatched");
      expect(h3.error_message).toBe("some error");

      expect(h4.status).toBe("dispatched");
    } finally {
      d.stop();
    }
  },
);

serviceTest("handoff sweeper ignores completed or failed handoffs", async () => {
  const d = makeTempDaemon();
  try {
    const now = new Date("2026-04-23T12:00:00Z");
    const oldTs = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    insertHandoff(d, "h5", "completed", oldTs);
    insertHandoff(d, "h6", "failed", oldTs);

    const worker = createHandoffSweeperWorker({ services: d.services });
    await worker.tick();

    const h5 = getHandoff(d, "h5");
    const h6 = getHandoff(d, "h6");

    expect(h5.status).toBe("completed");
    expect(h6.status).toBe("failed");
  } finally {
    d.stop();
  }
});
