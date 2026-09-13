import type { WorkflowCtx } from "@penumbra/workflows";

import {
  type ChainStartRequest,
  DispatchEventLog,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  T0Writer,
} from "@penumbra/core";
import { loadTsWorkflow } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";

import { emptyRecall } from "../_shared/test-helpers.js";
import { type FanoutSmokeResult, fn } from "./workflow.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

const PROBE_CONTENT = "native worktree fan-out reached this worker";

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

type TestCtx = WorkflowCtx & {
  chainStart?: (input: ChainStartRequest) => Promise<Response> | Response;
};

function makeCtx(overrides: Partial<TestCtx> & { args?: Record<string, unknown> } = {}): TestCtx {
  return {
    dispatch: async () => ({ conversation_id: "unused", handoff_id: "unused" }),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "executor",
      response_text: PROBE_CONTENT,
    }),
    cancel: async () => {},
    fileWrite: async (path) => path,
    progress: () => {},
    config: {},
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "penumbra",
    args: overrides.args ?? {},
    ...overrides,
  };
}

function seedProbe(
  db: Database,
  input: {
    conversationId: string;
    handoffId: string;
    branchName: string | null;
    reliability: "good" | "missing-lifecycle";
  },
): void {
  const handoffs = new HandoffWriter({ db });
  const events = new DispatchEventLog(db);
  const ts = "2026-09-12T10:00:00.000Z";

  handoffs.createApproved({
    handoff_id: input.handoffId,
    ts,
    project_id: "penumbra",
    conversation_id: input.conversationId,
    from: "workflow",
    to: "worker",
    to_role: "executor",
    message: "native fan-out probe",
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: 2,
    chain_trust_mode: "all",
    chain_task_type: "docs_mechanical",
    use_worktree: true,
    dispatch_kind: "workflow",
    parent_handoff_id: null,
    branch_base: "main",
    branch_name: input.branchName,
  });

  handoffs.claimDispatch(input.handoffId, "worker-1");

  if (input.reliability === "good") {
    handoffs.markCompleted(input.handoffId, {
      ts: "2026-09-12T10:00:10.000Z",
      expected_worker_id: "worker-1",
    });
  } else {
    handoffs.markFailed(input.handoffId, {
      reason: "no worktree",
      expected_worker_id: "worker-1",
    });
  }

  if (input.reliability === "good") {
    events.recordBatch([
      {
        handoff_id: input.handoffId,
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-09-12T10:00:01.000Z",
      },
      {
        handoff_id: input.handoffId,
        source: "worker",
        kind: "proc.spawn",
        ts: "2026-09-12T10:00:02.000Z",
      },
      {
        handoff_id: input.handoffId,
        source: "worker",
        kind: "dispatch.end",
        ts: "2026-09-12T10:00:09.000Z",
        meta: { committed: true, worktree_changed: true },
      },
    ]);
  } else {
    events.recordBatch([
      {
        handoff_id: input.handoffId,
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-09-12T10:00:01.000Z",
      },
      {
        handoff_id: input.handoffId,
        source: "worker",
        kind: "dispatch.end",
        ts: "2026-09-12T10:00:09.000Z",
        meta: { committed: true, worktree_changed: false },
      },
    ]);
  }

  new T0Writer(db).write({
    event_id: `response-${input.handoffId}`,
    ts: "2026-09-12T10:00:08.000Z",
    ingest_ts: "2026-09-12T10:00:08.000Z",
    source: "agentchat",
    source_detail: "worker",
    project_id: "penumbra",
    user_id: "test",
    machine_id: "test",
    session_id: input.conversationId,
    event_type: "agent-response",
    lane: "cli-subscription",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {
      response: PROBE_CONTENT,
      handoff_id: input.handoffId,
      agent: "executor",
    },
    payload_summary: "agent-response",
    origin: "dispatch",
  });
}

function chainStartForIndex(input: ChainStartRequest, index: number, branchName: string | null) {
  return Response.json({
    conversation_id: `conversation-${index}`,
    handoff_id: `handoff-${index}`,
    branch_name: branchName,
  });
}

function indexFromTaskName(input: ChainStartRequest): number {
  const tail = input.task_name?.split("-").pop() ?? "0";
  const parsed = Number(tail);
  return Number.isNaN(parsed) ? 0 : parsed;
}

