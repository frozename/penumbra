import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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

1. **High — Database schema change was deployed without rollback plan** (architect).
2. **Medium — Missing test coverage for the new recall endpoint** (architect).
3. **Low — Log statement left in production code path** (simplicity).

`;

  writeFileSync(join(reviewDir, 'synthesis.md'), synthesis, 'utf8');

  const stubChat: SiriusChatFn = async () =>
    JSON.stringify([
      { findingId: 'finding-1', classification: 'recall_miss', reason: 'stubbed classification' },
      { findingId: 'finding-2', classification: 'memory_ignored', reason: 'stubbed classification' },
      { findingId: 'finding-3', classification: 'not_memory_related', reason: 'stubbed classification' },
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
  expect(recent.recent.some(row => row.classification === 'recall_miss' && row.severity === 'High')).toBe(true);

  const cached = db
    .query<{ raw_response_json: string | null }, []>('SELECT raw_response_json FROM memory_efficacy_cache ORDER BY ts DESC LIMIT 1')
    .get();
  expect(cached?.raw_response_json).toContain('"classification":"recall_miss"');

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

test('parseFindings handles bolded severity findings and bare bold titles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'penumbra-efficacy-parse-coverage-'));
  const reviewDir = join(root, '.penumbra', 'reviews', '2026-05-14T01-00-49');
  mkdirSync(reviewDir, { recursive: true });

  const synthesis = `# Synthesis

## Severity-ranked findings

1. **High — Em-dash title** (architect).
2. **Medium - Hyphen title** (security).
3. **Bare bold title** (personas: simplicity): description.
4. **High — Premature generalization without a second concrete provider use case** (simplicity, devils_advocate).

`;

  writeFileSync(join(reviewDir, 'synthesis.md'), synthesis, 'utf8');

  const stubChat: SiriusChatFn = async () =>
    JSON.stringify([
      { findingId: 'finding-1', classification: 'recall_miss', reason: 'stubbed classification' },
      { findingId: 'finding-2', classification: 'memory_ignored', reason: 'stubbed classification' },
      { findingId: 'finding-3', classification: 'not_memory_related', reason: 'stubbed classification' },
      { findingId: 'finding-4', classification: 'missed_registration', reason: 'stubbed classification' },
    ]);

  const db = freshDb();
  const result = await buildMemoryEfficacyCache(db, {
    reviewsDir: join(root, '.penumbra', 'reviews'),
    siriusChat: stubChat,
    model: 'test',
  });

  expect(result.scanned).toBe(4);
  expect(result.classified).toBe(4);
  expect(result.skipped).toBe(0);

  const rows = db
    .query<{ finding_text: string; severity: string | null }, []>(
      `SELECT finding_text, severity FROM memory_efficacy_cache ORDER BY finding_index ASC`,
    )
    .all();

  expect(rows).toEqual([
    { finding_text: 'Em-dash title(architect).', severity: 'High' },
    { finding_text: 'Hyphen title(security).', severity: 'Medium' },
    { finding_text: 'Bare bold title(personas: simplicity): description.', severity: null },
    {
      finding_text: 'Premature generalization without a second concrete provider use case(simplicity, devils_advocate).',
      severity: 'High',
    },
  ]);

  rmSync(root, { recursive: true, force: true });
});

test('parseFindings handles real synthesis envelopes and live review smoke', async () => {
  const root = mkdtempSync(join(tmpdir(), 'penumbra-efficacy-real-format-'));
  const reviewDir = join(root, '.penumbra', 'reviews', '2026-05-14T01-00-49');
  mkdirSync(reviewDir, { recursive: true });

  const synthesis = `Land with revisions: short adjudication.

**Shared concerns**
1. Concern alpha.

**Contradictions**
1. Disagreement.

**Severity-ranked findings**
1. **High — First finding** (architect).
2. **Medium — Second finding** (security).
3. **Low — Third finding** (simplicity).

**Recommended actions**
1. Action one.

