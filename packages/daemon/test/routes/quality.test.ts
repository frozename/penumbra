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

function authHeaders(token: string, headers: HeadersInit = {}): HeadersInit {
  return { authorization: `Bearer ${token}`, ...headers };
}

test('quality status composes lane, adversarial, recommendation, memory, and pressure snapshots', async () => {
  const daemon = startTestDaemon();
  try {
    daemon.services.db.prepare(`
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff,
        reviewer_handoff, gate_status, recalled_memory_ids, recalled_query, override_reason, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'lane-quality-1',
      '2026-05-12T11:00:00.000Z',
      '2026-05-12T11:05:00.000Z',
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
      '2026-05-12T11:10:00.000Z',
      '2026-05-12T11:10:01.000Z',
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
      '2026-05-12T11:20:00.000Z',
      1,
      'decision',
      null,
      'missed_registration',
      'model',
      '2026-04-23T11:21:00.000Z',
      '{}',
    );

    const response = await daemon.fetch('/quality/status?window_hours=24&min_samples=2', {
      headers: authHeaders(daemon.token),
    });
    expect(response.status).toBe(200);

    const body = await response.json() as {
      generated_at: string;
      lanes: { total: number; by_status: Record<string, number>; by_class: Record<string, number>; last_close_at: string | null };
      adversarial: { runs_24h: number; success_24h: number; failure_24h: number; avg_latency_ms_24h: number | null; last_run_at: string | null };
      agent_recommendations: Record<string, unknown[]>;
      memory_efficacy: { window_hours: number; by_class: Record<string, number>; last_classified_at: string | null };
      subscription_pressure: { snapshots: unknown[]; warnings: unknown[] };
      errors?: string[];
    };

    expect(body.generated_at).toBeTruthy();
    expect(body.lanes.total).toBe(1);
    expect(body.lanes.by_status.passed).toBe(1);
    expect(body.lanes.by_class.BOUNDARY).toBe(1);
    expect(body.lanes.last_close_at).toBe('2026-05-12T11:05:00.000Z');
    expect(body.adversarial.runs_24h).toBe(1);
    expect(body.adversarial.success_24h).toBe(1);
    expect(body.memory_efficacy.window_hours).toBe(24);
    expect(body.subscription_pressure).toBeDefined();
    expect(body.agent_recommendations.BOUNDARY).toBeDefined();
    expect(body.agent_recommendations.STANDARD).toBeDefined();
    expect(body.agent_recommendations.TRIVIAL).toBeDefined();
  } finally {
    daemon.stop();
  }
});
