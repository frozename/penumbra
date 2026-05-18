import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema, HandoffWriter, HandoffReader, loadSqliteVec, migrate } from '@penumbra/core';
import { T0Writer } from '@penumbra/core';
import { createDaemonFetchHandler } from '@penumbra/daemon/src/serve.js';
import { runChatTurn } from '../../src/cli/loop.js';
import { registerAdapter } from '../../src/adapters/registry.js';
import { PenumbraClient } from '../../src/penumbra-client.js';
import type { AgentChatConfig } from '../../src/config/types.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

test('user → planner → @executor → approve → executor responds', async () => {
  // Spin up a tiny in-memory penumbra-shaped service
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const writer = new HandoffWriter({ db });
  const reader = new HandoffReader({ db });
  const t0Writer = new T0Writer(db);
  
  const services = {
    db, handoffWriter: writer, handoffReader: reader,
    machineId: { get: () => 'test' }, uuid: () => crypto.randomUUID(),
    clock: () => new Date(), t0Writer,
    redactor: { redact: (s: any) => s }, log: { info: () => {}, warn: () => {} },
    supervisor: { register: () => {}, startAll: () => {}, stopAll: () => {} },
    settings: { t1SessionIdleMinutes: 5, t1RollupIntervalSec: 60 }
  } as any;

  const token = 'test-token';
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return handler(req);
  }) as any;

  const root = mkdtempSync(join(tmpdir(), 'ac-e2e-'));
  writeFileSync(join(root, 'port'), `1\n`);
  writeFileSync(join(root, 'token'), `${token}\n`);

  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });

  // Register two fake adapters
  registerAdapter('plan-bot', () => ({
    kind: 'plan-bot',
    async dispatch() { return { text: "Plan: 1) do X. @executor please run." }; },
  }));
  registerAdapter('exec-bot', () => ({
    kind: 'exec-bot',
    async dispatch({ prompt }) { return { text: `done: ${prompt}` }; },
  }));

  const config: AgentChatConfig = {
    agents: [
      { name: 'planner', adapter: 'plan-bot', options: {}, roles: ['planner'] },
      { name: 'gemini',  adapter: 'exec-bot', options: {}, roles: ['executor'] },
    ],
    default_roles: { planner: 'planner', executor: 'gemini' },
  };

  // 1) Planner runs
  const planTurn = await runChatTurn({
    config, initialAgent: 'planner',
    userMessage: 'add rate limiting',
    conversation: { id: 'c-e2e', project_id: 'auth' },
    observe: (e) => client.observe(e),
  });
  expect(planTurn.next_mention?.target).toBe('executor');
  expect(planTurn.next_mention?.resolution.kind).toBe('role');

  // 2) Create the handoff via the route
  const created = await client.createHandoff({
    from: 'planner', to: 'gemini', to_role: 'executor',
    message: planTurn.text, conversation_id: 'c-e2e', project_id: 'auth',
    triggered_by_event_id: planTurn.response_event_id,
  });
  expect(created.status).toBe('pending');

  // 3) Approve it
  const approved = await client.approve(created.handoff_id);
  expect(approved.status).toBe('approved');

  // 4) Verify pending list is empty
  const list = await client.listPending();
  expect(list.handoffs.length).toBe(0);

  // 5) Executor runs against the planner's message
  const execTurn = await runChatTurn({
    config, initialAgent: 'gemini',
    userMessage: planTurn.text,
    conversation: { id: 'c-e2e', project_id: 'auth' },
    observe: (e) => client.observe(e),
  });
  expect(execTurn.text).toContain('done:');

  // 6) Verify T0 event was written via transaction
  const count = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM t0_events WHERE event_type='agent-handoff'"
  ).get()?.count;
  expect(count).toBe(1);

  // Verify observations were written
  const obsCount = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM t0_events WHERE event_type IN ('agent-prompt', 'agent-response')"
  ).get()?.count;
  expect(obsCount).toBe(4);

  // No live daemon to stop (in-process handler).
});
