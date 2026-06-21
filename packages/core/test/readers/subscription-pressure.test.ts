import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { applySchema } from "../../src/db/schema.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { readSubscriptionPressure } from "../../src/readers/subscription-pressure.js";

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
): void {
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

describe("readSubscriptionPressure", () => {
  it("returns empty snapshots and warnings for an empty database", () => {
    const db = makeDb();
    expect(readSubscriptionPressure(db)).toEqual({ snapshots: [], warnings: [] });
  });

  it("keeps only the most recent snapshot per provider and window", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:10:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 20,
      resets_at: 200,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "c",
      ts: "2026-05-08T00:20:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 30,
      resets_at: 300,
      source_kind: "local-state-claude-statusline",
    });

    const out = readSubscriptionPressure(db);
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]).toMatchObject({
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 30,
      resets_at: 300,
      observed_at: "2026-05-08T00:20:00Z",
      source_kind: "local-state-claude-statusline",
    });
  });

  it("returns multiple windows for the same provider", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:01:00Z",
      provider: "anthropic-claude",
      window_label: "seven_day",
      used_pct: 50,
      resets_at: 500,
      source_kind: "local-state-claude-statusline",
    });

    const out = readSubscriptionPressure(db);
    expect(out.snapshots.map((s) => s.window_label).sort()).toEqual(["five_hour", "seven_day"]);
  });

  it("keeps distinct snapshots for same provider/window when model differs", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 20,
      resets_at: 100,
      source_kind: "local-state-google-otlp-synth",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:01:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3-flash-preview",
      used_pct: 40,
      resets_at: 200,
      source_kind: "local-state-google-otlp-synth",
    });

    const out = readSubscriptionPressure(db);
    expect(out.snapshots).toHaveLength(2);
    const models = out.snapshots.map((s) => s.model).sort();
    expect(models).toEqual(["gemini-3-flash-preview", "gemini-3.1-pro-preview"]);
  });

  it("dedupes same provider/window/model and keeps latest", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 20,
      resets_at: 100,
      source_kind: "local-state-google-otlp-synth",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:02:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 25,
      resets_at: 200,
      source_kind: "local-state-google-otlp-synth",
    });

    const out = readSubscriptionPressure(db);
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]).toMatchObject({
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 25,
      observed_at: "2026-05-08T00:02:00Z",
    });
  });

  it("filters snapshots by provider", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:01:00Z",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 50,
      resets_at: 500,
      source_kind: "local-state-codex-rollout",
    });

    const out = readSubscriptionPressure(db, { provider: "anthropic-claude" });
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0].provider).toBe("anthropic-claude");
  });

  it("adds a stale_snapshot warning when the snapshot is older than the threshold", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });

    const out = readSubscriptionPressure(db, {
      stale_after_seconds: 1800,
      now: () => new Date("2026-05-08T01:00:00Z"),
    });

    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({
      code: "stale_snapshot",
      provider: "anthropic-claude",
      window_label: "five_hour",
      age_seconds: 3600,
    });
  });

  it("does not warn when the snapshot is still fresh", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });

    const out = readSubscriptionPressure(db, {
      stale_after_seconds: 86400,
      now: () => new Date("2026-05-08T01:00:00Z"),
    });

    expect(out.warnings).toHaveLength(0);
  });

  it("back-compat: row without model in payload yields model=null", () => {
    const db = makeDb();
    db.prepare(
      `
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, user_id, machine_id,
        event_type, lane, provider, payload_json
      ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)
    `,
    ).run(
      "legacy",
      "2026-05-08T00:00:00Z",
      "2026-05-08T00:00:00Z",
      "anthropic",
      JSON.stringify({
        window_label: "five_hour",
        used_pct: 20,
        resets_at: 100,
        source_kind: "legacy-reader",
      }),
    );

    const out = readSubscriptionPressure(db);
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]?.model).toBeNull();
  });
});
