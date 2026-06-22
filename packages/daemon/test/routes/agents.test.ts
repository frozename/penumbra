import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import {
  agentsFleetLatencyRoute,
  agentsPerformanceImportMarkdownRoute,
  agentsPerformanceMarkdownRoute,
  agentsPerformanceOperatorRoute,
  agentsPerformanceReconcilerRoute,
  agentsRankRoute,
  agentsRecommendRoute,
} from "../../src/routes/agents.js";
import { createDaemonFetchHandler } from "../../src/serve.js";
import { registerWorkerForTest } from "../../test-utils.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function makeServices(db: Database): Services {
  let n = 0;
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/agents-route-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    uuid: () => {
      n += 1;
      return `perf-${String(n)}`;
    },
    clock: () => new Date("2026-04-30T12:03:00Z"),
  });
}

interface ReconcilerCaptureResponse {
  performance: { outcome: string };
}

interface ErrorCodeResponse {
  error: { code: string };
}

interface RankResponse {
  window: { from: string | null };
  candidates: { agent_name: string }[];
}

interface OperatorCaptureResponse {
  performance: {
    handoff_id: string;
    agent_name: string;
    task_type: string;
    outcome: string;
    latency_ms: number;
    source: string;
  };
}

function makeHandlerFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return (input, init): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  };
}

