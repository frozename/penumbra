import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";

import {
  loadSqliteVec,
  migrate,
  pickFromPool,
  type PressureResult,
  type RouteAgentInput,
} from "@src/index.js";
import type { RoutingBias } from "@src/readers/routing-bias.js";
import type { AgentTaskType } from "@src/schemas/agent-performance.js";
import { AgentPerformanceWriter } from "@src/writers/agent-performance.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // platform-specific SQLite override; ignore failures elsewhere
  }
}

const NOW = "2026-05-01T12:00:00Z";

type AgentchatConfig = NonNullable<RouteAgentInput["agentchatConfig"]>;

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

// Demotion only considers rows inside the recency floor (7d); fixtures that
// must count toward demotion need wall-clock-recent timestamps.
function recentIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function writePerf(
  db: Database,
  agent: string,
  taskType: AgentTaskType,
  overrides: Partial<{
    outcome: "merged" | "pr_opened" | "failed" | "test_failed";
    failure_class: string | null;
    environment_failure: "y" | "n" | null;
    gate_outcome: "passed" | "skipped" | "failed" | "review_debt" | null;
    rounds: number;
    latency_ms: number;
    exec_ms: number;
    ts: string;
    id_suffix: string;
  }> = {},
): void {
  const idSuffix = overrides.id_suffix ? `-${overrides.id_suffix}` : "";
  new AgentPerformanceWriter(db).upsert({
    performance_id: `${taskType}-${agent}${idSuffix}`,
    ts: overrides.ts ?? recentIso(60),
    handoff_id: `handoff-${taskType}-${agent}${idSuffix}`,
    conversation_id: "conv",
    project_id: "proj",
    agent_name: agent,
    task_type: taskType,
    outcome: overrides.outcome ?? "merged",
    failure_class: overrides.failure_class,
    environment_failure: overrides.environment_failure,
    gate_outcome: overrides.gate_outcome,
    rounds: overrides.rounds ?? 1,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: null,
    cost_usd: null,
    tokens_used: 100,
    latency_ms: overrides.latency_ms ?? 10_000,
    exec_ms: overrides.exec_ms ?? null,
    source: "test",
    notes: null,
    metadata_json: "{}",
  });
}

function config(
  headroom_weighting = false,
  providers: { a: string; b: string } = { a: "anthropic", b: "openai" },
): AgentchatConfig {
  return {
    role_routing: { headroom_weighting },
    agents: [
      {
        name: "a",
        roles: [],
        pricing_mode: "subscription",
        subscription_provider: providers.a,
      },
      {
        name: "b",
        roles: [],
        pricing_mode: "subscription",
        subscription_provider: providers.b,
      },
    ],
  };
}

const excludeAnthropic: RoutingBias = {
  bias_id: "bias-anthropic-exclude",
  scope: "provider",
  value: "anthropic",
  mode: "exclude",
  weight: null,
  reason: "test",
  created_at: NOW,
  expires_at: "2027-01-01T00:00:00.000Z",
};

function pressure(anthropic: number, openai: number): PressureResult {
  return {
    warnings: [],
    snapshots: [
      {
        provider: "anthropic",
        window_label: "24h",
        model: null,
        used_pct: anthropic,
        resets_at: null,
        observed_at: NOW,
        source_kind: "subscription",
      },
      {
        provider: "openai",
        window_label: "24h",
        model: null,
        used_pct: openai,
        resets_at: null,
        observed_at: NOW,
        source_kind: "subscription",
      },
    ],
  };
}

