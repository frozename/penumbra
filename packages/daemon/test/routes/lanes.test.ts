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
  const root = mkdtempSync(join(tmpdir(), 'lanes-route-'));
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

test('open then close then recent returns lane with closed status', async () => {
  const daemon = startTestDaemon();
  try {
    const opened = await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-1',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    });
    expect(opened.status).toBe(200);
    const openBody = await opened.json() as { lane_id: string; ts_opened: string; gate_status: string };
    expect(openBody.lane_id).toBe('lane-1');
    expect(openBody.gate_status).toBe('open');

    const closed = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-1',
      gate_status: 'passed',
      reviewer_handoff: 'rev-1',
    });
    expect(closed.status).toBe(200);
    const closeBody = await closed.json() as { lane_id: string; gate_status: string; ts_closed: string | null };
    expect(closeBody.lane_id).toBe('lane-1');
    expect(closeBody.gate_status).toBe('passed');
    expect(closeBody.ts_closed).toBeTruthy();

    const recent = await daemon.fetch('/lanes/recent', { headers: authHeaders(daemon.token) });
    expect(recent.status).toBe(200);
    const recentBody = await recent.json() as { lanes: Array<{ lane_id: string; gate_status: string; ts_closed: string | null }> };
    expect(recentBody.lanes).toHaveLength(1);
    expect(recentBody.lanes[0]?.lane_id).toBe('lane-1');
    expect(recentBody.lanes[0]?.gate_status).toBe('passed');
    expect(recentBody.lanes[0]?.ts_closed).toBeTruthy();
  } finally {
    daemon.stop();
  }
});

test('duplicate lane_id returns 409', async () => {
  const daemon = startTestDaemon();
  try {
    expect((await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-dup',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    })).status).toBe(200);
    const dup = await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-dup',
      implementer_handoff: 'h-2',
      task_class: 'STANDARD',
    });
    expect(dup.status).toBe(409);
  } finally {
    daemon.stop();
  }
});

test('close unknown lane returns 404', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await postJson(daemon, '/lanes/close', {
      lane_id: 'missing',
      gate_status: 'passed',
    });
    expect(res.status).toBe(404);
  } finally {
    daemon.stop();
  }
});

test('close twice returns 409 on second call', async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-2',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    });
    const first = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-2',
      gate_status: 'passed',
    });
    expect(first.status).toBe(200);
    const second = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-2',
      gate_status: 'passed',
    });
    expect(second.status).toBe(409);
  } finally {
    daemon.stop();
  }
});

test('close stamps gate_outcome onto matching agent performance row', async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-stamp',
      implementer_handoff: 'h-stamp',
      task_class: 'STANDARD',
    });
    daemon.services.db.prepare(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'h-stamp',
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
      'event-stamp',
    );
    daemon.services.db.prepare(`
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
        gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used,
        latency_ms, source, notes, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'perf-stamp',
      '2026-04-23T12:02:00.000Z',
      'h-stamp',
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

    const closed = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-stamp',
      gate_status: 'failed',
    });
    expect(closed.status).toBe(200);

    const row = daemon.services.db.query<{ gate_outcome: string | null }, [string]>(
      'SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?',
    ).get('h-stamp');
    expect(row?.gate_outcome).toBe('failed');
  } finally {
    daemon.stop();
  }
});

test.each([
  ['passed', 0],
  ['failed', 0],
  ['skipped', 0],
  ['review_debt', 0],
] as const)('close preserves gate_status=%s in telemetry and memory verify count', async (gateStatus, expectedVerificationEvents) => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: `lane-${gateStatus}`,
      implementer_handoff: `h-${gateStatus}`,
      task_class: 'STANDARD',
    });
    daemon.services.db.prepare(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `h-${gateStatus}`,
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
      `event-${gateStatus}`,
    );
    daemon.services.db.prepare(`
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
        gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used,
        latency_ms, source, notes, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `perf-${gateStatus}`,
      '2026-04-23T12:02:00.000Z',
      `h-${gateStatus}`,
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
        `m-${gateStatus}`,
        '2026-04-23T11:00:00.000Z',
        '2026-04-23T11:30:00.000Z',
        `m-${gateStatus}`,
        `m-${gateStatus} body`,
        '2026-04-23T11:30:00.000Z',
        '2026-04-23T11:30:00.000Z',
      ],
    );
    daemon.services.db.run(
      `INSERT INTO dispatch_events(
        handoff_id, worker_id, source, kind, ts, meta_json
      ) VALUES (?, NULL, 'worker', 'memory_recall_injected', ?, ?)`,
      [`h-${gateStatus}`, '2026-04-23T12:00:30.000Z', JSON.stringify({ memory_id: `m-${gateStatus}` })],
    );

    const closed = await postJson(daemon, '/lanes/close', {
      lane_id: `lane-${gateStatus}`,
      gate_status: gateStatus,
    });
    expect(closed.status).toBe(200);

    const row = daemon.services.db.query<{ gate_outcome: string | null }, [string]>(
      'SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?',
    ).get(`h-${gateStatus}`);
    expect(row?.gate_outcome).toBe(gateStatus);

    const count = daemon.services.db.query<{ c: number }, []>(
      'SELECT COUNT(*) AS c FROM t2_memory_verification_events WHERE session_id = ?',
    ).get(`h-${gateStatus}`);
    expect(count?.c).toBe(expectedVerificationEvents);
  } finally {
    daemon.stop();
  }
});

