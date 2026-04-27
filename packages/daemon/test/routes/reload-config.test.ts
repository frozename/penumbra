import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { reloadConfigRoute } from '../../src/routes/reload-config.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function tempServices(opts?: { agentRegistry?: string[] | null }): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {}, input: {}, storageRoot: '/tmp/reload-config-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: Object.assign(() => new Date('2026-04-26T00:00:00Z'), {
      toISOString: () => '2026-04-26T00:00:00.000Z',
      now: () => 1714089600000,
    }),
    uuid: () => `id-${++n}`,
    agentRegistry: opts?.agentRegistry ?? ['planner', 'executor'],
  });
  return services;
}

test('POST /agentchat/reload replaces agentRegistry and returns info', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat.yaml');
  
  writeFileSync(yamlPath, `
  agents:
  - name: test-agent-1
    adapter: mock
  - name: test-agent-2
    adapter: mock
  `);
  process.env.AGENTCHAT_CONFIG = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agent_count).toBe(2);
    expect(body.reloaded_at).toBe('2026-04-26T00:00:00.000Z');
    
    expect(services.agentRegistry).toEqual(['test-agent-1', 'test-agent-2']);
  } finally {
    delete process.env.AGENTCHAT_CONFIG;
    unlinkSync(yamlPath);
  }
});

test('POST /agentchat/reload returns 422 if file missing', async () => {
  const services = tempServices();
  process.env.AGENTCHAT_CONFIG = '/tmp/does-not-exist.yaml';
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('not found');
    expect(services.agentRegistry).toEqual(['planner', 'executor']); // untouched
  } finally {
    delete process.env.AGENTCHAT_CONFIG;
  }
});

test('POST /agentchat/reload returns 422 and does not swap if yaml invalid', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-invalid.yaml');
  
  writeFileSync(yamlPath, `
agents:
  - no_name: true
`);

  process.env.AGENTCHAT_CONFIG = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('agentchat config invalid');
    expect(services.agentRegistry).toEqual(['planner', 'executor']); // untouched
  } finally {
    delete process.env.AGENTCHAT_CONFIG;
    unlinkSync(yamlPath);
  }
});
