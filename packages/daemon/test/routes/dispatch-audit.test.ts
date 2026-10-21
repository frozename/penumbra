import { DispatchAuditResponseSchema } from "@penumbra/api-contract";
import {
  buildDispatchAuditReport,
  buildServices,
  type DispatchAuditSources,
  dispatchAuditSourcesFromDb,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchAuditRoute } from "@src/routes/dispatch-audit.js";
import { createDaemonFetchHandler } from "@src/serve.js";

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
    uuid: () => `id-${String(++n)}`,
  });
}

const CHECK_RESULT_PROMPT = [
  "Task type: implement_small",
  "",
  "Implement the evidence renderer.",
  "IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.",
].join("\n");

function createCompletedHandoff(
  svc: Services,
  handoffId = "h-1",
  conversationId = "c-1",
  message = "Task type: implement_small\n\nchange it",
): void {
  svc.handoffWriter.create({
    handoff_id: handoffId,
    ts: "2026-05-01T00:00:00.000Z",
    from: "user",
    to: "codex",
    to_role: null,
    message,
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

function recordCompleteTimeline(
  svc: Services,
  handoffId = "h-1",
  dispatchEndMeta?: Record<string, unknown>,
): void {
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
      ...(dispatchEndMeta ? { meta: dispatchEndMeta } : {}),
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
    const res = dispatchAuditRoute(new Request("http://x/dispatch/audit"), svc);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_handoff_id" });
  });

  test("returns 404 for unknown handoff", async () => {
    const svc = services();
    const res = dispatchAuditRoute(
      new Request("http://x/dispatch/audit?handoff_id=h-missing"),
      svc,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "handoff_not_found" });
  });

  test("uses the supplied service readers and clock without replacing them", async () => {
    const svc = services();
    createCompletedHandoff(svc, "h-supplied", "c-supplied");
    recordCompleteTimeline(svc, "h-supplied");
    writeAgentResponse(svc, "c-supplied", "DONE");
    const calls: string[] = [];
    const sources = {
      handoffReader: {
        get: (handoffId: string): ReturnType<Services["handoffReader"]["get"]> => {
          calls.push(`handoff:${handoffId}`);
          return svc.handoffReader.get(handoffId);
        },
      },
      dispatchEventLog: {
        listByHandoff: (
          handoffId: string,
        ): ReturnType<Services["dispatchEventLog"]["listByHandoff"]> => {
          calls.push(`events:${handoffId}`);
          return svc.dispatchEventLog.listByHandoff(handoffId);
        },
      },
      chainReader: {
        getResponses: (
          conversationId: string,
          which: "final" | "all",
        ): ReturnType<Services["chainReader"]["getResponses"]> => {
          calls.push(`responses:${conversationId}:${which}`);
          return svc.chainReader.getResponses(conversationId, which);
        },
      },
      clock: (): Date => {
        calls.push("clock");
        return new Date("2026-05-01T00:00:20.000Z");
      },
    } satisfies DispatchAuditSources;

    const res = dispatchAuditRoute(
      new Request("http://x/dispatch/audit?handoff_id=h-supplied"),
      sources,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { report: { status: string } }).report.status).toBe("complete");
    expect(calls).toEqual([
      "handoff:h-supplied",
      "events:h-supplied",
      "responses:c-supplied:final",
      "clock",
    ]);
  });

  test("returns no_agent_output for completed handoff with no response", async () => {
    const svc = services();
    createCompletedHandoff(svc);
    recordCompleteTimeline(svc);

    const res = dispatchAuditRoute(new Request("http://x/dispatch/audit?handoff_id=h-1"), svc);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: {
        evidence: { response_count: number };
        handoff_id: string;
        status: string;
        trustworthy: boolean;
      };
    };
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

    const res = dispatchAuditRoute(new Request("http://x/dispatch/audit?handoff_id=h-1"), svc);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: {
        evidence: { response_count: number };
        status: string;
      };
    };
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

  test("audit response safeParses DispatchAuditResponseSchema", async () => {
    const svc = services();
    createCompletedHandoff(svc);
    const incomplete = dispatchAuditRoute(
      new Request("http://x/dispatch/audit?handoff_id=h-1"),
      svc,
    );
    expect(incomplete.status).toBe(200);
    const incompleteBody = DispatchAuditResponseSchema.parse(await incomplete.json());
    expect(incompleteBody.report.status).not.toBe("complete");
    recordCompleteTimeline(svc);
    writeAgentResponse(svc, "c-1", "DONE");

    const res = dispatchAuditRoute(new Request("http://x/dispatch/audit?handoff_id=h-1"), svc);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(DispatchAuditResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe("buildDispatchAuditReport", () => {
  test("returns an unwrapped report with trustworthy=true for a complete handoff", () => {
    const svc = services();
    createCompletedHandoff(svc);
    recordCompleteTimeline(svc);
    writeAgentResponse(svc, "c-1", "DONE");

    const report = buildDispatchAuditReport(dispatchAuditSourcesFromDb(svc.db, svc.clock), "h-1");

    expect(report).not.toBeNull();
    expect(report!.handoff_id).toBe("h-1");
    expect(report!.status).toBe("complete");
    expect(report!.terminal).toBe(true);
    expect(report!.trustworthy).toBe(true);
    expect(report!.evidence.response_count).toBe(1);
  });

  test("returns null for an unknown handoff", () => {
    const svc = services();
    const report = buildDispatchAuditReport(
      dispatchAuditSourcesFromDb(svc.db, svc.clock),
      "missing",
    );
    expect(report).toBeNull();
  });

  test("produces the same report as the route with a fixed clock", async () => {
    const svc = services();
    createCompletedHandoff(svc, "h-same", "c-same");
    recordCompleteTimeline(svc, "h-same");
    writeAgentResponse(svc, "c-same", "DONE");

    const routeRes = dispatchAuditRoute(
      new Request("http://x/dispatch/audit?handoff_id=h-same"),
      svc,
    );
    expect(routeRes.status).toBe(200);
    const routeBody = (await routeRes.json()) as {
      report: ReturnType<typeof buildDispatchAuditReport>;
    };

    const report = buildDispatchAuditReport(
      dispatchAuditSourcesFromDb(svc.db, svc.clock),
      "h-same",
    );

    expect(report).toEqual(routeBody.report);
  });

  test("factory report equals a services-backed report and leaves the DB usable", () => {
    const svc = services();
    createCompletedHandoff(svc, "h-factory", "c-factory");
    recordCompleteTimeline(svc, "h-factory");
    writeAgentResponse(svc, "c-factory", "DONE");

    const factoryReport = buildDispatchAuditReport(
      dispatchAuditSourcesFromDb(svc.db, svc.clock),
      "h-factory",
    );

    const servicesReport = buildDispatchAuditReport(svc, "h-factory");

    expect(factoryReport).toEqual(servicesReport);
    expect(svc.db.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
  });

  test("factory reads a caller-owned readonly DB without closing it", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "penumbra-dispatch-audit-readonly-"));
    const dbPath = join(fixtureDir, "penumbra.db");
    const writableDb = new Database(dbPath);
    let writableDbOpen = true;

    try {
      loadSqliteVec(writableDb);
      migrate(writableDb, { embeddingDim: 384 });
      const svc = buildServices({
        env: {},
        input: {},
        storageRoot: fixtureDir,
        db: writableDb,
        embedder: new TestEmbedder({ dim: 384 }),
        clock: () => new Date("2026-05-01T00:00:20.000Z"),
        uuid: () => "fixture-id",
      });
      createCompletedHandoff(svc, "h-readonly", "c-readonly");
      recordCompleteTimeline(svc, "h-readonly");
      writeAgentResponse(svc, "c-readonly", "DONE");
      writableDb.close();
      writableDbOpen = false;

      const readonlyDb = new Database(dbPath, { readonly: true });
      try {
        const report = buildDispatchAuditReport(
          dispatchAuditSourcesFromDb(readonlyDb, svc.clock),
          "h-readonly",
        );

        expect(report?.status).toBe("complete");
        expect(readonlyDb.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
      } finally {
        readonlyDb.close();
      }
    } finally {
      if (writableDbOpen) writableDb.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("flags a completed turn whose final response lacks the prompt's CHECK_RESULT line", () => {
    const svc = services();
    createCompletedHandoff(svc, "h-mid", "c-mid", CHECK_RESULT_PROMPT);
    recordCompleteTimeline(svc, "h-mid");
    writeAgentResponse(svc, "c-mid", "Now let me write the evidence renderer file.");

    const report = buildDispatchAuditReport(svc, "h-mid");

    expect(report?.status).toBe("end_turn_without_return_block");
    expect(report?.trustworthy).toBe(false);
    expect(report?.recommended_action).toBe("retry");
    expect(DispatchAuditResponseSchema.safeParse({ report }).success).toBe(true);
  });

  test("accepts a completed turn that returns the prompt's CHECK_RESULT line", () => {
    const svc = services();
    createCompletedHandoff(svc, "h-pass", "c-pass", CHECK_RESULT_PROMPT);
    recordCompleteTimeline(svc, "h-pass");
    writeAgentResponse(svc, "c-pass", "CHECK_RESULT: PASS\nall green");

    const report = buildDispatchAuditReport(svc, "h-pass");

    expect(report?.status).toBe("complete");
    expect(report?.recommended_action).toBe("accept");
  });

  test("flags an implementation turn whose dispatch.end recorded a dirty worktree", () => {
    const svc = services();
    createCompletedHandoff(svc, "h-dirty", "c-dirty");
    recordCompleteTimeline(svc, "h-dirty", {
      status: "ok",
      worktree_changed: true,
      dirty: true,
      committed: true,
    });
    writeAgentResponse(svc, "c-dirty", "DONE");

    const report = buildDispatchAuditReport(svc, "h-dirty");

    expect(report?.status).toBe("end_turn_without_return_block");
    expect(report?.recommended_action).toBe("retry");
  });

  test("flags a dispatch whose dispatch.end shows the branch left its base", () => {
    const svc = services();
    createCompletedHandoff(svc, "h-reset", "c-reset");
    recordCompleteTimeline(svc, "h-reset", {
      status: "ok",
      worktree_changed: true,
      dirty: false,
      committed: true,
      commit_integrity: {
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        base_is_ancestor: false,
        identity: { name: "Penumbra Worker", email: "worker@example.com" },
        mismatched_commits: [],
      },
    });
    writeAgentResponse(svc, "c-reset", "DONE");

    const report = buildDispatchAuditReport(svc, "h-reset");

    expect(report?.status).toBe("base_not_ancestor");
    expect(report?.trustworthy).toBe(false);
    expect(report?.recommended_action).toBe("review_manually");
    expect(report?.evidence.commit_integrity?.base_sha).toBe("a".repeat(40));
    expect(DispatchAuditResponseSchema.safeParse({ report }).success).toBe(true);
  });

  test("lists commits made under another identity", () => {
    const svc = services();
    createCompletedHandoff(svc, "h-idmis", "c-idmis");
    recordCompleteTimeline(svc, "h-idmis", {
      status: "ok",
      worktree_changed: true,
      dirty: false,
      committed: true,
      commit_integrity: {
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        base_is_ancestor: true,
        identity: { name: "Penumbra Worker", email: "worker@example.com" },
        mismatched_commits: ["c".repeat(40)],
      },
    });
    writeAgentResponse(svc, "c-idmis", "DONE");

    const report = buildDispatchAuditReport(svc, "h-idmis");

    expect(report?.status).toBe("commit_identity_mismatch");
    expect(report?.summary).toContain("c".repeat(12));
  });

  test("ignores malformed commit-integrity meta", () => {
    const svc = services();
    createCompletedHandoff(svc, "h-corrupt", "c-corrupt");
    recordCompleteTimeline(svc, "h-corrupt", {
      status: "ok",
      worktree_changed: true,
      dirty: false,
      committed: true,
      commit_integrity: { base_is_ancestor: "no" },
    });
    writeAgentResponse(svc, "c-corrupt", "DONE");

    const report = buildDispatchAuditReport(svc, "h-corrupt");

    expect(report?.status).toBe("complete");
  });

  test("no agent output stays untrustworthy and absent metadata stays null", () => {
    const svc = services();
    createCompletedHandoff(svc, "h-empty", "c-empty");
    recordCompleteTimeline(svc, "h-empty");

    const report = buildDispatchAuditReport(
      dispatchAuditSourcesFromDb(svc.db, svc.clock),
      "h-empty",
    );

    expect(report).not.toBeNull();
    expect(report!.status).toBe("no_agent_output");
    expect(report!.trustworthy).toBe(false);
    expect(report!.evidence.worktree_changed).toBeNull();
    expect(report!.evidence.dispatch_end_committed).toBeNull();
  });
});