test("close rejects gate_status='open' with 400", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-3',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    });
    const res = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-3',
      gate_status: 'open',
    });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

test('recent filters by status', async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-open',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    });
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-passed',
      implementer_handoff: 'h-2',
      task_class: 'STANDARD',
    });
    await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-passed',
      gate_status: 'passed',
    });

    const res = await daemon.fetch('/lanes/recent?status=passed', { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { lanes: Array<{ lane_id: string }> };
    expect(body.lanes.map((lane) => lane.lane_id)).toEqual(['lane-passed']);
  } finally {
    daemon.stop();
  }
});

test('close with metadata persists serialized JSON to DB', async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-meta',
      implementer_handoff: 'h-meta',
      task_class: 'BOUNDARY',
    });
    const res = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-meta',
      gate_status: 'passed',
      metadata: { high_findings: 2, round_count: 2, reviewer_agent: 'codex-acp-deep' },
    });
    expect(res.status).toBe(200);
    const row = daemon.services.db.query<{ metadata_json: string }, [string]>(
      'SELECT metadata_json FROM lane_ledger WHERE lane_id = ?',
    ).get('lane-meta');
    expect(JSON.parse(row!.metadata_json)).toEqual({ high_findings: 2, round_count: 2, reviewer_agent: 'codex-acp-deep' });
  } finally {
    daemon.stop();
  }
});

test('close with unknown metadata key returns 400', async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-strict',
      implementer_handoff: 'h-strict',
      task_class: 'STANDARD',
    });
    const res = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-strict',
      gate_status: 'passed',
      metadata: { invented_field: 'x' },
    });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

test('close with oversized metadata returns 400 metadata_too_large', async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-oversize',
      implementer_handoff: 'h-oversize',
      task_class: 'STANDARD',
    });
    const res = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-oversize',
      gate_status: 'passed',
      metadata: { notes: 'x'.repeat(5000) },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('metadata_too_large');
  } finally {
    daemon.stop();
  }
});

test('close with multi-byte oversized metadata returns 400 (byte-count semantics)', async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-multibyte',
      implementer_handoff: 'h-multibyte',
      task_class: 'STANDARD',
    });
    // Each '😀' is 4 UTF-8 bytes but only 2 UTF-16 code units.
    // 1100 repetitions = 2200 .length but 4400 bytes — exceeds the 4096-byte limit.
    const res = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-multibyte',
      gate_status: 'passed',
      metadata: { notes: '😀'.repeat(1100) },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('metadata_too_large');
  } finally {
    daemon.stop();
  }
});

test('recent limit is capped at 200', async () => {
  const daemon = startTestDaemon();
  try {
    for (let i = 0; i < 3; i++) {
      await postJson(daemon, '/lanes/open', {
        lane_id: `lane-${i}`,
        implementer_handoff: `h-${i}`,
        task_class: 'STANDARD',
      });
    }

    const res = await daemon.fetch('/lanes/recent?limit=999', { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { lanes: Array<unknown> };
    expect(body.lanes).toHaveLength(3);

    const capped = await daemon.fetch('/lanes/recent?limit=200', { headers: authHeaders(daemon.token) });
    expect(capped.status).toBe(200);
  } finally {
    daemon.stop();
  }
});

// GH #118 — ?since= offset normalization
test('GET /lanes/recent?since= returns same lanes for UTC and offset-equivalent timestamps', async () => {
  const daemon = startTestDaemon();
  // clock() → '2026-04-23T12:00:00.000Z'; opened lane ts_opened = that value
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-since',
      implementer_handoff: 'h-since',
      task_class: 'STANDARD',
    });

    // 1 minute before the lane opened — plain UTC
    const resUtc = await daemon.fetch(
      '/lanes/recent?since=2026-04-23T11%3A59%3A00Z',
      { headers: authHeaders(daemon.token) },
    );
    expect(resUtc.status).toBe(200);
    const utcBody = await resUtc.json() as { lanes: Array<unknown> };

    // Same instant with +05:00 offset (raw string looks like a later date/time)
    const resOffset = await daemon.fetch(
      '/lanes/recent?since=2026-04-23T16%3A59%3A00%2B05%3A00',
      { headers: authHeaders(daemon.token) },
    );
    expect(resOffset.status).toBe(200);
    const offsetBody = await resOffset.json() as { lanes: Array<unknown> };

    expect(utcBody.lanes).toHaveLength(1);
    expect(offsetBody.lanes).toHaveLength(utcBody.lanes.length);
  } finally {
    daemon.stop();
  }
});
