import { LanesRecentResponseSchema } from "@penumbra/api-contract";
import { expect, test } from "bun:test";

// eslint-disable-next-line no-restricted-imports -- the harness lives outside src
import { startHarness } from "../../e2e/harness/index";
test("lanes fixture preserves attribution, filtering, validation and reset", async () => {
  const h = await startHarness();
  const headers = { authorization: `Bearer ${h.token}`, "content-type": "application/json" };
  const row = {
    lane_id: "lane-1",
    ts_opened: "2026-09-10T10:00:00Z",
    ts_closed: null,
    task_class: "STANDARD" as const,
    implementer_handoff: "h-1",
    reviewer_handoff: null,
    gate_status: "open" as const,
    recalled_memory_ids: [],
    recalled_query: null,
    override_reason: null,
    metadata_json: "{}",
  };
  try {
    h.setLanes([row, { ...row, lane_id: "lane-2", ts_opened: "2026-09-10T11:00:00Z" }]);
    const recent = await Bun.fetch(`${h.baseUrl}/lanes/recent?limit=1`, { headers });
    const data = LanesRecentResponseSchema.parse(await recent.json());
    expect(data.lanes).toHaveLength(1);
    expect(data.lanes[0]?.lane_id).toBe("lane-2");
    const body = {
      lane_id: "lane-1",
      gate_status: "passed",
      reviewer_handoff: "reviewer-1",
      metadata: { notes: "verified" },
    };
    const result = await Bun.fetch(`${h.baseUrl}/lanes/close`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(result.status).toBe(200);
    const closed = LanesRecentResponseSchema.shape.lanes.element.parse(await result.json());
    expect(closed.reviewer_handoff).toBe("reviewer-1");
    expect(closed.gate_status).toBe("passed");
    expect(JSON.parse(closed.metadata_json)).toEqual(body.metadata);
    const filtered = LanesRecentResponseSchema.parse(
      await (
        await Bun.fetch(`${h.baseUrl}/lanes/recent?status=open&since=2026-09-10T10:30:00Z`, {
          headers,
        })
      ).json(),
    );
    expect(filtered.lanes.map((r) => r.lane_id)).toEqual(["lane-2"]);
    expect(
      (
        await Bun.fetch(`${h.baseUrl}/lanes/close`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await Bun.fetch(`${h.baseUrl}/lanes/close`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, lane_id: "lane-2", metadata: { notes: "" } }),
        })
      ).status,
    ).toBe(400);
    expect((await Bun.fetch(`${h.baseUrl}/lanes/recent?since=invalid`, { headers })).status).toBe(
      400,
    );
    h.reset();
    const reset = LanesRecentResponseSchema.parse(
      await (await Bun.fetch(`${h.baseUrl}/lanes/recent`, { headers })).json(),
    );
    expect(reset.lanes).toHaveLength(0);
  } finally {
    await h.stop();
  }
});