test("loads through the registered TS loader with a valid ts-function spec", async () => {
  const loaded = await loadTsWorkflow(join(import.meta.dirname, "workflow.ts"));
  expect(loaded.spec.name).toBe("fanout-smoke");
  expect(loaded.spec.run.kind).toBe("ts-function");
  expect(typeof loaded.fn).toBe("function");
});

test("dispatches every probe with the exact chain.start fields including explicit false values", async () => {
  const captured: ChainStartRequest[] = [];
  const ctx = makeCtx({
    chainStart: async (input) => {
      captured.push(input);
      return chainStartForIndex(input, indexFromTaskName(input), null);
    },
  });

  await fn(ctx, emptyRecall());

  expect(captured).toHaveLength(2);
  const sorted = [...captured].sort((a, b) => (a.task_name ?? "").localeCompare(b.task_name ?? ""));

  for (let i = 0; i < 2; i++) {
    const request = sorted[i];
    expect(request).toBeDefined();
    if (!request) throw new Error(`missing request at index ${i}`);
    expect(request).toMatchObject({
      initial_agent: "executor",
      task_name: `fanout-smoke-${i}`,
      branch_type: "smoke",
      task_class: "TRIVIAL",
      task_type: "docs_mechanical",
      use_worktree: true,
      isolated_install: false,
      max_hops: 2,
      project_id: "penumbra",
      dispatch_kind: "workflow",
    });
    expect(request.message).toContain(`test/fixtures/native-fanout-smoke/probe-${i}.txt`);
    expect(request.message).toContain(PROBE_CONTENT);
    expect(request.message).toContain("Do not cd, switch to main, switch branches");
  }
});

test("generates a bounded worker prompt with scoped commit ownership evidence", async () => {
  const captured: ChainStartRequest[] = [];
  const ctx = makeCtx({
    args: { count: 1 },
    chainStart: async (input) => {
      captured.push(input);
      return chainStartForIndex(input, 0, null);
    },
  });

  await fn(ctx, emptyRecall());

  expect(captured[0]?.message).toBe(
    [
      "This is a native worktree fan-out smoke probe.",
      "In your assigned worker worktree, create or modify only test/fixtures/native-fanout-smoke/probe-0.txt with exactly this single line:",
      "",
      PROBE_CONTENT,
      "",
      "Stay in the assigned worker worktree and on its assigned branch. Do not cd, switch to main, switch branches, or use broad staging.",
      "If you own the commit operation, commit only test/fixtures/native-fanout-smoke/probe-0.txt.",
      "If the dispatch reconciler owns the post-return commit, report honestly that the commit is pending.",
      "The coordinator must observe authoritative reconciler commit evidence before live acceptance; response prose alone is not commit proof.",
      "Do not ask the coordinator to run shell commands from your response.",
      "Return a short confirmation; do not claim the file was written or committed unless that operation completed in your assigned worker worktree.",
    ].join("\n"),
  );
});

test("clamps integer counts to 1 through 4 and defaults invalid inputs to 2", async () => {
  for (const [raw, expected] of [
    [undefined, 2],
    [0, 1],
    [-3, 1],
    [1, 1],
    [4, 4],
    [5, 4],
    ["3", 2],
    [Number.NaN, 2],
    [Number.POSITIVE_INFINITY, 2],
    [1.5, 2],
  ] as const) {
    const captured: ChainStartRequest[] = [];
    const ctx = makeCtx({
      args: raw === undefined ? {} : { count: raw },
      chainStart: async (input) => {
        captured.push(input);
        return chainStartForIndex(input, indexFromTaskName(input), null);
      },
    });
    await fn(ctx, emptyRecall());
    expect(captured).toHaveLength(expected);
  }
});

test("uses the explicit timeout_ms as the awaitChain budget", async () => {
  const awaitCalls: { conversationId: string; opts?: { timeoutMs?: number } }[] = [];
  const ctx = makeCtx({
    args: { count: 1, timeout_ms: 123_456 },
    chainStart: async (input) => chainStartForIndex(input, 0, null),
    awaitChain: async (conversationId, opts) => {
      awaitCalls.push({ conversationId, opts });
      return { status: "completed", final_agent: "executor", response_text: PROBE_CONTENT };
    },
  });
  await fn(ctx, emptyRecall());
  expect(awaitCalls[0]?.opts?.timeoutMs).toBe(123_456);
});

