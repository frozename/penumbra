import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate, routeAgent } from "../../src/index.js";
import { AgentPerformanceWriter } from "../../src/writers/agent-performance.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
}

const NOW = new Date("2026-05-01T12:00:00Z");

describe("routeAgent", () => {
  test("headroom-weighted routing applies factor when flag is on", () => {
    const input = {
      db,
      detail: "rank" as const,
      taskType: "implement_substantial" as const,
      agentchatConfig: {
        role_routing: { headroom_weighting: true },
        agents: [
          {
            name: "alpha",
            roles: ["coder"],
            pricing_mode: "subscription" as const,
            subscription_provider: "prov1",
          },
          {
            name: "beta",
            roles: ["coder"],
            pricing_mode: "subscription" as const,
            subscription_provider: "prov2",
          },
        ],
      },
      applyPressure: {
        snapshots: [
          {
            provider: "prov1",
            window_label: "five_minute",
            model: null,
            used_pct: 0.2,
            resets_at: null,
            observed_at: NOW.toISOString(),
            source_kind: "test",
          },
          {
            provider: "prov2",
            window_label: "five_minute",
            model: null,
            used_pct: 0.8,
            resets_at: null,
            observed_at: NOW.toISOString(),
            source_kind: "test",
          },
        ],
      },
    };

    // With flag on, alpha score * 0.8, beta score * 0.2
    const rankOn = routeAgent(input);
    const alphaOn = (rankOn as any).candidates.candidates.find(
      (c: any) => c.agent_name === "alpha",
    );
    const betaOn = (rankOn as any).candidates.candidates.find((c: any) => c.agent_name === "beta");

    // With flag off, scores should be unchanged
    input.agentchatConfig.role_routing.headroom_weighting = false;
    const rankOff = routeAgent(input);
    const alphaOff = (rankOff as any).candidates.candidates.find(
      (c: any) => c.agent_name === "alpha",
    );
    const betaOff = (rankOff as any).candidates.candidates.find(
      (c: any) => c.agent_name === "beta",
    );

    // Using simple precision check
    expect(alphaOn.score).toBeCloseTo(alphaOff.score * 0.8, 2);
    expect(betaOn.score).toBeCloseTo(betaOff.score * 0.2, 2);
  });

  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(db);

    writer.upsert({
      performance_id: "alpha-1",
      ts: "2026-04-30T10:00:00Z",
      handoff_id: "h-alpha-1",
      conversation_id: "c-alpha-1",
      project_id: "proj",
      agent_name: "alpha",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.1,
      tokens_used: 100,
      latency_ms: 60000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "beta-1",
      ts: "2026-04-30T11:00:00Z",
      handoff_id: "h-beta-1",
      conversation_id: "c-beta-1",
      project_id: "proj",
      agent_name: "beta",
      task_type: "implement_substantial",
      outcome: "pr_opened",
      rounds: 2,
      smoke_pass: "y",
      reviewer_findings: 1,
      maestro_score: null,
      cost_usd: 0.2,
      tokens_used: 100,
      latency_ms: 30000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "gamma-1",
      ts: "2026-04-30T12:00:00Z",
      handoff_id: "h-gamma-1",
      conversation_id: "c-gamma-1",
      project_id: "proj",
      agent_name: "gamma",
      task_type: "implement_substantial",
      outcome: "no_changes",
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "reviewer-1",
      ts: "2026-04-30T13:00:00Z",
      handoff_id: "h-reviewer-1",
      conversation_id: "c-reviewer-1",
      project_id: "proj",
      agent_name: "reviewer",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 120000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "reviewer-2",
      ts: "2026-04-30T13:30:00Z",
      handoff_id: "h-reviewer-2",
      conversation_id: "c-reviewer-2",
      project_id: "proj",
      agent_name: "reviewer",
      task_type: "review_adversarial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 120000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
  });

  test("rank mode returns ranked candidates", () => {
    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_substantial",
      since: "2026-04-29T00:00:00Z",
      minSamples: 1,
      includeNeutral: false,
      now: NOW,
    });

    expect(out.detail).toBe("rank");
    if (out.detail !== "rank") return;
    expect(out.candidates.candidates.map((candidate) => candidate.agent_name)).toEqual(
      expect.arrayContaining(["alpha", "beta"]),
    );
  });

  test("summary mode returns the current recommendation rows", () => {
    const out = routeAgent({
      db,
      detail: "summary",
      taskType: "implement_substantial",
      windowDays: 7,
      now: NOW,
    });

    expect(out.detail).toBe("summary");
    if (out.detail !== "summary") return;
    expect(out.recommendations.map((row) => row.agent_name)).toEqual([
      "beta",
      "alpha",
      "reviewer",
      "gamma",
    ]);
    expect(out.recommendations[0]!.avg_latency_seconds).toBe(30);
    expect(out.recommendations[1]!.avg_latency_seconds).toBe(60);
  });

  test("rank mode breaks score ties by lower latency", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "fast-1",
      ts: "2026-04-30T14:00:00Z",
      handoff_id: "h-fast-1",
      conversation_id: "c-fast-1",
      project_id: "proj",
      agent_name: "zulu-fast",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.1,
      tokens_used: 100,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "slow-1",
      ts: "2026-04-30T15:00:00Z",
      handoff_id: "h-slow-1",
      conversation_id: "c-slow-1",
      project_id: "proj",
      agent_name: "aardvark-slow",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.1,
      tokens_used: 100,
      latency_ms: 5000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_substantial",
      minSamples: 1,
      includeNeutral: false,
      agentRegistry: ["zulu-fast", "aardvark-slow"],
      now: NOW,
    });

    expect(out.detail).toBe("rank");
    if (out.detail !== "rank") return;
    expect(out.candidates.candidates.map((candidate) => candidate.agent_name)).toEqual([
      "zulu-fast",
      "aardvark-slow",
    ]);
  });

  test("rank mode places null latency after numeric latency on equal score and success rate", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "timed-1",
      ts: "2026-04-30T14:00:00Z",
      handoff_id: "h-timed-1",
      conversation_id: "c-timed-1",
      project_id: "proj",
      agent_name: "zulu-timed",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.1,
      tokens_used: 100,
      latency_ms: 2000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "unknown-1",
      ts: "2026-04-30T15:00:00Z",
      handoff_id: "h-unknown-1",
      conversation_id: "c-unknown-1",
      project_id: "proj",
      agent_name: "aardvark-unknown",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.1,
      tokens_used: 100,
      latency_ms: null,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_substantial",
      minSamples: 1,
      includeNeutral: false,
      agentRegistry: ["zulu-timed", "aardvark-unknown"],
      now: NOW,
    });

    expect(out.detail).toBe("rank");
    if (out.detail !== "rank") return;
    expect(out.candidates.candidates.map((candidate) => candidate.agent_name)).toEqual([
      "zulu-timed",
      "aardvark-unknown",
    ]);
  });

  test("rank mode keeps higher score ahead of lower score even when slower", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "strong-1",
      ts: "2026-04-30T14:00:00Z",
      handoff_id: "h-strong-1",
      conversation_id: "c-strong-1",
      project_id: "proj",
      agent_name: "zulu-strong",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.1,
      tokens_used: 100,
      latency_ms: 9000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "weak-1",
      ts: "2026-04-30T15:00:00Z",
      handoff_id: "h-weak-1",
      conversation_id: "c-weak-1",
      project_id: "proj",
      agent_name: "aardvark-weak",
      task_type: "implement_substantial",
      outcome: "failed",
      rounds: 1,
      smoke_pass: "n",
      reviewer_findings: 2,
      maestro_score: null,
      cost_usd: 0.1,
      tokens_used: 100,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_substantial",
      minSamples: 1,
      includeNeutral: false,
      agentRegistry: ["zulu-strong", "aardvark-weak"],
      now: NOW,
    });

    expect(out.detail).toBe("rank");
    if (out.detail !== "rank") return;
    expect(out.candidates.candidates.map((candidate) => candidate.agent_name)).toEqual([
      "zulu-strong",
      "aardvark-weak",
    ]);
  });

  test("single mode returns a role route and respects role task inference", () => {
    const out = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      message: "Implementation Plan for a new workflow",
      agentchatConfig: {
        agents: [{ name: "reviewer", roles: ["reviewer"], api_provider: "openai" }],
      },
      now: NOW,
    });

    expect(out.detail).toBe("single");
    if (out.detail !== "single") return;
    expect(out.route).toEqual({
      agent: "reviewer",
      role: "reviewer",
      taskType: "implement_substantial",
    });
  });

  test("pressure and registry filters exclude blocked agents", () => {
    const pressured = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      message: "Implementation Plan",
      agentRegistry: ["reviewer"],
      agentchatConfig: {
        agents: [
          {
            name: "reviewer",
            roles: ["reviewer"],
            pricing_mode: "subscription",
            subscription_provider: "anthropic",
          },
        ],
      },
      applyPressure: {
        snapshots: [
          {
            provider: "anthropic",
            window_label: "24h",
            model: null,
            used_pct: 0.95,
            resets_at: null,
            observed_at: "2026-05-01T11:00:00Z",
            source_kind: "subscription",
          },
        ],
      },
      now: NOW,
    });
    expect(pressured.detail).toBe("single");
    if (pressured.detail !== "single") return;
    expect(pressured.route).toBeNull();

    const registered = routeAgent({
      db,
      detail: "summary",
      taskType: "implement_substantial",
      agentRegistry: ["alpha"],
      now: NOW,
    });
    expect(registered.detail).toBe("summary");
    if (registered.detail !== "summary") return;
    expect(registered.recommendations.map((row) => row.agent_name)).toEqual(["alpha"]);
  });

  test("single mode honors role_exploration_policy='ranked-first'", () => {
    const out = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      message: "Implementation Plan",
      agentchatConfig: {
        agents: [
          { name: "reviewer", roles: ["reviewer"], api_provider: "openai" },
          { name: "reviewer-unsampled", roles: ["reviewer"], api_provider: "anthropic" },
        ],
      },
      roleExplorationPolicy: "ranked-first",
      now: NOW,
    });

    expect(out.detail).toBe("single");
    if (out.detail !== "single") return;
    expect(out.route).toEqual({
      agent: "reviewer",
      role: "reviewer",
      taskType: "implement_substantial",
    });
  });

  test("single mode honors role_exploration_policy='unsampled-first'", () => {
    const out = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      message: "Implementation Plan",
      agentchatConfig: {
        agents: [
          { name: "reviewer", roles: ["reviewer"], api_provider: "openai" },
          { name: "reviewer-unsampled", roles: ["reviewer"], api_provider: "anthropic" },
        ],
      },
      roleExplorationPolicy: "unsampled-first",
      now: NOW,
    });

    expect(out.detail).toBe("single");
    if (out.detail !== "single") return;
    expect(out.route).toEqual({
      agent: "reviewer-unsampled",
      role: "reviewer",
      taskType: "implement_substantial",
    });
  });

  test("single mode falls back to the configured default role agent", () => {
    const out = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      message: "Implementation Plan",
      agentchatConfig: {
        agents: [{ name: "reviewer-default", roles: ["reviewer"], api_provider: "openai" }],
      },
      defaultRoles: { reviewer: "reviewer-default" },
      now: NOW,
    });

    expect(out.detail).toBe("single");
    if (out.detail !== "single") return;
    expect(out.route).toEqual({
      agent: "reviewer-default",
      role: "reviewer",
      taskType: "implement_substantial",
    });
  });

  test("single mode falls back to the first role agent when nothing is sampled or defaulted", () => {
    const out = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      message: "Implementation Plan",
      agentchatConfig: {
        agents: [
          { name: "reviewer-first", roles: ["reviewer"], api_provider: "openai" },
          { name: "reviewer-second", roles: ["reviewer"], api_provider: "anthropic" },
        ],
      },
      now: NOW,
    });

    expect(out.detail).toBe("single");
    if (out.detail !== "single") return;
    expect(out.route).toEqual({
      agent: "reviewer-first",
      role: "reviewer",
      taskType: "implement_substantial",
    });
  });

  test("single mode only applies pressure filtering when applyPressure is present", () => {
    const pressured = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      message: "Implementation Plan",
      agentchatConfig: {
        agents: [
          {
            name: "reviewer",
            roles: ["reviewer"],
            pricing_mode: "subscription",
            subscription_provider: "anthropic",
          },
          { name: "reviewer-unsampled", roles: ["reviewer"], api_provider: "openai" },
        ],
      },
      roleExplorationPolicy: "ranked-first",
      applyPressure: {
        snapshots: [
          {
            provider: "anthropic",
            window_label: "24h",
            model: null,
            used_pct: 0.95,
            resets_at: null,
            observed_at: "2026-05-01T11:00:00Z",
            source_kind: "subscription",
          },
        ],
      },
      now: NOW,
    });
    expect(pressured.detail).toBe("single");
    if (pressured.detail !== "single") return;
    expect(pressured.route).toEqual({
      agent: "reviewer-unsampled",
      role: "reviewer",
      taskType: "implement_substantial",
    });

    const unpressured = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      message: "Implementation Plan",
      agentchatConfig: {
        agents: [
          {
            name: "reviewer",
            roles: ["reviewer"],
            pricing_mode: "subscription",
            subscription_provider: "anthropic",
          },
          { name: "reviewer-unsampled", roles: ["reviewer"], api_provider: "openai" },
        ],
      },
      roleExplorationPolicy: "ranked-first",
      now: NOW,
    });
    expect(unpressured.detail).toBe("single");
    if (unpressured.detail !== "single") return;
    expect(unpressured.route).toEqual({
      agent: "reviewer",
      role: "reviewer",
      taskType: "implement_substantial",
    });
  });

  test("minSamples=0 keeps zero-sample candidates out of the way without filtering them away", () => {
    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "docs_mechanical",
      minSamples: 0,
      includeNeutral: true,
      now: NOW,
    });

    expect(out.detail).toBe("rank");
    if (out.detail !== "rank") return;
    expect(out.candidates.candidates).toEqual([]);
  });
});

