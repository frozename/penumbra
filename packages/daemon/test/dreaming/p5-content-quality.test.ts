import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, loadSqliteVec } from '@penumbra/core';
import type { WebResearchAdapter } from '@penumbra/core';
import { ContentQualityJudge } from '../../src/dreaming/curator/content-quality-judge.js';
import { runP5Phase } from '../../src/dreaming/research.js';
import { buildDreamCycleDeps } from '../../src/dreaming/deps.js';

describe('P5 content quality', () => {
  test('ContentQualityJudge scores authoritative release notes high', async () => {
    const judge = new ContentQualityJudge({ threshold: 0.5 });
    const verdict = await judge.judge(
      {
        url: 'https://bun.sh/blog/bun-1-4',
        title: 'Bun 1.4 release notes',
        markdown: '# Bun 1.4\n\n' + 'Bun is a fast JavaScript runtime. '.repeat(40),
      },
      'bun runtime',
    );

    expect(verdict.score).toBeGreaterThanOrEqual(0.6);
    expect(verdict.lowQuality).toBe(false);
  });

  test('ContentQualityJudge flags short off-topic result', async () => {
    const judge = new ContentQualityJudge({ threshold: 0.5 });
    const verdict = await judge.judge(
      {
        url: 'https://reddit.com/r/gaming',
        title: 'cool gaming meme',
        markdown: 'cool stuff lol',
      },
      'bun sqlite driver',
    );

    expect(verdict.lowQuality).toBe(true);
  });

  test('ContentQualityJudge gives domain bonus to trusted hosts', async () => {
    const judge = new ContentQualityJudge({ threshold: 0.5 });

    const trusted = await judge.judge(
      {
        url: 'https://github.com/oven-sh/bun',
        title: 'oven-sh/bun',
        markdown: 'bun is a fast runtime '.repeat(30),
      },
      'bun',
    );

    const untrusted = await judge.judge(
      {
        url: 'https://random-blog.example.com',
        title: 'My take on bun',
        markdown: 'bun is a fast runtime '.repeat(30),
      },
      'bun',
    );

    expect(trusted.score).toBeGreaterThan(untrusted.score);
  });

  test('runP5Phase routes high-quality result through with quality_score in payload', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"bun runtime\"}')",
    ).run();

    const adapter: WebResearchAdapter = {
      async search() {
        return [
          {
            url: 'https://bun.sh/blog/bun-1-4',
            title: 'Bun 1.4 release notes',
            markdown: '# Bun 1.4\n\n' + 'Bun is a fast JavaScript runtime. '.repeat(40),
            fetched_at: new Date().toISOString(),
            source_provider: 'webfetch',
          },
        ];
      },
      async scrape() {
        throw new Error('scrape should not be used');
      },
    };

    const deps = {
      projectRegistry: { get: () => ({ dreaming: { research_provider: 'webfetch' } }) },
      getResearchAdapter: () => adapter,
      contentQualityJudge: {
        async judge() {
          return { score: 0.8, reasons: ['relevance:1.00', 'depth:1.00', 'spam:1.00', 'domain:trusted'], lowQuality: false };
        },
      },
    };

    await runP5Phase(db, 'cycle1', {} as any, deps as any);

    const action = db.prepare("SELECT * FROM dream_actions WHERE phase='P5'").get() as {
      status: string;
      payload_json: string;
    };
    const payload = JSON.parse(action.payload_json) as { quality_score: number; low_quality?: boolean };

    expect(action.status).toBe('queued');
    expect(payload.quality_score).toBe(0.8);
    expect(payload.low_quality).toBeUndefined();
  });

  test('runP5Phase filters disallowed domain BEFORE judging — judge never called for disallowed result', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"bun runtime\"}')",
    ).run();

    let judgeCallCount = 0;
    const adapter: WebResearchAdapter = {
      async search() {
        return [
          { url: 'https://allowed.com/page', title: 'Good', markdown: 'good content', fetched_at: '', source_provider: 'webfetch' as const },
          { url: 'https://disallowed.com/page', title: 'Bad', markdown: 'bad content', fetched_at: '', source_provider: 'webfetch' as const },
        ];
      },
      async scrape() { throw new Error('no scrape'); },
    };

    const deps = {
      projectRegistry: { get: () => ({ dreaming: { research_provider: 'webfetch', allowed_domains: ['allowed.com'] } }) },
      getResearchAdapter: () => adapter,
      contentQualityJudge: {
        async judge(_result: any, _query: string) {
          judgeCallCount++;
          return { score: 0.8, reasons: [], lowQuality: false };
        },
      },
    };

    await runP5Phase(db, 'cycle1', {} as any, deps as any);

    expect(judgeCallCount).toBe(1);
    const p5Actions = db.prepare("SELECT * FROM dream_actions WHERE phase='P5'").all() as any[];
    expect(p5Actions).toHaveLength(1);
  });

  test('runP5Phase cache key consistent — second call with same query+url hits cache, adapter not called again', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();

    const targetUrl = 'https://bun.sh/blog/bun-1-4';
    const payload = JSON.stringify({ query: 'bun runtime', url: targetUrl });

    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', ?)",
    ).run(payload);

    let scrapeCallCount = 0;
    const adapter: WebResearchAdapter = {
      async search() { return []; },
      async scrape() {
        scrapeCallCount++;
        return { url: targetUrl, title: 'Bun 1.4', markdown: 'content', fetched_at: new Date().toISOString(), source_provider: 'webfetch' as const };
      },
    };

    const deps = {
      projectRegistry: { get: () => ({ dreaming: { research_provider: 'webfetch' } }) },
      getResearchAdapter: () => adapter,
    };

    await runP5Phase(db, 'cycle1', {} as any, deps as any);
    expect(scrapeCallCount).toBe(1);

    // Insert second action with identical payload
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a2', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', ?)",
    ).run(payload);

    await runP5Phase(db, 'cycle1', {} as any, deps as any);
    expect(scrapeCallCount).toBe(1); // cache hit — adapter NOT called again
  });

  test('runP5Phase still gates by allowed_domains when no judge is configured', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"url\":\"http://bad.com\"}')",
    ).run();

    const deps = {
      projectRegistry: { get: () => ({ dreaming: { research_provider: 'webfetch', allowed_domains: ['good.com'] } }) },
      getResearchAdapter: () => ({ scrape: async () => ({ url: 'http://bad.com', title: 'x', markdown: 'x', fetched_at: new Date().toISOString(), source_provider: 'webfetch' }) }),
    };

    await runP5Phase(db, 'cycle1', {} as any, deps as any);

    const p4Action = db.prepare("SELECT status FROM dream_actions WHERE action_id='a1'").get() as { status: string };
    expect(p4Action.status).toBe('failed');

    const p5Actions = db.prepare("SELECT * FROM dream_actions WHERE phase='P5'").all() as any[];
    expect(p5Actions.length).toBe(0);
  });

  test('buildDreamCycleDeps uses dream config contentQualityThreshold', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db);

    const deps = buildDreamCycleDeps({}, db, {
      contentQualityThreshold: 0.7,
    } as any);
    expect(deps.contentQualityJudge).toBeDefined();

    const verdict = await deps.contentQualityJudge!.judge(
      {
        url: 'https://random-blog.example.com/article',
        title: 'runtime notes',
        markdown: 'bun runtime review. '.repeat(8),
      },
      'bun runtime latency',
    );

    expect(verdict.lowQuality).toBe(true);
    expect(verdict.score).toBeLessThan(0.7);
  });
});
