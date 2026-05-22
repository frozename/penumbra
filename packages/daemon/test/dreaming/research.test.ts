
import { describe, test, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, loadSqliteVec } from '@penumbra/core';
import { runP5Phase } from '../../src/dreaming/research.js';

describe('P5: Active Research', () => {
  test('P5 action rows carry untrusted_source=1 and status=queued', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db);
    
    // Seed P4 research_query
    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')"
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"test query\"}')"
    ).run();
    
    const deps = {
      projectRegistry: { get: () => ({ dreaming: { research_provider: 'webfetch' } }) },
      researchAdapter: { search: async () => [{ url: 'http://test.com', markdown: 'test', source_provider: 'webfetch' }] }
    };
    
    await runP5Phase(db, 'cycle1', {} as any, deps as any);
    
    const actions = db.prepare("SELECT * FROM dream_actions WHERE phase='P5'").all() as any[];
    expect(actions.length).toBe(1);
    expect(actions[0].untrusted_source).toBe(1);
    expect(actions[0].status).toBe('queued');
  });

  test('per-project allowed_domains enforced for research', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db);
    
    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')"
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"url\":\"http://bad.com\"}')"
    ).run();
    
    const deps = {
      projectRegistry: { get: () => ({ dreaming: { research_provider: 'webfetch', allowed_domains: ['good.com'] } }) },
      researchAdapter: { scrape: async () => { throw new Error('should not scrape'); } }
    };
    
    await runP5Phase(db, 'cycle1', {} as any, deps as any);
    
    const p4_action = db.prepare("SELECT status FROM dream_actions WHERE action_id='a1'").get() as any;
    expect(p4_action.status).toBe('failed');
    
    const p5_actions = db.prepare("SELECT * FROM dream_actions WHERE phase='P5'").all();
    expect(p5_actions.length).toBe(0);
  });

  test('dream_research_cache hit skips re-fetch', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db);
    
    db.prepare("INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')").run();
    db.prepare("INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"test query\"}')").run();
    
    // Seed cache
    db.prepare("INSERT INTO dream_research_cache(cache_key, provider, project_id, url, markdown, fetched_at, expires_at) VALUES('hash1', 'webfetch', 'proj1', 'http://cached.com', 'cached text', 1, 9999999999)").run();
    
    const mockSearch = mock(async () => []);
    const deps = {
      projectRegistry: { get: () => ({ dreaming: { research_provider: 'webfetch' } }) },
      researchAdapter: { search: mockSearch }
    };
    
    // Hack: override crypto.createHash to return 'hash1'
    const originalHash = require('node:crypto').createHash;
    require('node:crypto').createHash = () => ({ update: () => ({ digest: () => 'hash1' }) });
    
    await runP5Phase(db, 'cycle1', {} as any, deps as any);
    
    require('node:crypto').createHash = originalHash;
    
    expect(mockSearch.mock.calls.length).toBe(0);
    const actions = db.prepare("SELECT * FROM dream_actions WHERE phase='P5'").all() as any[];
    expect(actions.length).toBe(1);
    expect(actions[0].payload_json).toContain('cached text');
  });
});
