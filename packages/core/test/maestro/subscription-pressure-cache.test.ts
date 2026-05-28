import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { applySchema } from "../../src/db/schema.js";
import {
  createSubscriptionPressureCache,
  type SubscriptionPressureCacheOptions,
} from "../../src/maestro/subscription-pressure-cache.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

function insertSnapshotRow(
  db: Database,
  row: {
    event_id: string;
    ts: string;
    provider: string;
    window_label: string;
    model?: string | null;
    used_pct: number;
    resets_at: number | null;
    source_kind: string;
  },
) {
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, user_id, machine_id,
      event_type, lane, provider, payload_json
    ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)
  `,
  ).run(
    row.event_id,
    row.ts,
    row.ts,
    row.provider,
    JSON.stringify({
      window_label: row.window_label,
      model: row.model ?? null,
      used_pct: row.used_pct,
      resets_at: row.resets_at,
      source_kind: row.source_kind,
    }),
  );
}

describe("createSubscriptionPressureCache", () => {
  it("refreshes on construction so the first lookup is populated", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });

    const cache = createSubscriptionPressureCache(db);

    expect(cache.get("anthropic", "five_hour")).toMatchObject({
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      observed_at: "2026-05-08T00:00:00Z",
      source_kind: "local-state-claude-statusline",
    });
    expect(cache.lastUpdatedAt()).not.toBeNull();
  });

  it("refresh updates cached data without waiting for the interval", () => {
    const db = makeDb();
    const cache = createSubscriptionPressureCache(db);

    expect(cache.get("anthropic", "five_hour")).toBeNull();

    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });

    cache.refresh();

    expect(cache.get("anthropic", "five_hour")).toMatchObject({
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
    });
  });

  it("returns all windows for a provider", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:01:00Z",
      provider: "anthropic",
      window_label: "seven_day",
      used_pct: 20,
      resets_at: 200,
      source_kind: "local-state-claude-statusline",
    });

    const cache = createSubscriptionPressureCache(db);
    expect(cache.forProvider("anthropic")).toHaveLength(2);
    expect(cache.forProvider("missing")).toEqual([]);
  });

  it("keeps the previous snapshot when refresh fails", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });

    const errors: unknown[][] = [];
    const log = {
      info: () => undefined,
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    };
    const cache = createSubscriptionPressureCache(db, {
      log,
    } satisfies SubscriptionPressureCacheOptions);

    db.close();

    expect(() => cache.refresh()).not.toThrow();
    expect(cache.get("anthropic", "five_hour")).toMatchObject({
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
    });
    expect(errors).toHaveLength(1);
  });

  it("advances lastUpdatedAt on successful refreshes", () => {
    const db = makeDb();
    const cache = createSubscriptionPressureCache(db);

    const first = cache.lastUpdatedAt();
    expect(first).not.toBeNull();

    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });
    cache.refresh();

    const second = cache.lastUpdatedAt();
    expect(second).not.toBeNull();
    expect(second!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
  });

  it("allows stop() to be called more than once", () => {
    const db = makeDb();
    const cache = createSubscriptionPressureCache(db);

    expect(() => {
      cache.stop();
      cache.stop();
    }).not.toThrow();
  });

  it("get(provider, window, model) returns only the requested model snapshot", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-google-otlp-synth",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:01:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3-flash-preview",
      used_pct: 20,
      resets_at: 200,
      source_kind: "local-state-google-otlp-synth",
    });
    const cache = createSubscriptionPressureCache(db);

    expect(cache.get("google", "daily", "gemini-3.1-pro-preview")?.model).toBe(
      "gemini-3.1-pro-preview",
    );
    expect(cache.get("google", "daily", "gemini-3-flash-preview")?.model).toBe(
      "gemini-3-flash-preview",
    );
  });

  it("get(provider, window) without model returns the model=null snapshot", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "google",
      window_label: "daily",
      model: null,
      used_pct: 10,
      resets_at: 100,
      source_kind: "legacy",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:01:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 20,
      resets_at: 200,
      source_kind: "local-state-google-otlp-synth",
    });
    const cache = createSubscriptionPressureCache(db);

    expect(cache.get("google", "daily")?.model).toBeNull();
  });

  it("get(provider, window, model) returns null when no matching model exists", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-google-otlp-synth",
    });
    const cache = createSubscriptionPressureCache(db);

    expect(cache.get("google", "daily", "gemini-3-flash-preview")).toBeNull();
  });
});
