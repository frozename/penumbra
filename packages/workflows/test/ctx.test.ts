import {
  ChainReader,
  type ChainStartRequest,
  HandoffReader,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  type Services,
  T0Writer,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildWorkflowCtx, type WorkflowCtx } from "../src/ctx.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function fakeServices(): Services {
  return {
    handoffReader: {
      getRootForConversation: () => null,
      getLatestForConversation: () => null,
    },
    chainReader: {
      getResponses: () => [],
    },
  } as unknown as Services;
}

type RealChainFixture = {
  db: Database;
  services: Services;
  handoffWriter: HandoffWriter;
  t0Writer: T0Writer;
};

function realChainFixture(): RealChainFixture {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return {
    db,
    services: {
      handoffReader: new HandoffReader({ db }),
      chainReader: new ChainReader(db),
    } as unknown as Services,
    handoffWriter: new HandoffWriter({ db }),
    t0Writer: new T0Writer(db),
  };
}

function createApprovedHandoff(
  writer: HandoffWriter,
  input: {
    handoffId: string;
    conversationId: string;
    parentHandoffId?: string;
    ts: string;
  },
): void {
  writer.createApproved({
    handoff_id: input.handoffId,
    ts: input.ts,
    project_id: "proj-1",
    conversation_id: input.conversationId,
    from: "user",
    to: `agent-${input.handoffId}`,
    to_role: null,
    message: `message-${input.handoffId}`,
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: 3,
    chain_trust_mode: "all",
    chain_task_type: "implement_small",
    use_worktree: false,
    parent_handoff_id: input.parentHandoffId ?? null,
  });
}

function completeHandoff(writer: HandoffWriter, handoffId: string): void {
  expect(writer.claimDispatch(handoffId, `worker-${handoffId}`)).toBe(true);
  expect(
    writer.markCompleted(handoffId, {
      ts: "2026-09-12T12:00:00.000Z",
      expected_worker_id: `worker-${handoffId}`,
    }),
  ).toBe(true);
}

function writeAgentResponse(
  writer: T0Writer,
  input: {
    eventId: string;
    conversationId: string;
    handoffId: string;
    agent: string;
    text: string;
    ts: string;
  },
): void {
  writer.write({
    event_id: input.eventId,
    ts: input.ts,
    ingest_ts: input.ts,
    source: "agentchat",
    source_detail: input.agent,
    project_id: "proj-1",
    user_id: "test-user",
    machine_id: "test-machine",
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
      response: input.text,
      agent: input.agent,
      handoff_id: input.handoffId,
    },
    payload_summary: input.text,
    origin: "dispatch",
  });
}

function realAwaitCtx(
  fixture: RealChainFixture,
  opts: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
  } = {},
): ReturnType<typeof buildWorkflowCtx> {
  return buildWorkflowCtx({
    services: fixture.services,
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () => new Response(null, { status: 500 }),
    ...opts,
  });
}

test("dispatch returns ids from chain.start payload", async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  const out = await ctx.dispatch({ agent: "codex", message: "run this", task_type: "implementer" });
  expect(out).toEqual({ conversation_id: "conv-1", handoff_id: "hand-1" });
  expect(captured?.initial_agent).toBe("codex");
  expect(captured?.project_id).toBe("proj-1");
  expect(captured?.task_type).toBe("implementer");
});

test("dispatch forwards task_class to chain.start requests", async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  await ctx.dispatch({
    agent: "codex",
    message: "summarize this",
    task_type: "review_adversarial",
    task_class: "TRIVIAL",
  });

  expect(captured?.task_class).toBe("TRIVIAL");
});

test("dispatch threads deps.project into chainStart req.project_id", async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "sirius",
    agentchatConfig: {},
    workflowRunId: "wfrun-test-uuid",
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-2", handoff_id: "hand-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  const out = await ctx.dispatch({
    agent: "codex",
    message: "review this",
    task_type: "implementer",
  });
  expect(out).toEqual({ conversation_id: "conv-2", handoff_id: "hand-2" });
  expect(captured?.project_id).toBe("sirius");
});

