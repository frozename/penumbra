import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { quotaStatus } from "@src/readers/cost-quota.js";
import { recentCost } from "@src/readers/cost.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE t0_events (
      event_id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      ingest_ts TEXT NOT NULL,
      source TEXT NOT NULL,
      source_detail TEXT,
      project_id TEXT,
      user_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      session_id TEXT,
      event_type TEXT NOT NULL,
      lane TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      latency_ms INTEGER,
      request_id TEXT,
      payload_json TEXT NOT NULL,
      payload_summary TEXT
    );
  `);
  return db;
}

function insertUsageRow(
  db: Database,
  row: {
    event_id: string;
    ts: string;
    provider: string;
    model?: string | null;
    lane?: string;
    cost_usd: number | null;
    used: number;
    tokens_input?: number;
    tokens_cache_read?: number;
    tokens_cache_write?: number;
    handoff_id: string | null;
  },
): void {
  db.prepare(
    `
    INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json)
    VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', ?, ?, ?, ?, ?)
  `,
  ).run(
    row.event_id,
    row.ts,
    row.ts,
    row.lane ?? "cli-subscription",
    row.provider,
    row.model ?? null,
    row.cost_usd,
    JSON.stringify({
      handoff_id: row.handoff_id,
      used: row.used,
      tokens_input: row.tokens_input ?? row.used,
      tokens_cache_read: row.tokens_cache_read ?? 0,
      tokens_cache_write: row.tokens_cache_write ?? 0,
    }),
  );
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
      event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, payload_json
    ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?, ?)
  `,
  ).run(
    row.event_id,
    row.ts,
    row.ts,
    row.provider,
    row.model ?? null,
    JSON.stringify({
      window_label: row.window_label,
      model: row.model ?? null,
      used_pct: row.used_pct,
      resets_at: row.resets_at,
      source_kind: row.source_kind,
    }),
  );
}

describe("quotaStatus", () => {
  it("distinguishes display-only (subscription) vs billed (api) USD", () => {
    const db = makeDb();
    const result = quotaStatus(
      db,
      [
        { provider: "api-prov", quota_usd_per_24h: 10 },
        {
          provider: "sub-prov1",
          quota_usd_per_24h: 20,
          pressure_caps: { five_hour: { warn: null, refuse: 100 } },
        },
        {
          provider: "sub-prov2",
          quota_usd_per_24h: 20,
          synthetic_cap: { max_dispatches: 10, window_seconds: 60 },
        },
        { provider: "no-quota-prov" },
      ],
      {},
      () => new Date("2026-05-08T12:00:00Z"),
    );

    const apiProv = result.providers.find((p) => p.provider === "api-prov");
    const subProv1 = result.providers.find((p) => p.provider === "sub-prov1");
    const subProv2 = result.providers.find((p) => p.provider === "sub-prov2");
    const noQuotaProv = result.providers.find((p) => p.provider === "no-quota-prov");

    expect(apiProv?.usd_quota_mode).toBe("billed");
    expect(subProv1?.usd_quota_mode).toBe("display_only");
    expect(subProv2?.usd_quota_mode).toBe("display_only");
    expect(noQuotaProv?.usd_quota_mode).toBe("none");
  });

  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("computes remaining_usd and pct correctly when both quota and usage are present", () => {
    insertUsageRow(db, {
      event_id: "1",
      ts: "2026-04-28T12:00:00Z",
      provider: "anthropic",
      lane: "cloud",
      cost_usd: 12.4,
      used: 12000,
      handoff_id: "h1",
    });
    const out = quotaStatus(
      db,
      [{ provider: "anthropic", quota_usd_per_24h: 50.0 }],
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0]).toMatchObject({
      provider: "anthropic",
      used_usd: 12.4,
      used_usd_synth: null,
      quota_usd: 50.0,
      remaining_usd: 37.6,
      remaining_pct_usd: 75.2,
    });
  });

  it("uses token-side fields when only quota_tokens_per_24h is configured", () => {
    insertUsageRow(db, {
      event_id: "1",
      ts: "2026-04-28T12:00:00Z",
      provider: "openai",
      cost_usd: null,
      used: 250000,
      handoff_id: "h1",
    });
    const out = quotaStatus(
      db,
      [{ provider: "openai", quota_tokens_per_24h: 1_000_000 }],
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );
    expect(out.providers[0].quota_usd).toBeNull();
    expect(out.providers[0].used_tokens).toBe(250000);
    expect(out.providers[0].quota_tokens).toBe(1_000_000);
    expect(out.providers[0].remaining_tokens).toBe(750000);
    expect(out.providers[0].remaining_pct_tokens).toBe(75.0);
  });

  it("surfaces prompt cache token fields from the shared cost reader", () => {
    insertUsageRow(db, {
      event_id: "cache-quota",
      ts: "2026-04-28T12:00:00Z",
      provider: "openai",
      model: "gpt-5.4",
      cost_usd: null,
      used: 160,
      tokens_input: 100,
      tokens_cache_read: 25,
      tokens_cache_write: 5,
      handoff_id: "h-cache-quota",
    });
    insertUsageRow(db, {
      event_id: "cache-quota-zero",
      ts: "2026-04-28T12:01:00Z",
      provider: "google",
      model: "gemini-flash",
      cost_usd: null,
      used: 12,
      tokens_input: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 7,
      handoff_id: "h-cache-quota-zero",
    });

    const out = quotaStatus(
      db,
      [
        { provider: "openai", model: "gpt-5.4", quota_tokens_per_24h: 1_000_000 },
        { provider: "google", model: "gemini-flash", quota_tokens_per_24h: 1_000_000 },
      ],
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );

    expect(out.providers.find((row) => row.provider === "openai")).toMatchObject({
      tokens_cache_read: 25,
      tokens_cache_write: 5,
      cache_read_pct: 0.2,
    });
    expect(out.providers.find((row) => row.provider === "google")).toMatchObject({
      tokens_cache_read: 0,
      tokens_cache_write: 7,
      cache_read_pct: null,
    });
  });

  it("returns 0 used + full quota remaining for a provider with config but no usage", () => {
    const out = quotaStatus(
      db,
      [{ provider: "google", quota_usd_per_24h: 25 }],
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );
    expect(out.providers[0].used_usd).toBe(0);
    expect(out.providers[0].used_usd_synth).toBeNull();
    expect(out.providers[0].remaining_usd).toBe(25);
    expect(out.providers[0].remaining_pct_usd).toBe(100);
  });

  it("omits providers from response when no quota is configured", () => {
    insertUsageRow(db, {
      event_id: "1",
      ts: "2026-04-28T12:00:00Z",
      provider: "unknown",
      cost_usd: 1,
      used: 100,
      handoff_id: "h1",
    });
    const out = quotaStatus(
      db,
      [{ provider: "anthropic", quota_usd_per_24h: 50 }],
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );
    expect(out.providers.map((p) => p.provider)).toEqual(["anthropic"]);
  });
});