**Skipped/failed personas**
1. None.
`;

  writeFileSync(join(reviewDir, 'synthesis.md'), synthesis, 'utf8');

  const stubChat: SiriusChatFn = async () =>
    JSON.stringify([
      { findingId: 'finding-1', classification: 'recall_miss', reason: 'stubbed classification' },
      { findingId: 'finding-2', classification: 'memory_ignored', reason: 'stubbed classification' },
      { findingId: 'finding-3', classification: 'not_memory_related', reason: 'stubbed classification' },
    ]);

  const db = freshDb();
  const result = await buildMemoryEfficacyCache(db, {
    reviewsDir: join(root, '.penumbra', 'reviews'),
    siriusChat: stubChat,
    model: 'test',
  });

  expect(result.scanned).toBe(3);
  expect(result.classified).toBe(3);
  expect(result.skipped).toBe(0);

  const rows = db
    .query<{ finding_text: string; severity: string | null }, []>(
      `SELECT finding_text, severity FROM memory_efficacy_cache ORDER BY finding_index ASC`,
    )
    .all();
  expect(rows).toEqual([
    { finding_text: 'First finding(architect).', severity: 'High' },
    { finding_text: 'Second finding(security).', severity: 'Medium' },
    { finding_text: 'Third finding(simplicity).', severity: 'Low' },
  ]);

  const realReviewsDir = '/Volumes/WorkSSD/repos/penumbra-worktrees/97722ed3-73ce-42cd-8cd6-aa46cd814ea6/.penumbra/reviews';
  if (existsSync(realReviewsDir)) {
    const dirs = readdirSync(realReviewsDir).filter((d) => /^\d{4}/.test(d));
    let withFindings = 0;
    for (const d of dirs) {
      const syn = join(realReviewsDir, d, 'synthesis.md');
      if (!existsSync(syn)) continue;
      const tempRoot = mkdtempSync(join(tmpdir(), 'penumbra-efficacy-smoke-'));
      const td = join(tempRoot, '.penumbra', 'reviews', d);
      mkdirSync(td, { recursive: true });
      writeFileSync(join(td, 'synthesis.md'), readFileSync(syn, 'utf8'));
      const r = await buildMemoryEfficacyCache(freshDb(), {
        reviewsDir: join(tempRoot, '.penumbra', 'reviews'),
        siriusChat: async () => '[]',
        model: 'test',
      });
      if (r.scanned > 0) withFindings += 1;
      rmSync(tempRoot, { recursive: true, force: true });
    }
    expect(withFindings).toBeGreaterThan(dirs.length * 0.5);
  }

  rmSync(root, { recursive: true, force: true });
});

test('getMemoryEfficacyRecent includes raw response only when requested', async () => {
  const db = freshDb();
  db.query(
    `INSERT INTO memory_efficacy_cache (
      finding_id, synthesis_path, ts, finding_index, finding_text,
      severity, classification, classifier_model, classified_at, raw_response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'finding-1',
    '/tmp/synthesis.md',
    '2026-05-01T12:00:00Z',
    1,
    'Example finding',
    'High',
    'recall_miss',
    'test-model',
    '2026-05-01T12:01:00Z',
    '{"classification":"recall_miss"}',
  );

  const defaultRecent = getMemoryEfficacyRecent(db, { sinceISO: '1970-01-01T00:00:00Z', limit: 10 });
  expect(defaultRecent.recent[0]?.raw_response).toBeUndefined();

  const rawRecent = getMemoryEfficacyRecent(db, {
    sinceISO: '1970-01-01T00:00:00Z',
    limit: 10,
    includeRaw: true,
  });
  expect(rawRecent.recent[0]?.raw_response).toBe('{"classification":"recall_miss"}');
});

test('buildMemoryEfficacyCache preserves classifications for same-index findings from different files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'penumbra-efficacy-collisions-'));
  const reviewsDir = join(root, '.penumbra', 'reviews');
  const firstDir = join(reviewsDir, '2026-05-01T12-00-00');
  const secondDir = join(reviewsDir, '2026-05-02T12-00-00');
  mkdirSync(firstDir, { recursive: true });
  mkdirSync(secondDir, { recursive: true });

  writeFileSync(join(firstDir, 'synthesis.md'), `# Synthesis\n\n## Severity-ranked findings\n\n1. **High — First file finding** (architect).\n`, 'utf8');
  writeFileSync(join(secondDir, 'synthesis.md'), `# Synthesis\n\n## Severity-ranked findings\n\n1. **Low — Second file finding** (architect).\n`, 'utf8');

  const stubChat: SiriusChatFn = async () =>
    JSON.stringify([
      { findingId: 'finding-a', classification: 'recall_miss', reason: 'stubbed classification' },
      { findingId: 'finding-b', classification: 'memory_ignored', reason: 'stubbed classification' },
    ]);

  const db = freshDb();
  const result = await buildMemoryEfficacyCache(db, {
    reviewsDir,
    siriusChat: stubChat,
    model: 'test',
    sinceISO: '1970-01-01T00:00:00Z',
  });

  expect(result.scanned).toBe(2);
  expect(result.classified).toBe(2);
  expect(result.skipped).toBe(0);

  const rows = db.query<{
    finding_text: string;
    classification: string;
  }, []>(
    `SELECT finding_text, classification FROM memory_efficacy_cache ORDER BY finding_text ASC`,
  ).all();
  expect(rows).toEqual([
    { finding_text: 'First file finding(architect).', classification: 'recall_miss' },
    { finding_text: 'Second file finding(architect).', classification: 'memory_ignored' },
  ]);

  rmSync(root, { recursive: true, force: true });
});