test("dispatch uses per-call project_id override over deps.project", async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "sirius",
    agentchatConfig: {},
    workflowRunId: "wfrun-test-uuid",
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-3", handoff_id: "hand-3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  const out = await ctx.dispatch({
    agent: "codex",
    message: "noop",
    task_type: "implementer",
    project_id: "novaflow",
  });
  expect(out).toEqual({ conversation_id: "conv-3", handoff_id: "hand-3" });
  expect(captured?.project_id).toBe("novaflow");
});

test("dispatch stamps workflow dispatch_kind on chainStart requests", async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "sirius",
    agentchatConfig: {},
    workflowRunId: "wfrun-test-uuid",
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-4a", handoff_id: "hand-4a" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  const out = await ctx.dispatch({
    agent: "codex",
    message: "workflow hop",
    task_type: "implementer",
  });
  expect(out).toEqual({ conversation_id: "conv-4a", handoff_id: "hand-4a" });
  expect(captured?.dispatch_kind).toBe("workflow");
  expect(captured?.workflow_run_id).toBe("wfrun-test-uuid");
});

test("dispatch stamps caller_cwd from deps.cwd so the sandbox denies the originating root", async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/repo/originating-cwd",
    storageRoot: "/tmp/storage",
    project: "sirius",
    agentchatConfig: {},
    workflowRunId: "wfrun-test-uuid",
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            conversation_id: "conv-4b",
            handoff_id: "hand-4b",
            permission_profile: "review_readonly",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    },
  });

  const out = await ctx.dispatch({
    agent: "reviewer-seat",
    message: "adversarial review",
    task_type: "review_adversarial",
    permission_profile: "review_readonly",
    use_worktree: false,
  });
  expect(out.conversation_id).toBe("conv-4b");
  expect(captured?.caller_cwd).toBe("/repo/originating-cwd");
});

test("dispatch omits project_id when deps.project is falsy", async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "",
    agentchatConfig: {},
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-4", handoff_id: "hand-4" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  const out = await ctx.dispatch({ agent: "codex", message: "noop", task_type: "implementer" });
  expect(out).toEqual({ conversation_id: "conv-4", handoff_id: "hand-4" });
  expect(captured?.project_id).toBeUndefined();
});

test("awaitChain returns timeout when terminal state never arrives", async () => {
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    readChainStatus: () =>
      Promise.resolve({
        terminal: false,
        status: "failed" as const,
        final_agent: null,
        response_text: null,
      }),
    pollIntervalMs: 1,
    sleep: () => Promise.resolve(),
  });

  const out = await ctx.awaitChain("conv-1", { timeoutMs: 1 });
  expect(out.status).toBe("timeout");
  expect(out.final_agent).toBeNull();
  expect(out.response_text).toBeNull();
});

test("awaitChain uses exponential backoff up to a 2000ms cap", async () => {
  const sleepCalls: number[] = [];
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    readChainStatus: () =>
      Promise.resolve({
        terminal: false,
        status: "failed" as const,
        final_agent: null,
        response_text: null,
      }),
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
    now: (): number => nowMs,
  });

  const out = await ctx.awaitChain("conv-1", { timeoutMs: 10000 });
  expect(out.status).toBe("timeout");
  expect(sleepCalls.length).toBeGreaterThan(8);
  expect(sleepCalls[0]).toBe(200);
  expect(sleepCalls[1]).toBe(300);
  expect(sleepCalls[2]).toBe(450);
  expect(sleepCalls[3]).toBe(675);
  expect(sleepCalls[4]).toBeCloseTo(1012.5, 5);
  expect(sleepCalls[sleepCalls.length - 1]).toBe(2000);
});

test("awaitChain returns failed when handoff completed but zero responses", async () => {
  const ctx = buildWorkflowCtx({
    services: {
      handoffReader: {
        getRootForConversation: () => ({
          handoff_id: "hand-1",
          status: "completed",
          resolved_at: new Date().toISOString(),
        }),
        getLatestForConversation: () => ({
          handoff_id: "hand-1",
          status: "completed",
          resolved_at: new Date().toISOString(),
        }),
      },
      chainReader: {
        getResponses: () => [],
      },
    } as unknown as Services,
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
  });

  const out = await ctx.awaitChain("conv-1", { timeoutMs: 10 });
  expect(out.status).toBe("failed");
  expect(out.final_agent).toBeNull();
  expect(out.response_text).toBeNull();
});

