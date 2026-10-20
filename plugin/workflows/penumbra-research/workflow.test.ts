import type { WorkflowCtx } from "@penumbra/workflows";

import {
  type ChainStartRequest,
  DispatchEventLog,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  T0Writer,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { emptyRecall } from "../_shared/test-helpers.js";
import { primeFromMemory } from "./memory-prime.js";
import { RESEARCH_SOURCE_BOUNDS, validateSourceUrls } from "./research-contract.js";
import { resolveWebSeat } from "./web-seat.js";
import { fn, inputSchema, type ResearchResult } from "./workflow.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

type TestCtx = WorkflowCtx & {
  chainStart?: (input: ChainStartRequest) => Promise<Response> | Response;
};

const PROJECT = "penumbra";

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function seedT2Memory(
  db: Database,
  row: {
    memoryId: string;
    projectId: string | null;
    title: string;
    body: string;
    trust?: string;
    createdAt?: string;
  },
): void {
  const metadata = row.trust ? JSON.stringify({ trust: row.trust }) : "{}";
  db.prepare(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                                window_start, window_end, title, body, metadata_json,
                                compressed_from, created_at, updated_at)
       VALUES (?, ?, 'u1', 'fact', '[]', '2026-09-01T00:00:00Z', '2026-09-01T00:01:00Z',
               ?, ?, ?, NULL, ?, ?)`,
  ).run(
    row.memoryId,
    row.projectId,
    row.title,
    row.body,
    metadata,
    row.createdAt ?? "2026-09-01T00:01:00Z",
    row.createdAt ?? "2026-09-01T00:01:00Z",
  );
}

function seedGoodHandoff(
  db: Database,
  input: { handoffId: string; conversationId: string; agent?: string },
): void {
  const handoffs = new HandoffWriter({ db });
  handoffs.createApproved({
    handoff_id: input.handoffId,
    ts: "2026-09-12T10:00:00.000Z",
    project_id: PROJECT,
    conversation_id: input.conversationId,
    from: "workflow",
    to: "worker",
    to_role: "executor",
    message: "task",
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: 4,
    chain_trust_mode: "all",
    chain_task_type: "unknown",
    use_worktree: false,
    dispatch_kind: "workflow",
    parent_handoff_id: null,
    branch_base: "main",
    branch_name: null,
  });
  handoffs.claimDispatch(input.handoffId, "worker-1");
  handoffs.markCompleted(input.handoffId, {
    ts: "2026-09-12T10:00:10.000Z",
    expected_worker_id: "worker-1",
  });
  new T0Writer(db).write({
    event_id: `resp-${input.handoffId}`,
    ts: "2026-09-12T10:00:08.000Z",
    ingest_ts: "2026-09-12T10:00:08.000Z",
    source: "agentchat",
    source_detail: "worker",
    project_id: PROJECT,
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
    payload_json: { response: "ok", handoff_id: input.handoffId, agent: input.agent ?? "executor" },
    payload_summary: "agent-response",
    origin: "dispatch",
  });
  new DispatchEventLog(db).recordBatch([
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
      meta: { committed: true, worktree_changed: false },
    },
  ]);
}

function jsonBlock(obj: unknown): string {
  return `prose before\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\nafter`;
}

function makeCtx(overrides: Partial<TestCtx> & { args?: Record<string, unknown> } = {}): TestCtx {
  return {
    dispatch: async () => ({ conversation_id: "unused", handoff_id: "unused" }),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "executor",
      response_text: "done",
    }),
    cancel: async () => {},
    fileWrite: async (path: string) => path,
    progress: () => {},
    config: {},
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: PROJECT,
    args: overrides.args ?? {},
    ...overrides,
  };
}

// A full success path: planner -> research (N angles) -> synthesis -> artifact.
// chainStart hands out handoffs in order; awaitChain returns the mapped body.
function successCtx(opts: {
  angles: string[];
  angleSources: string[][];
  synthesisSources: string[];
  db: Database;
  webAgent?: string;
  fileWriteReceipt?: (path: string) => string;
  captured?: { requests: ChainStartRequest[] };
  requestedAngles?: number;
  plannerSubquestions?: string[];
  returnedSubquestions?: string[];
}): TestCtx {
  const { angles, angleSources, synthesisSources, db } = opts;
  let call = 0;
  const plannerHandoff = "h-planner";
  const plannerConv = "c-planner";
  const researchHandoffs = angles.map((_, i) => `h-research-${i}`);
  const researchConvs = angles.map((_, i) => `c-research-${i}`);
  const synthHandoff = "h-synth";
  const synthConv = "c-synth";
  seedGoodHandoff(db, { handoffId: plannerHandoff, conversationId: plannerConv });
  for (let i = 0; i < angles.length; i += 1) {
    seedGoodHandoff(db, { handoffId: researchHandoffs[i]!, conversationId: researchConvs[i]! });
  }
  seedGoodHandoff(db, { handoffId: synthHandoff, conversationId: synthConv });

  const ordered = [
    { handoff: plannerHandoff, conv: plannerConv },
    ...researchHandoffs.map((h, i) => ({ handoff: h, conv: researchConvs[i]! })),
    { handoff: synthHandoff, conv: synthConv },
  ];

  return makeCtx({
    db: () => db,
    config: opts.webAgent
      ? {}
      : { workloads: { web_research: { eligible_agents: [opts.webAgent ?? "web-seat"] } } },
    chainStart: async (input) => {
      const slot = ordered[call] ?? ordered[0]!;
      call += 1;
      opts.captured?.requests.push(input);
      return Response.json({
        conversation_id: slot.conv,
        handoff_id: slot.handoff,
        branch_name: null,
      });
    },
    awaitChain: async (conversationId) => {
      if (conversationId === plannerConv) {
        return {
          status: "completed",
          final_agent: "executor",
          response_text: jsonBlock({ subquestions: opts.plannerSubquestions ?? angles }),
        };
      }
      const idx = researchConvs.indexOf(conversationId);
      if (idx >= 0) {
        return {
          status: "completed",
          final_agent: "web-seat",
          response_text: jsonBlock({
            subquestion: opts.returnedSubquestions?.[idx] ?? angles[idx]!,
            findings: `findings for ${angles[idx]}`,
            sources: angleSources[idx]!,
          }),
        };
      }
      if (conversationId === synthConv) {
        return {
          status: "completed",
          final_agent: "executor",
          response_text: jsonBlock({
            report: "# Report\n\nbody",
            summary: "a summary",
            sources: synthesisSources,
          }),
        };
      }
      return { status: "completed", final_agent: "executor", response_text: jsonBlock({}) };
    },
    fileWrite: async (path) => (opts.fileWriteReceipt ? opts.fileWriteReceipt(path) : path),
    args: {
      question: "What is X?",
      angles: opts.requestedAngles ?? angles.length,
      web_agent: opts.webAgent,
    },
  });
}

// ---------------------------------------------------------------------------
// web seat resolution
// ---------------------------------------------------------------------------

test("resolveWebSeat uses explicit web_agent when provided", () => {
  const out = resolveWebSeat({ workloads: {} }, "claude-cli");
  expect(out).toEqual({ ok: true, agent: "claude-cli" });
});

test("resolveWebSeat reads config.workloads.web_research.eligible_agents", () => {
  const out = resolveWebSeat(
    { workloads: { web_research: { eligible_agents: ["gemini-cli", "codex-cli"] } } },
    undefined,
  );
  expect(out).toEqual({ ok: true, agent: "gemini-cli" });
});

test("resolveWebSeat returns no_web_capable_seat when no web_agent and no config", () => {
  expect(resolveWebSeat({}, undefined)).toEqual({ ok: false, error: "no_web_capable_seat" });
  expect(resolveWebSeat({ workloads: {} }, undefined)).toEqual({
    ok: false,
    error: "no_web_capable_seat",
  });
  expect(resolveWebSeat({ workloads: { web_research: {} } }, undefined)).toEqual({
    ok: false,
    error: "no_web_capable_seat",
  });
  expect(
    resolveWebSeat({ workloads: { web_research: { eligible_agents: [] } } }, undefined),
  ).toEqual({ ok: false, error: "no_web_capable_seat" });
  expect(
    resolveWebSeat({ workloads: { web_research: { eligible_agents: ["", "  "] } } }, undefined),
  ).toEqual({ ok: false, error: "no_web_capable_seat" });
});

test("resolveWebSeat ignores a blank explicit web_agent and falls through to config", () => {
  const out = resolveWebSeat(
    { workloads: { web_research: { eligible_agents: ["codex-cli"] } } },
    "  ",
  );
  expect(out).toEqual({ ok: true, agent: "codex-cli" });
});

// ---------------------------------------------------------------------------
// memory prime: actual DB scoped FTS / punctuation / trust
// ---------------------------------------------------------------------------

test("primeFromMemory returns matching memory scoped to project, excluding other projects and untrusted", () => {
  const db = freshDb();
  try {
    seedT2Memory(db, {
      memoryId: "m1",
      projectId: PROJECT,
      title: "penumbra dispatch reliability",
      body: "the silent retry fence was confirmed",
    });
    seedT2Memory(db, {
      memoryId: "m2",
      projectId: "other-project",
      title: "penumbra dispatch",
      body: "should not appear",
    });
    seedT2Memory(db, {
      memoryId: "m3",
      projectId: PROJECT,
      title: "untrusted note",
      body: "penumbra dispatch",
      trust: "untrusted",
    });
    const ctx = makeCtx({ db: () => db });
    const out = primeFromMemory(ctx, "penumbra dispatch reliability", PROJECT);
    expect(out.hits).toBe(1);
    expect(out.brief).toContain("dispatch reliability");
    expect(out.brief).not.toContain("should not appear");
    expect(out.brief).not.toContain("untrusted note");
  } finally {
    db.close();
  }
});

test("primeFromMemory sanitizes punctuation in the FTS query without throwing", () => {
  const db = freshDb();
  try {
    seedT2Memory(db, {
      memoryId: "m1",
      projectId: PROJECT,
      title: "ev259 root cause",
      body: "silent failure retry confirmed",
    });
    const ctx = makeCtx({ db: () => db });
    const out = primeFromMemory(ctx, "ev259: root-cause (silent) [failure] {retry}!", PROJECT);
    expect(out.hits).toBe(1);
    expect(out.brief).toContain("ev259");
  } finally {
    db.close();
  }
});

test("primeFromMemory returns zero hits and empty brief when nothing matches", () => {
  const db = freshDb();
  try {
    seedT2Memory(db, {
      memoryId: "m1",
      projectId: PROJECT,
      title: "unrelated topic",
      body: "nothing relevant",
    });
    const ctx = makeCtx({ db: () => db });
    const out = primeFromMemory(ctx, "completely different question", PROJECT);
    expect(out.hits).toBe(0);
    expect(out.brief).toBe("");
  } finally {
    db.close();
  }
});

test("primeFromMemory bounds title to 120 and body to 400 characters", () => {
  const db = freshDb();
  try {
    seedT2Memory(db, {
      memoryId: "m1",
      projectId: PROJECT,
      title: `topic ${"t".repeat(200)}`,
      body: "b".repeat(600),
    });
    const ctx = makeCtx({ db: () => db });
    const out = primeFromMemory(ctx, "topic", PROJECT);
    expect(out.hits).toBe(1);
    expect(out.brief.length).toBeLessThanOrEqual(120 + 400 + 20);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// unknown web seat: 0 dispatch, no artifact
// ---------------------------------------------------------------------------

test("returns no_web_capable_seat with zero chainStart calls and no fileWrite before any dispatch", async () => {
  let chainStartCalls = 0;
  let fileWrites = 0;
  const db = freshDb();
  try {
    const result = (await fn(
      makeCtx({
        db: () => db,
        config: {},
        chainStart: async () => {
          chainStartCalls += 1;
          return Response.json({ conversation_id: "c", handoff_id: "h" });
        },
        fileWrite: async () => {
          fileWrites += 1;
          return "/tmp/out";
        },
        args: { question: "What is X?" },
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_web_capable_seat");
    expect(chainStartCalls).toBe(0);
    expect(fileWrites).toBe(0);
    expect(result.report_path).toBeNull();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// planner: bad zero angles
// ---------------------------------------------------------------------------

test("planner returning zero subquestions fails closed before research dispatch", async () => {
  const db = freshDb();
  const researchCalls = 0;
  try {
    seedGoodHandoff(db, { handoffId: "h-planner", conversationId: "c-planner" });
    let call = 0;
    const result = (await fn(
      makeCtx({
        db: () => db,
        config: { workloads: { web_research: { eligible_agents: ["web-seat"] } } },
        chainStart: async () => {
          call += 1;
          return Response.json({
            conversation_id: "c-planner",
            handoff_id: "h-planner",
            branch_name: null,
          });
        },
        awaitChain: async () => ({
          status: "completed",
          final_agent: "executor",
          response_text: jsonBlock({ subquestions: [] }),
        }),
        fileWrite: async (p) => p,
        args: { question: "What is X?", angles: 3 },
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("planner_zero_angles");
    expect(call).toBe(1);
    expect(researchCalls).toBe(0);
  } finally {
    db.close();
  }
});

test("planner returning non-array or malformed JSON fails closed", async () => {
  const db = freshDb();
  try {
    seedGoodHandoff(db, { handoffId: "h-planner", conversationId: "c-planner" });
    const result = (await fn(
      makeCtx({
        db: () => db,
        config: { workloads: { web_research: { eligible_agents: ["web-seat"] } } },
        chainStart: async () =>
          Response.json({
            conversation_id: "c-planner",
            handoff_id: "h-planner",
            branch_name: null,
          }),
        awaitChain: async () => ({
          status: "completed",
          final_agent: "executor",
          response_text: "no json block at all",
        }),
        fileWrite: async (p) => p,
        args: { question: "What is X?" },
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("planner_parse_failed");
  } finally {
    db.close();
  }
});

test("planner rejects wrong cardinality, duplicates, blanks, and overlong subquestions", async () => {
  const invalidPlans = [
    ["only one"],
    ["duplicate", "DUPLICATE"],
    ["valid", "   "],
    ["valid", "x".repeat(501)],
  ];
  for (const subquestions of invalidPlans) {
    const db = freshDb();
    try {
      seedGoodHandoff(db, { handoffId: "h-planner", conversationId: "c-planner" });
      let starts = 0;
      const result = (await fn(
        makeCtx({
          db: () => db,
          config: { workloads: { web_research: { eligible_agents: ["web-seat"] } } },
          chainStart: async () => {
            starts += 1;
            return Response.json({
              conversation_id: "c-planner",
              handoff_id: "h-planner",
              branch_name: null,
            });
          },
          awaitChain: async () => ({
            status: "completed",
            final_agent: "executor",
            response_text: jsonBlock({ subquestions }),
          }),
          args: { question: "What is X?", angles: 2 },
        }),
        emptyRecall(),
      )) as ResearchResult;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("planner_invalid");
      expect(starts).toBe(1);
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// each stage lifecycle: full success path
// ---------------------------------------------------------------------------

test("full success path: prime -> planner -> research -> synthesis -> artifact", async () => {
  const db = freshDb();
  try {
    seedT2Memory(db, {
      memoryId: "m1",
      projectId: PROJECT,
      title: "prior knowledge",
      body: "X is known to be Y",
    });
    const captured: { requests: ChainStartRequest[] } = { requests: [] };
    const writes: string[] = [];
    const ctx = successCtx({
      angles: ["what is X part A", "what is X part B"],
      angleSources: [
        ["https://example.com/a1", "https://independent-a.com/a2"],
        ["https://example.com/b1", "https://independent-b.com/b2"],
      ],
      synthesisSources: ["https://example.com/a1", "https://example.com/b1"],
      db,
      captured,
      fileWriteReceipt: (p) => {
        writes.push(p);
        return p;
      },
    });
    const result = (await fn(ctx, emptyRecall())) as ResearchResult;
    expect(result.ok).toBe(true);
    expect(result.subquestions).toEqual(["what is X part A", "what is X part B"]);
    expect(result.angles_valid).toBe(2);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.sources).toEqual([
      "https://example.com/a1",
      "https://independent-a.com/a2",
    ]);
    expect(result.summary).toBe("a summary");
    expect(result.report_path).not.toBeNull();
    expect(writes).toHaveLength(1);
    expect(result.persisted).toBe(false);
    // planner + 2 research + synthesis = 4 chainStart calls
    expect(captured.requests).toHaveLength(4);
  } finally {
    db.close();
  }
});

test("planner and synthesis dispatches are tool_free; research dispatches are not tool_free", async () => {
  const db = freshDb();
  try {
    const captured: { requests: ChainStartRequest[] } = { requests: [] };
    const ctx = successCtx({
      angles: ["q1", "q2"],
      angleSources: [
        ["https://a.com", "https://b.com"],
        ["https://c.com", "https://d.com"],
      ],
      synthesisSources: ["https://a.com", "https://c.com"],
      db,
      captured,
    });
    await fn(ctx, emptyRecall());
    const [plannerReq, researchReq0, _researchReq1, synthReq] = captured.requests;
    expect(plannerReq?.tool_free).toBe(true);
    expect(plannerReq?.initial_agent).toBe("executor");
    expect(synthReq?.tool_free).toBe(true);
    expect(synthReq?.initial_agent).toBe("executor");
    expect(researchReq0?.initial_agent).toBe("web-seat");
    expect(researchReq0?.tool_free).toBe(false);
    for (const request of captured.requests) {
      expect(request.task_class).toBe("STANDARD");
      expect(request.trust_mode).toBe("all");
      expect(request.max_hops).toBe(1);
      expect(request.use_worktree).toBe(false);
    }
    expect(plannerReq?.task_type).toBe("plan_refine");
    expect(synthReq?.task_type).toBe("plan_refine");
    for (const request of captured.requests.slice(1, -1)) {
      expect(request.task_type).toBe("debug_diagnose");
    }
  } finally {
    db.close();
  }
});

test("chainStart requests bind project_id from ctx.project when no project_id arg", async () => {
  const db = freshDb();
  try {
    const captured: { requests: ChainStartRequest[] } = { requests: [] };
    const ctx = successCtx({
      angles: ["q1"],
      angleSources: [["https://a.com", "https://b.com"]],
      synthesisSources: ["https://a.com"],
      db,
      captured,
    });
    await fn(ctx, emptyRecall());
    for (const req of captured.requests) {
      expect(req.project_id).toBe(PROJECT);
    }
  } finally {
    db.close();
  }
});

test("chainStart requests bind explicit project_id arg over ctx.project", async () => {
  const db = freshDb();
  try {
    const captured: { requests: ChainStartRequest[] } = { requests: [] };
    const ctx = successCtx({
      angles: ["q1"],
      angleSources: [["https://a.com", "https://b.com"]],
      synthesisSources: ["https://a.com"],
      db,
      captured,
    });
    ctx.args = {
      question: "What is X?",
      angles: 1,
      web_agent: "web-seat",
      project_id: "custom-proj",
    };
    await fn(ctx, emptyRecall());
    for (const req of captured.requests) {
      expect(req.project_id).toBe("custom-proj");
    }
  } finally {
    db.close();
  }
});

test("deadline is forwarded: expired deadline prevents research dispatch", async () => {
  const db = freshDb();
  try {
    seedGoodHandoff(db, { handoffId: "h-planner", conversationId: "c-planner" });
    let researchCalls = 0;
    const result = (await fn(
      makeCtx({
        db: () => db,
        deadline: () => ({ remaining_ms: 0, expired: true }),
        config: { workloads: { web_research: { eligible_agents: ["web-seat"] } } },
        chainStart: async () => {
          researchCalls += 1;
          return Response.json({ conversation_id: "c", handoff_id: "h" });
        },
        awaitChain: async () => ({
          status: "completed",
          final_agent: "executor",
          response_text: jsonBlock({ subquestions: ["q1"] }),
        }),
        fileWrite: async (p) => p,
        args: { question: "What is X?", angles: 1 },
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(researchCalls).toBe(0);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// missing / invalid sources
// ---------------------------------------------------------------------------

test("research finding with fewer than two http(s) sources is rejected and fails closed", async () => {
  const db = freshDb();
  try {
    seedGoodHandoff(db, { handoffId: "h-planner", conversationId: "c-planner" });
    seedGoodHandoff(db, { handoffId: "h-research-0", conversationId: "c-research-0" });
    let call = 0;
    const ordered = [
      { handoff: "h-planner", conv: "c-planner" },
      { handoff: "h-research-0", conv: "c-research-0" },
    ];
    const result = (await fn(
      makeCtx({
        db: () => db,
        config: { workloads: { web_research: { eligible_agents: ["web-seat"] } } },
        chainStart: async () => {
          const slot = ordered[call]!;
          call += 1;
          return Response.json({
            conversation_id: slot.conv,
            handoff_id: slot.handoff,
            branch_name: null,
          });
        },
        awaitChain: async (conversationId) => {
          if (conversationId === "c-planner") {
            return {
              status: "completed",
              final_agent: "executor",
              response_text: jsonBlock({ subquestions: ["q1"] }),
            };
          }
          return {
            status: "completed",
            final_agent: "web-seat",
            response_text: jsonBlock({
              subquestion: "q1",
              findings: "some findings",
              sources: ["https://only-one.com"],
            }),
          };
        },
        fileWrite: async (p) => p,
        args: { question: "What is X?", angles: 1 },
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("angles_incomplete");
    expect(result.angles_valid).toBe(0);
  } finally {
    db.close();
  }
});

test("research finding with non-http sources (ftp) is rejected", async () => {
  const db = freshDb();
  try {
    seedGoodHandoff(db, { handoffId: "h-planner", conversationId: "c-planner" });
    seedGoodHandoff(db, { handoffId: "h-research-0", conversationId: "c-research-0" });
    let call = 0;
    const ordered = [
      { handoff: "h-planner", conv: "c-planner" },
      { handoff: "h-research-0", conv: "c-research-0" },
    ];
    const result = (await fn(
      makeCtx({
        db: () => db,
        config: { workloads: { web_research: { eligible_agents: ["web-seat"] } } },
        chainStart: async () => {
          const slot = ordered[call]!;
          call += 1;
          return Response.json({
            conversation_id: slot.conv,
            handoff_id: slot.handoff,
            branch_name: null,
          });
        },
        awaitChain: async (conversationId) => {
          if (conversationId === "c-planner") {
            return {
              status: "completed",
              final_agent: "executor",
              response_text: jsonBlock({ subquestions: ["q1"] }),
            };
          }
          return {
            status: "completed",
            final_agent: "web-seat",
            response_text: jsonBlock({
              subquestion: "q1",
              findings: "f",
              sources: ["ftp://a.com", "ftp://b.com"],
            }),
          };
        },
        fileWrite: async (p) => p,
        args: { question: "What is X?", angles: 1 },
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.angles_valid).toBe(0);
  } finally {
    db.close();
  }
});

test("research finding with empty findings body is rejected", async () => {
  const db = freshDb();
  try {
    seedGoodHandoff(db, { handoffId: "h-planner", conversationId: "c-planner" });
    seedGoodHandoff(db, { handoffId: "h-research-0", conversationId: "c-research-0" });
    let call = 0;
    const ordered = [
      { handoff: "h-planner", conv: "c-planner" },
      { handoff: "h-research-0", conv: "c-research-0" },
    ];
    const result = (await fn(
      makeCtx({
        db: () => db,
        config: { workloads: { web_research: { eligible_agents: ["web-seat"] } } },
        chainStart: async () => {
          const slot = ordered[call]!;
          call += 1;
          return Response.json({
            conversation_id: slot.conv,
            handoff_id: slot.handoff,
            branch_name: null,
          });
        },
        awaitChain: async (conversationId) => {
          if (conversationId === "c-planner") {
            return {
              status: "completed",
              final_agent: "executor",
              response_text: jsonBlock({ subquestions: ["q1"] }),
            };
          }
          return {
            status: "completed",
            final_agent: "web-seat",
            response_text: jsonBlock({
              subquestion: "q1",
              findings: "   ",
              sources: ["https://a.com", "https://b.com"],
            }),
          };
        },
        fileWrite: async (p) => p,
        args: { question: "What is X?", angles: 1 },
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.angles_valid).toBe(0);
  } finally {
    db.close();
  }
});

test("research finding whose subquestion does not match the dispatched angle is rejected", async () => {
  const db = freshDb();
  try {
    seedGoodHandoff(db, { handoffId: "h-planner", conversationId: "c-planner" });
    seedGoodHandoff(db, { handoffId: "h-research-0", conversationId: "c-research-0" });
    let call = 0;
    const ordered = [
      { handoff: "h-planner", conv: "c-planner" },
      { handoff: "h-research-0", conv: "c-research-0" },
    ];
    const result = (await fn(
      makeCtx({
        db: () => db,
        config: { workloads: { web_research: { eligible_agents: ["web-seat"] } } },
        chainStart: async () => {
          const slot = ordered[call]!;
          call += 1;
          return Response.json({
            conversation_id: slot.conv,
            handoff_id: slot.handoff,
            branch_name: null,
          });
        },
        awaitChain: async (conversationId) => {
          if (conversationId === "c-planner") {
            return {
              status: "completed",
              final_agent: "executor",
              response_text: jsonBlock({ subquestions: ["q1"] }),
            };
          }
          return {
            status: "completed",
            final_agent: "web-seat",
            response_text: jsonBlock({
              subquestion: "totally different",
              findings: "f",
              sources: ["https://a.com", "https://b.com"],
            }),
          };
        },
        fileWrite: async (p) => p,
        args: { question: "What is X?", angles: 1 },
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.angles_valid).toBe(0);
  } finally {
    db.close();
  }
});

test("research finding must preserve the exact dispatched subquestion", async () => {
  const db = freshDb();
  try {
    const ctx = successCtx({
      angles: ["How does a meteor impact cause climate change?"],
      returnedSubquestions: ["climate change"],
      angleSources: [["https://a.example/source", "https://b.example/source"]],
      synthesisSources: ["https://a.example/source"],
      db,
    });
    const result = (await fn(ctx, emptyRecall())) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("angles_incomplete");
    expect(result.angles_valid).toBe(0);
  } finally {
    db.close();
  }
});

test("research rejects same-host, duplicate, malformed, credentialed, controlled, and oversized sources", async () => {
  const invalidSourceSets = [
    ["https://same.example/a", "https://same.example/b"],
    ["https://a.example/x", "https://a.example/x", "https://b.example/y"],
    ["not-a-url", "https://a.example/x", "https://b.example/y"],
    ["https://user:pass@a.example/x", "https://b.example/y"],
    ["https://a.example/x\n", "https://b.example/y"],
    Array.from({ length: 13 }, (_, i) => `https://host-${String(i)}.example/source`),
  ];
  for (const sources of invalidSourceSets) {
    const db = freshDb();
    try {
      const result = (await fn(
        successCtx({
          angles: ["q1"],
          angleSources: [sources],
          synthesisSources: ["https://a.example/x"],
          db,
        }),
        emptyRecall(),
      )) as ResearchResult;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("angles_incomplete");
      expect(result.angles_valid).toBe(0);
    } finally {
      db.close();
    }
  }
});

