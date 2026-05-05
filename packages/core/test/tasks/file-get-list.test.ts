import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { TaskWriter, TaskNotFound } from '../../src/tasks/writer.js';
import type { FileTaskInput } from '../../src/tasks/schema.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
    // already loaded
  }
}

function freshDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function baseInput(overrides: Partial<FileTaskInput> = {}): FileTaskInput {
  return {
    prompt: 'do the thing',
    created_by_kind: 'human',
    created_by_id: 'cli',
    ...overrides,
  };
}

describe('TaskWriter.file + .get + .list', () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  test('file → get returns the row with hydrated JSON fields and status=pending', () => {
    const { task_id } = writer.file(baseInput({
      expected_artifacts: [{ type: 'commit' }],
    }));

    expect(task_id).toMatch(/^task_[0-9a-f-]{36}$/);

    const row = writer.get(task_id);
    expect(row.id).toBe(task_id);
    expect(row.status).toBe('pending');
    expect(row.kind).toBe('work');
    expect(row.priority).toBe('normal');
    expect(row.requires_review).toBe(false);
    expect(row.created_by_kind).toBe('human');
    expect(row.created_by_id).toBe('cli');
    expect(row.eligibility).toEqual({});
    expect(row.expected_artifacts).toEqual([{ type: 'commit' }]);
    expect(row.review_eligibility).toBeNull();
    expect(row.parent_task_id).toBeNull();
    expect(row.result_summary).toBeNull();
    expect(row.result_artifacts).toBeNull();
    expect(row.failure_reason).toBeNull();
    expect(row.chain_id).toBeNull();
    expect(typeof row.created_at).toBe('number');
    expect(row.updated_at).toBe(row.created_at);
  });

  test('file appends a task_events.kind=filed row', () => {
    const { task_id } = writer.file(baseInput());
    const events = db
      .query<{ kind: string; actor: string | null; payload_json: string | null }, [string]>(
        `SELECT kind, actor, payload_json FROM task_events WHERE task_id = ? ORDER BY id ASC`,
      )
      .all(task_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('filed');
    expect(events[0]!.actor).toBe('cli');
    expect(events[0]!.payload_json).toBeNull();
  });

  test('list({}) returns multiple tasks ordered by priority then created_at', async () => {
    const a = writer.file(baseInput({ prompt: 'a normal' })).task_id;
    await Bun.sleep(2);
    const b = writer.file(baseInput({ prompt: 'b urgent', priority: 'urgent' })).task_id;
    await Bun.sleep(2);
    const c = writer.file(baseInput({ prompt: 'c high', priority: 'high' })).task_id;
    await Bun.sleep(2);
    const d = writer.file(baseInput({ prompt: 'd low', priority: 'low' })).task_id;
    await Bun.sleep(2);
    const e = writer.file(baseInput({ prompt: 'e normal-newer' })).task_id;

    const rows = writer.list({});
    expect(rows.map(r => r.id)).toEqual([b, c, a, e, d]);
  });

  test('list({ status: pending }) filters correctly', () => {
    const t1 = writer.file(baseInput()).task_id;
    const t2 = writer.file(baseInput()).task_id;
    db.run(`UPDATE tasks SET status='cancelled' WHERE id=?`, [t2]);

    const rows = writer.list({ status: 'pending' });
    expect(rows.map(r => r.id)).toEqual([t1]);
  });

  test('list({ parent_task_id }) filters correctly', () => {
    const parent = writer.file(baseInput()).task_id;
    const child1 = writer.file(baseInput({ parent_task_id: parent })).task_id;
    const child2 = writer.file(baseInput({ parent_task_id: parent })).task_id;
    writer.file(baseInput()); // unrelated

    const rows = writer.list({ parent_task_id: parent });
    expect(rows.map(r => r.id).sort()).toEqual([child1, child2].sort());
  });

  test('list({ origin }) filters correctly', () => {
    const t1 = writer.file(baseInput({ origin: 'maestro' })).task_id;
    writer.file(baseInput({ origin: 'dispatch' }));
    writer.file(baseInput()); // null origin

    const rows = writer.list({ origin: 'maestro' });
    expect(rows.map(r => r.id)).toEqual([t1]);
  });

  test('get(unknown_id) throws TaskNotFound', () => {
    expect(() => writer.get('task_nonexistent')).toThrow(TaskNotFound);
  });

  test('get(id, { include: descendants }) returns zero descendants for fresh task', () => {
    const { task_id } = writer.file(baseInput());
    const row = writer.get(task_id, { include: ['descendants'] });
    expect(row.descendants).toEqual({ count: 0, depth: 0, ids: [] });
  });

  test('get(id, { include: descendants }) returns the right count + depth for nested tree', () => {
    const root = writer.file(baseInput()).task_id;
    const child = writer.file(baseInput({ parent_task_id: root })).task_id;
    const grand = writer.file(baseInput({ parent_task_id: child })).task_id;

    const row = writer.get(root, { include: ['descendants'] });
    expect(row.descendants!.count).toBe(2);
    expect(row.descendants!.depth).toBe(2);
    expect(row.descendants!.ids.sort()).toEqual([child, grand].sort());
  });

  test('get(id, { include: events }) returns the filed event', () => {
    const { task_id } = writer.file(baseInput());
    const row = writer.get(task_id, { include: ['events'] });
    expect(row.events).toHaveLength(1);
    expect(row.events![0]!.kind).toBe('filed');
    expect(row.events![0]!.actor).toBe('cli');
  });

  test('JSON round-trip: eligibility object survives file → get', () => {
    const { task_id } = writer.file(baseInput({
      eligibility: { required_tags: ['x'], min_tier: 'oc' },
    }));
    const row = writer.get(task_id);
    expect(row.eligibility).toEqual({ required_tags: ['x'], min_tier: 'oc' });
    expect(typeof row.eligibility).toBe('object');
  });
});