test("awaitChain waits for late agent-response stamped after handoff goes terminal", async () => {
  let getResponsesCalls = 0;
  const ctx = buildWorkflowCtx({
    services: {
      handoffReader: {
        getRootForConversation: () => ({
          handoff_id: "hand-1",
          status: "completed",
          resolved_at: new Date().toISOString(),
        }),
        getLatestForConversation: () => ({
          handoff_id: "hand-1",
          status: "completed",
          resolved_at: new Date().toISOString(),
        }),
      },
      chainReader: {
        getResponses: () => {
          getResponsesCalls += 1;
          if (getResponsesCalls < 4) return [];
          return [{ agent: "codex", text: "late review body that arrived after terminal" }];
        },
      },
    } as unknown as Services,
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    pollIntervalMs: 1,
  });

  const out = await ctx.awaitChain("conv-1", { timeoutMs: 5000, lateResponseGraceMs: 1000 });
  expect(out.status).toBe("completed");
  expect(out.final_agent).toBe("codex");
  expect(out.response_text).toBe("late review body that arrived after terminal");
  expect(getResponsesCalls).toBeGreaterThanOrEqual(4);
});

test("awaitChain returns completed when handoff completed and response is present", async () => {
  const ctx = buildWorkflowCtx({
    services: {
      handoffReader: {
        getRootForConversation: () => ({
          handoff_id: "hand-1",
          status: "completed",
          resolved_at: new Date().toISOString(),
        }),
        getLatestForConversation: () => ({
          handoff_id: "hand-1",
          status: "completed",
          resolved_at: new Date().toISOString(),
        }),
      },
      chainReader: {
        getResponses: () => [{ agent: "codex", text: "all good" }],
      },
    } as unknown as Services,
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
  });

  const out = await ctx.awaitChain("conv-1", { timeoutMs: 10 });
  expect(out.status).toBe("completed");
  expect(out.final_agent).toBe("codex");
  expect(out.response_text).toBe("all good");
});

test("awaitChain prefers terminal root handoff over later failed child handoff", async () => {
  const ctx = buildWorkflowCtx({
    services: {
      handoffReader: {
        getRootForConversation: () => ({
          handoff_id: "root-hand-1",
          status: "completed",
          resolved_at: new Date().toISOString(),
        }),
        getLatestForConversation: () => ({
          handoff_id: "child-hand-2",
          status: "failed",
          resolved_at: new Date().toISOString(),
        }),
      },
      chainReader: {
        getResponses: () => [{ agent: "claude", text: "authoritative root response" }],
      },
    } as unknown as Services,
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
  });

  const out = await ctx.awaitChain("conv-1", { timeoutMs: 10 });
  expect(out.status).toBe("completed");
  expect(out.final_agent).toBe("claude");
  expect(out.response_text).toBe("authoritative root response");
});

test("awaitChain reads the terminal root response instead of a later child response", async () => {
  const fixture = realChainFixture();
  const conversationId = "conv-real-root-and-child";
  const ctx = realAwaitCtx(fixture);
  try {
    createApprovedHandoff(fixture.handoffWriter, {
      handoffId: "root-real",
      conversationId,
      ts: "2026-09-12T10:00:00.000Z",
    });
    createApprovedHandoff(fixture.handoffWriter, {
      handoffId: "child-real",
      conversationId,
      parentHandoffId: "root-real",
      ts: "2026-09-12T10:01:00.000Z",
    });
    completeHandoff(fixture.handoffWriter, "root-real");
    completeHandoff(fixture.handoffWriter, "child-real");
    writeAgentResponse(fixture.t0Writer, {
      eventId: "response-root-real",
      conversationId,
      handoffId: "root-real",
      agent: "root-agent",
      text: "authoritative root result",
      ts: "2026-09-12T10:02:00.000Z",
    });
    writeAgentResponse(fixture.t0Writer, {
      eventId: "response-child-real",
      conversationId,
      handoffId: "child-real",
      agent: "child-agent",
      text: "later child result",
      ts: "2026-09-12T10:03:00.000Z",
    });

    const out = await ctx.awaitChain(conversationId, { timeoutMs: 10 });

    expect(out).toEqual({
      status: "completed",
      final_agent: "root-agent",
      response_text: "authoritative root result",
    });
  } finally {
    ctx.dispose();
    fixture.db.close();
  }
});

