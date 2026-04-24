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
import { ProjectCache } from '../../src/identity/project-cache.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

test('upsert records a git-kind project on first sight', () => {
  const cache = new ProjectCache({
    db,
    clock: () => new Date('2026-04-23T12:00:00Z'),
  });
  cache.upsertFromResolution(
    { kind: 'git', project_id: 'abc:.', git_remote: 'git@x/y.git', git_relpath_root: '.', repo_root: '/tmp/r' },
    '/tmp/r',
  );
  const row = db
    .query<{ kind: string; git_remote: string }, [string]>(
      'SELECT kind, git_remote FROM projects WHERE project_id=?',
    )
    .get('abc:.');
  expect(row?.kind).toBe('git');
  expect(row?.git_remote).toBe('git@x/y.git');
});

test('upsert appends new path to first_seen_paths without duplicates', () => {
  const cache = new ProjectCache({
    db,
    clock: () => new Date('2026-04-23T12:00:00Z'),
  });
  const res = {
    kind: 'git' as const,
    project_id: 'abc:.',
    git_remote: 'r',
    git_relpath_root: '.',
    repo_root: '/tmp/r',
  };
  cache.upsertFromResolution(res, '/tmp/r');
  cache.upsertFromResolution(res, '/tmp/r');
  cache.upsertFromResolution(res, '/tmp/r-other');
  const row = db
    .query<{ first_seen_paths: string }, [string]>(
      'SELECT first_seen_paths FROM projects WHERE project_id=?',
    )
    .get('abc:.');
  expect(JSON.parse(row!.first_seen_paths)).toEqual(['/tmp/r', '/tmp/r-other']);
});
