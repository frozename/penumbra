import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryRows, upsertRow } from '../src/store/sqlite.ts';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-eval-store-'));
  dirs.push(dir);
  return new Database(join(dir, 'eval.sqlite'));
}

test('upsertRow inserts and updates leaderboard rows', () => {
  const db = tempDb();
  upsertRow(db, {
    model_id: 'gemma',
    node: 'local',
    ub: 512,
    throughput_tps: 12,
    tool_call_score: 0.5,
    context_8k_score: 0.6,
    context_16k_score: 0.4,
    json_score: 0.7,
    composite_score: 0.53,
    source: 'run-1',
  });
  upsertRow(db, {
    model_id: 'gemma',
    node: 'local',
    ub: 512,
    throughput_tps: 20,
    tool_call_score: 0.6,
    context_8k_score: 0.7,
    context_16k_score: 0.5,
    json_score: 0.8,
    composite_score: 0.66,
    source: 'run-2',
  });

  const rows = queryRows(db, {});
  expect(rows).toHaveLength(1);
  expect(rows[0].throughput_tps).toBe(20);
  expect(rows[0].source).toBe('run-2');
});

test('queryRows filters by node and score thresholds', () => {
  const db = tempDb();
  upsertRow(db, {
    model_id: 'a',
    node: 'local',
    ub: 512,
    throughput_tps: 11,
    tool_call_score: 0.91,
    context_8k_score: 0.2,
    context_16k_score: 0.2,
    json_score: 0.2,
    composite_score: 0.5,
    source: 'x',
  });
  upsertRow(db, {
    model_id: 'b',
    node: 'remote',
    ub: 256,
    throughput_tps: 25,
    tool_call_score: 0.4,
    context_8k_score: 0.8,
    json_score: 0.9,
    composite_score: 0.7,
    source: 'y',
  });

  const rows = queryRows(db, { node: 'local', min_throughput: 10, min_tool_call_score: 0.9, sort_by: 'throughput_tps' });
  expect(rows).toHaveLength(1);
  expect(rows[0].model_id).toBe('a');
});