test("awaitChain does not let a later child response satisfy a completed root", async () => {
  const fixture = realChainFixture();
  const conversationId = "conv-real-child-only";
  const ctx = realAwaitCtx(fixture);
  try {
    createApprovedHandoff(fixture.handoffWriter, {
      handoffId: "root-without-response",
      conversationId,
      ts: "2026-09-12T11:00:00.000Z",
    });
    createApprovedHandoff(fixture.handoffWriter, {
      handoffId: "child-with-response",
      conversationId,
      parentHandoffId: "root-without-response",
      ts: "2026-09-12T11:01:00.000Z",
    });
    completeHandoff(fixture.handoffWriter, "root-without-response");
    completeHandoff(fixture.handoffWriter, "child-with-response");
    writeAgentResponse(fixture.t0Writer, {
      eventId: "response-child-only",
      conversationId,
      handoffId: "child-with-response",
      agent: "child-agent",
      text: "child-only result",
      ts: "2026-09-12T11:02:00.000Z",
    });

    const out = await ctx.awaitChain(conversationId, {
      timeoutMs: 10,
      lateResponseGraceMs: 0,
    });

    expect(out).toEqual({ status: "failed", final_agent: null, response_text: null });
  } finally {
    ctx.dispose();
    fixture.db.close();
  }
});

test("awaitChain observes a root response that arrives during late-response grace", async () => {
  const fixture = realChainFixture();
  const conversationId = "conv-real-late-root";
  let nowMs = 0;
  let wroteResponse = false;
  const ctx = realAwaitCtx(fixture, {
    now: () => nowMs,
    pollIntervalMs: 10,
    sleep: (ms) => {
      nowMs += ms;
      if (!wroteResponse) {
        wroteResponse = true;
        writeAgentResponse(fixture.t0Writer, {
          eventId: "response-late-root",
          conversationId,
          handoffId: "root-late-response",
          agent: "root-agent",
          text: "late authoritative root result",
          ts: "2026-09-12T12:02:00.000Z",
        });
      }
      return Promise.resolve();
    },
  });
  try {
    createApprovedHandoff(fixture.handoffWriter, {
      handoffId: "root-late-response",
      conversationId,
      ts: "2026-09-12T12:00:00.000Z",
    });
    completeHandoff(fixture.handoffWriter, "root-late-response");

    const out = await ctx.awaitChain(conversationId, {
      timeoutMs: 100,
      lateResponseGraceMs: 50,
    });

    expect(out).toEqual({
      status: "completed",
      final_agent: "root-agent",
      response_text: "late authoritative root result",
    });
  } finally {
    ctx.dispose();
    fixture.db.close();
  }
});

test("awaitChain preserves failed root status and its stamped response", async () => {
  const fixture = realChainFixture();
  const conversationId = "conv-real-failed-root";
  const ctx = realAwaitCtx(fixture);
  try {
    createApprovedHandoff(fixture.handoffWriter, {
      handoffId: "root-failed",
      conversationId,
      ts: "2026-09-12T13:00:00.000Z",
    });
    expect(
      fixture.handoffWriter.markFailed("root-failed", {
        reason: "worker failed",
        ts: "2026-09-12T13:01:00.000Z",
      }),
    ).toBe(true);
    writeAgentResponse(fixture.t0Writer, {
      eventId: "response-failed-root",
      conversationId,
      handoffId: "root-failed",
      agent: "root-agent",
      text: "partial failure detail",
      ts: "2026-09-12T13:02:00.000Z",
    });

    const out = await ctx.awaitChain(conversationId, { timeoutMs: 10 });

    expect(out).toEqual({
      status: "failed",
      final_agent: "root-agent",
      response_text: "partial failure detail",
    });
  } finally {
    ctx.dispose();
    fixture.db.close();
  }
});

