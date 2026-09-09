import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { createDaemonFetchHandler } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function buildClaimTestServices(): { services: Services; db: Database } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/handoffs-claim-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-25T20:00:00Z"),
    uuid: (): string => `e-${String(++n)}`,
  });
  return { services, db };
}

test("GET /handoffs?agent=agent-x (no status param) returns exactly the agent-x row", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });

  services.handoffWriter.create({
    handoff_id: "h-x",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-x",
    to_role: null,
    message: "m-x",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-x",
  });
  services.handoffWriter.create({
    handoff_id: "h-y",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-y",
    to_role: null,
    message: "m-y",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-y",
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs?agent=agent-x", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { handoffs: { to_agent: string }[] };
  expect(body.handoffs.map((h) => h.to_agent)).toEqual(["agent-x"]);
});

test("GET /handoffs?status=pending&agent=agent-x returns exactly the agent-x row", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });

  services.handoffWriter.create({
    handoff_id: "h-x",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-x",
    to_role: null,
    message: "m-x",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-x",
  });
  services.handoffWriter.create({
    handoff_id: "h-y",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-y",
    to_role: null,
    message: "m-y",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-y",
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs?status=pending&agent=agent-x", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { handoffs: { to_agent: string }[] };
  expect(body.handoffs.map((h) => h.to_agent)).toEqual(["agent-x"]);
});

test("GET /handoffs?status=pending&agent=nobody returns {handoffs:[]}", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });

  services.handoffWriter.create({
    handoff_id: "h-x",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-x",
    to_role: null,
    message: "m-x",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-x",
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs?status=pending&agent=nobody", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { handoffs: { to_agent: string }[] };
  expect(body.handoffs).toEqual([]);
});

test("GET /handoffs?agent= (empty) returns 400 validation_error", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });

  const res = await fetchHandler(
    new Request("http://x/handoffs?agent=", { headers: { authorization: `Bearer ${TOKEN}` } }),
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("validation_error");
});
