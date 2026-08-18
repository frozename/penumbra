import {
  applySchema,
  loadSqliteVec,
  type WebResearchAdapter,
  type WebResearchResult,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

import type { DreamConfig } from "../../src/dreaming/config.js";
import type { ResearchDeps } from "../../src/dreaming/research.js";

import { hashQuery, runP5Phase } from "../../src/dreaming/research.js";

interface DreamActionResearchRow {
  payload_json: string;
  status: string;
  untrusted_source: number;
}

interface DreamActionStatusRow {
  decided_by: string | null;
  status: string;
}

interface CacheCountRow {
  c: number;
}

interface CacheNegativeRow {
  is_negative: number;
}

interface CacheStateRow {
  is_negative: number;
  url: string;
}

interface CacheUrlRow {
  url: string;
}

function testConfig(overrides?: Partial<DreamConfig>): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 0.5,
    dailyUsd: 5.0,
    pressureGuardEnabled: true,
    perCycleEmbeddingUsd: 0.1,
    perCycleResearchUsd: 0.25,
    linkAutoThreshold: 0.75,
    p1BatchSize: 10,
    contentQualityThreshold: 0.7,
    reembedBatchSize: 100,
    skipPhases: new Set(),
    eventTriggerEnabled: true,
    idleMinutes: 15,
    triggerCooldownMinutes: 5,
    briefRefreshHours: 24,
    pc1BatchSize: 10,
    pc2MinClusterSize: 3,
    pc2ClusterLinkThreshold: 0.85,
    pc2AutoThreshold: 0.97,
    curatorEnabled: false,
    rewriterEnabled: false,
    rewriterBaseUrl: "",
    rewriterModel: "",
    rewriterTimeoutMs: 30_000,
    rewriterCacheTtlMs: 86_400_000,
    rewriterConcurrency: 1,
    ...overrides,
  };
}

function webfetchResult(overrides: Partial<WebResearchResult>): WebResearchResult {
  return {
    url: "https://example.com",
    title: "",
    markdown: "",
    fetched_at: new Date(0).toISOString(),
    source_provider: "webfetch",
    ...overrides,
  };
}

function depsWithAdapter(
  adapter: WebResearchAdapter,
  dreaming: Record<string, unknown>,
): ResearchDeps {
  return {
    projectRegistry: { get: () => ({ dreaming }) },
    getResearchAdapter: () => adapter,
  };
}

function unusedSearch(): Promise<WebResearchResult[]> {
  return Promise.reject(new Error("search should not be used"));
}

function unusedScrape(): Promise<WebResearchResult> {
  return Promise.reject(new Error("scrape should not be used"));
}

