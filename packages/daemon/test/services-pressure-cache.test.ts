import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function makeServices(): { db: Database; services: Services } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/penumbra-services-pressure-cache-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
  return { db, services };
}

function insertSnapshotRow(
  db: Database,
  row: {
    event_id: string;
    ts: string;
    provider: string;
    window_label: string;
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
      used_pct: row.used_pct,
      resets_at: row.resets_at,
      source_kind: row.source_kind,
    }),
  );
}

describe("buildServices subscription pressure cache", () => {
  it("exposes subscriptionPressureCache with the cache API", () => {
    const { db, services } = makeServices();

    expect(services.subscriptionPressureCache).toBeDefined();
    expect(typeof services.subscriptionPressureCache.start).toBe("function");
    expect(typeof services.subscriptionPressureCache.stop).toBe("function");
    expect(typeof services.subscriptionPressureCache.get).toBe("function");
    expect(typeof services.subscriptionPressureCache.forProvider).toBe("function");
    expect(typeof services.subscriptionPressureCache.lastUpdatedAt).toBe("function");
    expect(typeof services.subscriptionPressureCache.refresh).toBe("function");

    services.db.close();
    db.close();
  });

  it("refresh reflects inserted rate-limit snapshots", () => {
    const { db, services } = makeServices();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      source_kind: "local-state-claude-statusline",
    });

    services.subscriptionPressureCache.refresh();

    expect(services.subscriptionPressureCache.get("anthropic", "five_hour")).toMatchObject({
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 100,
      observed_at: "2026-05-08T00:00:00Z",
      source_kind: "local-state-claude-statusline",
    });

    services.db.close();
    db.close();
  });

  it("allows start() then stop() without throwing", () => {
    const { db, services } = makeServices();

    expect(() => {
      services.subscriptionPressureCache.start();
      services.subscriptionPressureCache.stop();
      services.subscriptionPressureCache.stop();
    }).not.toThrow();

    services.db.close();
    db.close();
  });
});
