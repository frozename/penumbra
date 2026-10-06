import {
  buildServices,
  loadSqliteVec,
  migrate,
  type PressureResult,
  readSubscriptionPressure,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";

import { isAnyProviderOverPressure } from "../src/pressure.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

beforeEach(() => setSystemTime(new Date("2026-05-08T01:00:00Z")));
afterEach(() => setSystemTime());

function makeServices(): { db: Database; services: Services } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    clock: () => new Date("2026-05-08T01:00:00Z"),
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
      used_pct: row.used_pct,
      resets_at: row.resets_at,
      source_kind: row.source_kind,
    }),
  );
}

describe("buildServices subscription pressure cache", () => {
  it("keeps distinct pressure groups when labels contain spaces", () => {
    const pressure: PressureResult = {
      warnings: [
        {
          code: "stale_snapshot",
          provider: "a b",
          window_label: "c",
          model: null,
          age_seconds: 9999,
        },
      ],
      snapshots: [
        {
          provider: "a",
          window_label: "b c",
          model: null,
          used_pct: 99,
          resets_at: null,
          observed_at: "2026-10-01T12:00:00Z",
          source_kind: "test",
        },
      ],
    };
    expect(isAnyProviderOverPressure(pressure)).toBe(true);
  });

  it("does not treat a fresh 50 percent usage snapshot as over pressure", () => {
    const pressure: PressureResult = {
      warnings: [],
      snapshots: [
        {
          provider: "anthropic",
          window_label: "five_hour",
          model: null,
          used_pct: 50,
          resets_at: null,
          observed_at: "2026-05-08T00:00:00Z",
          source_kind: "local-state-claude-statusline",
        },
      ],
    };

    expect(isAnyProviderOverPressure(pressure)).toBe(false);
  });

  it("does not let a stale per-model warning mask a fresh global (model=null) over-pressure snapshot", () => {
    // A stale warning keyed to a specific model must NOT match — and thus
    // silence — a fresh snapshot with model=null for the same provider +
    // window_label. Without the model dimension in the stale key, the two
    // collide and the fresh over-pressure snapshot would be dropped from the
    // check, letting a real throttle slip through.
    const pressure: PressureResult = {
      warnings: [
        {
          code: "stale_snapshot",
          provider: "google",
          window_label: "daily",
          model: "gemini-3-flash-preview",
          age_seconds: 999_999,
        },
      ],
      snapshots: [
        {
          provider: "google",
          window_label: "daily",
          model: null,
          used_pct: 100,
          resets_at: null,
          observed_at: "2026-05-08T00:00:00Z",
          source_kind: "local-state-google-otlp-synth",
        },
      ],
    };

    expect(isAnyProviderOverPressure(pressure)).toBe(true);
  });

  it("does not let a stale global (model=null) warning mask a fresh per-model over-pressure snapshot", () => {
    const pressure: PressureResult = {
      warnings: [
        {
          code: "stale_snapshot",
          provider: "google",
          window_label: "daily",
          model: null,
          age_seconds: 999_999,
        },
      ],
      snapshots: [
        {
          provider: "google",
          window_label: "daily",
          model: "gemini-3.1-pro-preview",
          used_pct: 100,
          resets_at: null,
          observed_at: "2026-05-08T00:00:00Z",
          source_kind: "local-state-google-otlp-synth",
        },
      ],
    };

    expect(isAnyProviderOverPressure(pressure)).toBe(true);
  });

  it("a fresh 100 percent usage snapshot is still over pressure (regression guard)", () => {
    const pressure: PressureResult = {
      warnings: [],
      snapshots: [
        {
          provider: "anthropic",
          window_label: "five_hour",
          model: null,
          used_pct: 100,
          resets_at: null,
          observed_at: "2026-05-08T00:00:00Z",
          source_kind: "local-state-claude-statusline",
        },
      ],
    };

    expect(isAnyProviderOverPressure(pressure)).toBe(true);
  });

  it("a stale >=90% snapshot with a matching stale key does NOT count as over pressure (fail open)", () => {
    const pressure: PressureResult = {
      warnings: [
        {
          code: "stale_snapshot",
          provider: "sakana",
          window_label: "weekly",
          model: null,
          age_seconds: 999_999,
        },
      ],
      snapshots: [
        {
          provider: "sakana",
          window_label: "weekly",
          model: null,
          used_pct: 100,
          resets_at: null,
          observed_at: "2026-05-08T00:00:00Z",
          source_kind: "subscription",
        },
      ],
    };

    expect(isAnyProviderOverPressure(pressure)).toBe(false);
  });

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
      resets_at: 1778284900,
      source_kind: "local-state-claude-statusline",
    });

    services.subscriptionPressureCache.refresh();

    expect(services.subscriptionPressureCache.get("anthropic", "five_hour")).toMatchObject({
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 1778284900,
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

it("a fresh 98% window with an implausible reset remains over pressure", () => {
  const { db, services } = makeServices();
  insertSnapshotRow(db, {
    event_id: "implausible",
    ts: new Date().toISOString(),
    provider: "openai",
    window_label: "secondary",
    used_pct: 98,
    resets_at: 3600,
    source_kind: "test",
  });
  services.subscriptionPressureCache.refresh();
  expect(isAnyProviderOverPressure(readSubscriptionPressure(db))).toBe(true);
  services.db.close();
  db.close();
});
