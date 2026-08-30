import type { DaemonClient } from "@src/daemon-client.js";

import { loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { agentRecommendHandler } from "@src/tools/agent-recommend.js";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { agentsRecommendRoute } from "../../../daemon/src/routes/agents.js";
import { fakeDaemon } from "../helpers.js";

type AgentRecommendFn = DaemonClient["agentRecommend"];

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function makeServices(db: Database): Services {
  let n = 0;
  return {
    db,
    uuid: () => `perf-${String(++n)}`,
    clock: () => new Date("2026-05-26T12:00:00Z"),
    machineId: { get: () => "test-machine" },
    agentchatConfig: {
      default_roles: {
        executor: "claude-acp-sonnet",
      },
      agents: [
        { name: "codex-acp-spark", roles: ["workload-impl"] },
        { name: "gemini-acp-pro", roles: ["workload-impl"] },
        { name: "claude-acp-sonnet", roles: ["executor"] },
      ],
      workloads: {
        implement_substantial: {
          eligible_roles: ["workload-impl"],
          eligible_agents: ["codex-acp-spark", "gemini-acp-pro"],
        },
      },
    },
  } as unknown as Services;
}

function insertPerformanceRow(
  db: Database,
  input: {
    id: string;
    ts: string;
    handoffId: string;
    agent: string;
    taskType: string;
    outcome: string;
    latencyMs: number;
  },
): void {
  db.prepare(
    `
    INSERT INTO agent_performance (
      performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
      rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used, latency_ms, source,
      notes, agent_kind, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    input.id,
    input.ts,
    input.handoffId,
    null,
    "proj",
    input.agent,
    input.taskType,
    input.outcome,
    1,
    "y",
    0,
    5,
    0.1,
    100,
    input.latencyMs,
    "worker",
    null,
    "coding",
    "{}",
  );
}

function makeBridgeHandler(services: Services): ReturnType<typeof agentRecommendHandler> {
  const agentRecommend: AgentRecommendFn = async (input) => {
    const params = new URLSearchParams();
    if (input.task_type !== undefined) params.set("task_type", input.task_type);
    if (input.workload !== undefined) params.set("workload", input.workload);
    if (input.risk_class !== undefined) params.set("risk_class", input.risk_class);
    if (input.window_days !== undefined) params.set("window_days", String(input.window_days));
    if (input.agent_kind !== undefined) params.set("agent_kind", input.agent_kind);
    const res = agentsRecommendRoute(
      new Request(`http://x/agents/recommend?${params.toString()}`),
      services,
    );
    if (res.status !== 200) {
      const body = (await res.json().catch(() => ({}))) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message ?? `agentsRecommendRoute failed: ${String(res.status)}`);
    }
    return await res.json();
  };
  return agentRecommendHandler(fakeDaemon({ agentRecommend }));
}

describe("agent_recommend workload routing", () => {
  let db: Database;
  let services: Services;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    services = makeServices(db);

    insertPerformanceRow(db, {
      id: "p1",
      ts: "2026-05-26T10:00:00Z",
      handoffId: "h1",
      agent: "codex-acp-spark",
      taskType: "implement_substantial",
      outcome: "merged",
      latencyMs: 25_000,
    });
    insertPerformanceRow(db, {
      id: "p2",
      ts: "2026-05-26T10:05:00Z",
      handoffId: "h2",
      agent: "gemini-acp-pro",
      taskType: "implement_substantial",
      outcome: "failed",
      latencyMs: 40_000,
    });
    insertPerformanceRow(db, {
      id: "p3",
      ts: "2026-05-26T10:10:00Z",
      handoffId: "h3",
      agent: "claude-acp-sonnet",
      taskType: "implement_substantial",
      outcome: "merged",
      latencyMs: 10_000,
    });

    insertPerformanceRow(db, {
      id: "p4",
      ts: "2026-05-26T10:15:00Z",
      handoffId: "h4",
      agent: "claude-acp-sonnet",
      taskType: "docs_mechanical",
      outcome: "merged",
      latencyMs: 11_000,
    });
    insertPerformanceRow(db, {
      id: "p5",
      ts: "2026-05-26T10:20:00Z",
      handoffId: "h5",
      agent: "codex-acp-spark",
      taskType: "docs_mechanical",
      outcome: "merged",
      latencyMs: 20_000,
    });
  });

  function firstBlockText(envelope: { content: { text: string }[] }): string {
    const block = envelope.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    return block.text;
  }

  it("filters implement_substantial candidates to workload-eligible agents and preserves ledger order", async () => {
    const handler = makeBridgeHandler(services);
    const out = await handler({ workload: "implement_substantial" });
    const rows = JSON.parse(firstBlockText(out)) as { agent_name: string }[];
    expect(rows.map((row) => row.agent_name)).toEqual(["codex-acp-spark", "gemini-acp-pro"]);
  });

  it("workload alias and task_type produce identical recommendations", async () => {
    const handler = makeBridgeHandler(services);
    const viaWorkload = await handler({ workload: "implement_substantial" });
    const viaTaskType = await handler({ task_type: "implement_substantial" });
    expect(firstBlockText(viaWorkload)).toBe(firstBlockText(viaTaskType));
  });

  it("falls back to existing behavior when workload config is absent", async () => {
    const handler = makeBridgeHandler(services);
    const out = await handler({ workload: "docs_mechanical" });
    const rows = JSON.parse(firstBlockText(out)) as { agent_name: string }[];
    expect(rows.map((row) => row.agent_name)).toEqual(["claude-acp-sonnet", "codex-acp-spark"]);
  });

  it("rejects conflicting workload and task_type with chain_start conflict format", async () => {
    const handler = makeBridgeHandler(services);
    let caught: unknown;
    try {
      await handler({ workload: "implement_substantial", task_type: "review_adversarial" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "agent_recommend: workload='implement_substantial' conflicts with task_type='review_adversarial'; pass only one or matching values",
    );
  });
});