describe("P5: Active Research", () => {
  test("P5 action rows carry untrusted_source=1 and status=queued", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    // Seed P4 research_query
    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"test query\"}')",
    ).run();

    const stubAdapter: WebResearchAdapter = {
      search: () => Promise.resolve([webfetchResult({ url: "http://test.com", markdown: "test" })]),
      scrape: unusedScrape,
    };
    const deps = depsWithAdapter(stubAdapter, { research_provider: "webfetch" });

    await runP5Phase(db, "cycle1", testConfig(), deps);

    const actions = db
      .prepare("SELECT * FROM dream_actions WHERE phase='P5'")
      .all() as DreamActionResearchRow[];
    expect(actions.length).toBe(1);
    expect(actions[0].untrusted_source).toBe(1);
    expect(actions[0].status).toBe("queued");
  });

  test("per-project allowed_domains enforced for research", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"url\":\"http://bad.com\"}')",
    ).run();

    const deps = depsWithAdapter(
      {
        search: unusedSearch,
        scrape: () => Promise.reject(new Error("should not scrape")),
      },
      { research_provider: "webfetch", allowed_domains: ["good.com"] },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);

    const p4_action = db
      .prepare("SELECT status FROM dream_actions WHERE action_id='a1'")
      .get() as DreamActionStatusRow;
    expect(p4_action.status).toBe("failed");

    const p5_actions = db.prepare("SELECT * FROM dream_actions WHERE phase='P5'").all();
    expect(p5_actions.length).toBe(0);
  });

  test("dream_research_cache hit skips re-fetch", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"test query\"}')",
    ).run();

    const cacheKey = hashQuery("test query", "test query");
    db.prepare(
      "INSERT INTO dream_research_cache(cache_key, provider, project_id, url, markdown, fetched_at, expires_at) VALUES(?, 'webfetch', 'proj1', 'http://cached.com', 'cached text', 1, 9999999999)",
    ).run(cacheKey);

    const mockSearch = mock((): Promise<WebResearchResult[]> => Promise.resolve([]));
    const deps = depsWithAdapter(
      {
        search: mockSearch,
        scrape: unusedScrape,
      },
      { research_provider: "webfetch" },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);

    expect(mockSearch.mock.calls.length).toBe(0);
    const actions = db
      .prepare("SELECT * FROM dream_actions WHERE phase='P5'")
      .all() as DreamActionResearchRow[];
    expect(actions.length).toBe(1);
    expect(actions[0]!.payload_json).toContain("cached text");
  });

  test("dream_research_cache miss fetches instead of throwing", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"uncached query\"}')",
    ).run();

    const searchMock = mock(
      (): Promise<WebResearchResult[]> =>
        Promise.resolve([
          webfetchResult({
            url: "https://example.com/fetched",
            title: "Fetched",
            markdown: "fresh uncached body",
          }),
        ]),
    );
    const deps = depsWithAdapter(
      {
        search: searchMock,
        scrape: unusedScrape,
      },
      { research_provider: "webfetch" },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);

    expect(searchMock.mock.calls.length).toBe(1);
    const p4 = db
      .prepare("SELECT status, decided_by FROM dream_actions WHERE action_id='a1'")
      .get() as DreamActionStatusRow;
    expect(p4.status).toBe("completed");
    expect(p4.decided_by).toBeNull();

    const actions = db
      .prepare("SELECT * FROM dream_actions WHERE phase='P5'")
      .all() as DreamActionResearchRow[];
    expect(actions.length).toBe(1);
    expect(actions[0]!.payload_json).toContain("fresh uncached body");
  });

  test("P5 caches empty search results as negative and short-circuits on second hit", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle2', 2, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"empty results query\"}')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a2', 'cycle2', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"empty results query\"}')",
    ).run();

    const searchMock = mock((): Promise<WebResearchResult[]> => Promise.resolve([]));
    const deps = depsWithAdapter(
      {
        search: searchMock,
        scrape: unusedScrape,
      },
      { research_provider: "webfetch" },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);
    await runP5Phase(db, "cycle2", testConfig(), deps);

    expect(searchMock.mock.calls.length).toBe(1);

    const cacheKey = createHash("sha256")
      .update("empty results query|empty results query")
      .digest("hex");
    const cacheRow = db
      .prepare("SELECT is_negative FROM dream_research_cache WHERE cache_key=?")
      .get(cacheKey) as CacheNegativeRow | null;
    expect(cacheRow).not.toBeNull();
    expect(cacheRow?.is_negative).toBe(1);

    const a1 = db
      .prepare("SELECT status, decided_by FROM dream_actions WHERE action_id='a1'")
      .get() as DreamActionStatusRow;
    const a2 = db
      .prepare("SELECT status, decided_by FROM dream_actions WHERE action_id='a2'")
      .get() as DreamActionStatusRow;
    expect(a1.status).toBe("failed");
    expect(a2.status).toBe("failed");
    expect(a2.decided_by).toBe("negative-cache-hit");
  });

  test("P5 caches allowed-domain-filtered results as negative and short-circuits on second hit", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle2', 2, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('b1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"domain filtered query\"}')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('b2', 'cycle2', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"domain filtered query\"}')",
    ).run();

    const searchMock = mock(
      (): Promise<WebResearchResult[]> =>
        Promise.resolve([
          webfetchResult({
            url: "https://forbidden.example/page",
            title: "Nope",
            markdown: "nope",
          }),
        ]),
    );
    const deps = depsWithAdapter(
      {
        search: searchMock,
        scrape: unusedScrape,
      },
      { research_provider: "webfetch", allowed_domains: ["allowed.example"] },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);
    await runP5Phase(db, "cycle2", testConfig(), deps);

    expect(searchMock.mock.calls.length).toBe(1);

    const cacheKey = createHash("sha256")
      .update("domain filtered query|domain filtered query")
      .digest("hex");
    const cacheRow = db
      .prepare("SELECT is_negative FROM dream_research_cache WHERE cache_key=?")
      .get(cacheKey) as CacheNegativeRow | null;
    expect(cacheRow).not.toBeNull();
    expect(cacheRow?.is_negative).toBe(1);

    const b1 = db
      .prepare("SELECT status, decided_by FROM dream_actions WHERE action_id='b1'")
      .get() as DreamActionStatusRow;
    const b2 = db
      .prepare("SELECT status, decided_by FROM dream_actions WHERE action_id='b2'")
      .get() as DreamActionStatusRow;
    expect(b1.status).toBe("failed");
    expect(b2.status).toBe("failed");
    expect(b2.decided_by).toBe("negative-cache-hit");
  });

  test("runP5Phase writes one cache row per search result", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"test query\"}')",
    ).run();

    const deps = depsWithAdapter(
      {
        search: () =>
          Promise.resolve([
            webfetchResult({ url: "https://example.com/a", title: "A", markdown: "a" }),
            webfetchResult({ url: "https://example.com/b", title: "B", markdown: "b" }),
            webfetchResult({ url: "https://example.com/c", title: "C", markdown: "c" }),
          ]),
        scrape: unusedScrape,
      },
      { research_provider: "webfetch" },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);

    const cache = db
      .prepare("SELECT COUNT(*) as c FROM dream_research_cache WHERE project_id='proj1'")
      .get() as CacheCountRow;
    expect(cache.c).toBe(3);
    const rows = db
      .prepare("SELECT url FROM dream_research_cache WHERE project_id='proj1' ORDER BY url")
      .all() as CacheUrlRow[];
    expect(rows).toEqual([
      { url: "https://example.com/a" },
      { url: "https://example.com/b" },
      { url: "https://example.com/c" },
    ]);
  });

  test("unexpired negative cache row short-circuits without re-fetching", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"negative cached query\"}')",
    ).run();

    const cacheKey = createHash("sha256")
      .update("negative cached query|negative cached query")
      .digest("hex");
    db.prepare(
      `INSERT INTO dream_research_cache(cache_key, provider, project_id, url, query_hash, title, markdown, fetched_at, expires_at, source_billed_usd, is_negative)
       VALUES(?, 'negative', 'proj1', 'negative cached query', ?, '', '', 1, 9999999999999, 0, 1)`,
    ).run(cacheKey, cacheKey);

    const searchMock = mock((): Promise<WebResearchResult[]> => Promise.resolve([]));
    const deps = depsWithAdapter(
      {
        search: searchMock,
        scrape: unusedScrape,
      },
      { research_provider: "webfetch" },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);

    expect(searchMock.mock.calls.length).toBe(0);
    const p4 = db
      .prepare("SELECT status, decided_by FROM dream_actions WHERE action_id='a1'")
      .get() as DreamActionStatusRow;
    expect(p4.status).toBe("failed");
    expect(p4.decided_by).toBe("negative-cache-hit");
  });

  test("expired negative cache row triggers re-fetch (does not serve empty positive result)", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"expired neg query\"}')",
    ).run();

    // Seed an EXPIRED negative cache row for the same cache_key the phase will compute.
    const cacheKey = createHash("sha256")
      .update("expired neg query|expired neg query")
      .digest("hex");
    db.prepare(
      `INSERT INTO dream_research_cache(cache_key, provider, project_id, url, query_hash, title, markdown, fetched_at, expires_at, source_billed_usd, is_negative)
       VALUES(?, 'negative', 'proj1', 'expired neg query', ?, '', '', 1, 1, 0, 1)`,
    ).run(cacheKey, cacheKey);

    const searchMock = mock(
      (): Promise<WebResearchResult[]> =>
        Promise.resolve([
          webfetchResult({
            url: "https://example.com/fresh",
            title: "Fresh",
            markdown: "fresh body",
          }),
        ]),
    );
    const deps = depsWithAdapter(
      {
        search: searchMock,
        scrape: unusedScrape,
      },
      { research_provider: "webfetch" },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);

    // Expired negative should have been treated as cache MISS → re-fetch.
    expect(searchMock.mock.calls.length).toBe(1);

    const p4 = db
      .prepare("SELECT status, decided_by FROM dream_actions WHERE action_id='a1'")
      .get() as DreamActionStatusRow;
    expect(p4.status).toBe("completed");
    expect(p4.decided_by).not.toBe("negative-cache-hit");

    // A real enrichment row with the freshly-fetched markdown should have been minted.
    const enrichment = db
      .prepare("SELECT payload_json FROM dream_actions WHERE phase='P5'")
      .all() as { payload_json: string }[];
    expect(enrichment.length).toBe(1);
    expect(enrichment[0]!.payload_json).toContain("fresh body");

    const cacheRow = db
      .prepare("SELECT is_negative, url FROM dream_research_cache WHERE cache_key=?")
      .get(cacheKey) as CacheStateRow | null;
    expect(cacheRow).toEqual({ is_negative: 0, url: "https://example.com/fresh" });
  });

  test("search action results cache hits on a second cycle with the same query (no re-bill)", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle2', 2, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"repeated topic\"}')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a2', 'cycle2', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"repeated topic\"}')",
    ).run();

    const searchMock = mock(
      (): Promise<WebResearchResult[]> =>
        Promise.resolve([
          {
            url: "https://example.com/article",
            title: "Article",
            markdown: "body",
            fetched_at: new Date().toISOString(),
            source_provider: "firecrawl",
            source_billed_usd: 0.02,
          },
        ]),
    );
    const deps = depsWithAdapter(
      {
        search: searchMock,
        scrape: unusedScrape,
      },
      { research_provider: "firecrawl" },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);
    await runP5Phase(db, "cycle2", testConfig(), deps);

    expect(searchMock.mock.calls.length).toBe(1);
  });

  test("P5 deduplicates enrichment actions for a repeated research URL", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle2', 2, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"repeated enrichment\"}')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a2', 'cycle2', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"repeated enrichment\"}')",
    ).run();

    const searchMock = mock(
      (): Promise<WebResearchResult[]> =>
        Promise.resolve([
          webfetchResult({
            url: "https://example.com/repeated",
            title: "Repeated",
            markdown: "same body",
          }),
        ]),
    );
    const deps = depsWithAdapter(
      {
        search: searchMock,
        scrape: unusedScrape,
      },
      { research_provider: "webfetch" },
    );

    await runP5Phase(db, "cycle1", testConfig(), deps);
    await runP5Phase(db, "cycle2", testConfig(), deps);

    expect(searchMock.mock.calls.length).toBe(1);
    const rows = db
      .prepare(
        "SELECT payload_json FROM dream_actions WHERE phase='P5' AND action_type='research_enrichment'",
      )
      .all() as { payload_json: string }[];
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payload_json) as { source_url?: string };
    expect(payload.source_url).toBe("https://example.com/repeated");
  });
});
