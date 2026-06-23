import { PermissionEventBus, type Services } from "@penumbra/core";
import { expect, test } from "bun:test";

import { permissionsEventsRoute } from "../../src/routes/permissions-events.js";

type ServicesWithPermissionEvents = Services & { permissionEvents: PermissionEventBus };

function makeServices(): ServicesWithPermissionEvents {
  const stub = {
    permissionEvents: new PermissionEventBus(),
    log: {
      info: (): void => {
        /* test sink */
      },
      warn: (): void => {
        /* test sink */
      },
    },
  };
  // The permissions SSE route only reads services.permissionEvents and services.log;
  // the full daemon service graph is irrelevant for these stream tests.
  return stub as unknown as ServicesWithPermissionEvents;
}

async function readChunks(stream: ReadableStream<Uint8Array>, max: number): Promise<string[]> {
  const reader = stream.getReader();
  const out: string[] = [];
  const td = new TextDecoder();
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(td.decode(value));
  }
  reader.releaseLock();
  return out;
}

test("GET /permissions/events streams emitted events as SSE", async () => {
  const services = makeServices();
  const res = permissionsEventsRoute(new Request("http://x/permissions/events"), services);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  // Emit and read in parallel
  if (!res.body) throw new Error("SSE response missing body");
  const chunkPromise = readChunks(res.body, 2);
  setTimeout(() => {
    services.permissionEvents.emit({
      kind: "permission.created",
      permission_id: "perm-1",
      ts: "2026-04-28T12:00:00.000Z",
      payload: { permission_id: "perm-1" },
    });
  }, 5);
  const chunks = await chunkPromise;
  // First chunk should contain the initial ': ok' comment.
  expect(chunks[0]).toContain(": ok");
  // The next chunk should carry the emitted event.
  expect(chunks.join("")).toContain("event: permission.created");
  expect(chunks.join("")).toContain('"permission_id":"perm-1"');
  expect(chunks.join("")).toContain("id: perm-1:");
});

test("GET /permissions/events with Last-Event-ID replays missed events from ring buffer", async () => {
  const services = makeServices();
  // Pre-emit two events.
  const a = services.permissionEvents.emit({
    kind: "permission.created",
    permission_id: "p-1",
    ts: "t",
    payload: {},
  });
  services.permissionEvents.emit({
    kind: "permission.created",
    permission_id: "p-2",
    ts: "t",
    payload: {},
  });

  const res = permissionsEventsRoute(
    new Request("http://x/permissions/events", {
      headers: { "last-event-id": `seq:${String(a.seq)}` },
    }),
    services,
  );
  expect(res.status).toBe(200);
  // Read the replay payload directly; the stream stays open for live updates.
  if (!res.body) throw new Error("SSE response missing body");
  const chunks = await readChunks(res.body, 1);
  const text = chunks.join("");
  // Should contain p-2 (after a.seq) but not p-1.
  expect(text).toContain("id: p-2:2");
  expect(text).not.toContain("id: p-1:1");
});

test("Last-Event-ID older than ring buffer signals client to resync (no replay)", async () => {
  const services = makeServices();
  // Use a tiny ring to force eviction.
  services.permissionEvents = new PermissionEventBus({ ringSize: 2 });
  const stale = services.permissionEvents.emit({
    kind: "permission.created",
    permission_id: "p-1",
    ts: "t",
    payload: {},
  });
  for (const id of ["p-2", "p-3", "p-4"]) {
    services.permissionEvents.emit({
      kind: "permission.created",
      permission_id: id,
      ts: "t",
      payload: {},
    });
  }
  const res = permissionsEventsRoute(
    new Request("http://x/permissions/events", {
      headers: { "last-event-id": `seq:${String(stale.seq)}` },
    }),
    services,
  );
  // Read until we see the resync hint.
  if (!res.body) throw new Error("SSE response missing body");
  const chunks = await readChunks(res.body, 1);
  expect(chunks.join("")).toContain(": resync");
});
