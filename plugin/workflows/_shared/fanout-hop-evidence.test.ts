import { DispatchEventLog, HandoffWriter, loadSqliteVec, migrate, T0Writer } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { readFanoutHopEvidence } from "./fanout-hop-evidence.js";
import { runFanout } from "./fanout.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function writeEvent(
  writer: T0Writer,
  input: {
    eventId: string;
    type: "agent-response" | "user-prompt";
    payload: Record<string, unknown>;
    ts: string;
  },
): void {
  writer.write({
    event_id: input.eventId,
    ts: input.ts,
    ingest_ts: input.ts,
    source: "agentchat",
    source_detail: "worker",
    project_id: "project-one",
    user_id: "test-user",
    machine_id: "test-machine",
    session_id: "conversation-1",
    event_type: input.type,
    lane: "cli-subscription",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: input.payload,
    payload_summary: input.type,
    origin: "dispatch",
  });
}

test("reads migrated-DB root/latest/hop metadata and shared reliability evidence", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const handoffs = new HandoffWriter({ db });
  const events = new DispatchEventLog(db);
  const t0 = new T0Writer(db);
  try {
    handoffs.createApproved({
      handoff_id: "root-h",
      ts: "2026-09-12T10:00:00.000Z",
      project_id: "project-one",
      conversation_id: "conversation-1",
      from: "workflow",
      to: "root-agent",
      to_role: "executor",
      message: "root task",
      triggered_by_event_id: null,
      resolved_by: "test",
      resolved_at: null,
      chain_max_hops: 4,
      chain_trust_mode: "all",
      chain_task_type: "review_adversarial",
      use_worktree: false,
      parent_handoff_id: null,
      branch_base: "main",
      branch_name: "root-real-branch",
    });
    expect(handoffs.claimDispatch("root-h", "worker-root")).toBe(true);
    expect(
      handoffs.markCompleted("root-h", {
        ts: "2026-09-12T10:00:20.000Z",
        expected_worker_id: "worker-root",
      }),
    ).toBe(true);
    handoffs.createApproved({
      handoff_id: "child-h",
      ts: "2026-09-12T10:01:00.000Z",
      project_id: "project-one",
      conversation_id: "conversation-1",
      from: "root-agent",
      to: "child-agent",
      to_role: null,
      message: "[silent-failure-retry] try again",
      triggered_by_event_id: null,
      resolved_by: "test",
      resolved_at: null,
      chain_max_hops: 4,
      chain_trust_mode: "all",
      chain_task_type: "review_adversarial",
      use_worktree: false,
      parent_handoff_id: "root-h",
      branch_base: "root-real-branch",
      branch_name: "child-real-branch",
    });
    expect(handoffs.claimDispatch("child-h", "worker-child")).toBe(true);
    expect(
      handoffs.markFailed("child-h", {
        reason: "child failed",
        expected_worker_id: "worker-child",
      }),
    ).toBe(true);
    events.recordBatch([
      {
        handoff_id: "root-h",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-09-12T10:00:01.000Z",
      },
      {
        handoff_id: "root-h",
        source: "worker",
        kind: "proc.spawn",
        ts: "2026-09-12T10:00:02.000Z",
      },
      {
        handoff_id: "root-h",
        source: "worker",
        kind: "proc.exited.resolved",
        ts: "2026-09-12T10:00:18.000Z",
      },
      {
        handoff_id: "root-h",
        source: "worker",
        kind: "dispatch.end",
        ts: "2026-09-12T10:00:19.000Z",
      },
    ]);
    writeEvent(t0, {
      eventId: "response-root",
      type: "agent-response",
      ts: "2026-09-12T10:00:17.000Z",
      payload: { response: "authoritative root output", handoff_id: "root-h", agent: "root-agent" },
    });
    writeEvent(t0, {
      eventId: "retry-prompt",
      type: "user-prompt",
      ts: "2026-09-12T10:00:50.000Z",
      payload: { prompt: "[silent-failure-retry] continue" },
    });
    writeEvent(t0, {
      eventId: "not-retry-prompt",
      type: "user-prompt",
      ts: "2026-09-12T10:00:51.000Z",
      payload: { prompt: "prefix [silent-failure-retry] is not enough" },
    });
    writeEvent(t0, {
      eventId: "unmatched-retry-prompt",
      type: "user-prompt",
      ts: "2026-09-12T10:00:52.000Z",
      payload: { prompt: "[silent-failure-retry] no handoff row was created" },
    });

    const result = readFanoutHopEvidence(db, {
      conversationId: "conversation-1",
      rootHandoffId: "root-h",
      provisionalBranchName: "invented-provisional",
    });

    expect(result).toMatchObject({
      latest_handoff_id: "child-h",
      hop_count: 2,
      extra_hops: 1,
      retry_prompt_count: 2,
      hops_incomplete: true,
      branch_name: "root-real-branch",
      branch_base: "main",
      parent_handoff_id: null,
      reliability_status: "complete",
      reliability_trustworthy: true,
      reliability_action: "accept",
    });
    expect(result.hops).toEqual([
      {
        handoff_id: "root-h",
        status: "completed",
        branch_name: "root-real-branch",
        to_agent: "root-agent",
        branch_base: "main",
        parent_handoff_id: null,
        created_ts: "2026-09-12T10:00:00.000Z",
        is_retry: false,
      },
      {
        handoff_id: "child-h",
        status: "failed",
        branch_name: "child-real-branch",
        to_agent: "child-agent",
        branch_base: "root-real-branch",
        parent_handoff_id: "root-h",
        created_ts: "2026-09-12T10:01:00.000Z",
        is_retry: true,
      },
    ]);

    const fanout = await runFanout(
      {
        dispatch: async () => ({ conversation_id: "unused", handoff_id: "unused" }),
        awaitChain: async (_conversationId, opts) => {
          expect(opts?.timeoutMs).toBe(10_000);
          return {
            status: "completed",
            final_agent: "root-agent",
            response_text: "authoritative root output",
          };
        },
        cancel: async () => {},
        fileWrite: async (path) => path,
        db: () => db,
        config: {},
        cwd: "/repo",
        storageRoot: "/storage",
        project: "project-one",
        args: {},
        chainStart: async () =>
          Response.json({
            conversation_id: "conversation-1",
            handoff_id: "root-h",
            branch_name: "stale-provisional",
          }),
      },
      { defaults: { timeout_ms: 10_000 }, tasks: [{ message: "review" }] },
    );

    expect(fanout.ok).toBe(true);
    expect(fanout.results[0]).toMatchObject({
      ok: true,
      response_text: "authoritative root output",
      handoff_id: "root-h",
      latest_handoff_id: "child-h",
      branch_name: "root-real-branch",
      reliability_trustworthy: true,
    });
  } finally {
    db.close();
  }
});

test("returns an unwrapped null audit as unverified instead of trustworthy", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  try {
    const result = readFanoutHopEvidence(db, {
      conversationId: "missing-conversation",
      rootHandoffId: "missing-root",
      provisionalBranchName: null,
    });

    expect(result.reliability_status).toBeNull();
    expect(result.reliability_trustworthy).toBeNull();
    expect(result.reliability_action).toBeNull();
  } finally {
    db.close();
  }
});
