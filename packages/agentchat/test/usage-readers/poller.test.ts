import {
  buildPressureExcludedKeys,
  loadSqliteVec,
  migrate,
  normalize,
  readSubscriptionPressure,
  RegexRedactor,
  T0EventInputSchema,
  T0Writer,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UsageReader, UsageReaderResult } from "@src/usage-readers/index.js";
import { startUsagePoller } from "@src/usage-readers/poller.js";

interface PollerEvent {
  event_id: string;
  event_type: string;
  model?: string | null;
  payload_json: { source_kind?: string; model?: string | null };
}

const noop = (): void => undefined;
const noopLog = { info: noop, error: noop };

class StubReader implements UsageReader {
  readonly id: string;
  reads = 0;
  next: UsageReaderResult;
  constructor(id: string, next: UsageReaderResult) {
    this.id = id;
    this.next = next;
  }
  read(_prev: unknown): Promise<UsageReaderResult> {
    this.reads++;
    return Promise.resolve(this.next);
  }
}

class ThrowingReader implements UsageReader {
  readonly id = "throws";
  reads = 0;
  read(): Promise<UsageReaderResult> {
    this.reads++;
    throw new Error("boom");
  }
}

describe("startUsagePoller", () => {
  it("group-aware dedup emits retirement again after a window resurrects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-retirement-"));
    const reader = new StubReader("codex-rollout", {
      cursor: {},
      usage_deltas: [],
      rate_limit_snapshots: [
        { provider: "openai", window_label: "secondary", used_pct: 0, retired: true },
      ],
    });
    const observed: PollerEvent[] = [];
    const poller = startUsagePoller({
      readers: [reader],
      cursorPath: join(dir, "cursor.json"),
      log: noopLog,
      emit: (event) => {
        observed.push(event);
        return Promise.resolve({ event_id: event.event_id });
      },
    });
    try {
      await poller.runOnce();
      reader.next.rate_limit_snapshots = [
        { provider: "openai", window_label: "secondary", used_pct: 98 },
      ];
      await poller.runOnce();
      reader.next.rate_limit_snapshots = [
        { provider: "openai", window_label: "secondary", used_pct: 0, retired: true },
      ];
      await poller.runOnce();
      expect(observed).toHaveLength(3);
    } finally {
      poller.stop();
    }
  });

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
    const observed: PollerEvent[] = [];
    const poller = startUsagePoller({
      readers: [reader],
      intervalMs: 30_000,
      cursorPath,
      emit: (e: PollerEvent) => {
        observed.push(e);
        return Promise.resolve({ event_id: e.event_id });
      },
      log: noopLog,
    });

    await poller.runOnce();
    await poller.runOnce();
    poller.stop();

    expect(observed).toHaveLength(1);
    expect(observed[0]?.event_id).toMatch(/^usage-poller-/);
    expect(new Set(observed.map((event) => event.event_id)).size).toBe(1);

    const persisted = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
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
    const observed: PollerEvent[] = [];
    const poller = startUsagePoller({
      readers: [reader],
      intervalMs: 30_000,
      cursorPath,
      emit: (e: PollerEvent) => {
        observed.push(e);
        return Promise.resolve({ event_id: "x" });
      },
      log: noopLog,
    });
    await poller.runOnce();
    poller.stop();
    expect(reader.reads).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.event_type).toBe("usage-update");
    expect(observed[0]?.payload_json.source_kind).toBe("local-state-a");
    const persisted = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
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
      emit: () => Promise.resolve({ event_id: "x" }),
      log: noopLog,
    });
    await poller.runOnce();
    poller.stop();
    expect(bad.reads).toBe(1);
    expect(ok.reads).toBe(1);
    const persisted = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
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
    const observed: PollerEvent[] = [];
    const poller = startUsagePoller({
      readers: [reader],
      intervalMs: 30_000,
      cursorPath,
      emit: (e: PollerEvent) => {
        observed.push(e);
        return Promise.resolve({ event_id: "x" });
      },
      log: noopLog,
    });
    await poller.runOnce();
    poller.stop();

    expect(observed).toHaveLength(1);
    expect(observed[0]?.event_type).toBe("rate-limit-snapshot");
    expect(observed[0]?.model).toBe("gemini-3.1-pro-preview");
    expect(observed[0]?.payload_json.model).toBe("gemini-3.1-pro-preview");
  });
});

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  /* already loaded */
}

