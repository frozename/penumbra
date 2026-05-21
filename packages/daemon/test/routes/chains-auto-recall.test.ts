import { beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ProjectRegistry, buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { chainsStartRoute } from '../../src/routes/chains.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

// strict-mode env can leak from a live maestro shell; clear it here so test fixtures stay deterministic
beforeAll(() => { delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID; });

function tempServices(withProjectRegistry = false): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/chains-auto-recall-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    ...(withProjectRegistry ? {
      projectRegistry: new ProjectRegistry(new Map([
        ['penumbra', { project_id: 'penumbra', root_path: '/tmp/penumbra' }],
      ])),
    } : {}),
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };
  return services;
}

function getHandoff(services: Services, handoff_id: string): any {
  return services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(handoff_id);
}

function getLane(services: Services, lane_id: string): any {
  return services.db.query<any, [string]>(`SELECT * FROM lane_ledger WHERE lane_id=?`).get(lane_id);
}

test('POST /chains/start auto-recalls STANDARD context and opens a lane', async () => {
  const services = tempServices(true);
  services.recallReader.recall = async () => ([
    { id: 'm1', title: 'memo1' },
    { id: 'm2', title: 'memo2' },
    { id: 'm3', title: 'memo3' },
  ] as any);

  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'do the thing', task_class: 'STANDARD', project_id: 'penumbra' }),
  }), services);

  expect(res.status).toBe(200);
  const body = await res.json() as { lane_id: string; recalled_memory_ids: string[]; handoff_id: string };
  expect(body.lane_id).toBeTruthy();
  expect(body.recalled_memory_ids).toEqual(['m1', 'm2', 'm3']);

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message.startsWith('## Relevant prior context')).toBe(true);

  const lane = getLane(services, body.lane_id);
  expect(lane.gate_status).toBe('open');
  expect(JSON.parse(lane.recalled_memory_ids)).toEqual(['m1', 'm2', 'm3']);
});

test('POST /chains/start with TRIVIAL opens a lane and calls recall with top_k=3', async () => {
  const services = tempServices();
  const recallArgs: any[] = [];
  services.recallReader.recall = async (args) => {
    recallArgs.push(args);
    return [
      { id: 'tm1', title: 'trivial-memo' },
    ] as any;
  };

  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'trivial work', task_class: 'TRIVIAL', project_id: 'penumbra' }),
  }), services);

  expect(res.status).toBe(200);
  const body = await res.json() as { lane_id: string; recalled_memory_ids: string[]; handoff_id: string };
  expect(body.lane_id).toBeTruthy();
  expect(body.recalled_memory_ids).toEqual(['tm1']);
  expect(recallArgs).toHaveLength(1);
  expect(recallArgs[0].limit).toBe(3);

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).toContain('## Relevant prior context');

  const lane = getLane(services, body.lane_id);
  expect(JSON.parse(lane.recalled_memory_ids)).toEqual(['tm1']);
});

test('POST /chains/start proceeds when auto recall throws', async () => {
  const services = tempServices(true);
  services.recallReader.recall = async () => {
    throw new Error('sirius down');
  };

  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'do the thing', task_class: 'BOUNDARY', project_id: 'penumbra' }),
  }), services);

  expect(res.status).toBe(200);
  const body = await res.json() as { lane_id: string; handoff_id: string };
  expect(body.lane_id).toBeTruthy();

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).not.toContain('## Relevant prior context');

  const lane = getLane(services, body.lane_id);
  expect(JSON.parse(lane.recalled_memory_ids)).toEqual([]);
});

test('POST /chains/start respects PENUMBRA_AUTO_RECALL_ENABLED=false', async () => {
  const services = tempServices(true);
  const previous = process.env.PENUMBRA_AUTO_RECALL_ENABLED;
  process.env.PENUMBRA_AUTO_RECALL_ENABLED = 'false';
  let called = false;
  services.recallReader.recall = async () => {
    called = true;
    throw new Error('recall should not run when disabled');
  };

  try {
    const res = await chainsStartRoute(new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({ initial_agent: 'planner', message: 'do the thing', task_class: 'STANDARD', project_id: 'penumbra' }),
    }), services);

    expect(res.status).toBe(200);
    const body = await res.json() as { lane_id: string; handoff_id: string };
    expect(body.lane_id).toBeTruthy();
    expect(called).toBe(false);

    const handoff = getHandoff(services, body.handoff_id);
    expect(handoff.message).not.toContain('## Relevant prior context');

    const lane = getLane(services, body.lane_id);
    expect(JSON.parse(lane.recalled_memory_ids)).toEqual([]);
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_AUTO_RECALL_ENABLED;
    } else {
      process.env.PENUMBRA_AUTO_RECALL_ENABLED = previous;
    }
  }
});

test('POST /chains/start times out auto recall after 1500ms and opens a lane without injection', async () => {
  const services = tempServices(true);
  services.recallReader.recall = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1700));
    return [];
  };

  const started = Date.now();
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'do the thing', task_class: 'STANDARD', project_id: 'penumbra' }),
  }), services);
  const elapsed = Date.now() - started;

  expect(res.status).toBe(200);
  expect(elapsed).toBeLessThan(1800);
  const body = await res.json() as { lane_id: string; handoff_id: string; recalled_memory_ids: string[] };
  expect(body.recalled_memory_ids).toEqual([]);

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).not.toContain('## Relevant prior context');

  const lane = getLane(services, body.lane_id);
  expect(lane.gate_status).toBe('open');
  expect(JSON.parse(lane.recalled_memory_ids)).toEqual([]);
});

test('POST /chains/start skips auto recall when project_id is absent', async () => {
  const services = tempServices(true);
  let called = false;
  services.recallReader.recall = async () => {
    called = true;
    throw new Error('recall should not be called without project_id');
  };

  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'do the thing', task_class: 'STANDARD' }),
  }), services);

  expect(res.status).toBe(200);
  expect(called).toBe(false);
  const body = await res.json() as { lane_id: string; handoff_id: string; recalled_memory_ids: string[] };
  expect(body.recalled_memory_ids).toEqual([]);

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).not.toContain('## Relevant prior context');

  const lane = getLane(services, body.lane_id);
  expect(lane.gate_status).toBe('open');
  expect(JSON.parse(lane.recalled_memory_ids)).toEqual([]);
});

test('POST /chains/start in legacy mode does not create a lane row', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'do the thing' }),
  }), services);

  expect(res.status).toBe(200);
  const body = await res.json() as { handoff_id: string; lane_id?: string; recalled_memory_ids?: string[] };
  expect(body.lane_id).toBeUndefined();
  expect(body.recalled_memory_ids).toBeUndefined();

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).not.toContain('## Relevant prior context');

  const lane = services.db.query<any, []>(`SELECT * FROM lane_ledger`).get();
  expect(lane).toBeNull();
});
