import { expect } from "bun:test";
import { serviceTest } from "./helpers/service-gates.js";
import { makeTempDaemon } from "./helpers.js";

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

serviceTest("POST /observations returns 200 when a residual SQLiteError bubbles up", async () => {
  const d = makeTempDaemon();
  const originalWrite = d.services.t0Writer.write.bind(d.services.t0Writer);
  d.services.t0Writer.write = () => {
    const err = new Error("UNIQUE constraint failed: t0_events.event_id") as Error & {
      name: string;
    };
    err.name = "SQLiteError";
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
        event_type: "agent-prompt",
        lane: "local",
        payload_json: { prompt: "hi" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event_id?: string };
    expect(body.event_id).toBeDefined();
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
