import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded in this process
}
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { T0Writer } from '../../src/writers/t0.js';
import { T0EventSchema } from '../../src/schemas/event.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

const sample = T0EventSchema.parse({
  event_id: 'e1',
  ts: '2026-04-23T11:59:59.000Z',
  ingest_ts: '2026-04-23T12:00:00.000Z',
  source: 'mcp',
  source_detail: 'claude-code',
  project_id: null,
  user_id: 'u',
  machine_id: 'm',
  session_id: 's',
  event_type: 'agent-tool-use',
  lane: 'local',
  provider: null,
  model: null,
  tokens_in: null,
  tokens_out: null,
  cost_usd: null,
  latency_ms: null,
  request_id: null,
  payload_json: { tool: 'Read' },
  payload_summary: 'Read src/x.ts',
});

test('writes a row and is retrievable', () => {
  const w = new T0Writer(db);
  w.write(sample);
  const row = db
    .query<{ event_id: string; payload_json: string }, [string]>(
      'SELECT event_id, payload_json FROM t0_events WHERE event_id=?',
    )
    .get('e1');
  expect(row?.event_id).toBe('e1');
  expect(JSON.parse(row!.payload_json)).toEqual({ tool: 'Read' });
});

test('insert of duplicate event_id fails loud', () => {
  const w = new T0Writer(db);
  w.write(sample);
  expect(() => w.write(sample)).toThrow();
});
