import { type Services } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import {
  usageQuotaStatusRoute,
  usageRecentRoute,
  usageSubscriptionPressureRoute,
} from "../../src/routes/usage.js";

type ProviderQuota = Services["providerQuotas"][number];

function makeServices(db: Database, providerQuotas: ProviderQuota[] = []): Services {
  return {
    db,
    clock: () => new Date("2026-04-28T13:00:00Z"),
    providerQuotas,
  } as unknown as Services;
}

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
    cost_usd: number | null;
    used: number;
    handoff_id: string | null;
    lane?: string;
  },
): void {
  db.prepare(
    `
    INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, cost_usd, payload_json)
    VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', ?, ?, ?, ?)
  `,
  ).run(
    row.event_id,
    row.ts,
    row.ts,
    row.lane ?? "cli-subscription",
    row.provider,
    row.cost_usd,
    JSON.stringify({ handoff_id: row.handoff_id, used: row.used }),
  );
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

interface ProviderRow {
  remaining_usd: number;
  used_usd: number;
}
interface RecentBody {
  total_cost_usd: number;
  by_provider: unknown[];
}
interface QuotaBody {
  providers: ProviderRow[];
}
interface SnapshotRow {
  provider: string;
  model: string | null;
  window_label: string;
  used_pct: number;
  resets_at: number | null;
  observed_at: string;
  source_kind: string;
}
interface WarningRow {
  code: string;
  provider: string;
  window_label: string;
}
interface PressureBody {
  snapshots: SnapshotRow[];
  warnings: WarningRow[];
}
interface ErrorBody {
  error: { code: string };
}

describe("GET /usage/recent", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("returns RecentCostOutput shape", async () => {
    insertUsageRow(db, {
      event_id: "1",
      ts: "2026-04-28T12:00:00Z",
      provider: "anthropic",
      cost_usd: 0.5,
      used: 1000,
      handoff_id: "h1",
    });
    const services = makeServices(db);
    const req = new Request("http://x/usage/recent?since=2026-04-28T00:00:00Z");
    const res = usageRecentRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecentBody;
    expect(body.total_cost_usd).toBe(0.5);
    expect(body.by_provider).toHaveLength(1);
  });

  it("returns 400 on malformed since", async () => {
    const services = makeServices(db);
    const req = new Request("http://x/usage/recent?since=not-a-date");
    const res = usageRecentRoute(req, services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_params");
  });
});

describe("GET /usage/quota_status", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("returns QuotaStatusOutput shape with configured providers and subtracts billed usage", async () => {
    insertUsageRow(db, {
      event_id: "1",
      ts: "2026-04-28T12:00:00Z",
      provider: "anthropic",
      cost_usd: 12.4,
      used: 12000,
      handoff_id: "h1",
      lane: "cloud",
    });
    const services = makeServices(db, [{ provider: "anthropic", quota_usd_per_24h: 50 }]);
    const req = new Request("http://x/usage/quota_status?since=2026-04-28T00:00:00Z");
    const res = usageQuotaStatusRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as QuotaBody;
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].remaining_usd).toBe(37.6);
    expect(body.providers[0].used_usd).toBe(12.4);
  });

  it("returns 400 on malformed since", () => {
    const services = makeServices(db);
    const req = new Request("http://x/usage/quota_status?since=garbage");
    const res = usageQuotaStatusRoute(req, services);
    expect(res.status).toBe(400);
  });

  it("accepts window=5h", () => {
    insertUsageRow(db, {
      event_id: "2",
      ts: "2026-04-28T12:00:00Z",
      provider: "google",
      cost_usd: null,
      used: 12,
      handoff_id: "h2",
    });
    const services = makeServices(db, [{ provider: "google", quota_tokens_per_5h: 100 }]);
    const req = new Request("http://x/usage/quota_status?since=2026-04-28T00:00:00Z&window=5h");
    const res = usageQuotaStatusRoute(req, services);
    expect(res.status).toBe(200);
  });

  it("accepts window=7d", async () => {
    insertUsageRow(db, {
      event_id: "3",
      ts: "2026-08-28T00:00:00Z",
      provider: "alibaba",
      cost_usd: null,
      used: 700,
      handoff_id: "h3",
    });
    const services = makeServices(db, [{ provider: "alibaba", quota_tokens_per_7d: 7_000_000 }]);
    const req = new Request("http://x/usage/quota_status?since=2026-08-26T15:53:00Z&window=7d");
    const res = usageQuotaStatusRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as QuotaBody;
    expect(body.providers[0].quota_tokens).toBe(7_000_000);
  });

  it("returns 400 on unknown window", () => {
    const services = makeServices(db, [{ provider: "google", quota_tokens_per_5h: 100 }]);
    const req = new Request("http://x/usage/quota_status?window=foo");
    const res = usageQuotaStatusRoute(req, services);
    expect(res.status).toBe(400);
  });
});

describe("GET /usage/subscription_pressure", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("returns PressureResult shape with populated snapshots", async () => {
    insertSnapshotRow(db, {
      event_id: "1",
      ts: "2026-05-07T12:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 15,
      resets_at: 1778163000,
      source_kind: "local-state-claude-statusline",
    });

    const services = makeServices(db);
    const req = new Request("http://x/usage/subscription_pressure");
    const res = usageSubscriptionPressureRoute(req, services);

    expect(res.status).toBe(200);
    const body = (await res.json()) as PressureBody;
    expect(body.snapshots).toEqual([
      {
        provider: "anthropic-claude",
        model: null,
        window_label: "five_hour",
        used_pct: 15,
        resets_at: 1778163000,
        observed_at: "2026-05-07T12:00:00Z",
        source_kind: "local-state-claude-statusline",
      },
    ]);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatchObject({
      code: "stale_snapshot",
      provider: "anthropic-claude",
      window_label: "five_hour",
    });
  });

  it("returns 400 on invalid stale_after_seconds", async () => {
    const services = makeServices(db);
    const req = new Request("http://x/usage/subscription_pressure?stale_after_seconds=0");
    const res = usageSubscriptionPressureRoute(req, services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_params");
  });

  it("filters snapshots by provider", async () => {
    insertSnapshotRow(db, {
      event_id: "1",
      ts: "2026-05-07T12:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 15,
      resets_at: 1778163000,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "2",
      ts: "2026-05-07T12:01:00Z",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 25,
      resets_at: 1778164000,
      source_kind: "local-state-codex-rollout",
    });

    const services = makeServices(db);
    const req = new Request("http://x/usage/subscription_pressure?provider=anthropic-claude");
    const res = usageSubscriptionPressureRoute(req, services);

    expect(res.status).toBe(200);
    const body = (await res.json()) as PressureBody;
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].provider).toBe("anthropic-claude");
  });
});