test("returns ok:true when every probe has DB branch and trustworthy reliability", async () => {
  const db = freshDb();
  try {
    seedProbe(db, {
      conversationId: "conversation-0",
      handoffId: "handoff-0",
      branchName: "smoke/probe-0",
      reliability: "good",
    });
    seedProbe(db, {
      conversationId: "conversation-1",
      handoffId: "handoff-1",
      branchName: "smoke/probe-1",
      reliability: "good",
    });

    const ctx = makeCtx({
      db: () => db,
      chainStart: async (input) => chainStartForIndex(input, indexFromTaskName(input), null),
    });

    const result = (await fn(ctx, emptyRecall())) as FanoutSmokeResult;

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.worktree_proven).toBe(2);
    expect(result.results).toHaveLength(2);
    for (const r of result.results) {
      expect(r.worktree_proven).toBe(true);
      expect(r.reliability_trustworthy).toBe(true);
      expect(typeof r.branch_name).toBe("string");
      expect(r.branch_name).not.toBe("");
    }
  } finally {
    db.close();
  }
});

test("fails closed when a probe has no branch_name evidence", async () => {
  const db = freshDb();
  try {
    seedProbe(db, {
      conversationId: "conversation-0",
      handoffId: "handoff-0",
      branchName: "smoke/probe-0",
      reliability: "good",
    });
    seedProbe(db, {
      conversationId: "conversation-1",
      handoffId: "handoff-1",
      branchName: null,
      reliability: "good",
    });

    const ctx = makeCtx({
      db: () => db,
      chainStart: async (input) => chainStartForIndex(input, indexFromTaskName(input), null),
    });

    const result = (await fn(ctx, emptyRecall())) as FanoutSmokeResult;

    expect(result.ok).toBe(false);
    expect(result.worktree_proven).toBe(1);
    expect(result.results[0]?.worktree_proven).toBe(true);
    expect(result.results[1]?.worktree_proven).toBe(false);
    expect(result.results[1]?.branch_name).toBeNull();
  } finally {
    db.close();
  }
});

test("fails closed when a probe's reliability is not trustworthy", async () => {
  const db = freshDb();
  try {
    seedProbe(db, {
      conversationId: "conversation-0",
      handoffId: "handoff-0",
      branchName: "smoke/probe-0",
      reliability: "good",
    });
    seedProbe(db, {
      conversationId: "conversation-1",
      handoffId: "handoff-1",
      branchName: "smoke/probe-1",
      reliability: "missing-lifecycle",
    });
    expect(
      db
        .query<{ kind: string }, [string]>(
          "SELECT kind FROM dispatch_events WHERE handoff_id = ? ORDER BY ts",
        )
        .all("handoff-1")
        .map((row) => row.kind),
    ).toEqual(["dispatch.start", "dispatch.end"]);

    const ctx = makeCtx({
      db: () => db,
      chainStart: async (input) => chainStartForIndex(input, indexFromTaskName(input), null),
    });

    const result = (await fn(ctx, emptyRecall())) as FanoutSmokeResult;

    expect(result.ok).toBe(false);
    expect(result.worktree_proven).toBe(2);
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[1]?.ok).toBe(false);
    expect(result.results[1]?.reliability_trustworthy).toBe(false);
    expect(result.results[1]?.error_summary).toBe("reliability_untrustworthy");
  } finally {
    db.close();
  }
});

test("emits bounded progress stages when progress is available", async () => {
  const progress: { message: string; meta?: Record<string, unknown> }[] = [];
  const ctx = makeCtx({
    progress: (message: string, meta?: Record<string, unknown>) => {
      progress.push({ message, meta });
    },
  });

  await fn(ctx, emptyRecall());

  expect(progress.map((p) => p.message)).toEqual([
    "fanout-smoke: building probes",
    "fanout-smoke: dispatching",
    "fanout-smoke: completed",
  ]);
  expect(progress[0]?.meta).toMatchObject({ count: 2, timeout_ms: 600_000 });
  expect(progress[2]?.meta).toMatchObject({
    ok: false,
    count: 2,
    worktree_proven: 0,
  });
});
