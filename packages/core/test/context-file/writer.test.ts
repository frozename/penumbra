import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }
import { loadSqliteVec, migrate } from '../../src/index.js';
import { ContextFileWriter } from '../../src/context-file/writer.js';

let dir = '';
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-ctx-'));
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedT1(rollupId: string, projectId: string, excerpt: string, endedAt: string) {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events,
       first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
     VALUES(?, ?, 'u', ?, ?, ?, 1, ?, ?, '')`,
    [rollupId, projectId, rollupId, endedAt, endedAt, excerpt, excerpt],
  );
}

test('writes atomic latest.md with most-recent T1 rollups', () => {
  seedT1('r1', 'p1', 'first', '2026-04-23T12:00:00Z');
  seedT1('r2', 'p1', 'second', '2026-04-23T13:00:00Z');
  const writer = new ContextFileWriter({ db, storageRoot: dir, topK: 5 });
  writer.rewrite('p1');
  const path = join(dir, 'context', 'p1', 'latest.md');
  expect(existsSync(path)).toBe(true);
  const content = readFileSync(path, 'utf8');
  expect(content).toContain('second');
  expect(content.indexOf('second')).toBeLessThan(content.indexOf('first'));
  expect(content).toContain('generated_at');
});

test('empty project produces a file noting "no memories yet"', () => {
  const writer = new ContextFileWriter({ db, storageRoot: dir, topK: 5 });
  writer.rewrite('p-empty');
  const path = join(dir, 'context', 'p-empty', 'latest.md');
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('no memories yet');
});

test('rewrite uses a tmp file then renames (never leaves half-written content)', () => {
  seedT1('r1', 'p1', 'hello', '2026-04-23T12:00:00Z');
  const writer = new ContextFileWriter({ db, storageRoot: dir, topK: 5 });
  writer.rewrite('p1');
  // The tmp file must be gone after a successful rewrite.
  const tmps = readdirSync(join(dir, 'context', 'p1')).filter((f) => f.endsWith('.tmp'));
  expect(tmps.length).toBe(0);
});

test('rewrite throws RangeError when topK < 1 (SQLite LIMIT -1 returns all rows)', () => {
  const writer = new ContextFileWriter({ db, storageRoot: dir, topK: 0 });
  expect(() => writer.rewrite('p1')).toThrow(RangeError);
});

test('frontmatter JSON-quotes generated_at and projectId to survive YAML-breaking chars', () => {
  const writer = new ContextFileWriter({ db, storageRoot: dir, topK: 5 });
  const projectId = 'has "quote" and \\ backslash';
  writer.rewrite(projectId);
  const content = readFileSync(join(dir, 'context', projectId, 'latest.md'), 'utf8');
  // generated_at: ISO timestamps contain colons; must be quoted.
  expect(content).toMatch(/^generated_at: "\d{4}-\d{2}-\d{2}T[^"]+"$/m);
  // project_id: quotes and backslashes must be JSON-escaped.
  expect(content).toContain('project_id: "has \\"quote\\" and \\\\ backslash"');
});
