import { expect, test } from 'bun:test';

// PHASE 1 LIMITATION: the bin's runAutoChain calls dispatchHandoff directly
// without going through POST /handoffs/<id>/claim, so when a worker is also
// running it can re-dispatch the same approved handoff. The spec's soft rule
// is "don't run agentchat --auto and agentchat worker against the same
// conversation simultaneously." Phase 2 routes the bin through the worker so
// claim becomes the single dispatch gate; this test will become meaningful
// then. For now it is skipped and documents the gap.
//
// TODO(phase-2): un-skip after the bin is converted to a thin SSE client.
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, createLogger, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { serve } from '@penumbra/daemon/src/serve.js';
import { PenumbraClient } from '../../src/penumbra-client.js';
import { runAutoChain } from '../../src/cli/auto-loop.js';
import { dispatchHandoff } from '../../src/cli/dispatch-handoff.js';
import { createWorkerDispatcher } from '../../src/worker/dispatcher.js';
import { startEventSource } from '../../src/worker/event-source.js';
import { registerAdapter } from '../../src/adapters/registry.js';
import type { AgentChatConfig } from '../../src/config/types.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

test.skip('PHASE 2 — bin runAutoChain and worker race to dispatch the same approved handoff; claimDispatch ensures exactly one wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-coexist-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services: Services = buildServices({
    env: {}, input: {}, storageRoot: dir, db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
  const handle = serve({ services, token: 'tok', port: 0 });
  writeFileSync(join(dir, 'port'), String(handle.port));
  writeFileSync(join(dir, 'token'), 'tok');

  registerAdapter('mock-coex', () => ({
    kind: 'mock-coex',
    async dispatch({ prompt }) { return { text: prompt.includes('From @planner') ? 'executor ok' : 'plan: @executor go' }; },
  }));
  const config: AgentChatConfig = {
    agents: [
      { name: 'planner', adapter: 'mock-coex', options: {}, roles: ['planner'], auto_approve_to: ['executor'] },
      { name: 'executor', adapter: 'mock-coex', options: {}, roles: ['executor'], auto_approve_to: [] },
    ],
    default_roles: { planner: 'planner', executor: 'executor' },
  };

  const client = new PenumbraClient({ storageRoot: dir });

  // Worker
  const dispatcher = createWorkerDispatcher({
    log: createLogger({ component: 't' }), concurrency: 1,
    claim: (id) => client.claimHandoff(id),
    dispatch: async (h) => {
      const result = await dispatchHandoff({
        handoff: h, config,
        conversation: { id: h.conversation_id, project_id: h.project_id ?? null },
        transcript: [], transcriptBudget: 4096,
        hopsSoFar: 0, maxHops: 5, trustMode: 'all',
        observe: (e) => client.observe(e),
        createHandoff: (body) => client.createHandoff(body),
        approve: (id, body) => client.approve(id, body),
      });
      try { await client.completeHandoff(h.handoff_id); } catch { /* may already be terminal */ }
      return result;
    },
  });
  const stop = startEventSource({
    client: {
      listHandoffs: (o) => client.listHandoffs(o),
      subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
    },
    statuses: ['approved', 'redirected'], pollIntervalMs: 25,
    onEvent: (row) => { void dispatcher.handle(row); },
  });

  try {
    const conv = { id: 'conv-coex-1', project_id: null };

    // Kick off via bin-style runAutoChain — it'll create+approve handoffs in-process.
    // The worker will see these via SSE/poll and may also try to dispatch.
    const binPromise = runAutoChain({
      config, initialAgent: 'planner', userMessage: 'race!', conversation: conv,
      maxHops: 3, transcriptBudget: 4096,
      observe: (e) => client.observe(e),
      createHandoff: (body) => client.createHandoff(body),
      approve: (id, body) => client.approve(id, body),
    });
    const binRes = await binPromise;

    // Allow the worker a brief window to also try to claim and lose
    await new Promise((r) => setTimeout(r, 100));

    expect(binRes.terminatedReason).toBe('no_mention');

    const responseEvents = services.db.query<{ payload_json: string }, [string]>(
      `SELECT payload_json FROM t0_events WHERE event_type='agent-response' AND session_id=?`
    ).all(conv.id);
    // Bin and worker may both observe agent-response; that's expected because the bin observes
    // its own dispatch events. The invariant is: NO handoff is dispatched twice (the bin races
    // the worker on the SAME approved handoff via claimDispatch). Verify by counting ROWS
    // that ever transitioned to 'dispatched' OR 'completed' is bounded by 1 per handoff.
    const handoffStates = services.db.query<{ status: string }, [string]>(
      `SELECT status FROM handoffs WHERE conversation_id=?`
    ).all(conv.id);
    // Every handoff ends in a terminal state; none are stuck at 'approved'.
    expect(handoffStates.every((h) => h.status === 'completed' || h.status === 'dispatched' || h.status === 'pending')).toBe(true);
    // There must be no double-dispatch: the bin logged exactly one set of agent-prompt/response per hop;
    // total agent-response rows match total bin hops (the bin is the canonical actor here because the
    // worker's claim attempts fail with 409).
    expect(responseEvents.length).toBe(binRes.hops);
  } finally {
    await stop();
    await dispatcher.idle();
    handle.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);