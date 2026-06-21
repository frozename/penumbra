import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUsagePoller } from "../../src/usage-readers/poller.js";
import type { UsageReader, UsageReaderResult } from "../../src/usage-readers/index.js";

function mkReader(id: string, cursor: unknown): UsageReader {
  return {
    id,
    read: async () => ({
      cursor,
      usage_deltas: [
        {
          provider: "p",
          model: id,
          tokens_input: 1,
          tokens_output: 2,
          cost_usd: 0.01,
          window_start: `2026-06-20T00:00:00.000Z`,
          window_end: `2026-06-20T00:01:00.000Z`,
        },
      ],
      rate_limit_snapshots: [],
    }),
  };
}

const noopLog = { info: () => {}, error: () => {} };

describe("usage poller cursor persistence is coalesced per tick", () => {
  it("persists the cursor file exactly once per tick regardless of reader count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-coalesced-"));
    const cursorPath = join(dir, "cursors.json");
    const readers = Array.from({ length: 10 }, (_, i) => mkReader(`r${i}`, { i }));
    const poller = startUsagePoller({
      readers,
      cursorPath,
      emit: async (e) => ({ event_id: e.event_id }),
      log: noopLog,
    });

    await poller.runOnce();
    expect(poller.persistCount()).toBe(1);

    // Cursor file still contains every reader's cursor — coalescing did not
    // drop any reader's progress.
    const persisted = JSON.parse(readFileSync(cursorPath, "utf8"));
    for (let i = 0; i < readers.length; i++) {
      expect(persisted[`r${i}`]).toEqual({ i });
    }

    await poller.runOnce();
    // Second tick: each reader returns the same dedup-stable event, so emit is
    // skipped, but the cursor is reassigned (same value) and we still persist
    // once. Verify the per-tick coalescing invariant holds (≤1 per tick).
    expect(poller.persistCount()).toBeLessThanOrEqual(2);
    poller.stop();
  });

  it("does not persist when no reader ran (non-holder skip)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-coalesced-"));
    const cursorPath = join(dir, "cursors.json");
    const machineReader: UsageReader = {
      id: "mg",
      machineGlobal: true,
      read: async () => ({ cursor: {}, usage_deltas: [], rate_limit_snapshots: [] }),
    };
    const poller = startUsagePoller({
      readers: [machineReader],
      cursorPath,
      emit: async () => ({ event_id: "x" }),
      log: noopLog,
      acquireMachineLock: () => false,
    });

    await poller.runOnce();
    poller.stop();
    expect(poller.persistCount()).toBe(0);
  });
});
