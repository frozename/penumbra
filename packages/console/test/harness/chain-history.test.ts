import { describe, expect, test } from "bun:test";

// eslint-disable-next-line no-restricted-imports -- e2e harness lives outside src/
import { startHarness } from "../../e2e/harness/index";

describe("chain history ordering", () => {
  test("history sorts unsorted seeds newest first before applying limit", async () => {
    const h = await startHarness();
    try {
      const rows = [1, 3, 2].map((minute) => ({
        ts: `2026-09-11T00:0${String(minute)}:00Z`,
        reason: `row-${String(minute)}`,
        hop_count: minute,
        terminal_handoff_id: `h${String(minute)}`,
        conversation_id: "c1",
      }));
      h.setChainHistory("c1", rows);

      const limited = await Bun.fetch(`${h.baseUrl}/chains/history?conversation_id=c1&limit=2`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(limited.status).toBe(200);
      const limitedBody = (await limited.json()) as { history: typeof rows };
      expect(limitedBody.history).toEqual([rows[1]!, rows[2]!]);

      const defaultResult = await Bun.fetch(`${h.baseUrl}/chains/history?conversation_id=c1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(defaultResult.status).toBe(200);
      const defaultBody = (await defaultResult.json()) as { history: typeof rows };
      expect(defaultBody.history).toEqual([rows[1]!, rows[2]!, rows[0]!]);
    } finally {
      await h.stop();
    }
  });

  test("history defaults to the newest 50 rows", async () => {
    const h = await startHarness();
    try {
      const rows = Array.from({ length: 51 }, (_, index) => ({
        ts: new Date(Date.UTC(2026, 8, 11, 0, index)).toISOString(),
        reason: `row-${String(index)}`,
        hop_count: index,
        terminal_handoff_id: `h${String(index)}`,
        conversation_id: "c1",
      }));
      h.setChainHistory("c1", rows);
      const res = await Bun.fetch(`${h.baseUrl}/chains/history?conversation_id=c1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { history: typeof rows };
      expect(body.history).toEqual(rows.slice(1).reverse());
    } finally {
      await h.stop();
    }
  });
});
