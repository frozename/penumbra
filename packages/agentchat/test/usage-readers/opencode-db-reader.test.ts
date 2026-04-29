import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeDbReader } from '../../src/usage-readers/opencode-db-reader.js';

function makeOpencodeDb(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-db-'));
  const path = join(dir, 'opencode.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);`);
  return { db, path };
}

function insertAssistant(db: Database, id: string, time_created: number, body: any) {
  db.prepare(`INSERT INTO message VALUES (?, 'sess-1', ?, ?, ?)`).run(id, time_created, time_created, JSON.stringify(body));
}

describe('OpenCodeDbReader', () => {
  it('emits usage_deltas grouped by (provider, model) with cost_usd populated', async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, 'm1', 1777421548000, { role: 'assistant', cost: 0.0011, tokens: { total: 500, input: 100, output: 200, reasoning: 50, cache: { read: 100, write: 50 } }, modelID: 'deepseek-v4-pro', providerID: 'opencode-go' });
    insertAssistant(db, 'm2', 1777421549000, { role: 'assistant', cost: 0.0013, tokens: { total: 600, input: 150, output: 250, reasoning: 60, cache: { read: 110, write: 30 } }, modelID: 'deepseek-v4-pro', providerID: 'opencode-go' });
    db.close();
    const reader = new OpenCodeDbReader({ dbPath: path });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(r.usage_deltas[0].provider).toBe('opencode-go');
    expect(r.usage_deltas[0].model).toBe('deepseek-v4-pro');
    expect(r.usage_deltas[0].cost_usd).toBeCloseTo(0.0024, 4);
    expect(r.usage_deltas[0].tokens_input).toBe(250);
    expect(r.usage_deltas[0].tokens_output).toBe(450);
  });

  it('cursor advances by max time_created; second call returns nothing for same data', async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, 'm1', 1777421548000, { role: 'assistant', cost: 0.001, tokens: { input: 10, output: 20 }, modelID: 'x', providerID: 'p' });
    db.close();
    const reader = new OpenCodeDbReader({ dbPath: path });
    const r1 = await reader.read(null);
    expect(r1.usage_deltas).toHaveLength(1);
    const r2 = await reader.read(r1.cursor);
    expect(r2.usage_deltas).toHaveLength(0);
  });

  it('skips rows missing tokens', async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, 'm1', 1777421548000, { role: 'assistant', cost: 0, modelID: 'x', providerID: 'p' });
    insertAssistant(db, 'm2', 1777421549000, { role: 'assistant', cost: 0.5, tokens: { input: 1, output: 1 }, modelID: 'x', providerID: 'p' });
    db.close();
    const reader = new OpenCodeDbReader({ dbPath: path });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(r.usage_deltas[0].tokens_input).toBe(1);
  });

  it('returns empty when db file is absent', async () => {
    const reader = new OpenCodeDbReader({ dbPath: '/tmp/no-such-opencode.db' });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(0);
  });
});
