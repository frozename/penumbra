import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { recentCost } from "../../src/readers/cost.js";

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

describe("recentCost", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("returns sum of max-per-handoff for a single provider", () => {
    insertUsageRow(db, {
      event_id: "1",
      ts: "2026-04-28T12:00:00Z",
      provider: "anthropic",
      cost_usd: 0.5,
      used: 1000,
      handoff_id: "h1",
    });
    insertUsageRow(db, {
      event_id: "2",
      ts: "2026-04-28T12:01:00Z",
      provider: "anthropic",
      cost_usd: 1.2,
      used: 2400,
      handoff_id: "h1",
    });
    insertUsageRow(db, {
      event_id: "3",
      ts: "2026-04-28T12:02:00Z",
      provider: "anthropic",
      cost_usd: 0.3,
      used: 600,
      handoff_id: "h2",
    });
    const out = recentCost(
      db,
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );
    expect(out.total_cost_usd).toBe(1.5);
    expect(out.total_cost_usd_billed).toBeNull();
    expect(out.total_cost_usd_synth).toBe(1.5);
    expect(out.total_tokens_used).toBe(3000);
    expect(out.handoff_count).toBe(2);
    expect(out.by_provider).toHaveLength(1);
    expect(out.by_provider[0].provider).toBe("anthropic");
    expect(out.by_provider[0].cost_usd).toBe(1.5);
    expect(out.by_provider[0].cost_usd_billed).toBeNull();
    expect(out.by_provider[0].cost_usd_synth).toBe(1.5);
  });

  it("groups by provider and sorts descending by cost", () => {
    insertUsageRow(db, {
      event_id: "1",
      ts: "2026-04-28T12:00:00Z",
      provider: "anthropic",
      cost_usd: 5.0,
      used: 1000,
      handoff_id: "h1",
    });
    insertUsageRow(db, {
      event_id: "2",
      ts: "2026-04-28T12:00:00Z",
      provider: "google",
      cost_usd: 0.5,
      used: 500,
      handoff_id: "h2",
    });
    insertUsageRow(db, {
      event_id: "3",
      ts: "2026-04-28T12:00:00Z",
      provider: "openai",
      cost_usd: null,
      used: 300,
      handoff_id: "h3",
    });
    const out = recentCost(
      db,
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );
    expect(out.by_provider.map((p) => p.provider)).toEqual(["anthropic", "google", "openai"]);
  });

  it("respects the since window", () => {
    insertUsageRow(db, {
      event_id: "1",
      ts: "2026-04-26T12:00:00Z",
      provider: "anthropic",
      cost_usd: 100,
      used: 999,
      handoff_id: "old",
    });
    insertUsageRow(db, {
      event_id: "2",
      ts: "2026-04-28T12:00:00Z",
      provider: "anthropic",
      cost_usd: 1,
      used: 100,
      handoff_id: "new",
    });
    const out = recentCost(
      db,
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );
    expect(out.total_cost_usd).toBe(1);
    expect(out.handoff_count).toBe(1);
  });

  it("returns zeros for empty window", () => {
    const out = recentCost(
      db,
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );
    expect(out.total_cost_usd).toBeNull();
    expect(out.total_cost_usd_billed).toBeNull();
    expect(out.total_cost_usd_synth).toBeNull();
    expect(out.total_tokens_used).toBe(0);
    expect(out.handoff_count).toBe(0);
    expect(out.by_provider).toHaveLength(0);
  });

  it("normalizes since timestamps with timezone offsets before SQL comparison", () => {
    insertUsageRow(db, {
      event_id: "tz-1",
      ts: "2026-04-28T12:30:00.000Z",
      provider: "anthropic",
      cost_usd: 1.1,
      used: 110,
      handoff_id: "h-tz",
    });
    const out = recentCost(
      db,
      { since: "2026-04-28T09:00:00-03:00" },
      () => new Date("2026-04-28T13:00:00.000Z"),
    );
    expect(out.handoff_count).toBe(1);
    expect(out.total_cost_usd).toBe(1.1);
    expect(out.window.from).toBe("2026-04-28T12:00:00.000Z");
  });

  it("partitions totals by lane into billed and synth buckets", () => {
    insertUsageRow(db, {
      event_id: "b1",
      ts: "2026-04-28T12:00:00Z",
      provider: "anthropic",
      lane: "cloud",
      cost_usd: 8.5,
      used: 1200,
      handoff_id: "h-cloud",
    });
    insertUsageRow(db, {
      event_id: "s1",
      ts: "2026-04-28T12:01:00Z",
      provider: "anthropic",
      lane: "cli-subscription",
      cost_usd: 2.25,
      used: 300,
      handoff_id: "h-synth",
    });

    const out = recentCost(
      db,
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );
    expect(out.total_cost_usd).toBe(10.75);
    expect(out.total_cost_usd_billed).toBe(8.5);
    expect(out.total_cost_usd_synth).toBe(2.25);
    expect(out.by_provider[0]).toMatchObject({
      provider: "anthropic",
      cost_usd: 10.75,
      cost_usd_billed: 8.5,
      cost_usd_synth: 2.25,
      handoff_count: 2,
    });
  });

  it("surfaces prompt cache tokens and read percentage by provider and model", () => {
    insertUsageRow(db, {
      event_id: "cache-1",
      ts: "2026-04-28T12:00:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      cost_usd: 1.1,
      used: 180,
      tokens_input: 100,
      tokens_cache_read: 50,
      tokens_cache_write: 10,
      handoff_id: "h-cache-1",
    });
    insertUsageRow(db, {
      event_id: "cache-2",
      ts: "2026-04-28T12:01:00Z",
      provider: "anthropic",
      model: "claude-opus",
      cost_usd: 2.2,
      used: 360,
      tokens_input: 200,
      tokens_cache_read: 100,
      tokens_cache_write: 20,
      handoff_id: "h-cache-2",
    });
    insertUsageRow(db, {
      event_id: "cache-zero",
      ts: "2026-04-28T12:02:00Z",
      provider: "google",
      model: "gemini-flash",
      cost_usd: null,
      used: 40,
      tokens_input: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 9,
      handoff_id: "h-cache-zero",
    });

    const out = recentCost(
      db,
      { since: "2026-04-28T00:00:00Z" },
      () => new Date("2026-04-28T13:00:00Z"),
    );

    const anthropic = out.by_provider.find((row) => row.provider === "anthropic");
    expect(anthropic).toMatchObject({
      tokens_cache_read: 150,
      tokens_cache_write: 30,
      cache_read_pct: 1 / 3,
    });
    const google = out.by_provider.find((row) => row.provider === "google");
    expect(google).toMatchObject({
      tokens_cache_read: 0,
      tokens_cache_write: 9,
      cache_read_pct: null,
    });

    const sonnet = out.by_provider_model.find(
      (row) => row.provider === "anthropic" && row.model === "claude-sonnet",
    );
    expect(sonnet).toMatchObject({
      tokens_cache_read: 50,
      tokens_cache_write: 10,
      cache_read_pct: 1 / 3,
    });
    const zeroInput = out.by_provider_model.find(
      (row) => row.provider === "google" && row.model === "gemini-flash",
    );
    expect(zeroInput).toMatchObject({
      tokens_cache_read: 0,
      tokens_cache_write: 9,
      cache_read_pct: null,
    });
  });
});

