import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { RoutingBias } from "../../src/readers/routing-bias.js";
import type { AgentRankOutput } from "../../src/schemas/agent-performance.js";
import type { RouteAgentInput, RouteAgentOutput } from "../../src/services/agent-routing.js";

import { loadSqliteVec, migrate, resolveBiasEffect, routeAgent } from "../../src/index.js";
import { AgentPerformanceWriter } from "../../src/writers/agent-performance.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const NOW = new Date("2026-05-01T12:00:00Z");

type RankCandidate = AgentRankOutput["candidates"][number];

function rankCandidates(out: RouteAgentOutput): RankCandidate[] {
  if (out.detail !== "rank") {
    throw new Error(`expected rank, got ${out.detail}`);
  }
  return out.candidates.candidates;
}

function findCandidate(out: RouteAgentOutput, agentName: string): RankCandidate {
  const candidate = rankCandidates(out).find((c) => c.agent_name === agentName);
  if (!candidate) throw new Error(`candidate ${agentName} not found`);
  return candidate;
}

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
            used_pct: 20,
            resets_at: null,
            observed_at: NOW.toISOString(),
            source_kind: "test",
          },
          {
            provider: "prov2",
            window_label: "five_minute",
            model: null,
            used_pct: 80,
            resets_at: null,
            observed_at: NOW.toISOString(),
            source_kind: "test",
          },
        ],
      },
      now: NOW,
    };

    // With flag on, alpha score * 0.8, beta score * 0.2
    const rankOn = routeAgent(input);
    const alphaOn = findCandidate(rankOn, "alpha");
    const betaOn = findCandidate(rankOn, "beta");

    // With flag off, scores should be unchanged
    input.agentchatConfig.role_routing.headroom_weighting = false;
    const rankOff = routeAgent(input);
    const alphaOff = findCandidate(rankOff, "alpha");
    const betaOff = findCandidate(rankOff, "beta");

    // Using simple precision check
    expect(alphaOn.score).toBeCloseTo(alphaOff.score * 0.8, 2);
    expect(betaOn.score).toBeCloseTo(betaOff.score * 0.2, 2);
  });

  test("headroom weighting keeps a ten percent provider viable and prefers it over high pressure", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "low-pressure-1",
      ts: "2026-04-30T11:30:00Z",
      handoff_id: "h-low-pressure-1",
      conversation_id: "c-low-pressure-1",
      project_id: "proj",
      agent_name: "low-pressure",
      task_type: "implement_substantial",
      outcome: "pr_opened",
      rounds: 2,
      smoke_pass: "y",
      reviewer_findings: 1,
      maestro_score: null,
      cost_usd: 0.2,
      tokens_used: 100,
      latency_ms: 90000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "high-pressure-1",
      ts: "2026-04-30T11:31:00Z",
      handoff_id: "h-high-pressure-1",
      conversation_id: "c-high-pressure-1",
      project_id: "proj",
      agent_name: "high-pressure",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: 0.1,
      tokens_used: 100,
      latency_ms: 30000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_substantial",
      since: "2026-04-29T00:00:00Z",
      agentRegistry: ["low-pressure", "high-pressure"],
      agentchatConfig: {
        role_routing: { headroom_weighting: true },
        agents: [
          {
            name: "low-pressure",
            roles: ["coder"],
            pricing_mode: "subscription" as const,
            subscription_provider: "low-provider",
          },
          {
            name: "high-pressure",
            roles: ["coder"],
            pricing_mode: "subscription" as const,
            subscription_provider: "high-provider",
          },
        ],
      },
      applyPressure: {
        snapshots: [
          {
            provider: "low-provider",
            window_label: "five_minute",
            model: null,
            used_pct: 10,
            resets_at: null,
            observed_at: NOW.toISOString(),
            source_kind: "test",
          },
          {
            provider: "high-provider",
            window_label: "five_minute",
            model: null,
            used_pct: 95,
            resets_at: null,
            observed_at: NOW.toISOString(),
            source_kind: "test",
          },
        ],
      },
      now: NOW,
    });

    const candidates = rankCandidates(out);
    const low = findCandidate(out, "low-pressure");
    const high = findCandidate(out, "high-pressure");
    expect(low.score).toBeGreaterThan(0);
    expect(candidates[0]!.agent_name).toBe("low-pressure");
    expect(low.score).toBeGreaterThan(high.score);
  });

  test("F7: phantom agent_names absent from agentRegistry are dropped (rank + summary)", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "f7-legit-1",
      ts: "2026-04-30T14:00:00Z",
      handoff_id: "h-f7-legit-1",
      conversation_id: "c-f7-legit-1",
      project_id: "proj",
      agent_name: "legit-seat",
      task_type: "review_adversarial",
      outcome: "merged",
      gate_outcome: "passed",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "manual_seed",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "f7-phantom-1",
      ts: "2026-04-30T14:01:00Z",
      handoff_id: "h-f7-phantom-1",
      conversation_id: "c-f7-phantom-1",
      project_id: "proj",
      agent_name: "penumbra",
      task_type: "review_adversarial",
      outcome: "merged",
      gate_outcome: "passed",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "manual_seed",
      notes: null,
      metadata_json: "{}",
    });

    // Self-audit: if a future config promotes "penumbra" to a real seat, this
    // guard trips and the test must be retired/updated rather than silently
    // passing for the wrong reason.
    const registry = ["legit-seat"];
    expect(registry).not.toContain("penumbra");

    const rankWith = routeAgent({
      db,
      detail: "rank",
      taskType: "review_adversarial",
      since: "2026-04-29T00:00:00Z",
      agentRegistry: registry,
      now: NOW,
    });
    const rankWithNames = rankCandidates(rankWith).map((c) => c.agent_name);
    expect(rankWithNames).toContain("legit-seat");
    expect(rankWithNames).not.toContain("penumbra");

    const summaryWith = routeAgent({
      db,
      detail: "summary",
      taskType: "review_adversarial",
      windowDays: 30,
      agentRegistry: registry,
      now: NOW,
    });
    if (summaryWith.detail !== "summary") throw new Error("expected summary");
    const summaryNames = summaryWith.recommendations.map((r) => r.agent_name);
    expect(summaryNames).toContain("legit-seat");
    expect(summaryNames).not.toContain("penumbra");

    // Guard: with NO membership signal, F7 is OFF (config-less test paths and
    // brief config-reload windows must not empty the pool). Phantom slips
    // through here — that's intentional, gated by registry presence.
    const rankWithout = routeAgent({
      db,
      detail: "rank",
      taskType: "review_adversarial",
      since: "2026-04-29T00:00:00Z",
      now: NOW,
    });
    expect(rankCandidates(rankWithout).map((c) => c.agent_name)).toContain("penumbra");
  });

  test("F7: agentchatConfig.agents alone drives the allowlist when agentRegistry is absent", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "f7c-legit",
      ts: "2026-04-30T15:00:00Z",
      handoff_id: "h-f7c-legit",
      conversation_id: "c-f7c-legit",
      project_id: "proj",
      agent_name: "config-seat",
      task_type: "review_adversarial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "manual_seed",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "f7c-phantom",
      ts: "2026-04-30T15:01:00Z",
      handoff_id: "h-f7c-phantom",
      conversation_id: "c-f7c-phantom",
      project_id: "proj",
      agent_name: "parse-artifact-token",
      task_type: "review_adversarial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "manual_seed",
      notes: null,
      metadata_json: "{}",
    });

    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "review_adversarial",
      since: "2026-04-29T00:00:00Z",
      agentchatConfig: {
        agents: [{ name: "config-seat", roles: ["reviewer"] }],
      },
      now: NOW,
    });
    const names = rankCandidates(out).map((c) => c.agent_name);
    expect(names).toContain("config-seat");
    expect(names).not.toContain("parse-artifact-token");
  });

  test("F4: gate_verdict denominator counts review_debt (in-memory + SQL parity)", () => {
    const writer = new AgentPerformanceWriter(db);
    const rows: { id: string; gate: string | null }[] = [
      { id: "f4-passed", gate: "passed" },
      { id: "f4-skipped", gate: "skipped" },
      { id: "f4-failed", gate: "failed" },
      { id: "f4-review-debt", gate: "review_debt" },
      { id: "f4-null", gate: null },
    ];
    for (const [i, row] of rows.entries()) {
      writer.upsert({
        performance_id: row.id,
        ts: `2026-04-30T0${String(i)}:00:00Z`,
        handoff_id: `h-${row.id}`,
        conversation_id: `c-${row.id}`,
        project_id: "proj",
        agent_name: "f4-agent",
        task_type: "review_adversarial",
        outcome: row.gate === "passed" || row.gate === "skipped" ? "merged" : "failed",
        gate_outcome: row.gate,
        rounds: 1,
        smoke_pass: "y",
        reviewer_findings: 0,
        maestro_score: 3,
        cost_usd: null,
        tokens_used: null,
        latency_ms: 1000,
        source: "manual_seed",
        notes: null,
        metadata_json: "{}",
      });
    }

    const rankOut = routeAgent({
      db,
      detail: "rank",
      taskType: "review_adversarial",
      since: "2026-04-29T00:00:00Z",
      includeNeutral: true,
      now: NOW,
    });
    const rankAgent = findCandidate(rankOut, "f4-agent");
    expect(rankAgent.gate_verdict_coverage).toBeCloseTo(4 / 5, 6);
    expect(rankAgent.gate_pass_rate).toBeCloseTo(2 / 4, 6);

    const summaryOut = routeAgent({
      db,
      detail: "summary",
      taskType: "review_adversarial",
      windowDays: 30,
      now: NOW,
    });
    if (summaryOut.detail !== "summary") throw new Error("expected summary");
    const summaryAgent = summaryOut.recommendations.find((r) => r.agent_name === "f4-agent");
    if (!summaryAgent) throw new Error("f4-agent missing from summary");
    expect(summaryAgent.gate_verdict_coverage).toBeCloseTo(4 / 5, 6);
    expect(summaryAgent.gate_pass_rate).toBeCloseTo(2 / 4, 6);

    expect(rankAgent.gate_verdict_coverage).toBeCloseTo(summaryAgent.gate_verdict_coverage, 6);
    expect(rankAgent.gate_pass_rate).toBeCloseTo(summaryAgent.gate_pass_rate, 6);
  });

  test("classifier-declined rows after cutover are excluded from rank scoring", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "classifier-alpha-success",
      ts: "2026-06-13T10:00:00.000Z",
      handoff_id: "h-classifier-alpha-success",
      conversation_id: "c-classifier-alpha-success",
      project_id: "proj",
      agent_name: "alpha",
      task_type: "implement_substantial",
      outcome: "merged",
      gate_outcome: "passed",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "classifier-alpha-declined",
      ts: "2026-06-13T10:01:00.000Z",
      handoff_id: "h-classifier-alpha-declined",
      conversation_id: "c-classifier-alpha-declined",
      project_id: "proj",
      agent_name: "alpha",
      task_type: "implement_substantial",
      outcome: "failed",
      failure_class: "classifier_declined",
      gate_outcome: null,
      rounds: 1,
      smoke_pass: "n",
      reviewer_findings: 10,
      maestro_score: 0,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "worker",
      notes: null,
      metadata_json: "{}",
    });

    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_substantial",
      since: "2026-06-13T00:00:00.000Z",
    });
    const alpha = findCandidate(out, "alpha");

    expect(alpha.samples).toBe(1);
    expect(alpha.failures).toBe(0);
    expect(alpha.success_rate).toBe(1);
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
    const rankedNames = out.candidates.candidates.map((candidate) => candidate.agent_name);
    expect(rankedNames).toContain("alpha");
    expect(rankedNames).toContain("beta");
  });

  test("rank mode defaults the hot-path query to a 30 day window", () => {
    const querySpy = spyOn(db, "query");
    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_small",
      minSamples: 1,
      includeNeutral: false,
      now: NOW,
    });

    expect(out.detail).toBe("rank");
    if (out.detail !== "rank") return;
    // bun-types `MockInstance.calls` widens to `any` for variadic overloads
    // (db.query has many); narrow back to a string SQL literal explicitly.
    const calls = querySpy.mock.calls as unknown as unknown[][];
    const sqls = calls
      .map((call) => (typeof call[0] === "string" ? call[0] : String(call[0])))
      .filter((value): value is string => typeof value === "string");
    const rankQuery = sqls.find(
      (sql) => sql.includes("FROM agent_performance") && sql.includes("ORDER BY ts DESC"),
    );
    expect(rankQuery).toContain("ts >= ?");
    expect(out.candidates.window.from).toBe("2026-04-01T12:00:00.000Z");
  });

  test("single mode treats agents with only out-of-window samples as unsampled", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "stale-coder-1",
      ts: "2026-03-31T12:00:00Z",
      handoff_id: "h-stale-coder-1",
      conversation_id: "c-stale-coder-1",
      project_id: "proj",
      agent_name: "stale-coder",
      task_type: "implement_small",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 60000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "fresh-coder-1",
      ts: "2026-04-30T12:00:00Z",
      handoff_id: "h-fresh-coder-1",
      conversation_id: "c-fresh-coder-1",
      project_id: "proj",
      agent_name: "fresh-coder",
      task_type: "implement_small",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const out = routeAgent({
      db,
      detail: "single",
      role: "coder",
      taskType: "implement_small",
      agentchatConfig: {
        agents: [
          { name: "stale-coder", roles: ["coder"], api_provider: "openai" },
          { name: "fresh-coder", roles: ["coder"], api_provider: "openai" },
        ],
      },
      roleExplorationPolicy: "unsampled-first",
      now: NOW,
    });

    expect(out.detail).toBe("single");
    if (out.detail !== "single") return;
    expect(out.route).toEqual({
      agent: "stale-coder",
      role: "coder",
      taskType: "implement_small",
    });
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
    // gamma's only row is `no_changes` (neutral). The summary path now
    // excludes neutral outcomes from the denominator to match the in-memory
    // rank path; a neutral-only agent drops out of the ranked pool.
    expect(out.recommendations.map((row) => row.agent_name)).toEqual(["beta", "alpha", "reviewer"]);
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
            used_pct: 95,
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
            used_pct: 95,
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

  test("stale >=90% snapshot does NOT exclude the provider's candidate (fail-open in routeAgent single)", () => {
    // Defect regression: a stale 100% snapshot for provider 'sakana' must
    // NOT hard-exclude sakana-backed agents. The scorer keys stale snapshots
    // by (provider, window_label, model) — dropping matching stale snapshots
    // from the exclusion check. If the stale snapshot were still applied,
    // this test would return the failover instead.
    const staleOut = routeAgent({
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
            subscription_provider: "sakana",
          },
          { name: "reviewer-failover", roles: ["reviewer"], api_provider: "openai" },
        ],
      },
      roleExplorationPolicy: "ranked-first",
      applyPressure: {
        snapshots: [
          {
            provider: "sakana",
            window_label: "weekly",
            model: null,
            used_pct: 100,
            resets_at: null,
            observed_at: "2026-04-01T00:00:00Z",
            source_kind: "subscription",
          },
        ],
        warnings: [
          {
            code: "stale_snapshot",
            provider: "sakana",
            window_label: "weekly",
            model: null,
            age_seconds: 999_999,
          },
        ],
      },
      now: NOW,
    });
    expect(staleOut.detail).toBe("single");
    if (staleOut.detail !== "single") return;
    expect(staleOut.route).toEqual({
      agent: "reviewer",
      role: "reviewer",
      taskType: "implement_substantial",
    });

    // Regression guard: an identical snapshot WITHOUT a stale warning must
    // still exclude the sakana seat — proves the stale filter is doing the
    // work, not some other pathway.
    const freshOut = routeAgent({
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
            subscription_provider: "sakana",
          },
          { name: "reviewer-failover", roles: ["reviewer"], api_provider: "openai" },
        ],
      },
      roleExplorationPolicy: "ranked-first",
      applyPressure: {
        snapshots: [
          {
            provider: "sakana",
            window_label: "weekly",
            model: null,
            used_pct: 100,
            resets_at: null,
            observed_at: NOW.toISOString(),
            source_kind: "subscription",
          },
        ],
      },
      now: NOW,
    });
    expect(freshOut.detail).toBe("single");
    if (freshOut.detail !== "single") return;
    expect(freshOut.route).toEqual({
      agent: "reviewer-failover",
      role: "reviewer",
      taskType: "implement_substantial",
    });
  });

  test("stale used_pct applies NO score penalty in applyPressureFactor (headroom weighting)", () => {
    const input: RouteAgentInput = {
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
        ],
      },
      applyPressure: {
        snapshots: [
          {
            provider: "prov1",
            window_label: "five_minute",
            model: null,
            used_pct: 100,
            resets_at: null,
            observed_at: "2026-04-01T00:00:00Z",
            source_kind: "test",
          },
        ],
        warnings: [
          {
            code: "stale_snapshot",
            provider: "prov1",
            window_label: "five_minute",
            model: null,
            age_seconds: 999_999,
          },
        ],
      },
      now: NOW,
    };

    const rankStale = routeAgent(input);
    const alphaStale = findCandidate(rankStale, "alpha");

    // With the same 100% snapshot but WITHOUT a stale warning, the factor
    // would zero the score. Fail-open must leave the score unchanged.
    const rankWithoutWarning = routeAgent({
      ...input,
      applyPressure: {
        snapshots: input.applyPressure!.snapshots,
        // no warnings — snapshot is treated as fresh, penalty applies
      },
    });
    const alphaPenalized = findCandidate(rankWithoutWarning, "alpha");

    // Fresh 100% zeroes score; stale one must not.
    expect(alphaPenalized.score).toBe(0);
    expect(alphaStale.score).toBeGreaterThan(0);
  });

  test("single mode excludes unhealthy agents and selects a failover", () => {
    const out = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      taskType: "implement_substantial",
      agentRegistry: ["reviewer", "reviewer-failover"],
      agentchatConfig: {
        agents: [
          { name: "reviewer", roles: ["reviewer"], api_provider: "local" },
          { name: "reviewer-failover", roles: ["reviewer"], api_provider: "cloud" },
        ],
      },
      roleExplorationPolicy: "ranked-first",
      unhealthyAgents: new Set(["reviewer"]),
      now: NOW,
    });

    expect(out.detail).toBe("single");
    if (out.detail !== "single") return;
    expect(out.route).toEqual({
      agent: "reviewer-failover",
      role: "reviewer",
      taskType: "implement_substantial",
    });
  });

  test("single mode admits a healthy local agent when it is not in the unhealthy set", () => {
    const out = routeAgent({
      db,
      detail: "single",
      role: "reviewer",
      taskType: "implement_substantial",
      agentRegistry: ["reviewer", "reviewer-failover"],
      agentchatConfig: {
        agents: [
          { name: "reviewer", roles: ["reviewer"], api_provider: "local" },
          { name: "reviewer-failover", roles: ["reviewer"], api_provider: "cloud" },
        ],
      },
      roleExplorationPolicy: "ranked-first",
      unhealthyAgents: new Set(),
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

  test("rank mode removes unhealthy candidates", () => {
    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_substantial",
      agentRegistry: ["reviewer", "reviewer-failover"],
      unhealthyAgents: new Set(["reviewer"]),
      now: NOW,
    });

    expect(out.detail).toBe("rank");
    if (out.detail !== "rank") return;
    expect(out.candidates.candidates.map((candidate) => candidate.agent_name)).not.toContain(
      "reviewer",
    );
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

  test("C6: NEUTRAL_OUTCOME_VALUES denominator parity — summary and rank agree on success_rate and gate_verdict_coverage when a no_changes row is present", () => {
    // Both paths must derive their denominators from the same NEUTRAL_OUTCOME_VALUES
    // constant. The SQL summary path excludes neutral rows via
    //   AND outcome NOT IN (NEUTRAL_OUTCOME_VALUES)
    // The in-memory rank path drops them through visibleRows when includeNeutral
    // is false. Fixture: one merged+passed, one failed+failed, one no_changes with
    // gate_outcome NULL. With the fix, both paths see samples=2 (verdict-bearing
    // only), successes=1, gate_outcome_count=2 → success_rate=0.5,
    // gate_verdict_coverage=1.0. Under the pre-fix SQL (no NEUTRAL filter), the
    // summary path would count the neutral row in samples and diverge from rank:
    // success_rate would be 1/3 ≈ 0.333 and gate_verdict_coverage 2/3 ≈ 0.667.
    const writer = new AgentPerformanceWriter(db);
    const baseRow = {
      project_id: "proj",
      agent_name: "neutral-parity",
      task_type: "implement_substantial" as const,
      rounds: 1,
      smoke_pass: "y" as const,
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "manual_seed" as const,
      notes: null,
      metadata_json: "{}",
    };
    writer.upsert({
      ...baseRow,
      performance_id: "neutral-parity-merged",
      ts: "2026-04-30T10:00:00Z",
      handoff_id: "h-neutral-parity-merged",
      conversation_id: "c-neutral-parity-merged",
      outcome: "merged",
      gate_outcome: "passed",
    });
    writer.upsert({
      ...baseRow,
      performance_id: "neutral-parity-failed",
      ts: "2026-04-30T11:00:00Z",
      handoff_id: "h-neutral-parity-failed",
      conversation_id: "c-neutral-parity-failed",
      outcome: "failed",
      gate_outcome: "failed",
    });
    writer.upsert({
      ...baseRow,
      performance_id: "neutral-parity-no-changes",
      ts: "2026-04-30T12:00:00Z",
      handoff_id: "h-neutral-parity-no-changes",
      conversation_id: "c-neutral-parity-no-changes",
      outcome: "no_changes",
      gate_outcome: null,
    });

    const rankOut = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_substantial",
      since: "2026-04-29T00:00:00Z",
      includeNeutral: false,
      now: NOW,
    });
    const rankAgent = findCandidate(rankOut, "neutral-parity");

    const summaryOut = routeAgent({
      db,
      detail: "summary",
      taskType: "implement_substantial",
      windowDays: 30,
      includeNeutral: false,
      now: NOW,
    });
    if (summaryOut.detail !== "summary") throw new Error("expected summary");
    const summaryAgent = summaryOut.recommendations.find((r) => r.agent_name === "neutral-parity");
    if (!summaryAgent) throw new Error("neutral-parity missing from summary");

    expect(rankAgent.samples).toBe(2);
    expect(rankAgent.success_rate).toBeCloseTo(0.5, 6);
    expect(rankAgent.gate_verdict_coverage).toBeCloseTo(1.0, 6);
    expect(summaryAgent.samples).toBe(2);
    expect(summaryAgent.success_rate).toBeCloseTo(0.5, 6);
    expect(summaryAgent.gate_verdict_coverage).toBeCloseTo(1.0, 6);
    expect(summaryAgent.success_rate).toBeCloseTo(rankAgent.success_rate, 6);
    expect(summaryAgent.gate_verdict_coverage).toBeCloseTo(rankAgent.gate_verdict_coverage, 6);
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
  ): void => {
    writer.upsert({
      ...baseRow,
      performance_id: `${agent}-${String(i)}`,
      ts: `2026-04-30T1${String(i % 10)}:00:00Z`,
      handoff_id: `h-${agent}-${String(i)}`,
      conversation_id: `c-${agent}-${String(i)}`,
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

  const rank = (latency_weighting: boolean): RankCandidate[] => {
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
  const find = (cands: ReturnType<typeof rank>, name: string): RankCandidate => {
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

describe("warm_pool_reuse_weighting routing", () => {
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
    outcome: "merged" | "failed",
  ): void => {
    writer.upsert({
      ...baseRow,
      performance_id: `${agent}-${String(i)}`,
      ts: `2026-04-30T1${String(i % 10)}:00:00Z`,
      handoff_id: `h-${agent}-${String(i)}`,
      conversation_id: `c-${agent}-${String(i)}`,
      agent_name: agent,
      task_type: "implement_substantial",
      outcome,
    });
  };

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  const rank = (
    warm_pool_reuse_weighting: boolean,
    warmPoolReuseRates?: Record<string, number>,
  ): RankCandidate[] => {
    const out = routeAgent({
      db,
      detail: "rank" as const,
      taskType: "implement_substantial" as const,
      minSamples: 1,
      includeNeutral: false,
      now: NOW,
      agentchatConfig: { role_routing: { warm_pool_reuse_weighting }, agents: [] },
      warmPoolReuseRates,
    });
    if (out.detail !== "rank") throw new Error("expected rank");
    return out.candidates.candidates;
  };

  const find = (cands: ReturnType<typeof rank>, name: string): RankCandidate => {
    const c = cands.find((x) => x.agent_name === name);
    if (!c) throw new Error(`candidate ${name} not found`);
    return c;
  };

  test("flag OFF: reuse rates do not affect scores (regression-safe)", () => {
    const w = new AgentPerformanceWriter(db);
    seed(w, "alpha", 1, "merged");
    seed(w, "beta", 1, "merged");
    const reuseRates = { alpha: 1.0, beta: 0.0 };
    const offWithRates = rank(false, reuseRates);
    const offNoRates = rank(false, undefined);
    expect(find(offWithRates, "alpha").score).toBeCloseTo(find(offNoRates, "alpha").score, 6);
    expect(find(offWithRates, "beta").score).toBeCloseTo(find(offNoRates, "beta").score, 6);
  });

  test("flag ON: higher reuse-rate candidate ranks above equal-merit lower-reuse candidate", () => {
    const w = new AgentPerformanceWriter(db);
    seed(w, "alpha", 1, "merged");
    seed(w, "beta", 1, "merged");
    // confirm equal scores with flag OFF
    const off = rank(false, { alpha: 1.0, beta: 0.0 });
    expect(find(off, "alpha").score).toBeCloseTo(find(off, "beta").score, 6);
    // with flag ON, alpha (reuse=1.0) should score above beta (reuse=0.0)
    const on = rank(true, { alpha: 1.0, beta: 0.0 });
    expect(find(on, "alpha").score).toBeGreaterThan(find(on, "beta").score);
  });

  test("flag ON + signal absent: falls back to baseline without crash", () => {
    const w = new AgentPerformanceWriter(db);
    seed(w, "alpha", 1, "merged");
    const noSignal = rank(true, undefined);
    const baseline = rank(false, undefined);
    expect(find(noSignal, "alpha").score).toBeCloseTo(find(baseline, "alpha").score, 6);
  });

  test("factor is bounded: high-reuse mediocre agent does not surpass a clearly stronger low-reuse agent", () => {
    const w = new AgentPerformanceWriter(db);
    // strong-beta: 3 merged, reuse 0.0
    for (let i = 1; i <= 3; i++) seed(w, "strong-beta", i, "merged");
    // weak-alpha: 1 merged + 2 failed, reuse 1.0
    seed(w, "weak-alpha", 1, "merged");
    seed(w, "weak-alpha", 2, "failed");
    seed(w, "weak-alpha", 3, "failed");
    const cands = rank(true, { "strong-beta": 0.0, "weak-alpha": 1.0 });
    expect(cands[0]!.agent_name).toBe("strong-beta");
  });
});

describe("routing bias (usage steering)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const w = new AgentPerformanceWriter(db);
    const seed = (agent: string, n: number, outcome: "merged" | "failed"): void => {
      w.upsert({
        performance_id: `${agent}-${String(n)}`,
        ts: `2026-06-13T10:0${String(n)}:00.000Z`,
        handoff_id: `h-${agent}-${String(n)}`,
        conversation_id: `c-${agent}-${String(n)}`,
        project_id: "proj",
        agent_name: agent,
        task_type: "implement_substantial",
        outcome,
        gate_outcome: outcome === "merged" ? "passed" : null,
        rounds: 1,
        smoke_pass: outcome === "merged" ? "y" : "n",
        reviewer_findings: 0,
        maestro_score: outcome === "merged" ? 5 : 0,
        cost_usd: null,
        tokens_used: null,
        latency_ms: 1000,
        source: "reconciler",
        notes: null,
        metadata_json: "{}",
      });
    };
    // Mixed outcomes => mid/low base scores with headroom so a boost factor does
    // not clamp at 1.0 and a divert factor stays > 0.
    for (const a of ["alpha", "beta", "gamma"]) {
      seed(a, 1, "merged");
      seed(a, 2, "failed");
      seed(a, 3, "failed");
    }
  });

  const AGENTS = [
    {
      name: "alpha",
      roles: ["coder"],
      pricing_mode: "subscription" as const,
      subscription_provider: "prov-a",
    },
    {
      name: "beta",
      roles: ["coder"],
      pricing_mode: "subscription" as const,
      subscription_provider: "prov-b",
    },
    {
      name: "gamma",
      roles: ["coder"],
      pricing_mode: "subscription" as const,
      subscription_provider: "prov-a",
    },
  ];

  const bias = (
    scope: "provider" | "agent",
    value: string,
    mode: "boost" | "divert" | "exclude",
    weight: number | null = null,
  ): RoutingBias => ({
    bias_id: `${scope}-${value}-${mode}`,
    scope,
    value,
    mode,
    weight,
    reason: null,
    created_at: "2026-06-14T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
  });

  const rankInput = (activeBiases?: RoutingBias[]): RouteAgentInput => ({
    db,
    detail: "rank",
    taskType: "implement_substantial",
    agentchatConfig: { agents: AGENTS },
    activeBiases,
    now: NOW,
  });
  const cands = (out: RouteAgentOutput): RankCandidate[] => rankCandidates(out);
  const findC = (out: RouteAgentOutput, name: string): RankCandidate | undefined =>
    cands(out).find((c) => c.agent_name === name);

  const singleInput = (activeBiases?: RoutingBias[]): RouteAgentInput => ({
    db,
    detail: "single",
    role: "coder",
    taskType: "implement_substantial",
    agentchatConfig: { agents: AGENTS },
    defaultRoles: { coder: "alpha" },
    activeBiases,
    now: NOW,
  });

  test("exported resolveBiasEffect honors precedence, defaults, explicit weights, and cumulative factors", () => {
    expect(resolveBiasEffect("alpha", "prov-a", [bias("agent", "alpha", "boost")])).toEqual({
      factor: 1.25,
      exclude: false,
    });
    expect(resolveBiasEffect("alpha", "prov-a", [bias("provider", "prov-a", "divert")])).toEqual({
      factor: 0.5,
      exclude: false,
    });
    expect(resolveBiasEffect("alpha", "prov-a", [bias("agent", "alpha", "boost", 2)])).toEqual({
      factor: 2,
      exclude: false,
    });
    expect(
      resolveBiasEffect("alpha", "prov-a", [
        bias("agent", "alpha", "boost"),
        bias("provider", "prov-a", "divert"),
        bias("agent", "alpha", "boost", 2),
      ]),
    ).toEqual({ factor: 1.25 * 0.5 * 2, exclude: false });
    expect(
      resolveBiasEffect("alpha", "prov-a", [
        bias("agent", "alpha", "boost"),
        bias("provider", "prov-a", "divert"),
        bias("agent", "alpha", "exclude"),
      ]),
    ).toEqual({ factor: 1.25 * 0.5, exclude: true });
  });

  test("GUARD: empty biases produce byte-identical output to no biases (rank + single)", () => {
    expect(routeAgent(rankInput([]))).toEqual(routeAgent(rankInput(undefined)));
    expect(routeAgent(singleInput([]))).toEqual(routeAgent(singleInput(undefined)));
  });

  test("boost raises a candidate score; divert lowers it", () => {
    const base = routeAgent(rankInput(undefined));
    const boosted = routeAgent(rankInput([bias("agent", "alpha", "boost", 1.5)]));
    expect(findC(boosted, "alpha")!.score).toBeGreaterThan(findC(base, "alpha")!.score);
    const diverted = routeAgent(rankInput([bias("agent", "beta", "divert", 0.5)]));
    expect(findC(diverted, "beta")!.score).toBeLessThan(findC(base, "beta")!.score);
  });

  test("exclude removes a candidate from the ranking", () => {
    const out = routeAgent(rankInput([bias("agent", "gamma", "exclude")]));
    expect(
      cands(out)
        .map((c) => c.agent_name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  test("provider-scope exclude matches all agents of that provider", () => {
    const out = routeAgent(rankInput([bias("provider", "prov-a", "exclude")]));
    // prov-a = alpha + gamma excluded; only beta (prov-b) remains
    expect(cands(out).map((c) => c.agent_name)).toEqual(["beta"]);
  });

  test("exclude > boost precedence: exclude wins on the same agent", () => {
    const out = routeAgent(
      rankInput([bias("agent", "alpha", "boost", 2.0), bias("agent", "alpha", "exclude")]),
    );
    expect(findC(out, "alpha")).toBeUndefined();
  });

  test("safe fallback: excluding ALL candidates re-admits rather than emptying the ranking", () => {
    const out = routeAgent(
      rankInput([bias("provider", "prov-a", "exclude"), bias("provider", "prov-b", "exclude")]),
    );
    expect(cands(out).length).toBe(3);
  });

  test("single mode: exclude steers selection away from the excluded agent", () => {
    const out = routeAgent(singleInput([bias("agent", "alpha", "exclude")]));
    expect(out.detail).toBe("single");
    if (out.detail !== "single") return;
    expect(out.route).not.toBeNull();
    expect(out.route?.agent).not.toBe("alpha");
  });

  test("single mode safe fallback: excluding ALL role agents still returns a route", () => {
    const out = routeAgent(
      singleInput([bias("provider", "prov-a", "exclude"), bias("provider", "prov-b", "exclude")]),
    );
    expect(out.detail).toBe("single");
    if (out.detail !== "single") return;
    expect(out.route).not.toBeNull();
  });
});

describe("tool_free adapter-aware penalty", () => {
  let db: Database;

  const seed = (agent: string, n: number, outcome: "merged" | "failed"): void => {
    new AgentPerformanceWriter(db).upsert({
      performance_id: `${agent}-${String(n)}`,
      ts: `2026-06-13T10:0${String(n)}:00.000Z`,
      handoff_id: `h-${agent}-${String(n)}`,
      conversation_id: `c-${agent}-${String(n)}`,
      project_id: "proj",
      agent_name: agent,
      task_type: "implement_substantial",
      outcome,
      gate_outcome: outcome === "merged" ? "passed" : null,
      rounds: 1,
      smoke_pass: outcome === "merged" ? "y" : "n",
      reviewer_findings: 0,
      maestro_score: outcome === "merged" ? 5 : 0,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
  };

  // Two agents with identical performance histories so any score delta isolates
  // the adapter-aware penalty as the only differentiator.
  const seedTwins = (): void => {
    for (const agent of ["acp-twin", "http-twin"]) {
      seed(agent, 1, "merged");
      seed(agent, 2, "failed");
      seed(agent, 3, "failed");
    }
  };

  const AGENTS = [
    {
      name: "acp-twin",
      roles: ["coder"],
      pricing_mode: "subscription" as const,
      subscription_provider: "prov-a",
      adapter: "stdio-acp",
    },
    {
      name: "http-twin",
      roles: ["coder"],
      pricing_mode: "subscription" as const,
      subscription_provider: "prov-b",
      adapter: "openai-compat-http",
    },
  ];

  const rankInput = (tool_free?: boolean): RouteAgentInput => ({
    db,
    detail: "rank",
    taskType: "implement_substantial",
    agentchatConfig: { agents: AGENTS },
    tool_free,
    now: NOW,
  });

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedTwins();
  });

  test("INERT DEFAULT: tool_free unset leaves output byte-identical to no tool_free", () => {
    // Adapter field is present on the config and tool_free is unset on both
    // sides — must be a no-op. Guards against a dead control flipping on
    // unaware callers.
    const without = routeAgent(rankInput(undefined));
    const withFalse = routeAgent(rankInput(false));
    expect(without).toEqual(withFalse);
  });

  test("tool_free:true penalizes the ACP candidate relative to an equivalent HTTP candidate", () => {
    const base = routeAgent(rankInput(undefined));
    const acpBase = rankCandidates(base).find((c) => c.agent_name === "acp-twin");
    const httpBase = rankCandidates(base).find((c) => c.agent_name === "http-twin");
    if (!acpBase || !httpBase) throw new Error("missing baseline candidates");
    // Equal histories => equal baseline scores; isolates the penalty.
    expect(acpBase.score).toBeCloseTo(httpBase.score, 6);

    const out = routeAgent(rankInput(true));
    const acp = rankCandidates(out).find((c) => c.agent_name === "acp-twin");
    const http = rankCandidates(out).find((c) => c.agent_name === "http-twin");
    if (!acp || !http) throw new Error("missing tool_free candidates");
    // ACP score must drop below the HTTP score under tool_free:true.
    expect(acp.score).toBeLessThan(http.score);
    // HTTP score must be unaffected (no adapter penalty).
    expect(http.score).toBeCloseTo(httpBase.score, 6);
  });
});
