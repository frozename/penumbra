import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { otlpLogsRoute, otlpMetricsRoute, otlpTracesRoute } from '../../src/routes/otlp.js';

const FIXTURE_PATH = join(import.meta.dir, '..', '..', '..', 'core', 'test', 'otlp', 'fixtures', 'gemini-logs.json');

let dbs: Database[] = [];

function makeServices(): Services {
  const db = new Database(':memory:');
  dbs.push(db);
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {}, input: {}, storageRoot: '/tmp/otlp-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-29T12:00:00Z'),
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
}

afterEach(() => { for (const d of dbs) d.close(); dbs = []; });

describe('otlpLogsRoute', () => {
  it('parses, normalizes, and ingests usage-update events from a gemini envelope', async () => {
    const services = makeServices();
    const body = readFileSync(FIXTURE_PATH, 'utf8');
    const req = new Request('http://localhost/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(200);
    const rows = services.db.prepare(`SELECT provider, model, event_type FROM t0_events WHERE event_type='usage-update'`).all() as Array<{ provider: string; model: string; event_type: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.provider).toBe('google');
    expect(rows[0]!.model).toBe('gemini-3-flash-preview');
  });

  it('returns 415 on non-JSON content-type', async () => {
    const services = makeServices();
    const req = new Request('http://localhost/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: 'binarygunk',
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(415);
  });

  it('returns 400 on malformed JSON', async () => {
    const services = makeServices();
    const req = new Request('http://localhost/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(400);
  });
});

describe('otlpMetricsRoute', () => {
  it('returns 200 and discards (no rows ingested)', async () => {
    const services = makeServices();
    const req = new Request('http://localhost/v1/metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"resourceMetrics":[]}',
    });
    const res = await otlpMetricsRoute(req, services);
    expect(res.status).toBe(200);
    const n = services.db.prepare(`SELECT COUNT(*) AS n FROM t0_events`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('otlpTracesRoute', () => {
  it('returns 200 and discards', async () => {
    const services = makeServices();
    const req = new Request('http://localhost/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"resourceSpans":[]}',
    });
    const res = await otlpTracesRoute(req, services);
    expect(res.status).toBe(200);
  });
});