describe("recentCost.by_provider_model", () => {
  it("aggregates token usage per (provider, model) tuple", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "m1",
      ts: "2026-04-29T11:30:00Z",
      provider: "google",
      model: "gemini-3-flash-preview",
      cost_usd: null,
      used: 100,
      handoff_id: "r1",
    });
    insertUsageRow(db, {
      event_id: "m2",
      ts: "2026-04-29T11:31:00Z",
      provider: "google",
      model: "gemini-3-flash-preview",
      cost_usd: null,
      used: 200,
      handoff_id: "r2",
    });
    insertUsageRow(db, {
      event_id: "m3",
      ts: "2026-04-29T11:32:00Z",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      cost_usd: null,
      used: 50,
      handoff_id: "r3",
    });

    const out = recentCost(
      db,
      { since: "2026-04-29T11:00:00Z" },
      () => new Date("2026-04-29T12:00:00Z"),
    );
    expect(out.by_provider_model).toBeDefined();
    const flash = out.by_provider_model.find((r) => r.model === "gemini-3-flash-preview");
    const pro = out.by_provider_model.find((r) => r.model === "gemini-3.1-pro-preview");
    expect(flash).toMatchObject({
      provider: "google",
      model: "gemini-3-flash-preview",
      handoff_count: 2,
      tokens_used: 300,
    });
    expect(pro).toMatchObject({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      handoff_count: 1,
      tokens_used: 50,
    });
  });

  it("surfaces subscription pressure rows under by_provider and by_provider_model", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "u1",
      ts: "2026-05-08T11:30:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      cost_usd: 1.2,
      used: 100,
      handoff_id: "h1",
    });
    insertUsageRow(db, {
      event_id: "u2",
      ts: "2026-05-08T11:35:00Z",
      provider: "google",
      model: "gemini-3-flash-preview",
      cost_usd: 0.4,
      used: 80,
      handoff_id: "h2",
    });
    insertSnapshotRow(db, {
      event_id: "s1",
      ts: "2026-05-08T11:40:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      window_label: "five_hour",
      used_pct: 55,
      resets_at: 1778166400,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "s2",
      ts: "2026-05-08T11:41:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      window_label: "daily",
      used_pct: 72,
      resets_at: null,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "s3",
      ts: "2026-05-08T11:45:00Z",
      provider: "google",
      model: "gemini-3-flash-preview",
      window_label: "five_hour",
      used_pct: 25,
      resets_at: 1778166600,
      source_kind: "local-state-gemini-statusline",
    });

    const out = recentCost(
      db,
      { since: "2026-05-08T00:00:00Z" },
      () => new Date("2026-05-08T12:00:00Z"),
    );

    const anthropic = out.by_provider.find((row) => row.provider === "anthropic");
    const google = out.by_provider.find((row) => row.provider === "google");
    expect(anthropic?.subscription_pressure).toEqual([
      {
        window_label: "daily",
        used_pct: 72,
        observed_at: "2026-05-08T11:41:00Z",
        source_kind: "local-state-claude-statusline",
        resets_at: null,
      },
      {
        window_label: "five_hour",
        used_pct: 55,
        observed_at: "2026-05-08T11:40:00Z",
        source_kind: "local-state-claude-statusline",
        resets_at: 1778166400,
      },
    ]);
    expect(google?.subscription_pressure).toEqual([
      {
        window_label: "five_hour",
        used_pct: 25,
        observed_at: "2026-05-08T11:45:00Z",
        source_kind: "local-state-gemini-statusline",
        resets_at: 1778166600,
      },
    ]);

    const anthModel = out.by_provider_model.find(
      (row) => row.provider === "anthropic" && row.model === "claude-sonnet",
    );
    const googleModel = out.by_provider_model.find(
      (row) => row.provider === "google" && row.model === "gemini-3-flash-preview",
    );
    expect(anthModel?.subscription_pressure).toEqual(anthropic?.subscription_pressure);
    expect(googleModel?.subscription_pressure).toEqual(google?.subscription_pressure);
  });

  it("aggregates totals / by_provider / by_provider_model consistently on a multi-provider, multi-model, multi-lane fixture", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "a1",
      ts: "2026-05-09T10:00:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      lane: "cloud",
      cost_usd: 3.0,
      used: 600,
      tokens_input: 400,
      tokens_cache_read: 200,
      tokens_cache_write: 30,
      handoff_id: "ha1",
    });
    insertUsageRow(db, {
      event_id: "a2",
      ts: "2026-05-09T10:01:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      lane: "cloud",
      cost_usd: 4.0,
      used: 800,
      tokens_input: 500,
      tokens_cache_read: 250,
      tokens_cache_write: 40,
      handoff_id: "ha1",
    });
    insertUsageRow(db, {
      event_id: "a3",
      ts: "2026-05-09T10:02:00Z",
      provider: "anthropic",
      model: "claude-opus",
      lane: "cli-subscription",
      cost_usd: 5.0,
      used: 1000,
      tokens_input: 700,
      tokens_cache_read: 300,
      tokens_cache_write: 50,
      handoff_id: "ha2",
    });
    insertUsageRow(db, {
      event_id: "g1",
      ts: "2026-05-09T10:03:00Z",
      provider: "google",
      model: "gemini-flash",
      lane: "cli-subscription",
      cost_usd: 1.2,
      used: 200,
      tokens_input: 150,
      tokens_cache_read: 60,
      tokens_cache_write: 10,
      handoff_id: "hg1",
    });
    insertUsageRow(db, {
      event_id: "o1",
      ts: "2026-05-09T10:04:00Z",
      provider: "openai",
      model: "gpt-4",
      lane: "cloud",
      cost_usd: null,
      used: 50,
      tokens_input: 50,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      handoff_id: "ho1",
    });

    const out = recentCost(
      db,
      { since: "2026-05-09T00:00:00Z" },
      () => new Date("2026-05-09T11:00:00Z"),
    );

    expect(out.handoff_count).toBe(4);
    expect(out.total_cost_usd).toBe(4.0 + 5.0 + 1.2);
    expect(out.total_cost_usd_billed).toBe(4.0);
    expect(out.total_cost_usd_synth).toBe(5.0 + 1.2);
    expect(out.total_tokens_used).toBe(800 + 1000 + 200 + 50);

    expect(out.by_provider.map((r) => r.provider)).toEqual(["anthropic", "google", "openai"]);
    const anth = out.by_provider.find((r) => r.provider === "anthropic")!;
    expect(anth).toMatchObject({
      cost_usd: 9.0,
      cost_usd_billed: 4.0,
      cost_usd_synth: 5.0,
      tokens_used: 1800,
      tokens_cache_read: 250 + 300,
      tokens_cache_write: 40 + 50,
      handoff_count: 2,
    });
    expect(anth.cache_read_pct).toBeCloseTo((250 + 300) / (250 + 300 + 500 + 700), 12);
    const google = out.by_provider.find((r) => r.provider === "google")!;
    expect(google).toMatchObject({
      cost_usd: 1.2,
      cost_usd_billed: null,
      cost_usd_synth: 1.2,
      tokens_used: 200,
      tokens_cache_read: 60,
      tokens_cache_write: 10,
      handoff_count: 1,
    });
    const openai = out.by_provider.find((r) => r.provider === "openai")!;
    expect(openai).toMatchObject({
      cost_usd: null,
      cost_usd_billed: null,
      cost_usd_synth: null,
      tokens_used: 50,
      handoff_count: 1,
    });

    const sonnet = out.by_provider_model.find(
      (r) => r.provider === "anthropic" && r.model === "claude-sonnet",
    )!;
    expect(sonnet).toMatchObject({
      cost_usd: 4.0,
      cost_usd_billed: 4.0,
      cost_usd_synth: null,
      tokens_used: 800,
      tokens_cache_read: 250,
      tokens_cache_write: 40,
      handoff_count: 1,
    });
    const opus = out.by_provider_model.find(
      (r) => r.provider === "anthropic" && r.model === "claude-opus",
    )!;
    expect(opus).toMatchObject({
      cost_usd: 5.0,
      cost_usd_billed: null,
      cost_usd_synth: 5.0,
      tokens_used: 1000,
      tokens_cache_read: 300,
      tokens_cache_write: 50,
      handoff_count: 1,
    });
    expect(out.by_provider_model.find((r) => r.provider === "openai")).toMatchObject({
      cost_usd: null,
      handoff_count: 1,
      tokens_used: 50,
    });
  });

  it("keeps only the latest snapshot per (provider, window_label, model)", () => {
    const db = makeDb();
    insertUsageRow(db, {
      event_id: "u1",
      ts: "2026-05-08T11:30:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      cost_usd: 1.2,
      used: 100,
      handoff_id: "h1",
    });
    insertSnapshotRow(db, {
      event_id: "old",
      ts: "2026-05-08T11:00:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      window_label: "five_hour",
      used_pct: 31,
      resets_at: 1778163000,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "new",
      ts: "2026-05-08T11:50:00Z",
      provider: "anthropic",
      model: "claude-sonnet",
      window_label: "five_hour",
      used_pct: 63,
      resets_at: 1778167200,
      source_kind: "local-state-claude-statusline",
    });

    const out = recentCost(
      db,
      { since: "2026-05-08T00:00:00Z" },
      () => new Date("2026-05-08T12:00:00Z"),
    );
    expect(out.by_provider[0]?.subscription_pressure).toEqual([
      {
        window_label: "five_hour",
        used_pct: 63,
        observed_at: "2026-05-08T11:50:00Z",
        source_kind: "local-state-claude-statusline",
        resets_at: 1778167200,
      },
    ]);
  });
});
