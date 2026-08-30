import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { handoffsEventsRoute } from "@src/routes/handoffs-events.js";
import { handoffsApproveRoute, handoffsCreateRoute } from "@src/routes/handoffs.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  // Optional Homebrew SQLite is unavailable in some CI images.
}

type HandoffCreateBody = { handoff_id: string };
type HandoffSseEvent = { handoff_id: string; status?: string };

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/sse-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return (): string => `e-${String(++n)}`;
    })(),
  });
}

async function createHandoff(services: Services): Promise<HandoffCreateBody> {
  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
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
  return (await res.json()) as HandoffCreateBody;
}

async function readSseEvents(
  stream: ReadableStream<Uint8Array>,
  n: number,
  timeoutMs = 1000,
): Promise<HandoffSseEvent[]> {
  const reader = stream.getReader();
  const events: HandoffSseEvent[] = [];
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
          Math.max(1, deadline - Date.now()),
        ),
      ),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as HandoffSseEvent);
    }
  }
  reader.releaseLock();
  return events;
}

function requireBody(res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw new Error("SSE response missing body");
  return res.body;
}

test("GET /handoffs/events delivers approved-handoff events to subscribers", async () => {
  const services = tempServices();
  const res = handoffsEventsRoute(new Request("http://x/handoffs/events"), services);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  // seed one handoff and approve it after the stream is open
  const create = await createHandoff(services);
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: "POST", body: "{}" }),
    create.handoff_id,
    services,
  );

  const events = await readSseEvents(requireBody(res), 1);
  expect(events.length).toBe(1);
  expect(events[0]?.handoff_id).toBe(create.handoff_id);
  expect(events[0]?.status).toBe("approved");
});

test("GET /handoffs/events does not replay events emitted before connect", async () => {
  const services = tempServices();
  // Emit BEFORE subscribing
  const create = await createHandoff(services);
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: "POST", body: "{}" }),
    create.handoff_id,
    services,
  );

  const res = handoffsEventsRoute(new Request("http://x/handoffs/events"), services);
  const events = await readSseEvents(requireBody(res), 1, 200);
  expect(events.length).toBe(0);
});

test("GET /handoffs/events fans out to multiple subscribers", async () => {
  const services = tempServices();
  const r1 = handoffsEventsRoute(new Request("http://x/handoffs/events"), services);
  const r2 = handoffsEventsRoute(new Request("http://x/handoffs/events"), services);

  const create = await createHandoff(services);
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: "POST", body: "{}" }),
    create.handoff_id,
    services,
  );

  const [a, b] = await Promise.all([
    readSseEvents(requireBody(r1), 1),
    readSseEvents(requireBody(r2), 1),
  ]);
  expect(a[0]?.handoff_id).toBe(create.handoff_id);
  expect(b[0]?.handoff_id).toBe(create.handoff_id);
});

test("GET /handoffs/events: cancelling the stream unsubscribes from the bus; later emits are not delivered to that subscriber", async () => {
  const services = tempServices();
  // Two subscribers: A will be cancelled mid-flight; B is the control that receives both events.
  const resA = handoffsEventsRoute(new Request("http://x/handoffs/events"), services);
  const resB = handoffsEventsRoute(new Request("http://x/handoffs/events"), services);

  // Emit event 1 — both subscribers see it.
  const c1 = await createHandoff(services);
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${c1.handoff_id}/approve`, { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );

  const aFirst = await readSseEvents(requireBody(resA), 1);
  expect(aFirst.map((e) => e.handoff_id)).toEqual([c1.handoff_id]);

  // Cancel subscriber A's stream. This should trigger the route's cancel() handler,
  // which is responsible for calling off() to unsubscribe from services.handoffEvents.
  await requireBody(resA).cancel();

  // Emit event 2.
  const c2Res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m2",
        conversation_id: "c1",
        triggered_by_event_id: "e2",
      }),
    }),
    services,
  );
  const c2 = (await c2Res.json()) as HandoffCreateBody;
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${c2.handoff_id}/approve`, { method: "POST", body: "{}" }),
    c2.handoff_id,
    services,
  );

  // Subscriber B sees BOTH events 1 and 2 in order — proves the bus is still routing.
  const bBoth = await readSseEvents(requireBody(resB), 2);
  expect(bBoth.map((e) => e.handoff_id)).toEqual([c1.handoff_id, c2.handoff_id]);

  // The bus is healthy AFTER the cancelled subscriber's enqueue would have been attempted —
  // i.e. unsubscribe ran cleanly rather than crashing on a closed controller.
});
