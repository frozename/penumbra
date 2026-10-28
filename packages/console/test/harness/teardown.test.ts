import { describe, expect, spyOn, test } from "bun:test";
import { Server } from "node:http";

// eslint-disable-next-line no-restricted-imports -- the harness lives outside src
import { startHarness } from "../../e2e/harness/index";

describe("harness stop()", () => {
  test("closes every open connection before closing the server", async () => {
    expect(typeof Server.prototype.closeAllConnections).toBe("function");
    const closeAllSpy = spyOn(Server.prototype, "closeAllConnections");
    const closeSpy = spyOn(Server.prototype, "close");
    try {
      const h = await startHarness();
      try {
        const res = await Bun.fetch(`${h.baseUrl}/dispatch/events?handoff_id=none`, {
          headers: { Authorization: `Bearer ${h.token}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { events: unknown[] };
        expect(body.events).toEqual([]);
      } finally {
        await h.stop();
      }

      expect(closeAllSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const closeAllAt = closeAllSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
      const closeAt = closeSpy.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
      expect(closeAllAt).toBeLessThan(closeAt);
    } finally {
      closeAllSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });
});
