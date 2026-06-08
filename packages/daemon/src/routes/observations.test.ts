import { expect, test } from "bun:test";
import { observationsRoute } from "./observations.js";

test("observationsRoute returns 200 with the normalized event_id when writer throws SQLiteError", async () => {
  const eventId = "evt-123";
  const req = new Request("http://localhost/observations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_id: eventId,
      ts: "2026-04-23T11:59:59Z",
      source: "mcp",
      source_detail: "claude-code",
      user_id: "ignored",
      machine_id: "ignored",
      session_id: "s1",
      event_type: "agent-prompt",
      lane: "local",
      payload_json: { prompt: "hi" },
    }),
  });
  const services = {
    machineId: { get: () => "machine-1" },
    clock: () => new Date("2026-04-23T12:00:00Z"),
    uuid: () => "uuid-1",
    redactor: { redact: (value: unknown) => value },
    t0Writer: {
      write: () => {
        const err = new Error("UNIQUE constraint failed: t0_events.event_id") as Error & {
          name: string;
        };
        err.name = "SQLiteError";
        throw err;
      },
    },
  } as any;

  const res = await observationsRoute(req, services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ event_id: eventId });
});

test("observationsRoute returns the writer event_id on success", async () => {
  const req = new Request("http://localhost/observations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ts: "2026-04-23T11:59:59Z",
      source: "mcp",
      source_detail: "claude-code",
      user_id: "ignored",
      machine_id: "ignored",
      session_id: "s1",
      event_type: "agent-prompt",
      lane: "local",
      payload_json: { prompt: "hi" },
    }),
  });
  const services = {
    machineId: { get: () => "machine-1" },
    clock: () => new Date("2026-04-23T12:00:00Z"),
    uuid: () => "uuid-1",
    redactor: { redact: (value: unknown) => value },
    t0Writer: {
      write: () => "evt-456",
    },
  } as any;

  const res = await observationsRoute(req, services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ event_id: "evt-456" });
});
