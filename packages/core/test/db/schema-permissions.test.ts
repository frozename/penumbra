import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, loadSqliteVec } from '../../src/index.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

test('permission_requests table exists with expected columns', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const cols = db.query<{ name: string; type: string; notnull: number }, []>(
    `SELECT name, type, "notnull" FROM pragma_table_info('permission_requests')`,
  ).all();
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  for (const required of [
    'permission_id', 'parent_handoff_id', 'conversation_id',
    'agent_name', 'tool_name', 'raw_input_json',
    'status', 'remember_scope', 'decision_reason', 'decided_by',
    'ttl_at', 'created_at', 'decided_at',
  ]) {
    expect(byName[required]).toBeDefined();
  }
  expect(byName.permission_id?.type).toBe('TEXT');
  // PK column is implicitly NOT NULL in sqlite even though notnull=0 in pragma.
  expect(byName.parent_handoff_id?.notnull).toBe(1);
  expect(byName.status?.notnull).toBe(1);
  expect(byName.ttl_at?.notnull).toBe(1);
});

test('permission_requests indexes exist', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const indexes = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='permission_requests'`,
  ).all().map((r) => r.name);
  expect(indexes).toContain('idx_perm_status_conv');
  expect(indexes).toContain('idx_perm_parent');
  expect(indexes).toContain('idx_perm_ttl');
});
