import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { applySchema, SCHEMA_VERSION } from '@penumbra/core/db/schema';

function fresh() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

describe('long-lived schema (v15)', () => {
  it('SCHEMA_VERSION is at least 15', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
  });

  it('applySchema creates all five long_lived_* tables', () => {
    const db = fresh();
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'long_lived_%' ORDER BY name",
    ).all().map((r) => r.name);
    expect(tables).toEqual([
      'long_lived_action_audit',
      'long_lived_agents',
      'long_lived_cooldowns',
      'long_lived_pending_actions',
      'long_lived_ticks',
    ]);
  });

  it('applySchema includes long-lived dispatch identity columns on handoffs', () => {
    const db = fresh();
    const cols = db.query<{ name: string }, []>(
      "PRAGMA table_info('handoffs')",
    ).all().map((c) => c.name);
    expect(cols).toContain('dispatch_kind');
    expect(cols).toContain('long_lived_agent_id');
    expect(cols).toContain('long_lived_tick_id');
  });

  it('long_lived_agents has expected NOT NULL columns', () => {
    const db = fresh();
    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info('long_lived_agents')",
    ).all();
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.id.type).toBe('TEXT');
    expect(byName.status.notnull).toBe(1);
    expect(byName.consecutive_failures.notnull).toBe(1);
    expect(byName.circuit_breaker_threshold.notnull).toBe(1);
    expect(byName.mcp_allowlist_json.notnull).toBe(1);
    expect(byName.approval_required_globs_json.notnull).toBe(1);
    expect(byName.cooldown_overrides_json.notnull).toBe(1);
    expect(byName.working_memory_json.notnull).toBe(1);
    expect(byName.standing_brief.notnull).toBe(1);
  });

  it('has the expected indexes', () => {
    const db = fresh();
    const idx = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_long_lived_%' ORDER BY name",
    ).all().map((r) => r.name);
    expect(idx).toEqual([
      'idx_long_lived_action_audit_lookup',
      'idx_long_lived_pending_actions_lookup',
      'idx_long_lived_ticks_by_agent',
    ]);
  });

  it('applySchema is idempotent (second call does not throw)', () => {
    const db = fresh();
    expect(() => applySchema(db, { embeddingDim: 384 })).not.toThrow();
  });
});
