import { expect, test } from "bun:test";
import { z } from "zod";

import {
  laneLedgerRecentHandler,
  LaneLedgerRecentInputShape,
} from "@src/tools/lane-ledger-recent.js";

import { installFetchMock, requestUrl } from "../helpers.js";

interface MockToolResult {
  content: { type: string; text: string }[];
}

function parseToolResult(out: unknown): unknown {
  const content = (out as MockToolResult).content;
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text);
}

test("LaneLedgerRecentInputShape accepts optional lane query filters", () => {
  const schema = z.object(LaneLedgerRecentInputShape);
  expect(schema.parse({})).toEqual({});
  expect(
    schema.parse({
      status: "passed",
      limit: 10,
      task_class: "STANDARD",
      since: "2026-01-01T00:00:00Z",
    }),
  ).toEqual({
    status: "passed",
    limit: 10,
    task_class: "STANDARD",
    since: "2026-01-01T00:00:00Z",
  });
  expect(() => schema.parse({ status: "bad" })).toThrow();
  expect(() => schema.parse({ limit: 0 })).toThrow();
});

test("laneLedgerRecentHandler GETs /lanes/recent with filters and returns lanes response", async () => {
  let receivedMethod: string | undefined;
  let receivedPath: string | undefined;
  let receivedSearch: string | undefined;
  let receivedAuth: string | undefined;
  const { daemon, restore } = installFetchMock((input, init): Promise<Response> => {
    const url = new URL(requestUrl(input));
    receivedMethod = init?.method;
    receivedPath = url.pathname;
    receivedSearch = url.search;
    receivedAuth = init?.headers
      ? (new Headers(init.headers).get("authorization") ?? undefined)
      : undefined;
    return Promise.resolve(
      Response.json({
        lanes: [
          {
            lane_id: "lane-recent-1",
            ts_opened: "2026-05-12T00:00:00Z",
            ts_closed: "2026-05-12T00:01:00Z",
            task_class: "STANDARD",
            implementer_handoff: "h-recent-1",
            reviewer_handoff: "h-review-1",
            gate_status: "passed",
            recalled_memory_ids: [],
            recalled_query: null,
            override_reason: null,
            metadata_json: "{}",
          },
        ],
      }),
    );
  });

  try {
    const out = parseToolResult(
      await laneLedgerRecentHandler(daemon)({ status: "passed", limit: 10 }),
    );

    expect(receivedMethod).toBe("GET");
    expect(receivedPath).toBe("/lanes/recent");
    expect(receivedSearch).toBe("?status=passed&limit=10");
    expect(receivedAuth).toBe("Bearer t");
    expect(out).toEqual({
      lanes: [
        {
          lane_id: "lane-recent-1",
          ts_opened: "2026-05-12T00:00:00Z",
          ts_closed: "2026-05-12T00:01:00Z",
          task_class: "STANDARD",
          implementer_handoff: "h-recent-1",
          reviewer_handoff: "h-review-1",
          gate_status: "passed",
          recalled_memory_ids: [],
          recalled_query: null,
          override_reason: null,
          metadata_json: "{}",
        },
      ],
    });
  } finally {
    restore();
  }
});

test("laneLedgerRecentHandler omits query params when no filters are given", async () => {
  let receivedSearch: string | undefined;
  const { daemon, restore } = installFetchMock((input): Promise<Response> => {
    receivedSearch = new URL(requestUrl(input)).search;
    return Promise.resolve(Response.json({ lanes: [] }));
  });

  try {
    parseToolResult(await laneLedgerRecentHandler(daemon)({}));
    expect(receivedSearch).toBe("");
  } finally {
    restore();
  }
});

test("laneLedgerRecentHandler surfaces daemon 400 errors", async () => {
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
      laneLedgerRecentHandler(daemon)({ status: "failed" }),
      "daemon /lanes/recent: HTTP 400",
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
