import { expect, test } from "bun:test";
import { z } from "zod";
import { DaemonClient } from "../../src/daemon-client.js";
import { LaneCloseInputShape, laneCloseHandler } from "../../src/tools/lane-close.js";

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

test("LaneCloseInputShape requires a closing gate status", () => {
  const schema = z.object(LaneCloseInputShape);
  expect(() => schema.parse({ lane_id: "lane-1", gate_status: "open" })).toThrow();
  expect(() => schema.parse({ lane_id: "", gate_status: "passed" })).toThrow();
  expect(schema.parse({ lane_id: "lane-1", gate_status: "failed" })).toEqual({
    lane_id: "lane-1",
    gate_status: "failed",
  });
});

test("laneCloseHandler posts lane_close to the daemon and returns the response", async () => {
  let receivedMethod: string | undefined;
  const receivedPaths: string[] = [];
  let receivedAuth: string | undefined;
  const receivedBodies: unknown[] = [];
  const { daemon, restore } = makeDaemon(async (input, init) => {
    receivedMethod = init?.method;
    const receivedPath = new URL(String(input)).pathname;
    receivedPaths.push(receivedPath);
    receivedAuth = init?.headers
      ? (new Headers(init.headers as HeadersInit).get("authorization") ?? undefined)
      : undefined;
    receivedBodies.push(JSON.parse(String(init?.body)));
    if (receivedPath === "/lanes/close") {
      return Response.json({
        lane_id: "lane-1234",
        gate_status: "passed",
        ts_closed: "2026-05-12T00:00:00Z",
        implementer_handoff: "h-impl",
        reviewer_handoff: "reviewer-1",
      });
    }
    return Response.json({ ok: true, authorized: true, events_written: 1 });
  });

  try {
    const out = await laneCloseHandler(daemon)({
      lane_id: "lane-1234",
      gate_status: "passed",
      reviewer_handoff_id: "reviewer-1",
      override_reason: "validated in review",
    });

    expect(receivedMethod).toBe("POST");
    expect(receivedPaths).toEqual(["/lanes/close", "/memory-verify/authorize"]);
    expect(receivedAuth).toBe("Bearer t");
    expect(receivedBodies[0]).toEqual({
      lane_id: "lane-1234",
      gate_status: "passed",
      reviewer_handoff: "reviewer-1",
      override_reason: "validated in review",
    });
    expect(out).toEqual({
      lane_id: "lane-1234",
      gate_status: "passed",
      ts_closed: "2026-05-12T00:00:00Z",
      implementer_handoff: "h-impl",
      reviewer_handoff: "reviewer-1",
    });
  } finally {
    restore();
  }
});

test("laneCloseHandler authorizes memory verification after a successful close", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const { daemon, restore } = makeDaemon(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (path === "/lanes/close") {
      return Response.json({
        lane_id: "lane-1234",
        gate_status: "passed",
        implementer_handoff: "h-impl",
        reviewer_handoff: "h-review",
      });
    }
    if (path === "/memory-verify/authorize") {
      return Response.json({ ok: true, authorized: true, events_written: 2 });
    }
    throw new Error(`unexpected path ${path}`);
  });

  try {
    await laneCloseHandler(daemon)({
      lane_id: "lane-1234",
      gate_status: "passed",
      reviewer_handoff_id: "h-review",
    });

    expect(calls).toEqual([
      {
        path: "/lanes/close",
        body: {
          lane_id: "lane-1234",
          gate_status: "passed",
          reviewer_handoff: "h-review",
        },
      },
      {
        path: "/memory-verify/authorize",
        body: {
          handoff_id: "h-impl",
          verdict: "passed",
          basis: {
            kind: "lane_close",
            lane_id: "lane-1234",
            reviewer_handoff: "h-review",
          },
          authorized_by_handoff: "h-review",
        },
      },
    ]);
  } finally {
    restore();
  }
});

test("laneCloseHandler surfaces daemon 400 errors", async () => {
  const { daemon, restore } = makeDaemon(
    async () =>
      new Response(JSON.stringify({ error: { code: "validation_failed" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    await expect(
      laneCloseHandler(daemon)({ lane_id: "lane-1234", gate_status: "failed" }),
    ).rejects.toThrow("daemon /lanes/close: HTTP 400");
  } finally {
    restore();
  }
});

test("lane_close forwards metadata to daemon POST body", async () => {
  let capturedBody: unknown;
  let callCount = 0;
  const { daemon, restore } = makeDaemon(async (_input, init) => {
    callCount += 1;
    capturedBody = JSON.parse(String(init?.body));
    return Response.json({ lane_id: "lane-meta", gate_status: "skipped" });
  });

  try {
    await laneCloseHandler(daemon)({
      lane_id: "lane-meta",
      gate_status: "skipped",
      metadata: { high_findings: 3, round_count: 2, notes: "clean pass" },
    });
    expect(callCount).toBe(1);
    expect((capturedBody as any).lane_id).toBe("lane-meta");
    expect((capturedBody as any).metadata).toEqual({
      high_findings: 3,
      round_count: 2,
      notes: "clean pass",
    });
  } finally {
    restore();
  }
});

test("lane_close omits metadata key when not provided", async () => {
  let capturedBody: unknown;
  let callCount = 0;
  const { daemon, restore } = makeDaemon(async (_input, init) => {
    callCount += 1;
    capturedBody = JSON.parse(String(init?.body));
    return Response.json({ lane_id: "lane-nometa", gate_status: "skipped" });
  });

  try {
    await laneCloseHandler(daemon)({ lane_id: "lane-nometa", gate_status: "skipped" });
    expect(callCount).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(capturedBody, "metadata")).toBe(false);
  } finally {
    restore();
  }
});

test("LaneCloseInputShape rejects unknown metadata keys at MCP boundary", () => {
  const schema = z.object(LaneCloseInputShape);
  const res = schema.safeParse({
    lane_id: "lane-1",
    gate_status: "passed",
    metadata: { invented_field: 1 },
  });
  expect(res.success).toBe(false);
});
