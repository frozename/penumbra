import { expect } from "bun:test";

import { makeTempDaemon } from "./helpers.js";
import { serviceTest } from "./helpers/service-gates.js";

serviceTest("POST /observations writes a T0 row and returns event_id", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/observations`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        ts: "2026-04-23T11:59:59Z",
        source: "mcp",
        source_detail: "claude-code",
        session_id: "s1",
        user_id: "ignored", // overridden by ctx.userId
        machine_id: "ignored", // overridden by ctx.machineId
        event_type: "agent-prompt",
        lane: "local",
        payload_json: { prompt: "hi" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event_id?: string };
    expect(body.event_id).toBeDefined();
    const row = d.services.db
      .query<
        {
          event_id: string;
          user_id: string;
          machine_id: string;
          session_id: string | null;
          event_type: string;
          source: string;
          lane: string;
        },
        []
      >("SELECT event_id, user_id, machine_id, session_id, event_type, source, lane FROM t0_events")
      .all();
    expect(row).toHaveLength(1);
    expect(row[0]!.event_id).toBe(body.event_id!);
    expect(row[0]!.user_id).toBe(d.services.machineId.get());
    expect(row[0]!.machine_id).toBe(d.services.machineId.get());
    expect(row[0]!.session_id).toBe("s1");
    expect(row[0]!.event_type).toBe("agent-prompt");
    expect(row[0]!.source).toBe("mcp");
    expect(row[0]!.lane).toBe("local");
  } finally {
    d.stop();
  }
});

serviceTest(
  "POST /observations returns 500 when a SQLiteError bubbles up from the writer",
  async () => {
    const d = makeTempDaemon();
    const originalWrite = d.services.t0Writer.write.bind(d.services.t0Writer);
    d.services.t0Writer.write = (): never => {
      const err = new Error("disk I/O error") as Error & { name: string; code?: string };
      err.name = "SQLiteError";
      err.code = "SQLITE_IOERR";
      throw err;
    };
    try {
      const res = await fetch(`${d.url}/observations`, {
        method: "POST",
        headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          ts: "2026-04-23T11:59:59Z",
          source: "mcp",
          source_detail: "claude-code",
          session_id: "s1",
          user_id: "ignored",
          machine_id: "ignored",
          event_type: "agent-prompt",
          lane: "local",
          payload_json: { prompt: "hi" },
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("sqlite_write_failed");
    } finally {
      d.services.t0Writer.write = originalWrite;
      d.stop();
    }
  },
);

serviceTest("POST /observations returns 503 when the writer reports SQLITE_BUSY", async () => {
  const d = makeTempDaemon();
  const originalWrite = d.services.t0Writer.write.bind(d.services.t0Writer);
  d.services.t0Writer.write = (): never => {
    const err = new Error("database is locked") as Error & { name: string; code?: string };
    err.name = "SQLiteError";
    err.code = "SQLITE_BUSY";
    throw err;
  };
  try {
    const res = await fetch(`${d.url}/observations`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        ts: "2026-04-23T11:59:59Z",
        source: "mcp",
        source_detail: "claude-code",
        session_id: "s1",
        user_id: "ignored",
        machine_id: "ignored",
        event_type: "agent-prompt",
        lane: "local",
        payload_json: { prompt: "hi" },
      }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("sqlite_busy");
  } finally {
    d.services.t0Writer.write = originalWrite;
    d.stop();
  }
});

serviceTest("POST /observations returns 400 on Zod failure", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/observations`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ts: "x", source: "bogus", payload_json: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  } finally {
    d.stop();
  }
});
