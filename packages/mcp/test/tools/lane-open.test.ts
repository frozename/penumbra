import { expect, test } from "bun:test";
import { z } from "zod";

import { laneOpenHandler, LaneOpenInputShape } from "../../src/tools/lane-open.js";
import { bodyAsString, installFetchMock, requestUrl } from "../helpers.js";

interface MockToolResult {
  content: { type: string; text: string }[];
}

function parseToolResult(out: unknown): unknown {
  const content = (out as MockToolResult).content;
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text);
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
  const { daemon, restore } = installFetchMock((input, init): Promise<Response> => {
    receivedMethod = init?.method;
    receivedPath = new URL(requestUrl(input)).pathname;
    receivedAuth = init?.headers
      ? (new Headers(init.headers).get("authorization") ?? undefined)
      : undefined;
    receivedBody = JSON.parse(bodyAsString(init?.body));
    return Promise.resolve(
      Response.json({
        lane_id: (receivedBody as { lane_id: string }).lane_id,
        ts_opened: "2026-05-12T00:00:00Z",
        ts_closed: null,
        task_class: "STANDARD",
        implementer_handoff: "handoff-1",
        reviewer_handoff: null,
        gate_status: "open",
        recalled_memory_ids: [],
        recalled_query: null,
        override_reason: null,
        metadata_json: "{}",
      }),
    );
  });

  try {
    const out = parseToolResult(
      await laneOpenHandler(daemon)({
        implementer_handoff_id: "handoff-1",
        task_class: "STANDARD",
      }),
    );

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
      ts_closed: null,
      task_class: "STANDARD",
      implementer_handoff: "handoff-1",
      reviewer_handoff: null,
      gate_status: "open",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: null,
      metadata_json: "{}",
    });
  } finally {
    restore();
  }
});

test("laneOpenHandler surfaces daemon 400 errors", async () => {
  const { daemon, restore } = installFetchMock(
    (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "validation_failed" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
  );
  try {
    await expectRejection(
      laneOpenHandler(daemon)({ implementer_handoff_id: "handoff-1", task_class: "STANDARD" }),
      "daemon /lanes/open: HTTP 400",
    );
  } finally {
    restore();
  }
});

async function expectRejection(promise: Promise<unknown>, needle: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain(needle);
    return;
  }
  throw new Error(`expected promise to reject containing ${JSON.stringify(needle)}`);
}
