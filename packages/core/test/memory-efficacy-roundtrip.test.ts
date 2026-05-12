import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqliteVec } from '../src/db/sqlite-vec.js';
import { applySchema } from '../src/db/schema.js';
import { getMemoryEfficacyRecent, buildMemoryEfficacyCache } from '../src/readers/memory-efficacy.js';
import type { SiriusChatFn } from '../src/services/sirius-chat.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded in this process
}

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

test('buildMemoryEfficacyCache classifies findings and getMemoryEfficacyRecent reads them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'penumbra-efficacy-'));
  const ts = '2026-05-01T12:00:00Z';
  const reviewDir = join(root, '.penumbra', 'reviews', '2026-05-01T12-00-00');
  mkdirSync(reviewDir, { recursive: true });

  const synthesis = `# Synthesis

## Severity-ranked findings

1. [High] Database schema change was deployed without rollback plan
2. [Medium] Missing test coverage for the new recall endpoint
3. [Low] Log statement left in production code path

## Summary

Three issues found during review.
`;

  writeFileSync(join(reviewDir, 'synthesis.md'), synthesis, 'utf8');

  const stubChat: SiriusChatFn = async () =>
    JSON.stringify([
      { index: 1, classification: 'recall_miss', reason: 'No memory was recalled for this' },
      { index: 2, classification: 'memory_ignored', reason: 'Memory existed but was ignored' },
      { index: 3, classification: 'not_memory_related', reason: 'Not a memory issue' },
    ]);

  const db = freshDb();

  const result1 = await buildMemoryEfficacyCache(db, {
    reviewsDir: join(root, '.penumbra', 'reviews'),
    siriusChat: stubChat,
    model: 'test',
  });

  expect(result1.scanned).toBe(3);
  expect(result1.classified).toBe(3);
  expect(result1.skipped).toBe(0);

  const recent = getMemoryEfficacyRecent(db, { sinceISO: '1970-01-01T00:00:00Z', limit: 10 });
  expect(recent.total).toBe(3);
  expect(recent.by_class).toEqual({
    missed_registration: 0,
    recall_miss: 1,
    memory_ignored: 1,
    not_memory_related: 1,
  });
  expect(recent.recent).toHaveLength(3);

  const result2 = await buildMemoryEfficacyCache(db, {
    reviewsDir: join(root, '.penumbra', 'reviews'),
    siriusChat: stubChat,
    model: 'test',
  });
  expect(result2.scanned).toBe(3);
  expect(result2.classified).toBe(0);
  expect(result2.skipped).toBe(3);

  rmSync(root, { recursive: true, force: true });
});