test("awaitChain maps a rejected root to failed without borrowing conversation text", async () => {
  const fixture = realChainFixture();
  const conversationId = "conv-real-rejected-root";
  const ctx = realAwaitCtx(fixture);
  try {
    fixture.handoffWriter.create({
      handoff_id: "root-rejected",
      ts: "2026-09-12T14:00:00.000Z",
      project_id: "proj-1",
      conversation_id: conversationId,
      from: "user",
      to: "root-agent",
      to_role: null,
      message: "cancel this dispatch",
      triggered_by_event_id: null,
      use_worktree: false,
      isolated_install: false,
      parent_handoff_id: null,
      chain_task_type: "implement_small",
      branch_base: null,
      chain_max_hops: 3,
      branch_name: null,
    });
    fixture.handoffWriter.reject("root-rejected", {
      resolved_by: "test",
      resolved_at: "2026-09-12T14:01:00.000Z",
      reason: "cancelled",
    });

    const out = await ctx.awaitChain(conversationId, {
      timeoutMs: 10,
      lateResponseGraceMs: 0,
    });

    expect(out).toEqual({ status: "failed", final_agent: null, response_text: null });
  } finally {
    ctx.dispose();
    fixture.db.close();
  }
});

test("awaitChain times out when real storage has no root handoff", async () => {
  const fixture = realChainFixture();
  let nowMs = 0;
  const ctx = realAwaitCtx(fixture, {
    now: () => nowMs,
    pollIntervalMs: 1,
    sleep: (ms) => {
      nowMs += ms;
      return Promise.resolve();
    },
  });
  try {
    const out = await ctx.awaitChain("conv-real-missing-root", { timeoutMs: 3 });
    expect(out).toEqual({ status: "timeout", final_agent: null, response_text: null });
  } finally {
    ctx.dispose();
    fixture.db.close();
  }
});

test("fileWrite resolves storage-relative paths and returns written path", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfctx-"));
  try {
    const ctx = buildWorkflowCtx({
      services: fakeServices(),
      cwd: join(root, "repo"),
      storageRoot: join(root, "storage"),
      project: "proj-1",
      agentchatConfig: {},
      chainStart: () =>
        Promise.resolve(
          new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });

    const written = await ctx.fileWrite("notes/out.txt", "hello");
    const expected = resolve(join(root, "storage", "notes/out.txt"));
    expect(written).toBe(realpathSync(expected));
    expect(readFileSync(realpathSync(expected), "utf8")).toBe("hello");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fileWrite resolves ./ paths from cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfctx-cwd-"));
  try {
    const cwd = join(root, "repo");
    const ctx = buildWorkflowCtx({
      services: fakeServices(),
      cwd,
      storageRoot: join(root, "storage"),
      project: "proj-1",
      agentchatConfig: {},
      chainStart: () =>
        Promise.resolve(
          new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });

    const written = await ctx.fileWrite("./report.md", "# hi");
    const expected = resolve(join(cwd, "report.md"));
    expect(written).toBe(realpathSync(expected));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fileWrite allows absolute paths inside cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfctx-abs-cwd-"));
  try {
    const cwd = join(root, "repo");
    const storageRoot = join(root, "storage");
    const target = resolve(join(cwd, "inside", "allowed.txt"));
    const ctx = buildWorkflowCtx({
      services: fakeServices(),
      cwd,
      storageRoot,
      project: "proj-1",
      agentchatConfig: {},
      chainStart: () =>
        Promise.resolve(
          new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });

    const written = await ctx.fileWrite(target, "ok");
    expect(written).toBe(realpathSync(target));
    expect(readFileSync(realpathSync(target), "utf8")).toBe("ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fileWrite rejects absolute paths outside allowed roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfctx-abs-outside-"));
  try {
    const cwd = join(root, "repo");
    const storageRoot = join(root, "storage");
    const outsideRoot = mkdtempSync(join(tmpdir(), "wfctx-outside-root-"));
    const outsidePath = resolve(join(outsideRoot, "outside.txt"));
    const ctx = buildWorkflowCtx({
      services: fakeServices(),
      cwd,
      storageRoot,
      project: "proj-1",
      agentchatConfig: {},
      chainStart: () =>
        Promise.resolve(
          new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    let caught: unknown;
    try {
      await ctx.fileWrite(outsidePath, "nope");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain("fileWrite path outside allowed roots");
    rmSync(outsideRoot, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ctx exposes args while the public type remains assignable without deadline", () => {
  const args = { base_ref: "main", target_ref: "HEAD", timeout_ms: 1234 };
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    args,
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
  });

  const publicCtx: WorkflowCtx<typeof args> = {
    dispatch: (input) => ctx.dispatch(input),
    awaitChain: (conversationId, opts) => ctx.awaitChain(conversationId, opts),
    cancel: (conversationId) => ctx.cancel(conversationId),
    fileWrite: (relativePath, body) => ctx.fileWrite(relativePath, body),
    db: ctx.db,
    config: ctx.config,
    cwd: ctx.cwd,
    storageRoot: ctx.storageRoot,
    project: ctx.project,
    args: ctx.args,
  };

  expect(publicCtx.args).toEqual(args);
});

// ---------------------------------------------------------------------------
// Run-level deadline (Task 10.1)
// ---------------------------------------------------------------------------

function notTerminal(): Promise<{
  terminal: false;
  status: "failed";
  final_agent: null;
  response_text: null;
}> {
  return Promise.resolve({
    terminal: false,
    status: "failed" as const,
    final_agent: null,
    response_text: null,
  });
}

function okChainStart(): (input: ChainStartRequest) => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ conversation_id: "conv-d", handoff_id: "hand-d" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
}

test("deadline returns null remaining_ms when runTimeoutMs is absent (unbounded)", () => {
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: okChainStart(),
    now: (): number => nowMs,
  });
  expect(ctx.deadline()).toEqual({ remaining_ms: null, expired: false });
  nowMs = 999_999;
  expect(ctx.deadline()).toEqual({ remaining_ms: null, expired: false });
});

test("deadline returns positive remaining_ms and expired=false within budget", () => {
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: okChainStart(),
    runTimeoutMs: 1000,
    now: (): number => nowMs,
  });
  nowMs = 400;
  const dl = ctx.deadline();
  expect(dl.remaining_ms).toBe(600);
  expect(dl.expired).toBe(false);
});

test("deadline returns remaining_ms 0 and expired=true when budget exhausted", () => {
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: okChainStart(),
    runTimeoutMs: 1000,
    now: (): number => nowMs,
  });
  nowMs = 1000;
  expect(ctx.deadline()).toEqual({ remaining_ms: 0, expired: true });
  nowMs = 1500;
  expect(ctx.deadline()).toEqual({ remaining_ms: 0, expired: true });
});

test("awaitChain clamps per-call timeout to remaining run budget (partial budget)", async () => {
  const sleepCalls: number[] = [];
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: okChainStart(),
    runTimeoutMs: 1000,
    readChainStatus: notTerminal,
    pollIntervalMs: 200,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
    now: (): number => nowMs,
  });
  // Consume 800ms of the 1000ms budget, leaving 200ms.
  nowMs = 800;
  // Request a 5000ms wait — should be clamped to the 200ms remaining.
  const out = await ctx.awaitChain("conv-1", { timeoutMs: 5000 });
  expect(out.status).toBe("timeout");
  const totalSleep = sleepCalls.reduce((a, b) => a + b, 0);
  expect(totalSleep).toBe(200);
});