describe("pickFromPool", () => {
  test("no pressure selects the highest-scored agent", () => {
    const db = freshDb();
    writePerf(db, "a", "implement_small", { rounds: 1, latency_ms: 10_000 });
    writePerf(db, "b", "implement_small", { rounds: 5, latency_ms: 60_000 });

    expect(pickFromPool(["a", "b"], db, config(), undefined, "implement_small")).toBe("a");
  });

  test("forces headroom weighting locally and sheds a pressured provider", () => {
    const db = freshDb();
    const agentchatConfig = config(false);
    writePerf(db, "a", "implement_small", { rounds: 1, latency_ms: 10_000 });
    writePerf(db, "b", "implement_small", { rounds: 5, latency_ms: 60_000 });

    expect(pickFromPool(["a", "b"], db, agentchatConfig, pressure(95, 10), "implement_small")).toBe(
      "b",
    );
    expect(agentchatConfig.role_routing?.headroom_weighting).toBe(false);
  });

  test("cold-start falls back to the first pool agent", () => {
    const db = freshDb();

    expect(pickFromPool(["a", "b"], db, config(), undefined, "implement_small")).toBe("a");
  });

  test("cold-start does not pick a provider-excluded first member when a non-excluded member exists", () => {
    const db = freshDb();

    expect(
      pickFromPool(
        ["a", "b"],
        db,
        config(false, { a: "anthropic", b: "openai" }),
        undefined,
        "review_adversarial",
        undefined,
        [excludeAnthropic],
      ),
    ).toBe("b");
  });

  test("an excluded member with history cannot win over a history-less non-excluded member", () => {
    const db = freshDb();
    writePerf(db, "a", "review_adversarial");

    expect(
      pickFromPool(
        ["a", "b"],
        db,
        config(false, { a: "anthropic", b: "openai" }),
        undefined,
        "review_adversarial",
        undefined,
        [excludeAnthropic],
      ),
    ).toBe("b");
  });

  test("all pool members excluded falls back to the first pool agent (preference-order re-admission)", () => {
    const db = freshDb();
    const excludeOpenai: RoutingBias = {
      ...excludeAnthropic,
      bias_id: "bias-openai-exclude",
      value: "openai",
    };

    expect(
      pickFromPool(
        ["a", "b"],
        db,
        config(false, { a: "anthropic", b: "openai" }),
        undefined,
        "review_adversarial",
        undefined,
        [excludeAnthropic, excludeOpenai],
      ),
    ).toBe("a");
  });

  test("warns when all pool members are excluded and the full pool is re-admitted", () => {
    const db = freshDb();
    const warnSpy = spyOn(console, "warn");
    const excludeOpenai: RoutingBias = {
      ...excludeAnthropic,
      bias_id: "bias-openai-exclude",
      value: "openai",
    };

    try {
      expect(
        pickFromPool(
          ["a", "b"],
          db,
          config(false, { a: "anthropic", b: "openai" }),
          undefined,
          "review_adversarial",
          undefined,
          [excludeAnthropic, excludeOpenai],
        ),
      ).toBe("a");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/\[pick-from-pool\].*re-admit/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does not warn when some pool members survive bias exclusion", () => {
    const db = freshDb();
    const warnSpy = spyOn(console, "warn");

    try {
      expect(
        pickFromPool(
          ["a", "b"],
          db,
          config(false, { a: "anthropic", b: "openai" }),
          undefined,
          "review_adversarial",
          undefined,
          [excludeAnthropic],
        ),
      ).toBe("b");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("single-element pool returns immediately without querying the database", () => {
    const db = freshDb();
    const querySpy = spyOn(db, "query");

    expect(pickFromPool(["a"], db, config(), undefined, "implement_small")).toBe("a");
    expect(querySpy).not.toHaveBeenCalled();
  });

  test("single-element pool with active biases returns immediately without querying the database", () => {
    const db = freshDb();
    const querySpy = spyOn(db, "query");

    // ["a"] exercises excluded-single-seat re-admission; ["b"] exercises a
    // filtered-but-surviving single seat.
    expect(
      pickFromPool(["a"], db, config(), undefined, "review_adversarial", undefined, [
        excludeAnthropic,
      ]),
    ).toBe("a");
    expect(
      pickFromPool(["b"], db, config(), undefined, "review_adversarial", undefined, [
        excludeAnthropic,
      ]),
    ).toBe("b");
    expect(querySpy).not.toHaveBeenCalled();
  });

  test("all providers over pressure still returns a fallback result", () => {
    const db = freshDb();
    writePerf(db, "a", "implement_small", { rounds: 1, latency_ms: 10_000 });
    writePerf(db, "b", "implement_small", { rounds: 5, latency_ms: 60_000 });

    expect(pickFromPool(["a", "b"], db, config(), pressure(95, 97), "implement_small")).toBe("a");
  });

  test("empty pool throws", () => {
    const db = freshDb();

    expect(() => pickFromPool([], db, config(), undefined, "implement_small")).toThrow(
      /pool must not be empty/,
    );
  });

  test("task type is threaded into the rank query", () => {
    const db = freshDb();
    writePerf(db, "b", "review_adversarial", { rounds: 1, latency_ms: 10_000 });

    expect(pickFromPool(["a", "b"], db, config(), undefined, "review_adversarial")).toBe("b");
  });

  test("demotes agents whose recent workload attempts all failed", () => {
    const db = freshDb();
    for (let i = 0; i < 10; i += 1) {
      writePerf(db, "a", "review_adversarial", {
        outcome: "merged",
        rounds: 1,
        latency_ms: 10_000,
        ts: `2026-05-01T10:${String(i).padStart(2, "0")}:00Z`,
        id_suffix: `old-success-${String(i)}`,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      writePerf(db, "a", "review_adversarial", {
        outcome: "failed",
        rounds: 1,
        latency_ms: 10_000,
        ts: recentIso(30 - i),
        id_suffix: `recent-failure-${String(i)}`,
      });
    }
    writePerf(db, "b", "review_adversarial", {
      outcome: "merged",
      rounds: 10,
      latency_ms: 60_000,
    });

    expect(pickFromPool(["a", "b"], db, config(), undefined, "review_adversarial")).toBe("b");
  });

  test("does not demote agents whose recent successful outcomes lack passing gate outcomes", () => {
    const db = freshDb();
    for (let i = 0; i < 3; i += 1) {
      writePerf(db, "a", "review_adversarial", {
        outcome: "merged",
        gate_outcome: i === 0 ? null : "review_debt",
        rounds: 1,
        latency_ms: 10_000,
        ts: recentIso(30 - i),
        id_suffix: `recent-success-gate-debt-${String(i)}`,
      });
    }
    writePerf(db, "b", "review_adversarial", {
      outcome: "merged",
      gate_outcome: "passed",
      rounds: 10,
      latency_ms: 60_000,
    });

    expect(pickFromPool(["a", "b"], db, config(), undefined, "review_adversarial")).toBe("a");
  });

  test("does not demote agents whose recent failures are classifier declines after cutover", () => {
    const previousCutover = process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO;
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2026-06-13T00:00:00.000Z";
    try {
      const db = freshDb();
      writePerf(db, "a", "review_adversarial", {
        outcome: "merged",
        rounds: 1,
        latency_ms: 10_000,
        ts: recentIso(60),
        id_suffix: "baseline-success",
      });
      db.query(`UPDATE agent_performance SET gate_outcome='passed' WHERE handoff_id=?`).run(
        "handoff-review_adversarial-a-baseline-success",
      );
      for (let i = 0; i < 3; i += 1) {
        writePerf(db, "a", "review_adversarial", {
          outcome: "failed",
          failure_class: "classifier_declined",
          rounds: 1,
          latency_ms: 10_000,
          ts: recentIso(30 - i),
          id_suffix: `classifier-decline-${String(i)}`,
        });
      }
      writePerf(db, "b", "review_adversarial", {
        outcome: "merged",
        rounds: 10,
        latency_ms: 60_000,
      });

      expect(pickFromPool(["a", "b"], db, config(), undefined, "review_adversarial")).toBe("a");
    } finally {
      if (previousCutover === undefined) delete process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO;
      else process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = previousCutover;
    }
  });

  test("does not demote agents whose recent test failures are verification environment failures", () => {
    const db = freshDb();
    writePerf(db, "a", "review_adversarial", {
      outcome: "merged",
      rounds: 1,
      latency_ms: 10_000,
      ts: recentIso(60),
      id_suffix: "baseline-success",
    });
    db.query(`UPDATE agent_performance SET gate_outcome='passed' WHERE handoff_id=?`).run(
      "handoff-review_adversarial-a-baseline-success",
    );
    for (let i = 0; i < 3; i += 1) {
      writePerf(db, "a", "review_adversarial", {
        outcome: "test_failed",
        environment_failure: "y",
        rounds: 1,
        latency_ms: 10_000,
        ts: recentIso(30 - i),
        id_suffix: `environment-failure-${String(i)}`,
      });
    }
    writePerf(db, "b", "review_adversarial", {
      outcome: "merged",
      rounds: 10,
      latency_ms: 60_000,
    });

    expect(pickFromPool(["a", "b"], db, config(), undefined, "review_adversarial")).toBe("a");
  });

  test("keeps a fallback when every pool agent has recent workload failures", () => {
    const db = freshDb();
    for (const agent of ["a", "b"]) {
      for (let i = 0; i < 3; i += 1) {
        writePerf(db, agent, "review_adversarial", {
          outcome: "failed",
          rounds: 1,
          latency_ms: 10_000,
          ts: recentIso(30 - i),
          id_suffix: `${agent}-recent-failure-${String(i)}`,
        });
      }
    }

    expect(pickFromPool(["a", "b"], db, config(), undefined, "review_adversarial")).toBe("a");
  });

  test("forces latency_weighting true and prefers the faster seat when exec_ms spread is material", () => {
    const db = freshDb();
    // Both agents: identical outcome/rounds/smoke/reviewer performance.
    // Caller config explicitly leaves latency_weighting at false.
    // "a" is slow (300 s exec), "b" is fast (1 s exec).
    writePerf(db, "a", "implement_small", {
      rounds: 1,
      latency_ms: 10_000,
      exec_ms: 300_000,
    });
    writePerf(db, "b", "implement_small", {
      rounds: 1,
      latency_ms: 10_000,
      exec_ms: 1_000,
    });
    db.query(
      `UPDATE agent_performance SET gate_outcome='passed' WHERE agent_name IN ('a','b')`,
    ).run();

    const callerConfig: AgentchatConfig = {
      role_routing: { headroom_weighting: false, latency_weighting: false },
      agents: [
        { name: "a", roles: [], pricing_mode: "subscription", subscription_provider: "anthropic" },
        { name: "b", roles: [], pricing_mode: "subscription", subscription_provider: "openai" },
      ],
    };

    // pickFromPool must force latency_weighting: true internally — "b" (faster)
    // should beat "a" (slower) despite identical outcome/rounds scores.
    // Without the override, both score identically and "a" wins alphabetically.
    expect(pickFromPool(["a", "b"], db, callerConfig, undefined, "implement_small")).toBe("b");

    // Caller config must not be mutated.
    expect(callerConfig.role_routing?.latency_weighting).toBe(false);
  });
});
