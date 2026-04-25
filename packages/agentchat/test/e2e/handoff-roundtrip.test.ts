import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, HandoffWriter, HandoffReader, loadSqliteVec, migrate } from '@penumbra/core';
import { handoffsCreateRoute, handoffsApproveRoute, handoffsListPendingRoute } from '../../../daemon/src/routes/handoffs.js';
import { runChatTurn } from '../../src/cli/loop.js';
import { registerAdapter } from '../../src/adapters/registry.js';
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
  const services = {
    db, handoffWriter: writer, handoffReader: reader,
    machineId: { get: () => 'test' }, uuid: () => crypto.randomUUID(),
    clock: () => new Date(), t0Writer: { write: () => {} },
    redactor: { redact: (s: any) => s }, log: { info: () => {}, warn: () => {} },
  } as any;

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
  });
  expect(planTurn.next_mention?.target).toBe('executor');
  expect(planTurn.next_mention?.resolution.kind).toBe('role');

  // 2) Create the handoff via the route
  const created = await (await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'planner', to: 'gemini', to_role: 'executor',
      message: planTurn.text, conversation_id: 'c-e2e', project_id: 'auth',
      triggered_by_event_id: 'evt-trigger',
    }),
  }), services)).json();
  expect(created.status).toBe('pending');

  // 3) Approve it
  const approved = await (await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    created.handoff_id, services,
  )).json();
  expect(approved.status).toBe('approved');

  // 4) Verify pending list is empty
  const list = await (await handoffsListPendingRoute(new Request('http://x/handoffs/pending'), services)).json();
  expect(list.handoffs.length).toBe(0);

  // 5) Executor runs against the planner's message
  const execTurn = await runChatTurn({
    config, initialAgent: 'gemini',
    userMessage: planTurn.text,
    conversation: { id: 'c-e2e', project_id: 'auth' },
  });
  expect(execTurn.text).toContain('done:');
});