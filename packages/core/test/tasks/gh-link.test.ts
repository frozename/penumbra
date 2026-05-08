import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { TaskWriter } from '../../src/tasks/writer.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function freshDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

describe('TaskWriter gh issue linking', () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  test('linkGhIssue + findByGhIssue round-trip', () => {
    const { task_id } = writer.file({
      prompt: 'wire github task sync',
      created_by_kind: 'human',
      created_by_id: 'cli',
    });

    writer.linkGhIssue(task_id, { repo: 'acordeiro/penumbra', issue_number: 123 });

    const found = writer.findByGhIssue('acordeiro/penumbra', 123);
    expect(found?.id).toBe(task_id);
    expect(found?.gh_issue_repo).toBe('acordeiro/penumbra');
    expect(found?.gh_issue_number).toBe(123);
  });

  test('unlinkGhIssue clears gh_issue_repo and gh_issue_number', () => {
    const { task_id } = writer.file({
      prompt: 'remove gh link',
      created_by_kind: 'human',
      created_by_id: 'cli',
    });
    writer.linkGhIssue(task_id, { repo: 'acordeiro/penumbra', issue_number: 321 });

    writer.unlinkGhIssue(task_id);

    const row = writer.get(task_id);
    expect(row.gh_issue_repo).toBeNull();
    expect(row.gh_issue_number).toBeNull();
  });
});
