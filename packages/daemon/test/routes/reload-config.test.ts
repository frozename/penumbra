import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { reloadConfigRoute } from '../../src/routes/reload-config.js';
import { formatAgentChatConfigError } from '../../src/agentchat-config.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

afterEach(() => {
  delete process.env.PENUMBRA_AGENTCHAT_CONFIG;
});

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
  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
  const infoSpy = spyOn(services.log, 'info').mockImplementation(() => undefined as any);
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agent_count).toBe(2);
    expect(body.reloaded_at).toBe('2026-04-26T00:00:00.000Z');
    expect(services.agentRegistry).toEqual(['test-agent-1', 'test-agent-2']);
    expect(services.agentRouting?.role_exploration_policy).toBe('unsampled-first');
    expect(infoSpy).toHaveBeenCalledWith({ agent_count: 2, prev_count: 2 }, 'agentchat-config-reloaded');
  } finally {
    unlinkSync(yamlPath);
  }
});

test('POST /agentchat/reload swaps role exploration policy from agentchat config', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-routing.yaml');

  writeFileSync(yamlPath, `
agents:
  - name: test-agent-1
    adapter: mock
    roles: [executor]
default_roles:
  executor: test-agent-1
role_routing:
  exploration_policy: ranked-first
`);
  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(services.agentRouting?.role_exploration_policy).toBe('ranked-first');
  } finally {
    unlinkSync(yamlPath);
  }
});

test('POST /agentchat/reload returns 422 if file missing', async () => {
  const services = tempServices();
  process.env.PENUMBRA_AGENTCHAT_CONFIG = '/tmp/does-not-exist.yaml';
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('not found');
    expect(services.agentRegistry).toEqual(['planner', 'executor']); // untouched
  } finally {}
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

  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('agentchat config invalid');
    expect(services.agentRegistry).toEqual(['planner', 'executor']); // untouched
  } finally {
    unlinkSync(yamlPath);
  }
});

test('POST /agentchat/reload honors PENUMBRA_AGENTCHAT_CONFIG', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-alt.yaml');

  writeFileSync(yamlPath, `
agents:
  - name: override-agent
    adapter: mock
`);

  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(services.agentRegistry).toEqual(['override-agent']);
  } finally {
    unlinkSync(yamlPath);
  }
});

test('formatAgentChatConfigError redacts apiKey/token/secret fields', () => {
  const formatted = formatAgentChatConfigError(new Error(
    'agentchat config invalid: agents.0.options.apiKey: got "sk-live-123"; agents.1.options.token: received abc123; agents.2.options.secret: bad value',
  ));
  expect(formatted).toContain('agents.0.options.apiKey: <redacted>');
  expect(formatted).toContain('agents.1.options.token: <redacted>');
  expect(formatted).toContain('agents.2.options.secret: <redacted>');
  expect(formatted).not.toContain('sk-live-123');
  expect(formatted).not.toContain('abc123');
});
