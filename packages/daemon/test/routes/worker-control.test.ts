import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { conversationsCancelRoute } from "../../src/routes/conversations.js";
import { handoffsCreateRoute } from "../../src/routes/handoffs.js";
import { workerControlRoute } from "../../src/routes/worker-control.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

interface WorkerControlTestEvent {
  type: string;
  conversation_id?: string;
  handoff_id?: string;
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/worker-ctrl-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `e-${String(n)}`;
      };
    })(),
  });
}

async function readSseEvents(
  stream: ReadableStream<Uint8Array>,
  n: number,
  timeoutMs = 1000,
): Promise<WorkerControlTestEvent[]> {
  const reader = stream.getReader();
  const events: WorkerControlTestEvent[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(
          () => {
            resolve({ value: undefined, done: true });
          },
          Math.max(0, deadline - Date.now()),
        ),
      ),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as WorkerControlTestEvent);
    }
  }
  reader.releaseLock();
  return events;
}

test("POST /conversations/:id/cancel records in DB and broadcasts", async () => {
  const services = tempServices();
  const cid = "conv-1";

  // Seed a handoff
  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: cid,
        triggered_by_event_id: "e1",
      }),
    }),
    services,
  );

  let emitted: WorkerControlTestEvent | null = null;
  services.workerControl.subscribe((event) => {
    emitted = event;
  });

  const res = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res.status).toBe(200);

  // Verify DB
  const row = services.handoffReader.listByStatus({
    statuses: ["pending"],
    conversation_id: cid,
  })[0];
  expect(row.cancel_requested_at).toBe("2026-04-26T00:00:00.000Z");

  // Verify Broadcast
  expect(emitted).toEqual({ type: "cancel", conversation_id: cid, handoff_id: "e-1" });
});

test("GET /worker/control performs durable sync and live broadcast", async () => {
  const services = tempServices();

  // 1. Request cancellation BEFORE worker connects
  // handoff_id will be e-1
  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: "c1",
        triggered_by_event_id: "e1",
      }),
    }),
    services,
  );
  conversationsCancelRoute(new Request("http://x"), "c1", services);

  // 2. Connect worker
  const res = workerControlRoute(new Request("http://x"), services);
  expect(res.status).toBe(200);

  // 3. Request ANOTHER cancellation while connected
  // handoff_id will be e-2
  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: "c2",
        triggered_by_event_id: "e2",
      }),
    }),
    services,
  );
  conversationsCancelRoute(new Request("http://x"), "c2", services);

  // 4. Read events (should get 1 durable + 1 live)
  const events = await readSseEvents(res.body!, 2);
  expect(events.length).toBe(2);
  expect(events[0]).toEqual({ type: "cancel", conversation_id: "c1", handoff_id: "e-1" });
  expect(events[1]).toEqual({ type: "cancel", conversation_id: "c2", handoff_id: "e-2" });
});
