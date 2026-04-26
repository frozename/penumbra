import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded in this process
}
import { migrate } from '../../src/db/migrations.js';
import { HandoffWriter } from '../../src/writers/handoff.js';
import { HandoffReader } from '../../src/readers/handoff.js';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js'; // Ensure to load vector extension if required by tests!

let db: Database;
let reader: HandoffReader;
let writer: HandoffWriter;

beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db); // Required because schema has vector indexes now
  migrate(db, { embeddingDim: 384 });
  writer = new HandoffWriter({ db });
  reader = new HandoffReader({ db });
});

const sampleParams = (id: string, conv: string) => ({
  handoff_id: id, ts: `2026-04-25T20:00:0${id.slice(-1)}.000Z`,
  from: 'claude', to: 'gemini', to_role: null,
  message: `m-${id}`, conversation_id: conv, project_id: null,
  triggered_by_event_id: `e-${id}`,
});

test('listPending returns only pending handoffs, oldest first', () => {
  writer.create(sampleParams('h-1', 'c-a'));
  writer.create(sampleParams('h-2', 'c-a'));
  writer.create(sampleParams('h-3', 'c-b'));
  writer.approve('h-2', { resolved_by: 'u', resolved_at: 't' });

  const all = reader.listPending();
  expect(all.map((h) => h.handoff_id)).toEqual(['h-1', 'h-3']);
});

test('listPending filters by conversation_id when provided', () => {
  writer.create(sampleParams('h-1', 'c-a'));
  writer.create(sampleParams('h-2', 'c-b'));

  const inA = reader.listPending({ conversation_id: 'c-a' });
  expect(inA.map((h) => h.handoff_id)).toEqual(['h-1']);
});

test('get returns the row by id, or null', () => {
  writer.create(sampleParams('h-1', 'c-a'));
  expect(reader.get('h-1')?.handoff_id).toBe('h-1');
  expect(reader.get('missing')).toBeNull();
});

test('listByStatus returns rows matching any of the given statuses, ordered by ts', () => {
  writer.create({ ...sampleParams('h-1', 'c-1'), ts: '2026-04-26T00:00:01Z' });
  writer.create({ ...sampleParams('h-2', 'c-1'), ts: '2026-04-26T00:00:02Z' });
  writer.create({ ...sampleParams('h-3', 'c-2'), ts: '2026-04-26T00:00:03Z' });
  writer.approve('h-2', { resolved_by: 'u', resolved_at: '2026-04-26T00:00:10Z' });

  const pending = reader.listByStatus({ statuses: ['pending'] });
  expect(pending.map((r) => r.handoff_id)).toEqual(['h-1', 'h-3']);

  const both = reader.listByStatus({ statuses: ['pending', 'approved'] });
  expect(both.map((r) => r.handoff_id)).toEqual(['h-1', 'h-2', 'h-3']);
});

test('listByStatus filters by conversation_id when given', () => {
  writer.create({ ...sampleParams('h-1', 'cA'), ts: '2026-04-26T00:00:01Z' });
  writer.create({ ...sampleParams('h-2', 'cB'), ts: '2026-04-26T00:00:02Z' });

  const r = reader.listByStatus({ statuses: ['pending'], conversation_id: 'cA' });
  expect(r.map((x) => x.handoff_id)).toEqual(['h-1']);
});

test('listByStatus rejects empty status list', () => {
  expect(() => reader.listByStatus({ statuses: [] })).toThrow();
});
