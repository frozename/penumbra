// The workflow wait-timeout marker and the stale-handoff sweeper both write
// dispatch_events rows directly (source "workflow" / "sweeper"). The console
// validates GET /dispatch/events with DispatchEventsListResponseSchema, so any
// stored source or kind missing from the read contract makes its dispatch
// timeline card fail to load for exactly those handoffs.
import { DispatchEventsListResponseSchema } from "@penumbra/api-contract";
import { DispatchEventLog, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { dispatchEventsGetRoute, dispatchEventsPostRoute } from "@src/routes/dispatch-events.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // ignore
}

function setup(): { db: Database; svc: Services } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const svc = { db, dispatchEventLog: new DispatchEventLog(db) } as unknown as Services;
  return { db, svc };
}

function insertRaw(
  db: Database,
  handoffId: string,
  source: string,
  kind: string,
  ts: string,
): void {
  db.run("INSERT INTO dispatch_events (handoff_id, source, kind, ts) VALUES (?, ?, ?, ?)", [
    handoffId,
    source,
    kind,
    ts,
  ]);
}

describe("dispatch events read contract covers directly written rows", () => {
  test("a timed-out handoff with the workflow marker and a sweeper end parses for the console", async () => {
    const { db, svc } = setup();
    svc.dispatchEventLog.recordBatch([
      {
        handoff_id: "h-timeout",
        worker_id: "w-1",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-10-07T10:00:00.000Z",
      },
    ]);
    insertRaw(
      db,
      "h-timeout",
      "workflow",
      "workflow.cancel.wait_timeout",
      "2026-10-07T10:30:00.000Z",
    );
    insertRaw(db, "h-timeout", "sweeper", "dispatch.end", "2026-10-07T11:15:00.000Z");

    const res = dispatchEventsGetRoute(
      new Request("http://x/dispatch/events?handoff_id=h-timeout"),
      svc,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { source: string; kind: string }[] };
    expect(body.events.map((e) => `${e.source}:${e.kind}`)).toEqual([
      "worker:dispatch.start",
      "workflow:workflow.cancel.wait_timeout",
      "sweeper:dispatch.end",
    ]);
    const parsed = DispatchEventsListResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`console contract rejected the rows: ${JSON.stringify(parsed.error.issues)}`);
    }
    expect(parsed.success).toBe(true);
  });

  test("workers still cannot post a workflow-sourced marker", async () => {
    const { svc } = setup();
    const res = await dispatchEventsPostRoute(
      new Request("http://x/dispatch/events", {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              handoff_id: "h-forge",
              source: "workflow",
              kind: "workflow.cancel.wait_timeout",
              ts: "2026-10-07T10:30:00.000Z",
            },
          ],
        }),
      }),
      svc,
    );
    expect(res.status).toBe(400);
    expect(svc.dispatchEventLog.listByHandoff("h-forge")).toEqual([]);
  });
});
