import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { recentCost } from '../../src/readers/cost.js';

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

function insertUsageRow(db: Database, row: {
  event_id: string;
  ts: string;
  provider: string;
  model?: string | null;
  lane?: string;
  cost_usd: number | null;
  used: number;
  handoff_id: string | null;
}) {
  db.prepare(`
    INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json)
    VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', ?, ?, ?, ?, ?)
  `).run(
    row.event_id,
    row.ts,
    row.ts,
    row.lane ?? 'cli-subscription',
    row.provider,
    row.model ?? null,
    row.cost_usd,
    JSON.stringify({ handoff_id: row.handoff_id, used: row.used }),
  );
}

describe('recentCost', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it('returns sum of max-per-handoff for a single provider', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 0.5, used: 1000, handoff_id: 'h1' });
    insertUsageRow(db, { event_id: '2', ts: '2026-04-28T12:01:00Z', provider: 'anthropic', cost_usd: 1.2, used: 2400, handoff_id: 'h1' });
    insertUsageRow(db, { event_id: '3', ts: '2026-04-28T12:02:00Z', provider: 'anthropic', cost_usd: 0.3, used: 600,  handoff_id: 'h2' });
    const out = recentCost(db, { since: '2026-04-28T00:00:00Z' }, () => new Date('2026-04-28T13:00:00Z'));
    expect(out.total_cost_usd).toBe(1.5);
    expect(out.total_cost_usd_billed).toBeNull();
    expect(out.total_cost_usd_synth).toBe(1.5);
    expect(out.total_tokens_used).toBe(3000);
    expect(out.handoff_count).toBe(2);
    expect(out.by_provider).toHaveLength(1);
    expect(out.by_provider[0].provider).toBe('anthropic');
    expect(out.by_provider[0].cost_usd).toBe(1.5);
    expect(out.by_provider[0].cost_usd_billed).toBeNull();
    expect(out.by_provider[0].cost_usd_synth).toBe(1.5);
  });

  it('groups by provider and sorts descending by cost', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 5.0,  used: 1000, handoff_id: 'h1' });
    insertUsageRow(db, { event_id: '2', ts: '2026-04-28T12:00:00Z', provider: 'google',    cost_usd: 0.50, used: 500,  handoff_id: 'h2' });
    insertUsageRow(db, { event_id: '3', ts: '2026-04-28T12:00:00Z', provider: 'openai',    cost_usd: null, used: 300,  handoff_id: 'h3' });
    const out = recentCost(db, { since: '2026-04-28T00:00:00Z' }, () => new Date('2026-04-28T13:00:00Z'));
    expect(out.by_provider.map(p => p.provider)).toEqual(['anthropic', 'google', 'openai']);
  });

  it('respects the since window', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-26T12:00:00Z', provider: 'anthropic', cost_usd: 100, used: 999, handoff_id: 'old' });
    insertUsageRow(db, { event_id: '2', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 1,   used: 100, handoff_id: 'new' });
    const out = recentCost(db, { since: '2026-04-28T00:00:00Z' }, () => new Date('2026-04-28T13:00:00Z'));
    expect(out.total_cost_usd).toBe(1);
    expect(out.handoff_count).toBe(1);
  });

  it('returns zeros for empty window', () => {
    const out = recentCost(db, { since: '2026-04-28T00:00:00Z' }, () => new Date('2026-04-28T13:00:00Z'));
    expect(out.total_cost_usd).toBeNull();
    expect(out.total_cost_usd_billed).toBeNull();
    expect(out.total_cost_usd_synth).toBeNull();
    expect(out.total_tokens_used).toBe(0);
    expect(out.handoff_count).toBe(0);
    expect(out.by_provider).toHaveLength(0);
  });

  it('partitions totals by lane into billed and synth buckets', () => {
    insertUsageRow(db, {
      event_id: 'b1',
      ts: '2026-04-28T12:00:00Z',
      provider: 'anthropic',
      lane: 'cloud',
      cost_usd: 8.5,
      used: 1200,
      handoff_id: 'h-cloud',
    });
    insertUsageRow(db, {
      event_id: 's1',
      ts: '2026-04-28T12:01:00Z',
      provider: 'anthropic',
      lane: 'cli-subscription',
      cost_usd: 2.25,
      used: 300,
      handoff_id: 'h-synth',
    });

    const out = recentCost(db, { since: '2026-04-28T00:00:00Z' }, () => new Date('2026-04-28T13:00:00Z'));
    expect(out.total_cost_usd).toBe(10.75);
    expect(out.total_cost_usd_billed).toBe(8.5);
    expect(out.total_cost_usd_synth).toBe(2.25);
    expect(out.by_provider[0]).toMatchObject({
      provider: 'anthropic',
      cost_usd: 10.75,
      cost_usd_billed: 8.5,
      cost_usd_synth: 2.25,
      handoff_count: 2,
    });
  });
});

describe('recentCost.by_provider_model', () => {
  it('aggregates token usage per (provider, model) tuple', () => {
    const db = makeDb();
    insertUsageRow(db, { event_id: 'm1', ts: '2026-04-29T11:30:00Z', provider: 'google', model: 'gemini-3-flash-preview', cost_usd: null, used: 100, handoff_id: 'r1' });
    insertUsageRow(db, { event_id: 'm2', ts: '2026-04-29T11:31:00Z', provider: 'google', model: 'gemini-3-flash-preview', cost_usd: null, used: 200, handoff_id: 'r2' });
    insertUsageRow(db, { event_id: 'm3', ts: '2026-04-29T11:32:00Z', provider: 'google', model: 'gemini-3.1-pro-preview', cost_usd: null, used: 50,  handoff_id: 'r3' });

    const out = recentCost(db, { since: '2026-04-29T11:00:00Z' }, () => new Date('2026-04-29T12:00:00Z'));
    expect(out.by_provider_model).toBeDefined();
    const flash = out.by_provider_model!.find((r) => r.model === 'gemini-3-flash-preview');
    const pro = out.by_provider_model!.find((r) => r.model === 'gemini-3.1-pro-preview');
    expect(flash).toMatchObject({ provider: 'google', model: 'gemini-3-flash-preview', handoff_count: 2, tokens_used: 300 });
    expect(pro).toMatchObject({ provider: 'google', model: 'gemini-3.1-pro-preview', handoff_count: 1, tokens_used: 50 });
  });
});