describe("quotaStatus per-model", () => {
  it("reports a row per (provider, model) tuple when model is set in quota config", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "q1",
      ts: "2026-04-29T11:30:00Z",
      provider: "google",
      model: "gemini-3-flash-preview",
      cost_usd: null,
      used: 100,
      handoff_id: "h1",
    });
    insertUsageRow(db, {
      event_id: "q2",
      ts: "2026-04-29T11:31:00Z",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      cost_usd: null,
      used: 50,
      handoff_id: "h2",
    });

    const out = quotaStatus(
      db,
      [
        { provider: "google", model: "gemini-3-flash-preview", quota_tokens_per_24h: 1000 },
        { provider: "google", model: "gemini-3.1-pro-preview", quota_tokens_per_24h: 200 },
      ],
      { since: "2026-04-29T11:00:00Z" },
      () => new Date("2026-04-29T12:00:00Z"),
    );

    expect(out.providers).toHaveLength(2);
    const flash = out.providers.find((p) => p.model === "gemini-3-flash-preview")!;
    const pro = out.providers.find((p) => p.model === "gemini-3.1-pro-preview")!;
    expect(flash.used_tokens).toBe(100);
    expect(flash.quota_tokens).toBe(1000);
    expect(pro.used_tokens).toBe(50);
    expect(pro.quota_tokens).toBe(200);
  });

  it("still aggregates by provider when no model field is set on the quota row", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "q3",
      ts: "2026-04-29T11:30:00Z",
      provider: "anthropic",
      model: "claude-opus",
      cost_usd: null,
      used: 100,
      handoff_id: "h3",
    });
    insertUsageRow(db, {
      event_id: "q4",
      ts: "2026-04-29T11:31:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      cost_usd: null,
      used: 50,
      handoff_id: "h4",
    });

    const out = quotaStatus(
      db,
      [{ provider: "anthropic", quota_tokens_per_24h: 10000 }],
      { since: "2026-04-29T11:00:00Z" },
      () => new Date("2026-04-29T12:00:00Z"),
    );

    expect(out.providers).toHaveLength(1);
    expect(out.providers[0]!.provider).toBe("anthropic");
    expect(out.providers[0]!.model).toBeUndefined();
    expect(out.providers[0]!.used_tokens).toBe(150);
  });
});

