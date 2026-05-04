import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { composeRecall } from '../src/recall.js';

test('resolves {{today}} in memory.search dateStart before SQL', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder(384),
    cwd: process.cwd(),
    project: 'test',
    sources: [{ source: 'memory.search', args: { query: 'x', dateStart: '{{today}}', limit: 1 } }],
    templateCtx: {
      now: () => new Date('2026-05-04T12:00:00Z'),
      project: 'test',
      sessionStart: '2026-05-04T10:00:00Z',
      tz: 'UTC',
    },
  });
  expect(bundle.warnings.find((w) => w.includes('{{today}}'))).toBeUndefined();
});

test('leaves args untouched when templateCtx omitted', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder(384),
    cwd: process.cwd(),
    project: 'test',
    sources: [{ source: 'fs.glob', args: { pattern: 'docs/**/*.md' } }],
  });
  expect(Array.isArray(bundle.byKey['fs.glob'])).toBe(true);
});
