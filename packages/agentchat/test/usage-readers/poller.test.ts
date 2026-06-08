import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUsagePoller } from "../../src/usage-readers/poller.js";
import type { UsageReader, UsageReaderResult } from "../../src/usage-readers/index.js";

class StubReader implements UsageReader {
  readonly id: string;
  reads = 0;
  next: UsageReaderResult;
  constructor(id: string, next: UsageReaderResult) {
    this.id = id;
    this.next = next;
  }
  async read(_prev: unknown | null) {
    this.reads++;
    return this.next;
  }
}

class ThrowingReader implements UsageReader {
  readonly id = "throws";
  reads = 0;
  async read() {
    this.reads++;
    throw new Error("boom");
  }
}

describe("startUsagePoller", () => {
  it("runOnce re-polling the same cursor position emits 0 new events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-"));
    const cursorPath = join(dir, "cursors.json");
    const reader = new StubReader("a", {
      cursor: { position: 1 },
      usage_deltas: [
        {
          provider: "p",
          model: "m",
          tokens_input: 3,
          tokens_output: 4,
          cost_usd: 0.7,
          window_start: "2026-06-08T00:00:00.000Z",
          window_end: "2026-06-08T00:05:00.000Z",
        },
      ],
      rate_limit_snapshots: [],
    });
    const observed: any[] = [];
    const poller = startUsagePoller({
      readers: [reader],
      intervalMs: 30_000,
      cursorPath,
      emit: async (e) => {
        observed.push(e);
        return { event_id: e.event_id };
      },
      log: { info: () => {}, error: () => {} },
    });

    await (poller as any).runOnce();
    await (poller as any).runOnce();
    poller.stop();

    expect(observed).toHaveLength(1);
    expect(observed[0].event_id).toMatch(/^usage-poller-/);
    expect(new Set(observed.map((event) => event.event_id)).size).toBe(1);

    const persisted = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(persisted.a).toEqual({ position: 1 });
    expect(reader.reads).toBe(2);
  });

  it("runs all readers and persists cursors atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-"));
    const cursorPath = join(dir, "cursors.json");
    const reader = new StubReader("a", {
      cursor: { x: 42 },
      usage_deltas: [
        {
          provider: "p",
          model: "m",
          tokens_input: 1,
          tokens_output: 2,
          cost_usd: 0.5,
          window_start: "",
          window_end: "",
        },
      ],
      rate_limit_snapshots: [],
    });
    const observed: any[] = [];
    const poller = startUsagePoller({
      readers: [reader],
      intervalMs: 30_000,
      cursorPath,
      emit: async (e) => {
        observed.push(e);
        return { event_id: "x" };
      },
      log: { info: () => {}, error: () => {} },
    });
    await (poller as any).runOnce();
    poller.stop();
    expect(reader.reads).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0].event_type).toBe("usage-update");
    expect(observed[0].payload_json.source_kind).toBe("local-state-a");
    const persisted = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(persisted.a).toEqual({ x: 42 });
  });

  it("isolates failures: one reader throws, others still run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-"));
    const cursorPath = join(dir, "cursors.json");
    const ok = new StubReader("ok", {
      cursor: { y: 1 },
      usage_deltas: [],
      rate_limit_snapshots: [],
    });
    const bad = new ThrowingReader();
    const poller = startUsagePoller({
      readers: [bad, ok],
      intervalMs: 30_000,
      cursorPath,
      emit: async () => ({ event_id: "x" }),
      log: { info: () => {}, error: () => {} },
    });
    await (poller as any).runOnce();
    poller.stop();
    expect(bad.reads).toBe(1);
    expect(ok.reads).toBe(1);
    const persisted = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(persisted.ok).toEqual({ y: 1 });
    expect(persisted.throws).toBeUndefined();
  });

  it("emits model-scoped fields for rate-limit snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-"));
    const cursorPath = join(dir, "cursors.json");
    const reader = new StubReader("rl", {
      cursor: { z: 1 },
      usage_deltas: [],
      rate_limit_snapshots: [
        {
          provider: "google",
          model: "gemini-3.1-pro-preview",
          window_label: "daily",
          used_pct: 42,
          window_minutes: 1440,
        },
      ],
    });
    const observed: any[] = [];
    const poller = startUsagePoller({
      readers: [reader],
      intervalMs: 30_000,
      cursorPath,
      emit: async (e) => {
        observed.push(e);
        return { event_id: "x" };
      },
      log: { info: () => {}, error: () => {} },
    });
    await (poller as any).runOnce();
    poller.stop();

    expect(observed).toHaveLength(1);
    expect(observed[0].event_type).toBe("rate-limit-snapshot");
    expect(observed[0].model).toBe("gemini-3.1-pro-preview");
    expect(observed[0].payload_json.model).toBe("gemini-3.1-pro-preview");
  });
});