describe("quotaStatus token window selection", () => {
  it("selects quota_tokens_per_5h when window=5h", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "w1",
      ts: "2026-04-29T11:30:00Z",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      cost_usd: null,
      used: 120,
      handoff_id: "h1",
    });

    const out = quotaStatus(
      db,
      [
        {
          provider: "google",
          model: "gemini-3.1-pro-preview",
          quota_tokens_per_24h: 2000,
          quota_tokens_per_5h: 500,
        },
      ],
      { since: "2026-04-29T11:00:00Z", window: "5h" },
      () => new Date("2026-04-29T12:00:00Z"),
    );

    expect(out.providers[0]?.quota_tokens).toBe(500);
  });

  it("defaults to quota_tokens_per_24h when window is omitted or 24h", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "w2",
      ts: "2026-04-29T11:30:00Z",
      provider: "google",
      model: "gemini-3-flash-preview",
      cost_usd: null,
      used: 120,
      handoff_id: "h2",
    });

    const providers = [
      {
        provider: "google",
        model: "gemini-3-flash-preview",
        quota_tokens_per_24h: 2000,
        quota_tokens_per_5h: 500,
      },
    ];
    const since = { since: "2026-04-29T11:00:00Z" };
    const withDefault = quotaStatus(db, providers, since, () => new Date("2026-04-29T12:00:00Z"));
    const with24h = quotaStatus(
      db,
      providers,
      { ...since, window: "24h" },
      () => new Date("2026-04-29T12:00:00Z"),
    );

    expect(withDefault.providers[0]?.quota_tokens).toBe(2000);
    expect(with24h.providers[0]?.quota_tokens).toBe(2000);
  });

  it("returns null quota_tokens for window=5h when only 24h quota exists", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "w3",
      ts: "2026-04-29T11:30:00Z",
      provider: "anthropic",
      cost_usd: null,
      used: 120,
      handoff_id: "h3",
    });

    const out = quotaStatus(
      db,
      [
        {
          provider: "anthropic",
          quota_tokens_per_24h: 1000,
        },
      ],
      { since: "2026-04-29T11:00:00Z", window: "5h" },
      () => new Date("2026-04-29T12:00:00Z"),
    );

    expect(out.providers[0]?.quota_tokens).toBeNull();
  });

  it("selects quota_tokens_per_7d when window=7d", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "w4",
      ts: "2026-08-27T12:30:00Z",
      provider: "alibaba",
      cost_usd: null,
      used: 700,
      handoff_id: "h4",
    });

    const out = quotaStatus(
      db,
      [
        {
          provider: "alibaba",
          quota_tokens_per_24h: 1_000,
          quota_tokens_per_7d: 7_000_000,
        },
      ],
      { since: "2026-08-26T15:53:00Z", window: "7d" },
      () => new Date("2026-08-27T13:00:00Z"),
    );

    expect(out.providers[0]?.quota_tokens).toBe(7_000_000);
  });

  it("returns null quota_tokens for window=7d when quota_tokens_per_7d is absent", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "w5",
      ts: "2026-08-27T12:30:00Z",
      provider: "alibaba",
      cost_usd: null,
      used: 700,
      handoff_id: "h5",
    });

    const out = quotaStatus(
      db,
      [
        {
          provider: "alibaba",
          quota_tokens_per_24h: 1_000,
        },
      ],
      { since: "2026-08-26T15:53:00Z", window: "7d" },
      () => new Date("2026-08-27T13:00:00Z"),
    );

    expect(out.providers[0]?.quota_tokens).toBeNull();
  });

  it("surfaces subscription pressure snapshots per row and dedupes by window_label", () => {
    const db = makeDb();
    const now = new Date("2026-05-08T12:00:00Z");
    insertUsageRow(db, {
      event_id: "sp-usage",
      ts: "2026-05-08T11:30:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      lane: "cli-subscription",
      cost_usd: 7.4,
      used: 4000,
      handoff_id: "sp-h1",
    });
    insertSnapshotRow(db, {
      event_id: "sp-old",
      ts: "2026-05-08T11:00:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      window_label: "five_hour",
      used_pct: 34,
      resets_at: 1778163000,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "sp-new",
      ts: "2026-05-08T11:45:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      window_label: "five_hour",
      used_pct: 51,
      resets_at: 1778252400,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "sp-daily",
      ts: "2026-05-08T11:50:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      window_label: "daily",
      used_pct: 80,
      resets_at: null,
      source_kind: "local-state-claude-statusline",
    });

    const out = quotaStatus(
      db,
      [{ provider: "anthropic", model: "claude-sonnet", quota_usd_per_24h: 20 }],
      { since: "2026-05-08T00:00:00Z" },
      () => now,
    );

    expect(out.providers).toHaveLength(1);
    expect(out.providers[0]).toMatchObject({
      used_usd: 0,
      used_usd_synth: 7.4,
      remaining_usd: 20,
    });
    const pressure = out.providers[0]?.subscription_pressure ?? [];
    expect(pressure).toHaveLength(2);
    const sorted = [...pressure].sort((a, b) => a.window_label.localeCompare(b.window_label));
    expect(sorted).toEqual([
      {
        status: "fresh",
        window_label: "daily",
        used_pct: 80,
        observed_at: "2026-05-08T11:50:00Z",
        source_kind: "local-state-claude-statusline",
        resets_at: null,
      },
      {
        status: "fresh",
        window_label: "five_hour",
        used_pct: 51,
        observed_at: "2026-05-08T11:45:00Z",
        source_kind: "local-state-claude-statusline",
        resets_at: 1778252400,
      },
    ]);
  });

  it("matches subscription pressure rows from recentCost for the same provider/model window", () => {
    const db = makeDb();
    const now = new Date("2026-05-08T12:00:00Z");
    insertUsageRow(db, {
      event_id: "sp-usage-2",
      ts: "2026-05-08T11:30:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      lane: "cli-subscription",
      cost_usd: 3.1,
      used: 1400,
      handoff_id: "sp-h2",
    });
    insertSnapshotRow(db, {
      event_id: "sp-h2-daily",
      ts: "2026-05-08T11:48:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      window_label: "daily",
      used_pct: 67,
      resets_at: null,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "sp-h2-five",
      ts: "2026-05-08T11:49:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      window_label: "five_hour",
      used_pct: 44,
      resets_at: 1778166540,
      source_kind: "local-state-claude-statusline",
    });

    const since = "2026-05-08T00:00:00Z";
    const recent = recentCost(db, { since }, () => now);
    const quota = quotaStatus(
      db,
      [{ provider: "anthropic", model: "claude-sonnet", quota_usd_per_24h: 20 }],
      { since },
      () => now,
    );

    const recentRow = recent.by_provider_model.find(
      (row) => row.provider === "anthropic" && row.model === "claude-sonnet",
    );
    expect(quota.providers[0]?.subscription_pressure).toEqual(recentRow?.subscription_pressure);
  });
});

