import { expect, test } from "bun:test";
import { z } from "zod";
import { DaemonClient } from "../../src/daemon-client.js";
import { LaneOpenInputShape, laneOpenHandler } from "../../src/tools/lane-open.js";

function makeDaemon(fetchImpl: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const daemon = new DaemonClient({ baseUrl: "http://daemon", token: "t" });
  return {
    daemon,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("LaneOpenInputShape requires implementer_handoff_id and a valid task class", () => {
  const schema = z.object(LaneOpenInputShape);
  expect(() => schema.parse({})).toThrow();
  expect(() => schema.parse({ implementer_handoff_id: "", task_class: "STANDARD" })).toThrow();
  expect(() =>
    schema.parse({ implementer_handoff_id: "h-1", task_class: "NOT_A_CLASS" }),
  ).toThrow();
  expect(schema.parse({ implementer_handoff_id: "h-1", task_class: "STANDARD" })).toEqual({
    implementer_handoff_id: "h-1",
    task_class: "STANDARD",
  });
});

test("laneOpenHandler posts lane_open to the daemon and returns the response", async () => {
  let receivedMethod: string | undefined;
  let receivedPath: string | undefined;
  let receivedAuth: string | undefined;
  let receivedBody: unknown;
  const { daemon, restore } = makeDaemon(async (input, init) => {
    receivedMethod = init?.method;
    receivedPath = new URL(String(input)).pathname;
    receivedAuth = init?.headers
      ? (new Headers(init.headers as HeadersInit).get("authorization") ?? undefined)
      : undefined;
    receivedBody = JSON.parse(String(init?.body));
    return Response.json({
      lane_id: (receivedBody as { lane_id: string }).lane_id,
      ts_opened: "2026-05-12T00:00:00Z",
      gate_status: "open",
    });
  });

  try {
    const out = await laneOpenHandler(daemon)({
      implementer_handoff_id: "handoff-1",
      task_class: "STANDARD",
    });

    expect(receivedMethod).toBe("POST");
    expect(receivedPath).toBe("/lanes/open");
    expect(receivedAuth).toBe("Bearer t");
    expect((receivedBody as { lane_id: string }).lane_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(receivedBody).toMatchObject({
      implementer_handoff: "handoff-1",
      task_class: "STANDARD",
    });
    expect(out).toEqual({
      lane_id: (receivedBody as { lane_id: string }).lane_id,
      ts_opened: "2026-05-12T00:00:00Z",
      gate_status: "open",
    });
  } finally {
    restore();
  }
});

test("laneOpenHandler surfaces daemon 400 errors", async () => {
  const { daemon, restore } = makeDaemon(
    async () =>
      new Response(JSON.stringify({ error: { code: "validation_failed" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    await expect(
      laneOpenHandler(daemon)({ implementer_handoff_id: "handoff-1", task_class: "STANDARD" }),
    ).rejects.toThrow("daemon /lanes/open: HTTP 400");
  } finally {
    restore();
  }
});