describe("agent routes", () => {
  let db: Database;
  let services: Services;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    services = makeServices(db);
    db.prepare(
      `
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, triggered_by_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "h1",
      "2026-04-30T12:00:00Z",
      "proj",
      "conv",
      "maestro",
      "claude",
      null,
      "Task type: implement_substantial",
      "completed",
      "worker",
      "2026-04-30T12:01:00Z",
      "event-1",
    );
  });

  it("captures reconciler results", async () => {
    const req = new Request("http://x/agents/performance/reconciler", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handoff_id: "h1",
        result: { status: "pr_opened", pr_url: "https://example.test/pull/1" },
      }),
    });
    const res = await agentsPerformanceReconcilerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReconcilerCaptureResponse;
    expect(body.performance.outcome).toBe("pr_opened");
  });

  it("captures verified reconciler results as a success outcome", async () => {
    const req = new Request("http://x/agents/performance/reconciler", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handoff_id: "h1",
        result: { status: "verified" },
      }),
    });

    const res = await agentsPerformanceReconcilerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReconcilerCaptureResponse;
    expect(body.performance.outcome).toBe("completed_with_output");

    const row = db
      .query<
        { outcome: string; source: string },
        [string]
      >("SELECT outcome, source FROM agent_performance WHERE handoff_id=?")
      .get("h1");
    expect(row).toEqual({
      outcome: "completed_with_output",
      source: "reconciler",
    });
  });

  it("rejects dispatch performance capture when worker token does not own the handoff", async () => {
    const handler = createDaemonFetchHandler({ services, token: "tok" });
    const registered = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: "tok",
      worker_id: "worker-b",
      fetcher: makeHandlerFetcher(handler),
    });
    db.prepare(`UPDATE handoffs SET worker_id = ?, chain_task_type = ? WHERE handoff_id = ?`).run(
      "worker-a",
      "review_adversarial",
      "h1",
    );

    const res = await handler(
      new Request("http://x/agents/performance/dispatch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${registered.worker_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          handoff_id: "h1",
          reason: "completed",
          task_type: "implement_substantial",
          worktree_changed: false,
          final_response_chars: 66,
          has_meaningful_output: true,
        }),
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorCodeResponse;
    expect(body.error.code).toBe("handoff_worker_mismatch");
    const count = db
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM agent_performance`)
      .get();
    expect(count?.count).toBe(0);
  });

  it("returns 404 before dispatch performance capture when handoff is missing", async () => {
    const handler = createDaemonFetchHandler({ services, token: "tok" });
    const registered = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: "tok",
      worker_id: "worker-b",
      fetcher: makeHandlerFetcher(handler),
    });

    const res = await handler(
      new Request("http://x/agents/performance/dispatch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${registered.worker_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          handoff_id: "missing-handoff",
          reason: "error",
          task_type: "review_adversarial",
          worktree_changed: false,
          final_response_chars: 39,
          has_meaningful_output: false,
        }),
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });

  it("returns rank output", async () => {
    await agentsPerformanceReconcilerRoute(
      new Request("http://x/agents/performance/reconciler", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoff_id: "h1", result: { status: "pr_opened" } }),
      }),
      services,
    );

    const res = await agentsRankRoute(
      new Request("http://x/agents/rank?task_type=implement_substantial"),
      services,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RankResponse;
    // rank now defaults to a bounded 30-day window, so window.from is the cutoff, not null.
    expect(typeof body.window.from).toBe("string");
    expect(body.candidates[0].agent_name).toBe("claude");
  });

  it("returns rank output for long-lived rows only when requested", async () => {
    db.prepare(
      `
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
        rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used, latency_ms, source,
        notes, agent_kind, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "perf-long-lived",
      "2026-04-30T12:00:00Z",
      "h-long-lived",
      null,
      null,
      "orch",
      "implement_substantial",
      "merged",
      1,
      "y",
      0,
      5,
      0.4,
      10,
      1000,
      "worker",
      null,
      "long_lived",
      "{}",
    );

    const res = await agentsRankRoute(
      new Request("http://x/agents/rank?task_type=implement_substantial&agent_kind=long_lived"),
      services,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: { agent_name: string }[] };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].agent_name).toBe("orch");
  });

  it("returns 400 for invalid task_type", async () => {
    const res = await agentsRankRoute(new Request("http://x/agents/rank?task_type=bad"), services);
    expect(res.status).toBe(400);
  });

  it("returns fleet latency over the requested window", async () => {
    const insertHandoff = db.prepare(
      `
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
        to_role, message, status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    insertHandoff.run(
      "h2",
      "2026-04-30T11:58:00Z",
      "proj",
      "conv-2",
      "maestro",
      "claude",
      null,
      "Task type: implement_small",
      "completed",
      "worker",
      "2026-04-30T12:00:00Z",
      "event-2",
    );
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', 'dispatch.end', ?, ?)
    `,
    ).run("h2", "worker-1", "2026-04-30T12:00:00Z", JSON.stringify({ wall_ms: 9000 }));

    const res = await agentsFleetLatencyRoute(
      new Request("http://x/agents/fleet_latency?window_hours=1"),
      services,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: { from: string; to: string; hours: number };
      agents: {
        agent_name: string;
        dispatch_count: number;
        dispatches_per_hour: number;
        exec_ms_p50: number;
        exec_ms_p95: number;
        framework_overhead_ms_p50: number | null;
        framework_overhead_ms_p95: number | null;
        acp_session_reuse_rate: number | null;
        framework_overhead_ms_p50_cold: number | null;
        framework_overhead_ms_p50_reuse: number | null;
        queue_depth: number;
      }[];
    };
    expect(body.window).toEqual({
      from: "2026-04-30T11:03:00.000Z",
      to: "2026-04-30T12:03:00.000Z",
      hours: 1,
    });
    expect(body.agents).toEqual([
      {
        agent_name: "claude",
        dispatch_count: 1,
        dispatches_per_hour: 1,
        exec_ms_p50: 9000,
        exec_ms_p95: 9000,
        framework_overhead_ms_p50: null,
        framework_overhead_ms_p95: null,
        acp_session_reuse_rate: null,
        framework_overhead_ms_p50_cold: null,
        framework_overhead_ms_p50_reuse: null,
        queue_depth: 0,
      },
    ]);
  });

  it("returns recommend output", async () => {
    await agentsPerformanceReconcilerRoute(
      new Request("http://x/agents/performance/reconciler", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoff_id: "h1", result: { status: "pr_opened" } }),
      }),
      services,
    );

    const res = await agentsRecommendRoute(
      new Request("http://x/agents/recommend?task_type=implement_substantial"),
      services,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent_name: string }[];
    expect(body[0].agent_name).toBe("claude");
  });

  it("returns recommend output for long-lived rows only when requested", async () => {
    db.prepare(
      `
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
        rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used, latency_ms, source,
        notes, agent_kind, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "perf-long-lived",
      "2026-04-30T12:00:00Z",
      "h-long-lived",
      null,
      null,
      "orch",
      "implement_substantial",
      "merged",
      1,
      "y",
      0,
      5,
      0.4,
      10,
      1000,
      "worker",
      null,
      "long_lived",
      "{}",
    );

    const res = await agentsRecommendRoute(
      new Request(
        "http://x/agents/recommend?task_type=implement_substantial&agent_kind=long_lived",
      ),
      services,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent_name: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].agent_name).toBe("orch");
  });

  it("captures operator results and persists the row", async () => {
    const res = await agentsPerformanceOperatorRoute(
      new Request("http://x/agents/performance/operator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handoff_id: "h1",
          task_type: "implement_substantial",
          outcome: "merged",
          rounds: 1,
          smoke_pass: "y",
          reviewer_findings: 0,
          maestro_score: 5,
          cost_usd: 0.4,
          notes: "Clean first-shot implementation.",
        }),
      }),
      services,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as OperatorCaptureResponse;
    expect(body.performance.handoff_id).toBe("h1");
    expect(body.performance.agent_name).toBe("claude");
    expect(body.performance.task_type).toBe("implement_substantial");
    expect(body.performance.outcome).toBe("merged");
    expect(body.performance.latency_ms).toBe(60_000);
    expect(body.performance.source).toBe("operator");

    const persisted = db
      .query<
        { handoff_id: string; agent_name: string; source: string; latency_ms: number },
        [string]
      >("SELECT handoff_id, agent_name, source, latency_ms FROM agent_performance WHERE handoff_id=?")
      .get("h1");
    expect(persisted).toEqual({
      handoff_id: "h1",
      agent_name: "claude",
      source: "operator",
      latency_ms: 60_000,
    });
  });

  it("returns 404 for operator capture when the handoff is missing", async () => {
    const res = await agentsPerformanceOperatorRoute(
      new Request("http://x/agents/performance/operator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handoff_id: "missing",
          task_type: "implement_substantial",
          outcome: "merged",
        }),
      }),
      services,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "handoff not found: missing" },
    });
  });

  it("returns 400 for malformed operator capture payloads", async () => {
    const res = await agentsPerformanceOperatorRoute(
      new Request("http://x/agents/performance/operator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handoff_id: "h1",
          task_type: "bad",
          outcome: "merged",
        }),
      }),
      services,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorCodeResponse;
    expect(body.error.code).toBe("invalid_params");
  });

  it("imports markdown ledger rows", async () => {
    const markdown = `
| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-28 | codex-mini | implement_substantial | merged* | 1 | y | 5 | 0 | ~0.40 | 8 | Clean first-shot; cherry-picked to main. |
| 2026-04-28 | gemini | implement_substantial | merged_with_concerns | 1 | n* | 5 | 0 | ~0.60 | 13 | Smoke failed but caught a real architecture bug. |
`;

    const res = await agentsPerformanceImportMarkdownRoute(
      new Request("http://x/agents/performance/import-markdown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          markdown,
          sourcePath: "docs/superpowers/notes/agent-performance.md",
          projectId: "penumbra",
        }),
      }),
      services,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 2, skipped: 0 });
  });

  it("renders the markdown ledger as text/markdown", async () => {
    await agentsPerformanceOperatorRoute(
      new Request("http://x/agents/performance/operator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handoff_id: "h1",
          task_type: "implement_substantial",
          outcome: "merged",
          rounds: 1,
          smoke_pass: "y",
          reviewer_findings: 0,
          maestro_score: 5,
          cost_usd: 0.4,
          notes: "Clean first-shot implementation.",
        }),
      }),
      services,
    );

    const res = await agentsPerformanceMarkdownRoute(
      new Request("http://x/agents/performance/markdown"),
      services,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Generated from agent_performance");
    expect(body).toContain(
      "| 2026-04-30 | claude | implement_substantial | merged | 1 | y | 5 | 0 | 0.40 | 1 | Clean first-shot implementation. |",
    );
  });

  it("serve.ts wires authenticated agent performance ledger routes", async () => {
    const handler = createDaemonFetchHandler({ services, token: "tok" });
    const operator = await handler(
      new Request("http://x/agents/performance/operator", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          handoff_id: "h1",
          task_type: "implement_substantial",
          outcome: "merged",
        }),
      }),
    );
    expect(operator.status).toBe(200);

    const importMarkdown = await handler(
      new Request("http://x/agents/performance/import-markdown", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          markdown: `
| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-29 | codex-mini | docs_mechanical | no_changes | 0 | n/a | 4 | 0 | ~1.25 | n/a | Cost marker row. |
`,
          sourcePath: "docs/superpowers/notes/agent-performance.md",
          projectId: "penumbra",
        }),
      }),
    );
    expect(importMarkdown.status).toBe(200);

    const markdown = await handler(
      new Request("http://x/agents/performance/markdown", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await markdown.text()).toContain("Generated from agent_performance");

    const recommend = await handler(
      new Request("http://x/agents/recommend?task_type=implement_substantial", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(recommend.status).toBe(200);
  });
});