it("quotaStatus reads rate-limit snapshots once per call", () => {
  const inner = makeDb();
  insertSnapshotRow(inner, {
    event_id: "snap",
    ts: "2026-10-01T11:59:00Z",
    provider: "openai",
    window_label: "daily",
    used_pct: 42,
    resets_at: null,
    source_kind: "test",
  });
  let pressureReads = 0;
  const db = new Proxy(inner, {
    get(target, prop): unknown {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop !== "prepare") return value;
      return (sql: string, ...rest: unknown[]): unknown => {
        if (sql.includes("rate-limit-snapshot")) pressureReads += 1;
        return (value as (...args: unknown[]) => unknown).call(target, sql, ...rest);
      };
    },
  });

  const result = quotaStatus(
    db,
    [{ provider: "openai", quota_usd_per_24h: 20 }],
    { since: "2026-10-01T00:00:00Z" },
    () => new Date("2026-10-01T12:00:00Z"),
  );
  expect(result.providers[0]?.subscription_pressure).toHaveLength(1);
  expect(pressureReads).toBe(1);
  inner.close();
});

it("quotaStatus surfaces an expired-only window with status expired", () => {
  const db = makeDb();
  insertUsageRow(db, {
    event_id: "usage",
    ts: "2026-10-01T11:59:00Z",
    provider: "openai",
    cost_usd: null,
    used: 1,
    handoff_id: null,
  });
  insertSnapshotRow(db, {
    event_id: "expired",
    ts: "2026-10-01T11:59:00Z",
    provider: "openai",
    window_label: "daily",
    used_pct: 98,
    resets_at: Date.parse("2026-10-01T11:59:30Z") / 1000,
    source_kind: "test",
  });
  const result = quotaStatus(
    db,
    [{ provider: "openai", quota_usd_per_24h: 20 }],
    { since: "2026-10-01T00:00:00Z" },
    () => new Date("2026-10-01T12:00:00Z"),
  );
  expect(result.providers[0]?.subscription_pressure).toMatchObject([
    { window_label: "daily", status: "expired" },
  ]);
  db.close();
});
