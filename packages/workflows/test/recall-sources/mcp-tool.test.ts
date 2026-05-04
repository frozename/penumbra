import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { composeRecall } from '../../src/recall.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test('mcp.tool happy path: invoker called and result keyed by tool name', async () => {
  const db = makeDb();
  const calls: Array<{ tool: string; input: Record<string, unknown> | undefined }> = [];
  const fixed = { agents: [{ id: 'codex-acp-fast', score: 0.9 }] };

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: '.',
    project: 'demo',
    sources: [
      {
        source: 'mcp.tool',
        args: { tool: 'agent.recommend', input: { task_type: 'impl' } },
      },
    ],
    invokeMcpTool: async (tool, input) => {
      calls.push({ tool, input });
      return fixed;
    },
  });

  expect(calls).toEqual([{ tool: 'agent.recommend', input: { task_type: 'impl' } }]);
  expect(bundle.byKey['mcp.tool.agent.recommend']).toEqual(fixed);
  expect(bundle.warnings).toEqual([]);
});

test('mcp.tool no invoker: result null with warning', async () => {
  const db = makeDb();

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: '.',
    project: 'demo',
    sources: [
      { source: 'mcp.tool', args: { tool: 'agent.recommend' } },
    ],
  });

  expect(bundle.byKey['mcp.tool.agent.recommend']).toBeNull();
  expect(
    bundle.warnings.some((w) => w.includes('invokeMcpTool not provided')),
  ).toBe(true);
});

test('mcp.tool invoker throws: result null, warning includes tool and message', async () => {
  const db = makeDb();

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: '.',
    project: 'demo',
    sources: [
      { source: 'mcp.tool', args: { tool: 'agent.recommend' } },
    ],
    invokeMcpTool: async () => {
      throw new Error('boom from invoker');
    },
  });

  expect(bundle.byKey['mcp.tool.agent.recommend']).toBeNull();
  const found = bundle.warnings.find(
    (w) => w.includes('agent.recommend') && w.includes('boom from invoker'),
  );
  expect(found).toBeDefined();
});
