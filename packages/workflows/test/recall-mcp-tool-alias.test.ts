import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { composeRecall } from '../src/recall.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test('mcp.tool buckets expose the bare tool name alias', async () => {
  const db = makeDb();
  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: '.',
    project: 'demo',
    sources: [
      {
        source: 'mcp.tool',
        args: { tool: 'memory.search', input: { query: 'q' } },
      },
    ],
    invokeMcpTool: async () => ({ hits: [{ id: 'x' }] }),
  });

  expect(bundle.byKey['memory.search']).toEqual({ hits: [{ id: 'x' }] });
  expect(bundle.byKey['mcp.tool.memory.search']).toBeUndefined();
});

test('mcp.tool falls back to the prefixed bucket for non-aliased tools', async () => {
  const db = makeDb();
  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: '.',
    project: 'demo',
    sources: [
      {
        source: 'mcp.tool',
        args: { tool: 'chain.list_agents' },
      },
    ],
    invokeMcpTool: async () => ({ hits: [{ id: 'x' }] }),
  });

  expect(bundle.byKey['mcp.tool.chain.list_agents']).toEqual({ hits: [{ id: 'x' }] });
  expect(bundle.byKey['chain.list_agents']).toBeUndefined();
});
