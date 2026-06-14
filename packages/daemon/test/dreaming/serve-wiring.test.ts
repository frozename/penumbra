import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema, loadSqliteVec } from "@penumbra/core";
import { buildDreamCycleDeps } from "../../src/dreaming/deps.js";

function insertPressureSnapshot(
  db: Database,
  input: {
    eventId: string;
    provider: string;
    usedPct: number;
    sourceKind?: string;
    ageSeconds?: number;
  },
): void {
  // Default to a fresh snapshot (age 0); pass ageSeconds to simulate a stale one
  // (older than the reader's 30-min freshness window).
  const ts = new Date(Date.now() - (input.ageSeconds ?? 0) * 1000).toISOString();
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, user_id, machine_id,
      event_type, lane, provider, payload_json
    ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)
  `,
  ).run(
    input.eventId,
    ts,
    ts,
    input.provider,
    JSON.stringify({
      window_label: "24h",
      model: null,
      used_pct: input.usedPct,
      resets_at: null,
      source_kind: input.sourceKind ?? "subscription",
    }),
  );
}

describe("buildDreamCycleDeps", () => {
  let db: Database;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);
    savedApiKey = process.env.FIRECRAWL_API_KEY;
  });

  afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env.FIRECRAWL_API_KEY;
    } else {
      process.env.FIRECRAWL_API_KEY = savedApiKey;
    }
    db.close();
  });

  test("returns all four dep fields when embedder and FIRECRAWL_API_KEY are present", () => {
    process.env.FIRECRAWL_API_KEY = "test-key-123";

    const fakeProjectRegistry = {
      get: (_id: string) => null,
      list: () => [],
    };
    const fakeEmbedder = {
      embed: async (_bodies: string[]) => [new Float32Array([0.1, 0.2, 0.3])],
    };
    const services = { projectRegistry: fakeProjectRegistry, embedder: fakeEmbedder };

    const deps = buildDreamCycleDeps(services, db, {} as any);

    expect(deps.projectRegistry).toBe(fakeProjectRegistry);
    expect(typeof deps.getResearchAdapter).toBe("function");
    const adapter = deps.getResearchAdapter!({ dreaming: { research_provider: "firecrawl" } });
    expect(typeof adapter?.search).toBe("function");
    expect(typeof adapter?.scrape).toBe("function");
    expect(typeof deps.memoryObserve).toBe("function");
    expect(typeof deps.onReembed).toBe("function");
  });

  test("projectRegistry in deps reflects runtime service replacement", () => {
    const registryA = {
      get: (_id: string) => undefined,
      list: () => [],
    };
    const registryB = {
      get: (_id: string) => undefined,
      list: () => [],
    };
    const services: any = {
      projectRegistry: registryA,
    };

    const deps = buildDreamCycleDeps(services, db, {} as any);
    services.projectRegistry = registryB;

    expect(deps.projectRegistry).toBe(registryB);
  });

  test("omits onReembed when no embedder supplied", () => {
    process.env.FIRECRAWL_API_KEY = "test-key-123";

    const deps = buildDreamCycleDeps(
      { projectRegistry: undefined, embedder: undefined },
      db,
      {} as any,
    );

    expect(deps.onReembed).toBeUndefined();
    expect(typeof deps.getResearchAdapter).toBe("function");
    expect(typeof deps.memoryObserve).toBe("function");
  });

  test("pressureGuard reports whether any subscription provider is over pressure", async () => {
    const deps = buildDreamCycleDeps({}, db, {} as any);

    expect(typeof deps.pressureGuard?.check).toBe("function");

    insertPressureSnapshot(db, {
      eventId: "pressure-openai",
      provider: "openai",
      usedPct: 0.05,
    });
    expect(await deps.pressureGuard!.check()).toEqual({ anyThrottled: false });

    insertPressureSnapshot(db, {
      eventId: "pressure-anthropic",
      provider: "anthropic",
      usedPct: 0.95,
    });
    expect(await deps.pressureGuard!.check()).toEqual({ anyThrottled: true });
  });

  test("pressureGuard fails OPEN on a STALE over-pressure snapshot (no permanent wedge)", async () => {
    const deps = buildDreamCycleDeps({}, db, {} as any);

    // A snapshot older than the reader's 30-min freshness window that reads as
    // over-pressure must NOT throttle dreaming — otherwise a single forgotten/stale
    // reading would wedge dreaming forever.
    insertPressureSnapshot(db, {
      eventId: "pressure-stale-anthropic",
      provider: "anthropic",
      usedPct: 0.99,
      ageSeconds: 3600,
    });
    expect(await deps.pressureGuard!.check()).toEqual({ anyThrottled: false });
  });

  test("pressureGuard reports not-throttled when no pressure data exists (fail open)", async () => {
    const deps = buildDreamCycleDeps({}, db, {} as any);
    expect(await deps.pressureGuard!.check()).toEqual({ anyThrottled: false });
  });

  test("uses webfetch adapter when project specifies webfetch provider", () => {
    delete process.env.FIRECRAWL_API_KEY;

    const deps = buildDreamCycleDeps({}, db, {} as any);

    const adapter = deps.getResearchAdapter!({ dreaming: { research_provider: "webfetch" } });
    expect(typeof adapter?.search).toBe("function");
    expect(typeof adapter?.scrape).toBe("function");
  });

  test("getResearchAdapter returns null when project has research_provider=off", () => {
    const deps = buildDreamCycleDeps({}, db, {} as any);

    const result = deps.getResearchAdapter!({ dreaming: { research_provider: "off" } });
    expect(result).toBeNull();
  });

  test("getResearchAdapter returns null when project has no dreaming config", () => {
    const deps = buildDreamCycleDeps({}, db, {} as any);

    const result = deps.getResearchAdapter!({});
    expect(result).toBeNull();
  });

  test("getResearchAdapter returns different adapter instances for firecrawl vs webfetch", () => {
    process.env.FIRECRAWL_API_KEY = "test-key-123";

    const deps = buildDreamCycleDeps({}, db, {} as any);

    const firecrawlAdapter = deps.getResearchAdapter!({
      dreaming: { research_provider: "firecrawl" },
    });
    const webfetchAdapter = deps.getResearchAdapter!({
      dreaming: { research_provider: "webfetch" },
    });

    expect(firecrawlAdapter).not.toBeNull();
    expect(webfetchAdapter).not.toBeNull();
    // Different classes — firecrawl falls back to webfetch, plain webfetch doesn't
    expect(firecrawlAdapter).not.toBe(webfetchAdapter);
    expect(Object.getPrototypeOf(firecrawlAdapter!)).not.toBe(
      Object.getPrototypeOf(webfetchAdapter!),
    );
  });

  test("memoryObserve inserts a t2_memories row and returns memory_id", async () => {
    process.env.FIRECRAWL_API_KEY = "test-key-123";
    const deps = buildDreamCycleDeps({}, db, {} as any);

    const result = await deps.memoryObserve!("## Brief content", "proj-abc", "cycle-xyz-1234");

    expect(typeof result.memory_id).toBe("string");
    expect(result.memory_id.length).toBeGreaterThan(0);

    const rows = db
      .prepare("SELECT * FROM t2_memories WHERE memory_id = ?")
      .all(result.memory_id) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("brief");
    expect(rows[0].user_id).toBe("system");
    expect(rows[0].project_id).toBe("proj-abc");
    expect(rows[0].body).toBe("## Brief content");
  });

  test("onReembed delegates to embedder.embed", async () => {
    const vec = new Float32Array([0.5, 0.6]);
    const seen: string[][] = [];
    const fakeEmbedder = {
      embed: async (bodies: string[]) => {
        seen.push(bodies);
        return [vec];
      },
    };

    const deps = buildDreamCycleDeps({ embedder: fakeEmbedder }, db, {} as any);
    const result = await deps.onReembed!("mem-1", "hello world");

    expect(result).toBe(vec);
    expect(seen).toEqual([["hello world"]]);
  });
});
