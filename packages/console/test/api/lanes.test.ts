import { afterEach, expect, test } from "bun:test";

import { DaemonClient } from "@src/api/client";
import { DaemonContractError } from "@src/api/errors";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const row = {
  lane_id: "lane-1",
  ts_opened: "2026-09-10T10:00:00Z",
  ts_closed: null,
  task_class: "STANDARD",
  implementer_handoff: "h-1",
  reviewer_handoff: null,
  gate_status: "open",
  recalled_memory_ids: [],
  recalled_query: null,
  override_reason: null,
  metadata_json: "{}",
};
test("lanes validates requests before HTTP and parses bare close rows", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      init,
    });
    return Promise.resolve(
      new Response(
        JSON.stringify(
          init?.method === "POST" ? { ...row, gate_status: "passed" } : { lanes: [row] },
        ),
        { headers: { "content-type": "application/json" } },
      ),
    );
  }) as unknown as typeof fetch;
  const client = new DaemonClient({
    getConfig: (): { baseUrl: string; token: string } => ({
      baseUrl: "http://daemon.test",
      token: "test",
    }),
  });
  expect((await client.lanes.recent({ limit: 20 })).lanes[0]?.lane_id).toBe("lane-1");
  expect(calls[0]?.url).toBe("http://daemon.test/lanes/recent?limit=20");
  const body = {
    lane_id: "lane-1",
    gate_status: "passed" as const,
    reviewer_handoff: "reviewer-full",
    metadata: { notes: "verified" },
  };
  expect((await client.lanes.close(body)).gate_status).toBe("passed");
  expect(calls[1]?.init?.method).toBe("POST");
  expect(JSON.parse(calls[1]?.init?.body as string)).toEqual(body);
  expect(() => client.lanes.close({ ...body, metadata: { notes: "" } })).toThrow(
    DaemonContractError,
  );
  expect(() => client.lanes.recent({ limit: 0 })).toThrow(DaemonContractError);
  expect(calls).toHaveLength(2);
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ lane: row }), {
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch;
  const error: unknown = await client.lanes.close(body).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(DaemonContractError);
});