test("second awaitChain never re-arms the run budget", async () => {
  const sleepCallsA: number[] = [];
  const sleepCallsB: number[] = [];
  let nowMs = 0;
  let sleepTarget = sleepCallsA;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: okChainStart(),
    runTimeoutMs: 1000,
    readChainStatus: notTerminal,
    pollIntervalMs: 200,
    sleep: (ms: number) => {
      sleepTarget.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
    now: (): number => nowMs,
  });
  // First call: 600ms requested, 1000ms budget → effective 600ms.
  await ctx.awaitChain("conv-1", { timeoutMs: 600 });
  const totalA = sleepCallsA.reduce((a, b) => a + b, 0);
  expect(totalA).toBe(600);
  // 400ms of run budget remains.
  // Second call: 600ms requested, but only 400ms remains → effective 400ms.
  sleepTarget = sleepCallsB;
  const out = await ctx.awaitChain("conv-1", { timeoutMs: 600 });
  expect(out.status).toBe("timeout");
  const totalB = sleepCallsB.reduce((a, b) => a + b, 0);
  expect(totalB).toBe(400);
});

test("awaitChain returns timeout immediately when run budget exhausted (no status poll)", async () => {
  let statusCalls = 0;
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: okChainStart(),
    runTimeoutMs: 100,
    readChainStatus: () => {
      statusCalls += 1;
      return notTerminal();
    },
    pollIntervalMs: 200,
    sleep: (ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    },
    now: (): number => nowMs,
  });
  nowMs = 101;
  const out = await ctx.awaitChain("conv-1", { timeoutMs: 5000 });
  expect(out.status).toBe("timeout");
  expect(out.final_agent).toBeNull();
  expect(out.response_text).toBeNull();
  expect(statusCalls).toBe(0);
});

