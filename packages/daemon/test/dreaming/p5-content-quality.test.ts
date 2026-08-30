import type { WebResearchAdapter, WebResearchResult } from "@penumbra/core";

import { applySchema, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { DreamConfig } from "@src/dreaming/config.js";
import type { ContentQualityVerdict } from "@src/dreaming/curator/content-quality-judge.js";
import { ContentQualityJudge } from "@src/dreaming/curator/content-quality-judge.js";
import { buildDreamCycleDeps } from "@src/dreaming/deps.js";
import type { ResearchDeps } from "@src/dreaming/research.js";
import { runP5Phase } from "@src/dreaming/research.js";

interface DreamActionPayloadRow {
  payload_json: string;
  status: string;
}

interface DreamActionStatusRow {
  status: string;
}

interface QualityPayload {
  low_quality?: boolean;
  quality_score: number;
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

function unusedSearch(): Promise<WebResearchResult[]> {
  return Promise.resolve([]);
}

function unusedScrape(): Promise<WebResearchResult> {
  return Promise.reject(new Error("scrape should not be used"));
}

function p5Deps(adapter: WebResearchAdapter, dreaming: Record<string, unknown>): ResearchDeps {
  return {
    projectRegistry: { get: () => ({ dreaming }) },
    getResearchAdapter: () => adapter,
  };
}

function parseQualityPayload(json: string): QualityPayload {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("quality_score" in parsed) ||
    typeof parsed.quality_score !== "number"
  ) {
    throw new TypeError("expected quality payload");
  }
  return {
    quality_score: parsed.quality_score,
    low_quality:
      "low_quality" in parsed && typeof parsed.low_quality === "boolean"
        ? parsed.low_quality
        : undefined,
  };
}

class StubContentQualityJudge extends ContentQualityJudge {
  constructor(private readonly fn: () => ContentQualityVerdict) {
    super({ threshold: 0.5 });
  }

  override judge(): Promise<ContentQualityVerdict> {
    return Promise.resolve(this.fn());
  }
}

describe("P5 content quality", () => {
  test("ContentQualityJudge scores authoritative release notes high", async () => {
    const judge = new ContentQualityJudge({ threshold: 0.5 });
    const verdict = await judge.judge(
      {
        url: "https://bun.sh/blog/bun-1-4",
        title: "Bun 1.4 release notes",
        markdown: "# Bun 1.4\n\n" + "Bun is a fast JavaScript runtime. ".repeat(40),
      },
      "bun runtime",
    );

    expect(verdict.score).toBeGreaterThanOrEqual(0.6);
    expect(verdict.lowQuality).toBe(false);
  });

  test("ContentQualityJudge flags short off-topic result", async () => {
    const judge = new ContentQualityJudge({ threshold: 0.5 });
    const verdict = await judge.judge(
      {
        url: "https://reddit.com/r/gaming",
        title: "cool gaming meme",
        markdown: "cool stuff lol",
      },
      "bun sqlite driver",
    );

    expect(verdict.lowQuality).toBe(true);
  });

  test("ContentQualityJudge gives domain bonus to trusted hosts", async () => {
    const judge = new ContentQualityJudge({ threshold: 0.5 });

    const trusted = await judge.judge(
      {
        url: "https://github.com/oven-sh/bun",
        title: "oven-sh/bun",
        markdown: "bun is a fast runtime ".repeat(30),
      },
      "bun",
    );

    const untrusted = await judge.judge(
      {
        url: "https://random-blog.example.com",
        title: "My take on bun",
        markdown: "bun is a fast runtime ".repeat(30),
      },
      "bun",
    );

    expect(trusted.score).toBeGreaterThan(untrusted.score);
  });

  test("runP5Phase routes high-quality result through with quality_score in payload", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"bun runtime\"}')",
    ).run();

    const adapter: WebResearchAdapter = {
      search: () =>
        Promise.resolve([
          {
            url: "https://bun.sh/blog/bun-1-4",
            title: "Bun 1.4 release notes",
            markdown: "# Bun 1.4\n\n" + "Bun is a fast JavaScript runtime. ".repeat(40),
            fetched_at: new Date().toISOString(),
            source_provider: "webfetch",
          },
        ]),
      scrape: unusedScrape,
    };

    const deps: ResearchDeps = {
      ...p5Deps(adapter, { research_provider: "webfetch" }),
      contentQualityJudge: new StubContentQualityJudge(() => ({
        score: 0.8,
        reasons: ["relevance:1.00", "depth:1.00", "spam:1.00", "domain:trusted"],
        lowQuality: false,
      })),
    };

    await runP5Phase(db, "cycle1", testConfig(), deps);

    const action = db
      .prepare<
        DreamActionPayloadRow,
        []
      >("SELECT payload_json, status FROM dream_actions WHERE phase='P5'")
      .get();
    if (action === null) throw new TypeError("expected P5 action row");
    const payload = parseQualityPayload(action.payload_json);

    expect(action.status).toBe("queued");
    expect(payload.quality_score).toBe(0.8);
    expect(payload.low_quality).toBeUndefined();
  });

  test("runP5Phase filters disallowed domain BEFORE judging — judge never called for disallowed result", async () => {
    const db = new Database(":memory:");
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
      search: () =>
        Promise.resolve([
          {
            url: "https://allowed.com/page",
            title: "Good",
            markdown: "good content",
            fetched_at: "",
            source_provider: "webfetch" as const,
          },
          {
            url: "https://disallowed.com/page",
            title: "Bad",
            markdown: "bad content",
            fetched_at: "",
            source_provider: "webfetch" as const,
          },
        ]),
      scrape: unusedScrape,
    };

    const deps: ResearchDeps = {
      ...p5Deps(adapter, {
        research_provider: "webfetch",
        allowed_domains: ["allowed.com"],
      }),
      contentQualityJudge: new StubContentQualityJudge(() => {
        judgeCallCount++;
        return { score: 0.8, reasons: [], lowQuality: false };
      }),
    };

    await runP5Phase(db, "cycle1", testConfig(), deps);

    expect(judgeCallCount).toBe(1);
    const p5Actions = db
      .prepare<
        DreamActionPayloadRow,
        []
      >("SELECT payload_json, status FROM dream_actions WHERE phase='P5'")
      .all();
    expect(p5Actions).toHaveLength(1);
  });

  test("runP5Phase cache key consistent — second call with same query+url hits cache, adapter not called again", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();

    const targetUrl = "https://bun.sh/blog/bun-1-4";
    const payload = JSON.stringify({ query: "bun runtime", url: targetUrl });

    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', ?)",
    ).run(payload);

    let scrapeCallCount = 0;
    const adapter: WebResearchAdapter = {
      search: unusedSearch,
      scrape: () => {
        scrapeCallCount++;
        return Promise.resolve({
          url: targetUrl,
          title: "Bun 1.4",
          markdown: "content",
          fetched_at: new Date().toISOString(),
          source_provider: "webfetch" as const,
        });
      },
    };

    const deps = p5Deps(adapter, { research_provider: "webfetch" });

    await runP5Phase(db, "cycle1", testConfig(), deps);
    expect(scrapeCallCount).toBe(1);

    // Insert second action with identical payload
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a2', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', ?)",
    ).run(payload);

    await runP5Phase(db, "cycle1", testConfig(), deps);
    expect(scrapeCallCount).toBe(1); // cache hit — adapter NOT called again
  });

  test("runP5Phase still gates by allowed_domains when no judge is configured", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    db.prepare(
      "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"url\":\"http://bad.com\"}')",
    ).run();

    const adapter: WebResearchAdapter = {
      search: unusedSearch,
      scrape: () =>
        Promise.resolve(
          webfetchResult({
            url: "http://bad.com",
            title: "x",
            markdown: "x",
          }),
        ),
    };
    const deps = p5Deps(adapter, {
      research_provider: "webfetch",
      allowed_domains: ["good.com"],
    });

    await runP5Phase(db, "cycle1", testConfig(), deps);

    const p4Action = db
      .prepare<DreamActionStatusRow, []>("SELECT status FROM dream_actions WHERE action_id='a1'")
      .get();
    if (p4Action === null) throw new TypeError("expected P4 action row");
    expect(p4Action.status).toBe("failed");

    const p5Actions = db
      .prepare<
        DreamActionPayloadRow,
        []
      >("SELECT payload_json, status FROM dream_actions WHERE phase='P5'")
      .all();
    expect(p5Actions.length).toBe(0);
  });

  test("buildDreamCycleDeps uses dream config contentQualityThreshold", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const deps = buildDreamCycleDeps(
      {},
      db,
      testConfig({
        contentQualityThreshold: 0.7,
      }),
    );
    expect(deps.contentQualityJudge).toBeDefined();

    const verdict = await deps.contentQualityJudge!.judge(
      {
        url: "https://random-blog.example.com/article",
        title: "runtime notes",
        markdown: "bun runtime review. ".repeat(8),
      },
      "bun runtime latency",
    );

    expect(verdict.lowQuality).toBe(true);
    expect(verdict.score).toBeLessThan(0.7);
  });
});
