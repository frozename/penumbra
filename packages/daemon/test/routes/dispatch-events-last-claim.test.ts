import { applySchema, buildServices, loadSqliteVec, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { createDaemonFetchHandler } from "@src/serve.js";

const TOKEN = "tok";
const LAST_CLAIM_URL = "http://x/dispatch/events/last_claim";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/dispatch-events-last-claim-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
}

describe("GET /dispatch/events/last_claim (#259)", () => {
  let services: Services;
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    services = tempServices();
    handler = createDaemonFetchHandler({ services, token: TOKEN });
  });

  test("returns last_claim_at null on an empty event log", async () => {
    const res = await handler(
      new Request(LAST_CLAIM_URL, { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_claim_at: null });
  });

  test("returns the latest claim ts and ignores non-claim kinds", async () => {
    services.dispatchEventLog.recordBatch([
      {
        kind: "claim",
        source: "daemon",
        handoff_id: "h-1",
        worker_id: "w-1",
        ts: "2026-05-01T00:00:01.000Z",
      },
      {
        kind: "claim",
        source: "daemon",
        handoff_id: "h-2",
        worker_id: "w-2",
        ts: "2026-05-01T00:00:05.000Z",
      },
      {
        kind: "dispatch.end",
        source: "worker",
        handoff_id: "h-1",
        ts: "2026-05-01T00:00:09.000Z",
      },
    ]);

    const res = await handler(
      new Request(LAST_CLAIM_URL, { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_claim_at: "2026-05-01T00:00:05.000Z" });
  });

  test("rejects requests without an authorization header", async () => {
    const res = await handler(new Request(LAST_CLAIM_URL));
    expect(res.status).toBe(401);
  });
});