it("round-trips a poller snapshot through the ingestion schema into routing pressure", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const writer = new T0Writer(db);
  const reader = new StubReader("codex-rollout", {
    cursor: {},
    usage_deltas: [],
    rate_limit_snapshots: [
      { provider: "openai", window_label: "secondary", used_pct: 98, resets_at: 3600 },
    ],
  });
  const poller = startUsagePoller({
    readers: [reader],
    cursorPath: join(mkdtempSync(join(tmpdir(), "poller-roundtrip-")), "cursor.json"),
    log: noopLog,
    emit: (event) =>
      Promise.resolve({
        event_id: writer.write(
          normalize(T0EventInputSchema.parse(event), {
            userId: "u",
            machineId: "m",
            now: () => new Date(),
            uuid: () => "unused",
            redactor: new RegexRedactor([]),
          }),
        ),
      }),
  });
  try {
    await poller.runOnce();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t0_events").get()?.n).toBe(1);
    const pressure = readSubscriptionPressure(db);
    expect(pressure.snapshots.map((snapshot) => snapshot.used_pct)).toEqual([98]);
    expect(buildPressureExcludedKeys(pressure).size).toBe(0);
  } finally {
    poller.stop();
    db.close();
  }
});

it("keeps column and payload model identical for live, retired and model-undefined snapshots", async () => {
  const reader = new StubReader("models", {
    cursor: {},
    usage_deltas: [],
    rate_limit_snapshots: [
      { provider: "openai", window_label: "primary", model: "codex", used_pct: 98 },
      { provider: "openai", window_label: "secondary", model: "codex", used_pct: 0, retired: true },
      { provider: "openai", window_label: "daily", used_pct: 40 },
    ],
  });
  const observed: PollerEvent[] = [];
  const poller = startUsagePoller({
    readers: [reader],
    cursorPath: join(mkdtempSync(join(tmpdir(), "poller-models-")), "cursor.json"),
    log: noopLog,
    emit: (event) => {
      observed.push(event);
      return Promise.resolve({ event_id: event.event_id });
    },
  });
  try {
    await poller.runOnce();
    expect(observed).toHaveLength(3);
    for (const event of observed) expect(event.model).toBe(event.payload_json.model);
  } finally {
    poller.stop();
  }
});

it("does not re-emit an unchanged retired snapshot on consecutive ticks", async () => {
  const reader = new StubReader("codex-rollout", {
    cursor: {},
    usage_deltas: [],
    rate_limit_snapshots: [
      { provider: "openai", window_label: "secondary", used_pct: 0, retired: true },
    ],
  });
  const observed: PollerEvent[] = [];
  const poller = startUsagePoller({
    readers: [reader],
    cursorPath: join(mkdtempSync(join(tmpdir(), "poller-retired-")), "cursor.json"),
    log: noopLog,
    emit: (event) => {
      observed.push(event);
      return Promise.resolve({ event_id: "retirement-x" });
    },
  });
  try {
    await poller.runOnce();
    await poller.runOnce();
    expect(observed).toHaveLength(1);
  } finally {
    poller.stop();
  }
});
it("re-emits a byte-identical live snapshot after the group was retired", async () => {
  const live = { provider: "openai", window_label: "secondary", used_pct: 98 };
  const reader = new StubReader("codex-rollout", {
    cursor: {},
    usage_deltas: [],
    rate_limit_snapshots: [live],
  });
  const summaries: string[] = [];
  const poller = startUsagePoller({
    readers: [reader],
    cursorPath: join(mkdtempSync(join(tmpdir(), "poller-resurrect-")), "cursor.json"),
    log: noopLog,
    emit: (event) => {
      summaries.push(event.payload_summary);
      return Promise.resolve({ event_id: event.event_id });
    },
  });
  try {
    await poller.runOnce();
    reader.next.rate_limit_snapshots = [{ ...live, used_pct: 0, retired: true }];
    await poller.runOnce();
    reader.next.rate_limit_snapshots = [live];
    await poller.runOnce();
    await poller.runOnce();
    expect(summaries).toHaveLength(3);
    expect(summaries[0]).toContain("98%");
    expect(summaries[1]).toContain("retired");
    expect(summaries[2]).toBe(summaries[0]);
  } finally {
    poller.stop();
  }
});
it("round-trips live retirement and identical resurrection through durable ingestion", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const writer = new T0Writer(db);
  const live = { provider: "openai", window_label: "secondary", used_pct: 98 };
  const reader = new StubReader("codex-rollout", {
    cursor: {},
    usage_deltas: [],
    rate_limit_snapshots: [live],
  });
  const poller = startUsagePoller({
    readers: [reader],
    cursorPath: join(mkdtempSync(join(tmpdir(), "poller-durable-")), "cursor.json"),
    log: noopLog,
    emit: (event) =>
      Promise.resolve({
        event_id: writer.write(
          normalize(T0EventInputSchema.parse(event), {
            userId: "u",
            machineId: "m",
            now: () => new Date(),
            uuid: () => "unused",
            redactor: new RegexRedactor([]),
          }),
        ),
      }),
  });
  try {
    await poller.runOnce();
    reader.next.rate_limit_snapshots = [{ ...live, used_pct: 0, retired: true }];
    await poller.runOnce();
    expect(readSubscriptionPressure(db).snapshots).toEqual([]);
    reader.next.rate_limit_snapshots = [live];
    await poller.runOnce();
    expect(readSubscriptionPressure(db).snapshots.map((snapshot) => snapshot.used_pct)).toEqual([
      98,
    ]);
  } finally {
    poller.stop();
    db.close();
  }
});
