import { _resetForTest, getMcpEventBus, type McpEvent } from "@src/events/mcp-event-bus.js";
import { mcpEventsPublishRoute } from "@src/routes/mcp-events.js";
import { beforeEach, describe, expect, it } from "bun:test";

describe("POST /mcp-events/publish", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("publishes a valid event to the bus and returns 202", async () => {
    const bus = getMcpEventBus();
    const received: McpEvent[] = [];
    bus.subscribe({ server: "ha", event: "state_changed" }, (e: McpEvent) => received.push(e));

    const req = new Request("http://x/mcp-events/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server: "ha",
        event: "state_changed",
        payload: { entity: "light.kitchen" },
      }),
    });
    const res = await mcpEventsPublishRoute(req);
    expect(res.status).toBe(202);
    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ entity: "light.kitchen" });
    expect(typeof received[0].published_at).toBe("number");
  });

  it("rejects malformed bodies with 400", async () => {
    const req = new Request("http://x/mcp-events/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: "ha" }),
    });
    const res = await mcpEventsPublishRoute(req);
    expect(res.status).toBe(400);
  });

  it("rejects non-JSON body with 400", async () => {
    const req = new Request("http://x/mcp-events/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await mcpEventsPublishRoute(req);
    expect(res.status).toBe(400);
  });
});
