import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { qualityStatus } from '../../../core/src/readers/quality-status.js';
import { createDaemonFetchHandler } from '../../src/serve.js';
import { qualityStatusRoute } from '../../src/routes/quality.js';
import { EFFICACY_RUNNER_HEARTBEAT_STALE_MS, memoryEfficacyRecentRoute, memoryEfficacyRebuildRoute } from '../../src/routes/memory.js';

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

  const root = mkdtempSync(join(tmpdir(), 'quality-route-'));
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

test('quality status composes lane, adversarial, recommendation, memory, and pressure snapshots', async () => {
  const daemon = startTestDaemon();
  try {
    const now = Date.now();
    const laneOpenedAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const laneClosedAt = new Date(now - 90 * 60 * 1000).toISOString();
    const adversarialAt = new Date(now - 80 * 60 * 1000).toISOString();
    const memoryFindingAt = new Date(now - 70 * 60 * 1000).toISOString();

    daemon.services.db.prepare(`
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff,
        reviewer_handoff, gate_status, recalled_memory_ids, recalled_query, override_reason, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'lane-quality-1',
      laneOpenedAt,
      laneClosedAt,
      'BOUNDARY',
      'handoff-quality-1',
      null,
      'passed',
      '[]',
      null,
      null,
      '{}',
    );

    daemon.services.db.prepare(`
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
        event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary, origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'evt-quality-1',
      adversarialAt,
      new Date(now - 79 * 60 * 1000).toISOString(),
      'daemon',
      null,
      null,
      'penumbra',
      'machine',
      null,
      'workflow.outcome',
      'system',
      null,
      null,
      null,
      null,
      null,
      250,
      null,
      JSON.stringify({ workflow_name: 'adversarial-review', outcome: 'success' }),
      null,
      null,
    );

    daemon.services.db.prepare(`
      INSERT INTO memory_efficacy_cache (
        finding_id, synthesis_path, ts, finding_index, finding_text,
        severity, classification, classifier_model, classified_at, raw_response_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'finding-quality-1',
      '/tmp/review/synthesis.md',
      memoryFindingAt,
      1,
      'decision',
      null,
      'missed_registration',
      'model',
      '2026-04-23T11:21:00.000Z',
      '{}',
    );

    const body = qualityStatus(daemon.services.db, {
      window_hours: 24,
      min_samples: 2,
    }) as {
      generated_at: string;
      lanes: { total: number; by_status: Record<string, number>; by_class: Record<string, number>; last_close_at: string | null };
      adversarial: { window_hours: number; runs_window: number; success_window: number; failure_window: number; avg_latency_ms_window: number | null; last_run_at: string | null };
      agent_recommendations: { task_type: string; recent: unknown[] };
      memory_efficacy: { window_hours: number; by_class: Record<string, number> };
      subscription_pressure: { snapshots: unknown[]; warnings: unknown[] };
      errors?: string[];
    };

    expect(body.generated_at).toBeTruthy();
    expect(body.lanes.total).toBe(1);
    expect(body.lanes.by_status.passed).toBe(1);
    expect(body.lanes.by_class.BOUNDARY).toBe(1);
    expect(body.lanes.last_close_at).toBe(laneClosedAt);
    expect(body.adversarial.window_hours).toBe(24);
    expect(body.adversarial.runs_window).toBe(1);
    expect(body.adversarial.success_window).toBe(1);
    expect(body.memory_efficacy.window_hours).toBe(24);
    expect(body.subscription_pressure).toBeDefined();
    expect(body.agent_recommendations.task_type).toBe('implement_substantial');
    expect(Array.isArray(body.agent_recommendations.recent)).toBe(true);
  } finally {
    daemon.stop();
  }
});

test('quality status honors task_type query override', async () => {
  const daemon = startTestDaemon();
  try {
    const body = qualityStatus(daemon.services.db, { task_type: 'review_adversarial' });
    expect(body.agent_recommendations?.task_type).toBe('review_adversarial');
  } finally {
    daemon.stop();
  }
});

test('quality status degrades each section independently when reads fail', async () => {
  const daemon = startTestDaemon();
  try {
    daemon.services.db.exec(`
      DROP TABLE IF EXISTS lane_ledger;
      DROP TABLE IF EXISTS t0_events;
      DROP TABLE IF EXISTS agent_performance;
      DROP TABLE IF EXISTS memory_efficacy_cache;
    `);

    const response = await qualityStatusRoute(new Request('http://x/quality/status'), daemon.services);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      generated_at: string;
      lanes: null;
      adversarial: null;
      agent_recommendations: null;
      memory_efficacy: null;
      subscription_pressure: null;
      errors: string[];
    };

    expect(body.generated_at).toBeTruthy();
    expect(body.lanes).toBeNull();
    expect(body.adversarial).toBeNull();
    expect(body.agent_recommendations).toBeNull();
    expect(body.memory_efficacy).toBeNull();
    expect(body.subscription_pressure).toBeNull();
    expect(body.errors).toEqual([
      'lanes_failed',
      'adversarial_failed',
      'agent_recommendations_failed',
      'memory_efficacy_failed',
      'subscription_pressure_failed',
    ]);
  } finally {
    daemon.stop();
  }
});

test('memory efficacy routes thread source and include raw response opt-in', async () => {
  const daemon = startTestDaemon();
  try {
    const now = Date.now();
    daemon.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
    const rebuildReq = new Request('http://x/memory/efficacy/rebuild', {
      method: 'POST',
      body: JSON.stringify({ source: 'cli', reviews_dir: '/etc/passwd' }),
    });
    const rebuildRes = await memoryEfficacyRebuildRoute(rebuildReq, daemon.services);
    expect(rebuildRes.status).toBe(202);

    const jobRow = daemon.services.db
      .query<{ enqueued_by: string; reviews_dir: string }, []>('SELECT enqueued_by, reviews_dir FROM memory_efficacy_jobs ORDER BY ts_enqueued DESC LIMIT 1')
      .get();
    expect(jobRow?.enqueued_by).toBe('cli');
    expect(jobRow?.reviews_dir).toBe(resolve(daemon.services.storageRoot, '..', '.penumbra/reviews'));

    daemon.services.db.prepare(`
      INSERT INTO memory_efficacy_cache (
        finding_id, synthesis_path, ts, finding_index, finding_text,
        severity, classification, classifier_model, classified_at, raw_response_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'finding-route-1',
      '/tmp/review/synthesis.md',
      new Date(now - 60 * 60 * 1000).toISOString(),
      1,
      'Route finding',
      null,
      'memory_ignored',
      'model',
      new Date(now - 59 * 60 * 1000).toISOString(),
      '{"classification":"memory_ignored"}',
    );

    const recentReq = new Request('http://x/memory/efficacy/recent', {
      method: 'POST',
      body: JSON.stringify({ since: '1970-01-01T00:00:00Z', limit: 10, include_raw: true }),
    });
    const recentRes = await memoryEfficacyRecentRoute(recentReq, daemon.services);
    expect(recentRes.status).toBe(200);
  } finally {
    daemon.stop();
  }
});

test('POST /memory/efficacy/rebuild uses services.reviewsDir when set', async () => {
  const daemon = startTestDaemon();
  try {
    daemon.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
    daemon.services.reviewsDir = '/tmp/explicit-reviews-dir';
    const rebuildReq = new Request('http://x/memory/efficacy/rebuild', {
      method: 'POST',
      body: JSON.stringify({ source: 'cli' }),
    });
    const rebuildRes = await memoryEfficacyRebuildRoute(rebuildReq, daemon.services);
    expect(rebuildRes.status).toBe(202);

    const jobRow = daemon.services.db
      .query<{ reviews_dir: string }, []>('SELECT reviews_dir FROM memory_efficacy_jobs ORDER BY ts_enqueued DESC LIMIT 1')
      .get();
    expect(jobRow?.reviews_dir).toBe('/tmp/explicit-reviews-dir');
  } finally {
    daemon.stop();
  }
});

test('POST /memory/efficacy/recent validates since as an ISO timestamp', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = { db } as unknown as Services;

  const invalidRes = await memoryEfficacyRecentRoute(
    new Request('http://x/memory/efficacy/recent', {
      method: 'POST',
      body: JSON.stringify({ since: '2026/05/01' }),
    }),
    services,
  );
  expect(invalidRes.status).toBe(400);
  const invalidBody = await invalidRes.json() as { error: { code: string; field_errors: Array<{ path: Array<string | number>; message: string }> } };
  expect(invalidBody.error.code).toBe('validation_error');
  expect(invalidBody.error.field_errors[0]?.path).toEqual(['since']);

  const validRes = await memoryEfficacyRecentRoute(
    new Request('http://x/memory/efficacy/recent', {
      method: 'POST',
      body: JSON.stringify({ since: '2026-05-01T00:00:00Z' }),
    }),
    services,
  );
  expect(validRes.status).toBe(200);
});

