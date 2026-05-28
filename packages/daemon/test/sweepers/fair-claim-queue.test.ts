import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HandoffReader, HandoffWriter, loadSqliteVec, migrate } from "@penumbra/core";

// Telemetry assertion (per_root_top3 in dispatch_event meta) is already covered
// by packages/daemon/test/routes/handoffs-claim-telemetry.test.ts. This file
// focuses on claim ordering across multiple roots.

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function insertApproved(
  db: Database,
  handoff_id: string,
  root_handoff_id: string,
  parent_handoff_id: string | null,
  ts_offset_ms: number,
): void {
  const ts = new Date(1700000000000 + ts_offset_ms).toISOString();
  db.run(
    `INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, parent_handoff_id, root_handoff_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`,
    [
      handoff_id,
      ts,
      "p",
      `conv-${root_handoff_id}`,
      "a",
      "b",
      "msg",
      parent_handoff_id,
      root_handoff_id,
    ],
  );
}

test("two-chain interleave: A0, B0, A1, A2, A3", () => {
  const db = makeDb();
  insertApproved(db, "A0", "A", null, 0);
  insertApproved(db, "A1", "A", "A0", 1);
  insertApproved(db, "A2", "A", "A0", 2);
  insertApproved(db, "A3", "A", "A0", 3);
  insertApproved(db, "B0", "B", null, 50);

  const reader = new HandoffReader({ db });
  const writer = new HandoffWriter({ db });

  // Claim 1: both roots tied at in_flight=0 → FIFO ts breaks → A0.
  const r1 = reader.listByStatus({ statuses: ["approved"] })[0];
  expect(r1?.handoff_id).toBe("A0");
  expect(writer.claimDispatch(r1!.handoff_id, "worker-1")).toBe(true);

  // Claim 2: A.in_flight=1 (A0 dispatched), B.in_flight=0 → B0 wins.
  const r2 = reader.listByStatus({ statuses: ["approved"] })[0];
  expect(r2?.handoff_id).toBe("B0");
  expect(writer.claimDispatch(r2!.handoff_id, "worker-2")).toBe(true);

  // Claim 3: both at in_flight=1 → FIFO ts → A1.
  const r3 = reader.listByStatus({ statuses: ["approved"] })[0];
  expect(r3?.handoff_id).toBe("A1");
  expect(writer.claimDispatch(r3!.handoff_id, "worker-3")).toBe(true);

  // Claim 4: A.in_flight=2, no remaining B; A2 wins by FIFO ts.
  const r4 = reader.listByStatus({ statuses: ["approved"] })[0];
  expect(r4?.handoff_id).toBe("A2");
  expect(writer.claimDispatch(r4!.handoff_id, "worker-4")).toBe(true);

  // Claim 5: only A3 remaining.
  const r5 = reader.listByStatus({ statuses: ["approved"] })[0];
  expect(r5?.handoff_id).toBe("A3");
});

test("single-root claim order is FIFO (no perf regression)", () => {
  const db = makeDb();
  for (let i = 0; i < 8; i++) {
    insertApproved(db, `X${i}`, "X", i === 0 ? null : "X0", i);
  }

  const reader = new HandoffReader({ db });
  const writer = new HandoffWriter({ db });

  for (let i = 0; i < 8; i++) {
    const next = reader.listByStatus({ statuses: ["approved"] })[0];
    expect(next?.handoff_id).toBe(`X${i}`);
    expect(writer.claimDispatch(next!.handoff_id, `worker-${i}`)).toBe(true);
  }
});

test("claim ordering after mid-stream completion of A0", () => {
  const db = makeDb();
  insertApproved(db, "A0", "A", null, 0);
  insertApproved(db, "A1", "A", "A0", 1);
  insertApproved(db, "A2", "A", "A0", 2);
  insertApproved(db, "B0", "B", null, 50);

  const reader = new HandoffReader({ db });
  const writer = new HandoffWriter({ db });

  const first = reader.listByStatus({ statuses: ["approved"] })[0];
  expect(first?.handoff_id).toBe("A0");
  writer.claimDispatch(first!.handoff_id, "w1");

  const second = reader.listByStatus({ statuses: ["approved"] })[0];
  expect(second?.handoff_id).toBe("B0");
  writer.claimDispatch(second!.handoff_id, "w2");

  // Complete A0 — drops A's in-flight count back to 0 (A1, A2 still approved).
  db.run("UPDATE handoffs SET status='completed' WHERE handoff_id='A0'");

  // A.in_flight=0, B.in_flight=1 → A wins → FIFO → A1.
  const next = reader.listByStatus({ statuses: ["approved"] })[0];
  expect(next?.handoff_id).toBe("A1");
});
