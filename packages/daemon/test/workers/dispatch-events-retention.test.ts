import { expect } from "bun:test";

import { createDispatchEventsRetentionWorker } from "../../src/workers/dispatch-events-retention.js";
import { makeTempDaemon } from "../helpers.js";
import { serviceTest } from "../helpers/service-gates.js";

function insertDispatchEvent(
  d: ReturnType<typeof makeTempDaemon>,
  handoffId: string,
  ts: string,
): void {
  d.services.db.run(
    `INSERT INTO dispatch_events(handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES(?, 'w1', 'worker', 'agent.heartbeat', ?, NULL)`,
    [handoffId, ts],
  );
}

function count(d: ReturnType<typeof makeTempDaemon>): number {
  return d.services.db.query<{ c: number }, []>("SELECT COUNT(*) c FROM dispatch_events").get()!.c;
}

serviceTest("dispatch-events retention prunes rows older than the horizon", async () => {
  const d = makeTempDaemon();
  d.services.supervisor.stopAll();
  try {
    const oldTs = new Date(d.services.clock().getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();
    insertDispatchEvent(d, "old", oldTs);

    const worker = createDispatchEventsRetentionWorker({ services: d.services, retentionDays: 14 });
    await worker.tick();

    expect(count(d)).toBe(0); // older than 14d → pruned
  } finally {
    d.stop();
  }
});

serviceTest("dispatch-events retention keeps rows within the horizon", async () => {
  const d = makeTempDaemon();
  d.services.supervisor.stopAll();
  try {
    const recentTs = new Date(d.services.clock().getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    insertDispatchEvent(d, "recent", recentTs);

    const worker = createDispatchEventsRetentionWorker({ services: d.services, retentionDays: 14 });
    await worker.tick();

    expect(count(d)).toBe(1); // within 14d → kept
  } finally {
    d.stop();
  }
});

// NOTE: the batched-loop behavior (multiple DELETE rounds when rows exceed
// batchSize) is identical to and covered by t0-retention.test.ts. A
// dispatch-events variant here is omitted because makeTempDaemon also registers
// a background dispatch-events-retention worker, which races an explicit
// batchSize'd worker on the same table and makes a strict final-count assertion
// nondeterministic (a test-harness artifact, not a production concern — prod runs
// exactly one such worker).
