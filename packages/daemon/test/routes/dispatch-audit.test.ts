import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "../../src/serve.js";
import { dispatchAuditRoute } from "../../src/routes/dispatch-audit.js";

function services(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/dispatch-audit-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-01T00:00:20.000Z"),
    uuid: () => `id-${++n}`,
  });
}

function createCompletedHandoff(svc: Services, handoffId = "h-1", conversationId = "c-1"): void {
  svc.handoffWriter.create({
    handoff_id: handoffId,
    ts: "2026-05-01T00:00:00.000Z",
    from: "user",
    to: "codex",
    to_role: null,
    message: "Task type: implement_small\n\nchange it",
    conversation_id: conversationId,
    project_id: null,
    triggered_by_event_id: "e-1",
    use_worktree: true,
    chain_task_type: "implement_small",
  });
  svc.handoffWriter.approve(handoffId, {
    resolved_by: "test",
    resolved_at: "2026-05-01T00:00:01.000Z",
  });
  svc.handoffWriter.claimDispatch(handoffId, "worker-1");
  svc.handoffWriter.markCompleted(handoffId, { ts: "2026-05-01T00:00:10.000Z" });
}

function recordCompleteTimeline(svc: Services, handoffId = "h-1"): void {
  svc.dispatchEventLog.recordBatch([
    {
      handoff_id: handoffId,
      worker_id: "worker-1",
      source: "worker",
      kind: "dispatch.start",
      ts: "2026-05-01T00:00:02.000Z",
    },
    {
      handoff_id: handoffId,
      worker_id: "worker-1",
      source: "worker",
      kind: "proc.spawn",
      ts: "2026-05-01T00:00:03.000Z",
    },
    {
      handoff_id: handoffId,
      worker_id: "worker-1",
      source: "worker",
      kind: "proc.exited.resolved",
      ts: "2026-05-01T00:00:08.000Z",
    },
    {
      handoff_id: handoffId,
      worker_id: "worker-1",
      source: "worker",
      kind: "dispatch.end",
      ts: "2026-05-01T00:00:09.000Z",
    },
  ]);
}

function writeAgentResponse(svc: Services, conversationId: string, response: string): void {
  svc.t0Writer.write({
    event_id: "response-1",
    ts: "2026-05-01T00:00:11.000Z",
    ingest_ts: "2026-05-01T00:00:11.000Z",
    source: "agentchat",
    source_detail: null,
    project_id: null,
    user_id: "codex",
    machine_id: "machine-1",
    session_id: conversationId,
    event_type: "agent-response",
    lane: "local",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: { response },
    payload_summary: response,
  });
}

describe("dispatchAuditRoute", () => {
  test("returns 400 when handoff_id is missing", async () => {
    const svc = services();
    const res = await dispatchAuditRoute(new Request("http://x/dispatch/audit"), svc);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_handoff_id" });
  });

  test("returns 404 for unknown handoff", async () => {
    const svc = services();
    const res = await dispatchAuditRoute(
      new Request("http://x/dispatch/audit?handoff_id=h-missing"),
      svc,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "handoff_not_found" });
  });

  test("returns no_agent_output for completed handoff with no response", async () => {
    const svc = services();
    createCompletedHandoff(svc);
    recordCompleteTimeline(svc);

    const res = await dispatchAuditRoute(
      new Request("http://x/dispatch/audit?handoff_id=h-1"),
      svc,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.handoff_id).toBe("h-1");
    expect(body.report.status).toBe("no_agent_output");
    expect(body.report.trustworthy).toBe(false);
    expect(body.report.evidence.response_count).toBe(0);
  });

  test("includes available conversation responses in the reliability report", async () => {
    const svc = services();
    createCompletedHandoff(svc);
    recordCompleteTimeline(svc);
    writeAgentResponse(svc, "c-1", "DONE");

    const res = await dispatchAuditRoute(
      new Request("http://x/dispatch/audit?handoff_id=h-1"),
      svc,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.status).toBe("complete");
    expect(body.report.evidence.response_count).toBe(1);
  });

  test("serve.ts wires authenticated GET /dispatch/audit", async () => {
    const svc = services();
    createCompletedHandoff(svc, "h-serve", "c-serve");
    recordCompleteTimeline(svc, "h-serve");
    const handler = createDaemonFetchHandler({ services: svc, token: "tok" });

    const res = await handler(
      new Request("http://x/dispatch/audit?handoff_id=h-serve", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { report: { handoff_id: string } }).report.handoff_id).toBe(
      "h-serve",
    );
  });
});
