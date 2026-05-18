import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createDaemonFetchHandler } from '../../src/serve.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function startTestDaemon(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  stop: () => void;
} {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const gateOutcomeColumn = db
    .query<{ name: string }, []>(`PRAGMA table_info(agent_performance)`)
    .all()
    .some((row) => row.name === 'gate_outcome');
  if (!gateOutcomeColumn) {
    db.exec(`ALTER TABLE agent_performance ADD COLUMN gate_outcome TEXT`);
  }

  const root = mkdtempSync(join(tmpdir(), 'lanes-no-auto-fire-'));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:00:00.000Z'),
  });

  const token = 'tok';
  const handler = createDaemonFetchHandler({ services, token });

  return {
    fetch: (path, init) => handler(new Request(`http://x${path}`, init)),
    services,
    token,
    stop: () => {
      try { services.supervisor.stopAll(); } catch {}
      try { db.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function authHeaders(token: string, headers: HeadersInit = {}): HeadersInit {
  return { authorization: `Bearer ${token}`, ...headers };
}

async function postJson(
  daemon: ReturnType<typeof startTestDaemon>,
  path: string,
  body: unknown,
): Promise<Response> {
  return daemon.fetch(path, {
    method: 'POST',
    headers: authHeaders(daemon.token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

test.each([
  ['unset', undefined],
  ['enabled', '1'],
  ['disabled', '0'],
] as const)('POST /lanes/close never writes memory verify rows when PENUMBRA_MEMORY_VERIFY_AUTO_FIRE=%s', async (_label, value) => {
  const prior = process.env.PENUMBRA_MEMORY_VERIFY_AUTO_FIRE;
  if (value === undefined) {
    delete process.env.PENUMBRA_MEMORY_VERIFY_AUTO_FIRE;
  } else {
    process.env.PENUMBRA_MEMORY_VERIFY_AUTO_FIRE = value;
  }

  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-no-auto-fire',
      implementer_handoff: 'h-no-auto-fire',
      task_class: 'STANDARD',
    });
    daemon.services.db.prepare(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'h-no-auto-fire',
      '2026-04-23T12:00:00.000Z',
      'proj',
      'conv',
      'maestro',
      'claude',
      null,
      'Task type: implement_small',
      'completed',
      'worker',
      '2026-04-23T12:01:00.000Z',
      'event-no-auto-fire',
    );
    daemon.services.db.prepare(`
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
        gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used,
        latency_ms, source, notes, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'perf-no-auto-fire',
      '2026-04-23T12:02:00.000Z',
      'h-no-auto-fire',
      'conv',
      'proj',
      'claude',
      'implement_small',
      'merged',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'worker',
      null,
      '{}',
    );
    daemon.services.db.run(
      `INSERT INTO t2_memories(
        memory_id, project_id, user_id, kind, source_session_ids,
        window_start, window_end, title, body, metadata_json,
        compressed_from, created_at, updated_at
      ) VALUES (?, NULL, 'u1', 'fact', '[]', ?, ?, ?, ?, '{}', NULL, ?, ?)`,
      [
        'm-no-auto-fire',
        '2026-04-23T11:00:00.000Z',
        '2026-04-23T11:30:00.000Z',
        'm-no-auto-fire',
        'm-no-auto-fire body',
        '2026-04-23T11:30:00.000Z',
        '2026-04-23T11:30:00.000Z',
      ],
    );
    daemon.services.db.run(
      `INSERT INTO dispatch_events(
        handoff_id, worker_id, source, kind, ts, meta_json
      ) VALUES (?, NULL, 'worker', 'memory_recall_injected', ?, ?)`,
      ['h-no-auto-fire', '2026-04-23T12:00:30.000Z', JSON.stringify({ memory_id: 'm-no-auto-fire' })],
    );

    const closed = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-no-auto-fire',
      gate_status: 'passed',
    });
    expect(closed.status).toBe(200);

    const count = daemon.services.db.query<{ c: number }, []>(
      'SELECT COUNT(*) AS c FROM t2_memory_verification_events',
    ).get();
    expect(count?.c).toBe(0);
  } finally {
    daemon.stop();
    if (prior === undefined) {
      delete process.env.PENUMBRA_MEMORY_VERIFY_AUTO_FIRE;
    } else {
      process.env.PENUMBRA_MEMORY_VERIFY_AUTO_FIRE = prior;
    }
  }
});
