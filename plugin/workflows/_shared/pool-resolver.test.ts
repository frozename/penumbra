import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  AgentPerformanceWriter,
  loadSqliteVec,
  migrate,
} from "../../../packages/core/src/index.js";
import type { WorkflowCtx } from "../../../packages/workflows/src/ctx.js";
import { parseAgentField, resolveAgent } from "./pool-resolver.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
}

const NOW = new Date().toISOString();
const NOW_MS = Date.parse(NOW);

function minutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * 24 * 60 * 60_000).toISOString();
}

function withDeadPinWindow<T>(value: string | undefined, fn: () => T): T {
  const oldWindow = process.env.PENUMBRA_DEAD_PIN_FAILURE_WINDOW_MS;
  if (value === undefined) delete process.env.PENUMBRA_DEAD_PIN_FAILURE_WINDOW_MS;
  else process.env.PENUMBRA_DEAD_PIN_FAILURE_WINDOW_MS = value;
  try {
    return fn();
  } finally {
    if (oldWindow === undefined) delete process.env.PENUMBRA_DEAD_PIN_FAILURE_WINDOW_MS;
    else process.env.PENUMBRA_DEAD_PIN_FAILURE_WINDOW_MS = oldWindow;
  }
}

function withNow<T>(nowMs: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function writePerf(
  db: Database,
  agent: string,
  taskType = "review_adversarial",
  opts: {
    handoffId?: string;
    source?: string;
    outcome?: string;
    environmentFailure?: "y" | null;
    ts?: string;
  } = {},
): void {
  const handoffId = opts.handoffId ?? `handoff-${agent}`;
  new AgentPerformanceWriter(db).upsert({
    performance_id: opts.handoffId ? `perf-${opts.handoffId}` : `perf-${agent}`,
    ts: opts.ts ?? NOW,
    handoff_id: handoffId,
    conversation_id: "conv",
    project_id: "proj",
    agent_name: agent,
    task_type: taskType,
    outcome: opts.outcome ?? "merged",
    rounds: agent === "a" ? 1 : 5,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: null,
    cost_usd: null,
    tokens_used: 100,
    latency_ms: agent === "a" ? 10_000 : 60_000,
    source: opts.source ?? "test",
    notes: null,
    environment_failure: opts.environmentFailure ?? null,
    metadata_json: "{}",
  });
}

function writeWorkerPerf(
  db: Database,
  row: {
    agent: string;
    handoffId: string;
    ts: string;
    outcome: string;
    taskType?: string;
    environmentFailure?: "y" | null;
  },
): void {
  new AgentPerformanceWriter(db).upsert({
    performance_id: `perf-${row.handoffId}`,
    ts: row.ts,
    handoff_id: row.handoffId,
    conversation_id: `conv-${row.handoffId}`,
    project_id: "proj",
    agent_name: row.agent,
    task_type: row.taskType ?? "review_adversarial",
    outcome: row.outcome,
    rounds: 5,
    smoke_pass: "n",
    reviewer_findings: 0,
    maestro_score: null,
    cost_usd: null,
    tokens_used: 100,
    latency_ms: 60_000,
    source: "worker",
    notes: null,
    environment_failure: row.environmentFailure ?? null,
    metadata_json: "{}",
  });
}

function writeDeadPinWorkerRows(
  db: Database,
  rows: Array<{ suffix: string; ts: string; outcome: string; environmentFailure?: "y" | null }>,
): void {
  for (const row of rows) {
    writeWorkerPerf(db, {
      agent: "dead-pin-seat",
      handoffId: `dead-pin-seat-${row.suffix}`,
      ts: row.ts,
      outcome: row.outcome,
      environmentFailure: row.environmentFailure,
    });
  }
}

function writePressure(db: Database, provider: string, usedPct: number): void {
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, user_id, machine_id,
      event_type, lane, provider, payload_json
    ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)
  `,
  ).run(
    `pressure-${provider}`,
    NOW,
    NOW,
    provider,
    JSON.stringify({
      window_label: "24h",
      model: null,
      used_pct: usedPct,
      resets_at: null,
      source_kind: "subscription",
    }),
  );
}

function writeBias(
  db: Database,
  scope: "provider" | "agent",
  value: string,
  mode: "boost" | "divert" | "exclude",
  expiresAt = new Date(Date.parse(NOW) + 60_000).toISOString(),
): void {
  db.prepare(
    `INSERT INTO routing_bias (
      bias_id, scope, value, mode, weight, reason, created_at, expires_at
    ) VALUES (?, ?, ?, ?, NULL, 'test', ?, ?)`,
  ).run(`bias-${scope}-${value}-${mode}`, scope, value, mode, NOW, expiresAt);
}

function ctx(overrides: Partial<WorkflowCtx> = {}): WorkflowCtx {
  return {
    dispatch: async () => ({ conversation_id: "conv", handoff_id: "handoff" }),
    awaitChain: async () => ({ status: "completed", final_agent: "a", response_text: "ok" }),
    fileWrite: async () => "path",
    config: {
      role_routing: { headroom_weighting: false },
      agents: [
        {
          name: "a",
          roles: ["reviewer"],
          pricing_mode: "subscription",
          subscription_provider: "anthropic",
        },
        {
          name: "b",
          roles: ["reviewer"],
          pricing_mode: "subscription",
          subscription_provider: "openai",
        },
      ],
    },
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "proj",
    args: {},
    ...overrides,
  };
}

describe("parseAgentField", () => {
  test("parses strings, non-empty arrays, and object pools", () => {
    expect(parseAgentField("a")).toEqual({ kind: "single", agent: "a" });
    expect(parseAgentField(["a", "b"])).toEqual({ kind: "pool", agents: ["a", "b"] });
    expect(
      parseAgentField({
        members: [{ agent: "a" }, { agent: "b", tier: "cloud" }],
        select: "order",
        fallback_to_cloud: true,
      }),
    ).toEqual({ kind: "pool", agents: ["a", "b"] });
  });

  test("returns null for absent or empty values", () => {
    expect(parseAgentField(undefined)).toBeNull();
    expect(parseAgentField([])).toBeNull();
    expect(parseAgentField({ members: [] })).toBeNull();
  });
});

describe("agentPoolToNames", () => {
  test("normalizes every agent pool form to declaration-order names", async () => {
    const { agentPoolToNames } =
      (await import("./pool-resolver.js")) as typeof import("./pool-resolver.js") & {
        agentPoolToNames?: (pool: unknown) => string[];
      };
    expect(agentPoolToNames).toBeFunction();

    expect(agentPoolToNames("a")).toEqual(["a"]);
    expect(agentPoolToNames(["a", "b"])).toEqual(["a", "b"]);
    expect(
      agentPoolToNames?.({
        members: [{ agent: "a", tier: "local" }, { agent: "b" }],
        select: "rank",
      }),
    ).toEqual(["a", "b"]);
  });
});

describe("resolveAgent", () => {
  test("routes away from a single pinned agent after three recent worker failures", () => {
    const db = freshDb();
    writeDeadPinWorkerRows(db, [
      { suffix: "h3", ts: minutesAgo(1), outcome: "failed" },
      { suffix: "h2", ts: minutesAgo(2), outcome: "failed" },
      { suffix: "h1", ts: minutesAgo(3), outcome: "failed" },
    ]);

    const result = resolveAgent(
      { kind: "single", agent: "dead-pin-seat" },
      "review_adversarial",
      ctx({
        config: {
          role_routing: { headroom_weighting: false },
          agents: [
            { name: "dead-pin-seat", roles: ["reviewer"] },
            { name: "healthy-seat", roles: ["reviewer"] },
          ],
        },
        db: () => db,
      }),
      { fallback_role: "reviewer" },
    );

    expect(result).not.toBe("dead-pin-seat");
  });

  test("keeps a single pinned agent when three worker failures are outside the dead-pin window", () => {
    withDeadPinWindow("86400000", () => {
      const db = freshDb();
      writeDeadPinWorkerRows(db, [
        { suffix: "stale-h3", ts: daysAgo(2), outcome: "failed" },
        { suffix: "stale-h2", ts: daysAgo(3), outcome: "failed" },
        { suffix: "stale-h1", ts: daysAgo(4), outcome: "failed" },
      ]);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        expect(
          resolveAgent(
            { kind: "single", agent: "dead-pin-seat" },
            "review_adversarial",
            ctx({
              config: {
                role_routing: { headroom_weighting: false },
                agents: [
                  { name: "dead-pin-seat", roles: ["reviewer"] },
                  { name: "healthy-seat", roles: ["reviewer"] },
                ],
              },
              db: () => db,
            }),
            { fallback_role: "reviewer" },
          ),
        ).toBe("dead-pin-seat");
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test("falls back to the default dead-pin window when the env value is invalid", () => {
    withDeadPinWindow("not-a-number", () => {
      const db = freshDb();
      writeDeadPinWorkerRows(db, [
        { suffix: "invalid-env-h3", ts: minutesAgo(1), outcome: "failed" },
        { suffix: "invalid-env-h2", ts: minutesAgo(2), outcome: "failed" },
        { suffix: "invalid-env-h1", ts: minutesAgo(3), outcome: "failed" },
      ]);

      const result = resolveAgent(
        { kind: "single", agent: "dead-pin-seat" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              { name: "dead-pin-seat", roles: ["reviewer"] },
              { name: "healthy-seat", roles: ["reviewer"] },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer" },
      );

      expect(result).not.toBe("dead-pin-seat");
    });
  });

  test("uses registry-style integer parsing for the dead-pin failure window", () => {
    const fixedNow = Date.parse("2026-09-03T12:00:00.000Z");
    withNow(fixedNow, () => {
      withDeadPinWindow("60000.5", () => {
        const db = freshDb();
        writeDeadPinWorkerRows(db, [
          {
            suffix: "float-window-h3",
            ts: new Date(fixedNow - 2 * 60_000).toISOString(),
            outcome: "failed",
          },
          {
            suffix: "float-window-h2",
            ts: new Date(fixedNow - 3 * 60_000).toISOString(),
            outcome: "failed",
          },
          {
            suffix: "float-window-h1",
            ts: new Date(fixedNow - 4 * 60_000).toISOString(),
            outcome: "failed",
          },
        ]);

        const result = resolveAgent(
          { kind: "single", agent: "dead-pin-seat" },
          "review_adversarial",
          ctx({
            config: {
              role_routing: { headroom_weighting: false },
              agents: [
                { name: "dead-pin-seat", roles: ["reviewer"] },
                { name: "healthy-seat", roles: ["reviewer"] },
              ],
            },
            db: () => db,
          }),
          { fallback_role: "reviewer" },
        );

        expect(result).not.toBe("dead-pin-seat");
      });
    });
  });

  test("includes a worker failure exactly at the dead-pin window boundary", () => {
    const fixedNow = Date.parse("2026-09-03T12:00:00.000Z");
    withNow(fixedNow, () => {
      withDeadPinWindow("1000", () => {
        const db = freshDb();
        writeDeadPinWorkerRows(db, [
          { suffix: "boundary-h3", ts: new Date(fixedNow - 998).toISOString(), outcome: "failed" },
          { suffix: "boundary-h2", ts: new Date(fixedNow - 999).toISOString(), outcome: "failed" },
          { suffix: "boundary-h1", ts: new Date(fixedNow - 1000).toISOString(), outcome: "failed" },
        ]);

        const result = resolveAgent(
          { kind: "single", agent: "dead-pin-seat" },
          "review_adversarial",
          ctx({
            config: {
              role_routing: { headroom_weighting: false },
              agents: [
                { name: "dead-pin-seat", roles: ["reviewer"] },
                { name: "healthy-seat", roles: ["reviewer"] },
              ],
            },
            db: () => db,
          }),
          { fallback_role: "reviewer" },
        );

        expect(result).not.toBe("dead-pin-seat");
      });
    });
  });

  test("rejects representable oversized dead-pin windows instead of expanding into stale failures", () => {
    const fixedNow = Date.parse("2026-09-03T12:00:00.000Z");
    withNow(fixedNow, () => {
      withDeadPinWindow(String(365 * 24 * 60 * 60_000), () => {
        const db = freshDb();
        writeDeadPinWorkerRows(db, [
          {
            suffix: "stale-oversized-h3",
            ts: new Date(fixedNow - 100 * 24 * 60 * 60_000).toISOString(),
            outcome: "failed",
          },
          {
            suffix: "stale-oversized-h2",
            ts: new Date(fixedNow - 101 * 24 * 60 * 60_000).toISOString(),
            outcome: "failed",
          },
          {
            suffix: "stale-oversized-h1",
            ts: new Date(fixedNow - 102 * 24 * 60 * 60_000).toISOString(),
            outcome: "failed",
          },
        ]);
        const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);

        try {
          expect(
            resolveAgent(
              { kind: "single", agent: "dead-pin-seat" },
              "review_adversarial",
              ctx({
                config: {
                  role_routing: { headroom_weighting: false },
                  agents: [
                    { name: "dead-pin-seat", roles: ["reviewer"] },
                    { name: "healthy-seat", roles: ["reviewer"] },
                  ],
                },
                db: () => db,
              }),
              { fallback_role: "reviewer" },
            ),
          ).toBe("dead-pin-seat");
        } finally {
          warnSpy.mockRestore();
        }
      });
    });
  });

  test("does not fail open for a non-representable oversized dead-pin window", () => {
    withDeadPinWindow("1e16", () => {
      const db = freshDb();
      writeDeadPinWorkerRows(db, [
        { suffix: "huge-window-h3", ts: minutesAgo(1), outcome: "failed" },
        { suffix: "huge-window-h2", ts: minutesAgo(2), outcome: "failed" },
        { suffix: "huge-window-h1", ts: minutesAgo(3), outcome: "failed" },
      ]);

      const result = resolveAgent(
        { kind: "single", agent: "dead-pin-seat" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              { name: "dead-pin-seat", roles: ["reviewer"] },
              { name: "healthy-seat", roles: ["reviewer"] },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer" },
      );

      expect(result).not.toBe("dead-pin-seat");
    });
  });

  test("logs only when an old dead pin revives outside the failure window", () => {
    const db = freshDb();
    writeDeadPinWorkerRows(db, [
      { suffix: "revived-h3", ts: daysAgo(8), outcome: "failed" },
      { suffix: "revived-h2", ts: daysAgo(9), outcome: "failed" },
      { suffix: "revived-h1", ts: daysAgo(10), outcome: "failed" },
    ]);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        resolveAgent(
          { kind: "single", agent: "dead-pin-seat" },
          "review_adversarial",
          ctx({
            config: {
              role_routing: { headroom_weighting: false },
              agents: [
                { name: "dead-pin-seat", roles: ["reviewer"] },
                { name: "healthy-seat", roles: ["reviewer"] },
              ],
            },
            db: () => db,
          }),
          { fallback_role: "reviewer" },
        ),
      ).toBe("dead-pin-seat");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toBe("[workflow-agent-resolver] dead pin revived");
      expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
        agent: "dead-pin-seat",
        task_type: "review_adversarial",
        stale_failures: 3,
      });

      warnSpy.mockClear();
      const healthyDb = freshDb();
      expect(
        resolveAgent(
          { kind: "single", agent: "dead-pin-seat" },
          "review_adversarial",
          ctx({
            config: {
              role_routing: { headroom_weighting: false },
              agents: [
                { name: "dead-pin-seat", roles: ["reviewer"] },
                { name: "healthy-seat", roles: ["reviewer"] },
              ],
            },
            db: () => healthyDb,
          }),
          { fallback_role: "reviewer" },
        ),
      ).toBe("dead-pin-seat");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("keeps a single pinned agent when any recent worker row completed", () => {
    const db = freshDb();
    writeDeadPinWorkerRows(db, [
      { suffix: "mixed-h3", ts: minutesAgo(1), outcome: "failed" },
      {
        suffix: "mixed-h2",
        ts: minutesAgo(2),
        outcome: "completed_with_output",
      },
      { suffix: "mixed-h1", ts: minutesAgo(3), outcome: "failed" },
    ]);

    expect(
      resolveAgent(
        { kind: "single", agent: "dead-pin-seat" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              { name: "dead-pin-seat", roles: ["reviewer"] },
              { name: "healthy-seat", roles: ["reviewer"] },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer" },
      ),
    ).toBe("dead-pin-seat");
  });

  test("keeps a single pinned agent when a recent worker failure was environmental", () => {
    const db = freshDb();
    writeDeadPinWorkerRows(db, [
      { suffix: "env-h3", ts: minutesAgo(1), outcome: "failed" },
      {
        suffix: "env-h2",
        ts: minutesAgo(2),
        outcome: "failed",
        environmentFailure: "y",
      },
      { suffix: "env-h1", ts: minutesAgo(3), outcome: "failed" },
    ]);

    expect(
      resolveAgent(
        { kind: "single", agent: "dead-pin-seat" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              { name: "dead-pin-seat", roles: ["reviewer"] },
              { name: "healthy-seat", roles: ["reviewer"] },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer" },
      ),
    ).toBe("dead-pin-seat");
  });

  test("keeps a dead single pinned agent when no fallback role is provided", () => {
    const db = freshDb();
    writeDeadPinWorkerRows(db, [
      { suffix: "nofallback-h3", ts: minutesAgo(1), outcome: "failed" },
      { suffix: "nofallback-h2", ts: minutesAgo(2), outcome: "failed" },
      { suffix: "nofallback-h1", ts: minutesAgo(3), outcome: "failed" },
    ]);

    expect(
      resolveAgent(
        { kind: "single", agent: "dead-pin-seat" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              { name: "dead-pin-seat", roles: ["reviewer"] },
              { name: "healthy-seat", roles: ["reviewer"] },
            ],
          },
          db: () => db,
        }),
      ),
    ).toBe("dead-pin-seat");
  });

  test("keeps a single pinned agent when recent failures are not worker-sourced", () => {
    const db = freshDb();
    writePerf(db, "dead-pin-seat", "review_adversarial", {
      handoffId: "nonworker-h3",
      ts: "2026-08-31T10:02:00.000Z",
      outcome: "failed",
    });
    writePerf(db, "dead-pin-seat", "review_adversarial", {
      handoffId: "nonworker-h2",
      ts: "2026-08-31T10:01:00.000Z",
      outcome: "failed",
      source: "reconciler",
    });
    writePerf(db, "dead-pin-seat", "review_adversarial", {
      handoffId: "nonworker-h1",
      ts: "2026-08-31T10:00:00.000Z",
      outcome: "failed",
    });

    expect(
      resolveAgent(
        { kind: "single", agent: "dead-pin-seat" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              { name: "dead-pin-seat", roles: ["reviewer"] },
              { name: "healthy-seat", roles: ["reviewer"] },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer" },
      ),
    ).toBe("dead-pin-seat");
  });

  test("routes away from a single pinned agent when non-environmental failures are separated by environmental rows", () => {
    const db = freshDb();
    // Non-failed environmental rows prove the env filter runs before the LIMIT/failure check.
    writeWorkerPerf(db, {
      agent: "dead-pin-seat",
      handoffId: "env-sep-h5",
      ts: minutesAgo(1),
      outcome: "completed_with_output",
      environmentFailure: "y",
    });
    writeWorkerPerf(db, {
      agent: "dead-pin-seat",
      handoffId: "env-sep-h4",
      ts: minutesAgo(2),
      outcome: "failed",
    });
    writeWorkerPerf(db, {
      agent: "dead-pin-seat",
      handoffId: "env-sep-h3",
      ts: minutesAgo(3),
      outcome: "completed_with_output",
      environmentFailure: "y",
    });
    writeWorkerPerf(db, {
      agent: "dead-pin-seat",
      handoffId: "env-sep-h2",
      ts: minutesAgo(4),
      outcome: "failed",
    });
    writeWorkerPerf(db, {
      agent: "dead-pin-seat",
      handoffId: "env-sep-h1",
      ts: minutesAgo(5),
      outcome: "failed",
    });

    const result = resolveAgent(
      { kind: "single", agent: "dead-pin-seat" },
      "review_adversarial",
      ctx({
        config: {
          role_routing: { headroom_weighting: false },
          agents: [
            { name: "dead-pin-seat", roles: ["reviewer"] },
            { name: "healthy-seat", roles: ["reviewer"] },
          ],
        },
        db: () => db,
      }),
      { fallback_role: "reviewer" },
    );

    expect(result).not.toBe("dead-pin-seat");
  });

  test("keeps the configured single agent when no fallback role is provided", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent({ kind: "single", agent: "a" }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("a");
  });

  test("routes away from a single preferred agent excluded by provider bias", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("b");
  });

  test("limits a single-agent fallback to reviewer-role agents", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writePerf(db, "c");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
              {
                name: "b",
                roles: ["executor"],
                pricing_mode: "subscription",
                subscription_provider: "openai",
              },
              {
                name: "c",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "google",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer" },
      ),
    ).toBe("c");
  });

  test("safely re-admits an excluded planner when no other planner-role agent exists", () => {
    const db = freshDb();
    writePerf(db, "a", "plan_refine");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "plan_refine",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["planner"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "planner" },
      ),
    ).toBe("a");
  });

  test("limits a plan-refine fallback to planner-role agents", () => {
    const db = freshDb();
    writePerf(db, "a", "plan_refine");
    writePerf(db, "b", "plan_refine");
    writePerf(db, "c", "plan_refine");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "plan_refine",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["planner"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
              {
                name: "b",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "openai",
              },
              {
                name: "c",
                roles: ["planner"],
                pricing_mode: "subscription",
                subscription_provider: "google",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "planner" },
      ),
    ).toBe("c");
  });

  test("avoids a pressured reviewer on a single-agent fallback", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writePerf(db, "c");
    writeBias(db, "provider", "anthropic", "exclude");
    writePressure(db, "openai", 95);
    writePressure(db, "google", 10);

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
              {
                name: "b",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "openai",
              },
              {
                name: "c",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "google",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer" },
      ),
    ).toBe("c");
  });

  test("forwards tool_free on a single-agent fallback", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writePerf(db, "c");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
              {
                name: "b",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "openai",
                adapter: "stdio-acp",
              },
              {
                name: "c",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "google",
                adapter: "openai-compat-http",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer", tool_free: true },
      ),
    ).toBe("c");
  });

  test("safely re-admits the preferred single agent when biases exclude every candidate", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "provider", "anthropic", "exclude");
    writeBias(db, "provider", "openai", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("a");
  });

  test("does not pick an excluded pool member when a non-excluded member exists", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("b");
  });

  test("does not pick an excluded pool member when the only non-excluded member has no history (synthesizer cold-start)", () => {
    const db = freshDb();
    writePerf(db, "a");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("b");
  });

  test("applies boost biases while resolving a pool", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    db.query(
      `UPDATE agent_performance SET rounds = 1, latency_ms = 10000 WHERE agent_name = 'b'`,
    ).run();
    writeBias(db, "agent", "b", "boost");

    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("b");
  });

  test("applies divert biases while resolving a pool", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    db.query(
      `UPDATE agent_performance SET rounds = 1, latency_ms = 10000 WHERE agent_name = 'b'`,
    ).run();
    writeBias(db, "agent", "a", "divert");

    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("b");
  });

  test("honors agent-scoped exclusions for a configured single agent", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "agent", "a", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("b");
  });

  test("ignores expired routing biases", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(
      db,
      "provider",
      "anthropic",
      "exclude",
      new Date(Date.parse(NOW) - 60_000).toISOString(),
    );

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("a");
  });

  test("keeps current single and pool behavior when the workflow database is unavailable", () => {
    const workflowCtx = ctx();

    expect(resolveAgent({ kind: "single", agent: "a" }, "review_adversarial", workflowCtx)).toBe(
      "a",
    );
    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", workflowCtx),
    ).toBe("a");
    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", workflowCtx, {
        excludeAgents: ["a"],
      }),
    ).toBe("b");
  });

  test("degrades to the configured single agent when the bias store read fails", () => {
    const db = freshDb();
    db.exec("DROP TABLE routing_bias");

    expect(
      resolveAgent({ kind: "single", agent: "a" }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("a");
  });

  test("degrades to the configured single agent when fallback routing throws", () => {
    const db = freshDb();
    writeBias(db, "provider", "anthropic", "exclude");
    db.exec("DROP TABLE agent_performance");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("a");
  });

  test("reads the database once and keeps the configured single agent when no bias is active", () => {
    let dbCalls = 0;
    const db = freshDb();
    const out = resolveAgent({ kind: "single", agent: "a" }, "review_adversarial", {
      ...ctx(),
      db: () => {
        dbCalls += 1;
        return db;
      },
    });

    expect(out).toBe("a");
    expect(dbCalls).toBe(1);
  });

  test("resolves pools using pressure-aware selection", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writePressure(db, "anthropic", 95);
    writePressure(db, "openai", 10);

    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("b");
  });

  test("tool_free:true reaches the scorer and demotes an ACP twin in favor of an equivalent HTTP twin", () => {
    // Two agents with identical performance histories so the only score
    // differentiator is the adapter-aware penalty wired through tool_free.
    // "acp-twin" carries an ACP adapter; "http-twin" carries an HTTP adapter.
    const db = freshDb();
    writePerf(db, "acp-twin");
    writePerf(db, "http-twin");
    const ctxWithAdapters = ctx({
      config: {
        role_routing: { headroom_weighting: false },
        agents: [
          {
            name: "acp-twin",
            roles: [],
            pricing_mode: "subscription",
            subscription_provider: "anthropic",
            adapter: "stdio-acp",
          },
          {
            name: "http-twin",
            roles: [],
            pricing_mode: "subscription",
            subscription_provider: "openai",
            adapter: "openai-compat-http",
          },
        ],
      },
      db: () => db,
    });

    // tool_free unset is the inert baseline. With identical performance the
    // scorer ties; pickFromPool's pickPreferred breaks the tie deterministically
    // and "acp-twin" wins by declaration order (no penalty).
    expect(
      resolveAgent(
        { kind: "pool", agents: ["acp-twin", "http-twin"] },
        "review_adversarial",
        ctxWithAdapters,
      ),
    ).toBe("acp-twin");

    // tool_free:true flips the winner: the ACP candidate gets the 0.85 penalty
    // and the HTTP twin overtakes it. Confirms the flag flows resolveAgent →
    // pickFromPool → routeAgent and the scorer's adapter check fires.
    expect(
      resolveAgent(
        { kind: "pool", agents: ["acp-twin", "http-twin"] },
        "review_adversarial",
        ctxWithAdapters,
        { tool_free: true },
      ),
    ).toBe("http-twin");
  });

  test("tool_free unset (the default for tool-needing callers) leaves the ACP candidate eligible to win", () => {
    // Mirrors the inert-default contract from the routeAgent test layer: a
    // caller that does NOT opt into tool_free must see ACP candidates compete
    // on baseline merit, with no transport penalty. Guards against the wiring
    // accidentally defaulting to true and breaking tool-needing roles.
    const db = freshDb();
    writePerf(db, "acp-twin");
    writePerf(db, "http-twin");
    const ctxWithAdapters = ctx({
      config: {
        role_routing: { headroom_weighting: false },
        agents: [
          {
            name: "acp-twin",
            roles: [],
            pricing_mode: "subscription",
            subscription_provider: "anthropic",
            adapter: "stdio-acp",
          },
          {
            name: "http-twin",
            roles: [],
            pricing_mode: "subscription",
            subscription_provider: "openai",
            adapter: "openai-compat-http",
          },
        ],
      },
      db: () => db,
    });

    // No tool_free → ACP keeps parity and wins on declaration-order tiebreak.
    expect(
      resolveAgent(
        { kind: "pool", agents: ["acp-twin", "http-twin"] },
        "review_adversarial",
        ctxWithAdapters,
      ),
    ).toBe("acp-twin");
    // Explicit false is also inert.
    expect(
      resolveAgent(
        { kind: "pool", agents: ["acp-twin", "http-twin"] },
        "review_adversarial",
        ctxWithAdapters,
        { tool_free: false },
      ),
    ).toBe("acp-twin");
  });
});
