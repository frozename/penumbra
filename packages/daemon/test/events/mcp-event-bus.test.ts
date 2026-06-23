import { createMcpEventBus } from "@penumbra/daemon/events/mcp-event-bus";
import { describe, expect, it } from "bun:test";

describe("mcp-event-bus", () => {
  it("delivers a published event to matching subscribers", () => {
    const bus = createMcpEventBus();
    const received: { server: string; event: string }[] = [];
    bus.subscribe({ server: "ha", event: "state_changed" }, (e) => {
      received.push({ server: e.server, event: e.event });
    });

    bus.publish({
      server: "ha",
      event: "state_changed",
      payload: { entity: "light.kitchen" },
      published_at: 1,
    });

    expect(received).toEqual([{ server: "ha", event: "state_changed" }]);
  });

  it("does not deliver to non-matching subscribers", () => {
    const bus = createMcpEventBus();
    let count = 0;
    bus.subscribe({ server: "ha", event: "state_changed" }, () => {
      count++;
    });
    bus.publish({ server: "ha", event: "automation_failed", payload: {}, published_at: 1 });
    bus.publish({ server: "finance", event: "state_changed", payload: {}, published_at: 1 });
    expect(count).toBe(0);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createMcpEventBus();
    let count = 0;
    const unsub = bus.subscribe({ server: "ha", event: "state_changed" }, () => {
      count++;
    });
    bus.publish({ server: "ha", event: "state_changed", payload: {}, published_at: 1 });
    expect(count).toBe(1);
    unsub();
    bus.publish({ server: "ha", event: "state_changed", payload: {}, published_at: 2 });
    expect(count).toBe(1);
  });

  it("one subscriber failing does not block others", () => {
    const bus = createMcpEventBus();
    let goodCount = 0;
    bus.subscribe({ server: "x", event: "y" }, () => {
      throw new Error("boom");
    });
    bus.subscribe({ server: "x", event: "y" }, () => {
      goodCount++;
    });
    bus.publish({ server: "x", event: "y", payload: {}, published_at: 1 });
    expect(goodCount).toBe(1);
  });
});