test("dispatch is rejected after run deadline expiry without chainStart side effect", async () => {
  let chainStartCalls = 0;
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () => {
      chainStartCalls += 1;
      return okChainStart()({} as ChainStartRequest);
    },
    runTimeoutMs: 100,
    now: (): number => nowMs,
  });
  nowMs = 101;
  let caught: unknown;
  try {
    await ctx.dispatch({ agent: "codex", message: "too late" });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(chainStartCalls).toBe(0);
});

test("dispatch succeeds before run deadline expiry", async () => {
  let chainStartCalls = 0;
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () => {
      chainStartCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-ok", handoff_id: "hand-ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    runTimeoutMs: 1000,
    now: (): number => nowMs,
  });
  nowMs = 500;
  const out = await ctx.dispatch({ agent: "codex", message: "in time" });
  expect(out).toEqual({ conversation_id: "conv-ok", handoff_id: "hand-ok" });
  expect(chainStartCalls).toBe(1);
});

test("different ctx instances have independent run clocks", async () => {
  let nowMs = 0;
  let callsA = 0;
  let callsB = 0;
  const ctxA = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () => {
      callsA += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "ca", handoff_id: "ha" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    runTimeoutMs: 100,
    now: (): number => nowMs,
  });
  const ctxB = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () => {
      callsB += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "cb", handoff_id: "hb" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    now: (): number => nowMs,
  });
  nowMs = 101;
  // ctxA expired, ctxB unbounded.
  let caughtA: unknown;
  try {
    await ctxA.dispatch({ agent: "codex", message: "expired" });
  } catch (err) {
    caughtA = err;
  }
  expect(caughtA).toBeInstanceOf(Error);
  expect(callsA).toBe(0);
  const outB = await ctxB.dispatch({ agent: "codex", message: "fine" });
  expect(outB).toEqual({ conversation_id: "cb", handoff_id: "hb" });
  expect(callsB).toBe(1);
});

test("cancel is still usable after run deadline expiry", async () => {
  let cancelCalled = false;
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: okChainStart(),
    chainCancel: () => {
      cancelCalled = true;
      return Promise.resolve();
    },
    runTimeoutMs: 100,
    now: (): number => nowMs,
  });
  nowMs = 101;
  expect(ctx.deadline().expired).toBe(true);
  await ctx.cancel("conv-1");
  expect(cancelCalled).toBe(true);
});

test("unbounded awaitChain backoff sequence is unchanged with no runTimeoutMs", async () => {
  const sleepCalls: number[] = [];
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: okChainStart(),
    readChainStatus: notTerminal,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
    now: (): number => nowMs,
  });
  await ctx.awaitChain("conv-1", { timeoutMs: 10000 });
  expect(sleepCalls.length).toBeGreaterThan(8);
  expect(sleepCalls[0]).toBe(200);
  expect(sleepCalls[1]).toBe(300);
  expect(sleepCalls[2]).toBe(450);
  expect(sleepCalls[3]).toBe(675);
  expect(sleepCalls[4]).toBeCloseTo(1012.5, 5);
  expect(sleepCalls[sleepCalls.length - 1]).toBe(2000);
});

test("dispatch forwards permission_profile and max_hops to chain.start requests", async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            conversation_id: "conv-p",
            handoff_id: "hand-p",
            permission_profile: "review_readonly",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });

  const out = await ctx.dispatch({
    agent: "opencode-seat",
    message: "review this",
    task_type: "review_adversarial",
    permission_profile: "review_readonly",
    max_hops: 1,
  });
  expect(captured?.permission_profile).toBe("review_readonly");
  expect(captured?.max_hops).toBe(1);
  expect(out).toEqual({
    conversation_id: "conv-p",
    handoff_id: "hand-p",
    permission_profile: "review_readonly",
  });
});

