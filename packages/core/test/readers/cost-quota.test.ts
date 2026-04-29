import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { quotaStatus } from '../../src/readers/cost-quota.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
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

function insertUsageRow(db: Database, row: { event_id: string; ts: string; provider: string; cost_usd: number | null; used: number; handoff_id: string | null; }) {
  db.prepare(`
    INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, cost_usd, payload_json)
    VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription', ?, ?, ?)
  `).run(row.event_id, row.ts, row.ts, row.provider, row.cost_usd, JSON.stringify({ handoff_id: row.handoff_id, used: row.used }));
}

describe('quotaStatus', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it('computes remaining_usd and pct correctly when both quota and usage are present', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 12.40, used: 12000, handoff_id: 'h1' });
    const out = quotaStatus(
      db,
      [{ provider: 'anthropic', quota_usd_per_24h: 50.00 }],
      { since: '2026-04-28T00:00:00Z' },
      () => new Date('2026-04-28T13:00:00Z'),
    );
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0]).toMatchObject({
      provider: 'anthropic',
      used_usd: 12.40,
      quota_usd: 50.00,
      remaining_usd: 37.60,
      remaining_pct_usd: 75.2,
    });
  });

  it('uses token-side fields when only quota_tokens_per_24h is configured', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'openai', cost_usd: null, used: 250000, handoff_id: 'h1' });
    const out = quotaStatus(
      db,
      [{ provider: 'openai', quota_tokens_per_24h: 1_000_000 }],
      { since: '2026-04-28T00:00:00Z' },
      () => new Date('2026-04-28T13:00:00Z'),
    );
    expect(out.providers[0].quota_usd).toBeNull();
    expect(out.providers[0].used_tokens).toBe(250000);
    expect(out.providers[0].quota_tokens).toBe(1_000_000);
    expect(out.providers[0].remaining_tokens).toBe(750000);
    expect(out.providers[0].remaining_pct_tokens).toBe(75.0);
  });

  it('returns 0 used + full quota remaining for a provider with config but no usage', () => {
    const out = quotaStatus(
      db,
      [{ provider: 'google', quota_usd_per_24h: 25 }],
      { since: '2026-04-28T00:00:00Z' },
      () => new Date('2026-04-28T13:00:00Z'),
    );
    expect(out.providers[0].used_usd).toBe(0);
    expect(out.providers[0].remaining_usd).toBe(25);
    expect(out.providers[0].remaining_pct_usd).toBe(100);
  });

  it('omits providers from response when no quota is configured', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'unknown', cost_usd: 1, used: 100, handoff_id: 'h1' });
    const out = quotaStatus(
      db,
      [{ provider: 'anthropic', quota_usd_per_24h: 50 }],
      { since: '2026-04-28T00:00:00Z' },
      () => new Date('2026-04-28T13:00:00Z'),
    );
    expect(out.providers.map(p => p.provider)).toEqual(['anthropic']);
  });
});
