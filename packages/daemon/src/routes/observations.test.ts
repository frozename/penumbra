import type { Services } from "@penumbra/core";

import { expect, test } from "bun:test";

import { observationsRoute } from "./observations.js";

function makeServices(write: () => string): Services {
  return {
    machineId: { get: () => "machine-1" },
    clock: () => new Date("2026-04-23T12:00:00Z"),
    uuid: () => "uuid-1",
    redactor: { redact: (value: unknown) => value },
    t0Writer: { write },
  } as unknown as Services;
}

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/observations", {
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
      ...overrides,
    }),
  });
}

test("observationsRoute surfaces a 500 when the writer throws a generic SQLiteError", async () => {
  const req = makeReq({ event_id: "evt-123" });
  const services = makeServices(() => {
    const err = new Error("disk I/O error") as Error & { name: string; code?: string };
    err.name = "SQLiteError";
    err.code = "SQLITE_IOERR";
    throw err;
  });

  const res = await observationsRoute(req, services);
  expect(res.status).toBe(500);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("sqlite_write_failed");
});

test("observationsRoute maps SQLITE_BUSY to a 503 with retry semantics", async () => {
  const req = makeReq({ event_id: "evt-busy" });
  const services = makeServices(() => {
    const err = new Error("database is locked") as Error & { name: string; code?: string };
    err.name = "SQLiteError";
    err.code = "SQLITE_BUSY";
    throw err;
  });

  const res = await observationsRoute(req, services);
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("sqlite_busy");
});

test("observationsRoute returns the writer event_id on success", async () => {
  const req = makeReq();
  const services = makeServices(() => "evt-456");

  const res = await observationsRoute(req, services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ event_id: "evt-456" });
});