test("research rejects same-host sources even when one URL uses a DNS root trailing dot", async () => {
  const db = freshDb();
  try {
    const result = (await fn(
      successCtx({
        angles: ["q1"],
        angleSources: [["https://same.example/a", "https://same.example./b"]],
        synthesisSources: ["https://same.example/a"],
        db,
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("angles_incomplete");
    expect(result.angles_valid).toBe(0);
  } finally {
    db.close();
  }
});

test("validateSourceUrls canonicalizes DNS hosts without changing URL identity", () => {
  const distinct = validateSourceUrls(
    ["https://same.example./a", "https://other.example/b"],
    RESEARCH_SOURCE_BOUNDS,
  );
  expect(distinct.ok).toBe(true);
  if (!distinct.ok) throw new Error("unexpected");
  expect(distinct.urls).toEqual(["https://same.example./a", "https://other.example/b"]);

  const ipv6 = validateSourceUrls(
    ["http://[::1]/a", "http://[2001:db8::1]/b"],
    RESEARCH_SOURCE_BOUNDS,
  );
  expect(ipv6.ok).toBe(true);

  const caseAndDot = validateSourceUrls(
    ["HTTPS://A.EXAMPLE./a", "https://other.example/b"],
    RESEARCH_SOURCE_BOUNDS,
  );
  expect(caseAndDot.ok).toBe(true);

  const idn = validateSourceUrls(
    ["https://müller.example/a", "https://other.example/b"],
    RESEARCH_SOURCE_BOUNDS,
  );
  expect(idn.ok).toBe(true);

  const subdomains = validateSourceUrls(
    ["https://sub.host.example/a", "https://host.example/b"],
    RESEARCH_SOURCE_BOUNDS,
  );
  expect(subdomains.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// reliability acceptance: bad reliability fails the angle
// ---------------------------------------------------------------------------

test("research angle with untrustworthy reliability is rejected and fails closed", async () => {
  const db = freshDb();
  try {
    seedGoodHandoff(db, { handoffId: "h-planner", conversationId: "c-planner" });
    // bad reliability: dispatch.start but no dispatch.end committed
    const handoffs = new HandoffWriter({ db });
    handoffs.createApproved({
      handoff_id: "h-research-0",
      ts: "2026-09-12T10:00:00.000Z",
      project_id: PROJECT,
      conversation_id: "c-research-0",
      from: "workflow",
      to: "worker",
      to_role: "executor",
      message: "task",
      triggered_by_event_id: null,
      resolved_by: "test",
      resolved_at: null,
      chain_max_hops: 4,
      chain_trust_mode: "all",
      chain_task_type: "unknown",
      use_worktree: false,
      dispatch_kind: "workflow",
      parent_handoff_id: null,
      branch_base: "main",
      branch_name: null,
    });
    handoffs.claimDispatch("h-research-0", "worker-1");
    handoffs.markCompleted("h-research-0", {
      ts: "2026-09-12T10:00:10.000Z",
      expected_worker_id: "worker-1",
    });
    new DispatchEventLog(db).recordBatch([
      {
        handoff_id: "h-research-0",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-09-12T10:00:01.000Z",
      },
    ]);
    let call = 0;
    const ordered = [
      { handoff: "h-planner", conv: "c-planner" },
      { handoff: "h-research-0", conv: "c-research-0" },
    ];
    const result = (await fn(
      makeCtx({
        db: () => db,
        config: { workloads: { web_research: { eligible_agents: ["web-seat"] } } },
        chainStart: async () => {
          const slot = ordered[call]!;
          call += 1;
          return Response.json({
            conversation_id: slot.conv,
            handoff_id: slot.handoff,
            branch_name: null,
          });
        },
        awaitChain: async (conversationId) => {
          if (conversationId === "c-planner") {
            return {
              status: "completed",
              final_agent: "executor",
              response_text: jsonBlock({ subquestions: ["q1"] }),
            };
          }
          return {
            status: "completed",
            final_agent: "web-seat",
            response_text: jsonBlock({
              subquestion: "q1",
              findings: "f",
              sources: ["https://a.com", "https://b.com"],
            }),
          };
        },
        fileWrite: async (p) => p,
        args: { question: "What is X?", angles: 1 },
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.angles_valid).toBe(0);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// synthesis: invented source
// ---------------------------------------------------------------------------

test("synthesis with an invented URL not in accepted angle sources is rejected", async () => {
  const db = freshDb();
  try {
    const result = (await fn(
      successCtx({
        angles: ["q1"],
        angleSources: [["https://a.com", "https://b.com"]],
        synthesisSources: ["https://a.com", "https://invented.com"],
        db,
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("synthesis_invented_source");
    expect(result.report_path).toBeNull();
  } finally {
    db.close();
  }
});

test("synthesis rejects empty, duplicate, malformed, and oversized source arrays", async () => {
  const invalidSynthesisSources = [
    [],
    ["https://a.example/x", "https://a.example/x"],
    ["https://a.example/x", "not-a-url"],
    Array.from({ length: 73 }, () => "https://a.example/x"),
  ];
  for (const sources of invalidSynthesisSources) {
    const db = freshDb();
    try {
      const result = (await fn(
        successCtx({
          angles: ["q1"],
          angleSources: [["https://a.example/x", "https://b.example/y"]],
          synthesisSources: sources,
          db,
        }),
        emptyRecall(),
      )) as ResearchResult;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("synthesis_invalid");
    } finally {
      db.close();
    }
  }
});

test("source identity is canonicalized consistently between research and synthesis", async () => {
  const db = freshDb();
  try {
    const result = (await fn(
      successCtx({
        angles: ["q1"],
        angleSources: [["HTTPS://A.EXAMPLE:443/x", "https://b.example/y"]],
        synthesisSources: ["https://a.example/x"],
        db,
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(true);
    expect(result.sources).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(result.memory_candidate?.source_urls).toEqual(["https://a.example/x"]);
  } finally {
    db.close();
  }
});

test("workflow accepts 12 sources per angle and 72 unique synthesis sources", async () => {
  const db = freshDb();
  try {
    const angles = Array.from({ length: 6 }, (_, i) => `q${String(i + 1)}`);
    const angleSources = angles.map((_, angleIndex) =>
      Array.from(
        { length: 12 },
        (_, sourceIndex) =>
          `https://source-${String(angleIndex)}-${String(sourceIndex)}.example/article`,
      ),
    );
    const synthesisSources = angleSources.flat();
    const result = (await fn(
      successCtx({ angles, angleSources, synthesisSources, db }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.ok).toBe(true);
    expect(result.sources).toHaveLength(72);
    expect(result.memory_candidate?.source_urls).toHaveLength(72);
  } finally {
    db.close();
  }
});

test("synthesis with empty report is rejected", async () => {
  const db = freshDb();
  try {
    const ctx = successCtx({
      angles: ["q1"],
      angleSources: [["https://a.com", "https://b.com"]],
      synthesisSources: ["https://a.com"],
      db,
    });
    ctx.awaitChain = async (conversationId) => {
      if (conversationId === "c-planner") {
        return {
          status: "completed",
          final_agent: "executor",
          response_text: jsonBlock({ subquestions: ["q1"] }),
        };
      }
      if (conversationId === "c-research-0") {
        return {
          status: "completed",
          final_agent: "web-seat",
          response_text: jsonBlock({
            subquestion: "q1",
            findings: "f",
            sources: ["https://a.com", "https://b.com"],
          }),
        };
      }
      if (conversationId === "c-synth") {
        return {
          status: "completed",
          final_agent: "executor",
          response_text: jsonBlock({ report: "  ", summary: "s", sources: ["https://a.com"] }),
        };
      }
      return { status: "completed", final_agent: "executor", response_text: "" };
    };
    const result = (await fn(ctx, emptyRecall())) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("synthesis_invalid");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// artifact errors / incorrect receipt
// ---------------------------------------------------------------------------

test("invalid fileWrite receipt fails closed with no ok:true and null report_path", async () => {
  for (const receipt of ["", "   ", "not-the-requested-path", null] as const) {
    const db = freshDb();
    try {
      const result = (await fn(
        successCtx({
          angles: ["q1"],
          angleSources: [["https://a.com", "https://b.com"]],
          synthesisSources: ["https://a.com"],
          db,
          fileWriteReceipt: () => receipt as string,
        }),
        emptyRecall(),
      )) as ResearchResult;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("artifact_write_failed");
      expect(result.report_path).toBeNull();
    } finally {
      db.close();
    }
  }
});

test("fileWrite throwing fails closed with no best-effort ok:true", async () => {
  const db = freshDb();
  try {
    const ctx = successCtx({
      angles: ["q1"],
      angleSources: [["https://a.com", "https://b.com"]],
      synthesisSources: ["https://a.com"],
      db,
    });
    ctx.fileWrite = async () => {
      throw new Error("disk full");
    };
    const result = (await fn(ctx, emptyRecall())) as ResearchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("artifact_write_failed");
    expect(result.report_path).toBeNull();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// output bounds: no full body inline
// ---------------------------------------------------------------------------

test("return shape omits full report body and full findings body inline", async () => {
  const db = freshDb();
  try {
    const longReport = "R".repeat(5000);
    const longFindings = "F".repeat(3000);
    const ctx = successCtx({
      angles: ["q1"],
      angleSources: [["https://a.com", "https://b.com"]],
      synthesisSources: ["https://a.com"],
      db,
    });
    ctx.awaitChain = async (conversationId) => {
      if (conversationId === "c-planner") {
        return {
          status: "completed",
          final_agent: "executor",
          response_text: jsonBlock({ subquestions: ["q1"] }),
        };
      }
      if (conversationId === "c-research-0") {
        return {
          status: "completed",
          final_agent: "web-seat",
          response_text: jsonBlock({
            subquestion: "q1",
            findings: longFindings,
            sources: ["https://a.com", "https://b.com"],
          }),
        };
      }
      if (conversationId === "c-synth") {
        return {
          status: "completed",
          final_agent: "executor",
          response_text: jsonBlock({
            report: longReport,
            summary: "s",
            sources: ["https://a.com"],
          }),
        };
      }
      return { status: "completed", final_agent: "executor", response_text: "" };
    };
    const result = (await fn(ctx, emptyRecall())) as ResearchResult;
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(longReport);
    expect(serialized).not.toContain(longFindings);
    expect(result.findings[0]?.findings_excerpt?.length ?? 0).toBeLessThanOrEqual(400);
    expect(result.summary?.length ?? 0).toBeLessThanOrEqual(2000);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// no t2 writes
// ---------------------------------------------------------------------------

test("workflow never writes to t2_memories", async () => {
  const db = freshDb();
  try {
    seedT2Memory(db, { memoryId: "m1", projectId: PROJECT, title: "prior", body: "knowledge" });
    const before =
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM t2_memories").get()?.c ?? -1;
    await fn(
      successCtx({
        angles: ["q1"],
        angleSources: [["https://a.com", "https://b.com"]],
        synthesisSources: ["https://a.com"],
        db,
      }),
      emptyRecall(),
    );
    const after =
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM t2_memories").get()?.c ?? -2;
    expect(after).toBe(before);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// persist flag: memory_candidate only when persist true
// ---------------------------------------------------------------------------

test("memory_candidate is present and bounded when persist is true (default)", async () => {
  const db = freshDb();
  try {
    const result = (await fn(
      successCtx({
        angles: ["q1"],
        angleSources: [["https://a.com", "https://b.com"]],
        synthesisSources: ["https://a.com"],
        db,
      }),
      emptyRecall(),
    )) as ResearchResult;
    expect(result.persisted).toBe(false);
    expect(result.persistence_reason).toBe("no_native_t2_write_path");
    expect(result.memory_candidate).not.toBeNull();
    expect(result.memory_candidate?.question).toBe("What is X?");
    expect(result.memory_candidate?.summary).toBe("a summary");
    expect(result.memory_candidate?.source_urls).toContain("https://a.com/");
    expect(result.memory_candidate?.report_path).not.toBeNull();
  } finally {
    db.close();
  }
});

test("memory_candidate is null when persist is false", async () => {
  const db = freshDb();
  try {
    const ctx = successCtx({
      angles: ["q1"],
      angleSources: [["https://a.com", "https://b.com"]],
      synthesisSources: ["https://a.com"],
      db,
    });
    ctx.args = { question: "What is X?", angles: 1, web_agent: "web-seat", persist: false };
    const result = (await fn(ctx, emptyRecall())) as ResearchResult;
    expect(result.persisted).toBe(false);
    expect(result.persistence_reason).toBeNull();
    expect(result.memory_candidate).toBeNull();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// input schema strictness
// ---------------------------------------------------------------------------

test("inputSchema rejects missing question, out-of-range angles, and unknown fields", () => {
  expect(inputSchema.safeParse({}).success).toBe(false);
  expect(inputSchema.safeParse({ question: "" }).success).toBe(false);
  expect(inputSchema.safeParse({ question: "   \t\n" }).success).toBe(false);
  expect(inputSchema.safeParse({ question: "q", angles: 0 }).success).toBe(false);
  expect(inputSchema.safeParse({ question: "q", angles: 7 }).success).toBe(false);
  expect(inputSchema.safeParse({ question: "q", angles: 1.5 }).success).toBe(false);
  expect(inputSchema.safeParse({ question: "q", unknown_field: true }).success).toBe(false);
  expect(inputSchema.safeParse({ question: "q" }).success).toBe(true);
  expect(inputSchema.safeParse({ question: "q", angles: 6 }).success).toBe(true);
});

test("whitespace-only question fails before memory, dispatch, or artifact expenditure", async () => {
  let dbCalls = 0;
  let dispatchCalls = 0;
  let fileWrites = 0;
  const promise = fn(
    makeCtx({
      db: () => {
        dbCalls += 1;
        return freshDb();
      },
      chainStart: async () => {
        dispatchCalls += 1;
        return Response.json({ conversation_id: "c", handoff_id: "h" });
      },
      fileWrite: async (path) => {
        fileWrites += 1;
        return path;
      },
      args: { question: "  \t\n " },
    }),
    emptyRecall(),
  );
  await expect(promise).rejects.toThrow();
  expect(dbCalls).toBe(0);
  expect(dispatchCalls).toBe(0);
  expect(fileWrites).toBe(0);
});

test("inputSchema applies defaults: angles 4, persist true, timeout 1800000, out_dir research", () => {
  const parsed = inputSchema.parse({ question: "q" });
  expect(parsed.angles).toBe(4);
  expect(parsed.persist).toBe(true);
  expect(parsed.timeout_ms).toBe(1800000);
  expect(parsed.out_dir).toBe("research");
  expect(parsed.planner_agent).toBe("executor");
  expect(parsed.synthesis_agent).toBe("executor");
});