test("dispatch throws when chain_start response does not echo a requested profile", async () => {
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-n", handoff_id: "hand-n" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
  });

  let caught: unknown;
  try {
    await ctx.dispatch({
      agent: "opencode-seat",
      message: "review this",
      permission_profile: "review_readonly",
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toContain("permission_profile");
});

test("dispatch throws when chain_start echoes a different profile than requested", async () => {
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            conversation_id: "conv-m",
            handoff_id: "hand-m",
            permission_profile: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });

  let caught: unknown;
  try {
    await ctx.dispatch({
      agent: "opencode-seat",
      message: "review this",
      permission_profile: "review_readonly",
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toContain("permission_profile");
});

test("dispatch result omits permission_profile key when no profile was requested", async () => {
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-o", handoff_id: "hand-o" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
  });

  const out = await ctx.dispatch({ agent: "codex", message: "plain" });
  expect(out).toEqual({ conversation_id: "conv-o", handoff_id: "hand-o" });
});

test("dispatch forwards cwd_override to chain.start requests", async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    workflowRunId: "run-9",
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-c", handoff_id: "hand-c" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  await ctx.dispatch({
    agent: "opencode-seat",
    message: "review this",
    use_worktree: false,
    cwd_override: "/tmp/scratch-run-9",
    max_hops: 1,
  });
  expect(captured?.cwd_override).toBe("/tmp/scratch-run-9");
  expect(captured?.use_worktree).toBe(false);
});

test("scratchWorktree.acquire rejects without a workflow_run_id", async () => {
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    chainStart: okChainStart(),
  });
  let caught: unknown;
  try {
    await ctx.scratchWorktree!.acquire();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toContain("workflow_run_id");
});

test("scratchWorktree.acquire is memoized and binds owner_run_id to the run", async () => {
  const acquireCalls: { owner_run_id?: string; cwd?: string; project_id?: string }[] = [];
  const handle = {
    owner_run_id: "run-7",
    path: "/tmp/scratch-run-7",
    sha: "0".repeat(40),
    repo_root: "/tmp/repo",
    project_id: "proj-uuid",
    release: (): Promise<{ kept: boolean }> => Promise.resolve({ kept: false }),
  };
  const services = {
    ...fakeServices(),
    scratchWorktrees: {
      acquire: (input: {
        owner_run_id?: string;
        cwd?: string;
        project_id?: string;
      }): Promise<typeof handle> => {
        acquireCalls.push(input);
        return Promise.resolve(handle);
      },
    },
    projectRegistry: { get: () => ({ project_id: "proj-uuid" }) },
  } as unknown as Services;

  const ctx = buildWorkflowCtx({
    services,
    cwd: "/tmp/caller-cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    workflowRunId: "run-7",
    chainStart: okChainStart(),
  });

  const first = await ctx.scratchWorktree!.acquire();
  const second = await ctx.scratchWorktree!.acquire();
  expect(first).toBe(handle);
  expect(second).toBe(first);
  expect(acquireCalls).toHaveLength(1);
  expect(acquireCalls[0].owner_run_id).toBe("run-7");
  expect(acquireCalls[0].cwd).toBe("/tmp/caller-cwd");
  expect(acquireCalls[0].project_id).toBe("proj-uuid");
});

test("scratchWorktree.acquire forwards ref to services.scratchWorktrees.acquire", async () => {
  const acquireCalls: { owner_run_id?: string; ref?: string }[] = [];
  const handle = {
    owner_run_id: "run-8",
    path: "/tmp/scratch-run-8",
    sha: "0".repeat(40),
    repo_root: "/tmp/repo",
    project_id: null,
    release: (): Promise<{ kept: boolean }> => Promise.resolve({ kept: false }),
  };
  const services = {
    ...fakeServices(),
    scratchWorktrees: {
      acquire: (input: { owner_run_id?: string; ref?: string }): Promise<typeof handle> => {
        acquireCalls.push(input);
        return Promise.resolve(handle);
      },
    },
  } as unknown as Services;

  const ctx = buildWorkflowCtx({
    services,
    cwd: "/tmp/caller-cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    workflowRunId: "run-8",
    chainStart: okChainStart(),
  });

  await ctx.scratchWorktree!.acquire({ ref: "target-branch-9" });
  expect(acquireCalls).toHaveLength(1);
  expect(acquireCalls[0].ref).toBe("target-branch-9");
});