test('POST /memory/efficacy/recent accepts ISO timestamps with offsets', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = { db } as unknown as Services;

  const validRes = await memoryEfficacyRecentRoute(
    new Request('http://x/memory/efficacy/recent', {
      method: 'POST',
      body: JSON.stringify({ since: '2026-05-01T12:00:00+02:00' }),
    }),
    services,
  );
  expect(validRes.status).toBe(200);
});

test('memory efficacy rebuild returns backend_unavailable when runner heartbeat is stale', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = {
    db,
    storageRoot: '/tmp/quality-route-test',
    memoryEfficacyRunnerHeartbeatAt: Date.now() - (EFFICACY_RUNNER_HEARTBEAT_STALE_MS + 1_000),
  } as Services;

  const rebuildReq = new Request('http://x/memory/efficacy/rebuild', {
    method: 'POST',
    body: JSON.stringify({ source: 'http' }),
  });
  const rebuildRes = await memoryEfficacyRebuildRoute(rebuildReq, services);
  expect(rebuildRes.status).toBe(503);
  await expect(rebuildRes.json()).resolves.toEqual({
    error: {
      code: 'backend_unavailable',
      message: 'no live job runner',
    },
  });
  const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM memory_efficacy_jobs').get();
  expect(count?.n).toBe(0);
});