describe("latency_weighting routing", () => {
  let db: Database;

  const baseRow = {
    project_id: "proj",
    rounds: 1,
    smoke_pass: "y" as const,
    reviewer_findings: 0,
    maestro_score: null,
    cost_usd: null,
    tokens_used: null,
    latency_ms: null,
    source: "reconciler" as const,
    notes: null,
    metadata_json: "{}",
  };

  const seed = (
    writer: AgentPerformanceWriter,
    agent: string,
    i: number,
    fields: {
      outcome: "merged" | "failed" | "test_failed";
      exec_ms: number | null;
      framework_overhead_ms?: number | null;
    },
  ) => {
    writer.upsert({
      ...baseRow,
      performance_id: `${agent}-${i}`,
      ts: `2026-04-30T1${i % 10}:00:00Z`,
      handoff_id: `h-${agent}-${i}`,
      conversation_id: `c-${agent}-${i}`,
      agent_name: agent,
      task_type: "implement_substantial",
      outcome: fields.outcome,
      exec_ms: fields.exec_ms,
      framework_overhead_ms: fields.framework_overhead_ms ?? null,
    });
  };

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  const rank = (latency_weighting: boolean) => {
    const out = routeAgent({
      db,
      detail: "rank" as const,
      taskType: "implement_substantial" as const,
      minSamples: 1,
      includeNeutral: false,
      now: NOW,
      agentchatConfig: { role_routing: { latency_weighting }, agents: [] },
    });
    if (out.detail !== "rank") throw new Error("expected rank");
    return out.candidates.candidates;
  };
  const find = (cands: ReturnType<typeof rank>, name: string) => {
    const c = cands.find((x) => x.agent_name === name);
    if (!c) throw new Error(`candidate ${name} not found`);
    return c;
  };

  test("flag OFF: exec_ms does not affect score (regression-safe)", () => {
    const w = new AgentPerformanceWriter(db);
    seed(w, "swift", 1, { outcome: "merged", exec_ms: 10_000 });
    seed(w, "sloth", 1, { outcome: "merged", exec_ms: 300_000 });
    const off = rank(false);
    expect(find(off, "swift").score).toBeCloseTo(find(off, "sloth").score, 6);
  });

  test("flag ON: lower exec_ms scores higher, all else equal", () => {
    const w = new AgentPerformanceWriter(db);
    seed(w, "swift", 1, { outcome: "merged", exec_ms: 10_000 });
    seed(w, "sloth", 1, { outcome: "merged", exec_ms: 300_000 });
    expect(find(rank(true), "swift").score).toBeGreaterThan(find(rank(true), "sloth").score);
    // and OFF they are equal — isolates the latency term as the only differentiator
    expect(find(rank(false), "swift").score).toBeCloseTo(find(rank(false), "sloth").score, 6);
  });

  test("flag ON: latency term keys on true-exec (exec_ms - framework_overhead_ms)", () => {
    const w = new AgentPerformanceWriter(db);
    seed(w, "coldy", 1, {
      outcome: "merged",
      exec_ms: 100_000,
      framework_overhead_ms: 90_000,
    });
    seed(w, "worky", 1, { outcome: "merged", exec_ms: 100_000, framework_overhead_ms: 0 });
    expect(find(rank(true), "coldy").score).toBeGreaterThan(find(rank(true), "worky").score);
  });

  test("flag ON: null framework_overhead_ms falls back to raw exec_ms", () => {
    const w = new AgentPerformanceWriter(db);
    seed(w, "swift", 1, { outcome: "merged", exec_ms: 10_000 });
    seed(w, "sloth", 1, { outcome: "merged", exec_ms: 300_000 });
    expect(find(rank(true), "swift").score).toBeGreaterThan(find(rank(true), "sloth").score);
  });

  test("flag ON: outcome dominates latency (>=0.28 outcome-weight invariant)", () => {
    const w = new AgentPerformanceWriter(db);
    // good-slow: 2x merged (success 1.0) but slowest exec
    seed(w, "good-slow", 1, { outcome: "merged", exec_ms: 300_000 });
    seed(w, "good-slow", 2, { outcome: "merged", exec_ms: 300_000 });
    // weak-fast: merged + test_failed (success 0.5) but fastest exec
    seed(w, "weak-fast", 1, { outcome: "merged", exec_ms: 10_000 });
    seed(w, "weak-fast", 2, { outcome: "test_failed", exec_ms: 10_000 });
    expect(rank(true)[0]!.agent_name).toBe("good-slow");
  });

  test("flag ON: exec_ms is winsorized (one outlier dispatch does not inflate it)", () => {
    const w = new AgentPerformanceWriter(db);
    for (let i = 1; i <= 9; i++) seed(w, "tail", i, { outcome: "merged", exec_ms: 5_000 });
    seed(w, "tail", 10, { outcome: "merged", exec_ms: 500_000 }); // single outlier
    // winsorized mean clips the outlier to the in-distribution tail, not (9*5000+500000)/10=54500
    expect(find(rank(true), "tail").avg_exec_ms).toBeCloseTo(5_000, 0);
  });

  test("flag ON: min-success floor — a sub-floor fast agent gets no latency boost", () => {
    const w = new AgentPerformanceWriter(db);
    // subfloor-fast: 1 merged + 5 failed => success 1/6 ~ 0.167 < 0.2 floor; fastest exec
    seed(w, "subfloor-fast", 1, { outcome: "merged", exec_ms: 5_000 });
    for (let i = 2; i <= 6; i++) seed(w, "subfloor-fast", i, { outcome: "failed", exec_ms: 5_000 });
    // solid-slow: merged, success 1.0, slowest exec (eligible)
    seed(w, "solid-slow", 1, { outcome: "merged", exec_ms: 300_000 });
    // sub-floor agent is excluded from latency weighting => score identical with flag on/off
    expect(find(rank(true), "subfloor-fast").score).toBeCloseTo(
      find(rank(false), "subfloor-fast").score,
      6,
    );
    // an eligible agent's score DOES move when the flag toggles
    expect(find(rank(true), "solid-slow").score).not.toBeCloseTo(
      find(rank(false), "solid-slow").score,
      6,
    );
  });
});
