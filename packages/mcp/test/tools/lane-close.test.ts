import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { DaemonClient } from "../../src/daemon-client.js";
import { LaneCloseInputShape, laneCloseHandler } from "../../src/tools/lane-close.js";
import { createDaemonFetchHandler } from "../../../daemon/src/serve.js";

function parseToolResult(out: unknown): unknown {
  const content = (out as { content: Array<{ type: string; text: string }> }).content;
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text);
}

function makeDaemon(fetchImpl: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const daemon = new DaemonClient({ baseUrl: "http://daemon", token: "t" });
  return {
    daemon,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function makeLiveDaemon() {
  try {
    if (process.platform === "darwin") {
      Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
    }
  } catch {}

  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "lane-close-mcp-"));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-12T00:00:00.000Z"),
  });
  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token });
  return {
    daemon: new DaemonClient({ baseUrl: "http://daemon", token }),
    services,
    token,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new Request(String(input), init)),
    stop() {
      try {
        services.supervisor.stopAll();
      } catch {}
      try {
        db.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("LaneCloseInputShape requires a closing gate status", () => {
  const schema = z.object(LaneCloseInputShape);
  expect(() => schema.parse({ lane_id: "lane-1", gate_status: "open" })).toThrow();
  expect(() => schema.parse({ lane_id: "", gate_status: "passed" })).toThrow();
  expect(schema.parse({ lane_id: "lane-1", gate_status: "failed" })).toEqual({
    lane_id: "lane-1",
    gate_status: "failed",
  });
});

test("laneCloseHandler posts lane_close to the daemon and returns the response", async () => {
  let receivedMethod: string | undefined;
  const receivedPaths: string[] = [];
  let receivedAuth: string | undefined;
  const receivedBodies: unknown[] = [];
  const { daemon, restore } = makeDaemon(async (input, init) => {
    receivedMethod = init?.method;
    const receivedPath = new URL(String(input)).pathname;
    receivedPaths.push(receivedPath);
    receivedAuth = init?.headers
      ? (new Headers(init.headers as HeadersInit).get("authorization") ?? undefined)
      : undefined;
    receivedBodies.push(JSON.parse(String(init?.body)));
    if (receivedPath === "/lanes/close") {
      return Response.json({
        lane_id: "lane-1234",
        ts_opened: "2026-05-12T00:00:00Z",
        ts_closed: "2026-05-12T00:00:00Z",
        task_class: "STANDARD",
        implementer_handoff: "h-impl",
        reviewer_handoff: "reviewer-1",
        gate_status: "passed",
        recalled_memory_ids: [],
        recalled_query: null,
        override_reason: "validated in review",
        metadata_json: "{}",
      });
    }
    return Response.json({ ok: true, authorized: true, events_written: 1 });
  });

  try {
    const out = parseToolResult(
      await laneCloseHandler(daemon)({
        lane_id: "lane-1234",
        gate_status: "passed",
        reviewer_handoff_id: "reviewer-1",
        override_reason: "validated in review",
      }),
    );

    expect(receivedMethod).toBe("POST");
    expect(receivedPaths).toEqual(["/lanes/close", "/memory-verify/authorize"]);
    expect(receivedAuth).toBe("Bearer t");
    expect(receivedBodies[0]).toEqual({
      lane_id: "lane-1234",
      gate_status: "passed",
      reviewer_handoff: "reviewer-1",
      override_reason: "validated in review",
    });
    expect(out).toEqual({
      lane_id: "lane-1234",
      ts_opened: "2026-05-12T00:00:00Z",
      ts_closed: "2026-05-12T00:00:00Z",
      task_class: "STANDARD",
      implementer_handoff: "h-impl",
      reviewer_handoff: "reviewer-1",
      gate_status: "passed",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: "validated in review",
      metadata_json: "{}",
      memory_verify_authorization: "authorized",
    });
  } finally {
    restore();
  }
});

test("laneCloseHandler authorizes memory verification after a successful close", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const { daemon, restore } = makeDaemon(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (path === "/lanes/close") {
      return Response.json({
        lane_id: "lane-1234",
        ts_opened: "2026-05-12T00:00:00Z",
        ts_closed: "2026-05-12T00:00:00Z",
        task_class: "STANDARD",
        gate_status: "passed",
        implementer_handoff: "h-impl",
        reviewer_handoff: "h-review",
        recalled_memory_ids: [],
        recalled_query: null,
        override_reason: null,
        metadata_json: "{}",
      });
    }
    if (path === "/memory-verify/authorize") {
      return Response.json({ ok: true, authorized: true, events_written: 2 });
    }
    throw new Error(`unexpected path ${path}`);
  });

  try {
    await laneCloseHandler(daemon)({
      lane_id: "lane-1234",
      gate_status: "passed",
      reviewer_handoff_id: "h-review",
    });

    expect(calls).toEqual([
      {
        path: "/lanes/close",
        body: {
          lane_id: "lane-1234",
          gate_status: "passed",
          reviewer_handoff: "h-review",
        },
      },
      {
        path: "/memory-verify/authorize",
        body: {
          handoff_id: "h-impl",
          verdict: "passed",
          basis: {
            kind: "lane_close",
            lane_id: "lane-1234",
            reviewer_handoff: "h-review",
          },
          authorized_by_handoff: "h-review",
        },
      },
    ]);
  } finally {
    restore();
  }
});

test("laneCloseHandler surfaces daemon 400 errors", async () => {
  const { daemon, restore } = makeDaemon(
    async () =>
      new Response(JSON.stringify({ error: { code: "validation_failed" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    await expect(
      laneCloseHandler(daemon)({ lane_id: "lane-1234", gate_status: "failed" }),
    ).rejects.toThrow("daemon /lanes/close: HTTP 400");
  } finally {
    restore();
  }
});

test("lane_close forwards metadata to daemon POST body", async () => {
  let capturedBody: unknown;
  let callCount = 0;
  const { daemon, restore } = makeDaemon(async (_input, init) => {
    callCount += 1;
    capturedBody = JSON.parse(String(init?.body));
    return Response.json({
      lane_id: "lane-meta",
      ts_opened: "2026-05-12T00:00:00Z",
      ts_closed: "2026-05-12T00:00:00Z",
      task_class: "STANDARD",
      implementer_handoff: "h-meta",
      reviewer_handoff: null,
      gate_status: "skipped",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: null,
      metadata_json: "{}",
    });
  });

  try {
    await laneCloseHandler(daemon)({
      lane_id: "lane-meta",
      gate_status: "skipped",
      metadata: { high_findings: 3, round_count: 2, notes: "clean pass" },
    });
    expect(callCount).toBe(1);
    expect((capturedBody as any).lane_id).toBe("lane-meta");
    expect((capturedBody as any).metadata).toEqual({
      high_findings: 3,
      round_count: 2,
      notes: "clean pass",
    });
  } finally {
    restore();
  }
});

test("lane_close round-trips through the live daemon contract and authorizes memory verify", async () => {
  const live = makeLiveDaemon();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = live.fetchImpl;

  try {
    const opened = await live.fetchImpl("http://daemon/lanes/open", {
      method: "POST",
      headers: {
        authorization: `Bearer ${live.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        lane_id: "lane-live",
        implementer_handoff: "h-live-impl",
        task_class: "STANDARD",
      }),
    });
    expect(opened.status).toBe(200);

    // The lane_close guardrail (added after this test, commit 2be61b5c) requires
    // both the lane's implementer_handoff and the reviewer_handoff to resolve to
    // known handoffs, with the reviewer agent differing from the implementer.
    // Seed both so the close exercises the real with-reviewer authorize path.
    const seedHandoff = (handoff_id: string, to: string) =>
      live.services.handoffWriter.createApproved({
        handoff_id,
        ts: "2026-05-12T00:00:00.000Z",
        project_id: null,
        conversation_id: "c-live",
        from: "user",
        to,
        to_role: null,
        message: "seed",
        triggered_by_event_id: `e-${handoff_id}`,
        resolved_by: "test",
        resolved_at: null,
        chain_max_hops: null,
        chain_trust_mode: null,
        chain_task_type: null,
        use_worktree: null,
        parent_handoff_id: null,
        branch_base: null,
      });
    seedHandoff("h-live-impl", "codex");
    seedHandoff("h-live-review", "gemini");

    const out = parseToolResult(
      await laneCloseHandler(live.daemon)({
        lane_id: "lane-live",
        gate_status: "passed",
        reviewer_handoff_id: "h-live-review",
      }),
    );

    expect(out).toMatchObject({
      lane_id: "lane-live",
      gate_status: "passed",
      implementer_handoff: "h-live-impl",
      reviewer_handoff: "h-live-review",
      ts_closed: "2026-05-12T00:00:00.000Z",
    });

    const recent = await live.fetchImpl("http://daemon/lanes/recent", {
      headers: { authorization: `Bearer ${live.token}` },
    });
    expect(recent.status).toBe(200);
    expect(await recent.json()).toMatchObject({
      lanes: [
        expect.objectContaining({
          lane_id: "lane-live",
          gate_status: "passed",
          implementer_handoff: "h-live-impl",
          reviewer_handoff: "h-live-review",
        }),
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    live.stop();
  }
});

test("lane_close omits metadata key when not provided", async () => {
  let capturedBody: unknown;
  let callCount = 0;
  const { daemon, restore } = makeDaemon(async (_input, init) => {
    callCount += 1;
    capturedBody = JSON.parse(String(init?.body));
    return Response.json({
      lane_id: "lane-nometa",
      ts_opened: "2026-05-12T00:00:00Z",
      ts_closed: "2026-05-12T00:00:00Z",
      task_class: "STANDARD",
      implementer_handoff: "h-nometa",
      reviewer_handoff: null,
      gate_status: "skipped",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: null,
      metadata_json: "{}",
    });
  });

  try {
    await laneCloseHandler(daemon)({ lane_id: "lane-nometa", gate_status: "skipped" });
    expect(callCount).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(capturedBody, "metadata")).toBe(false);
  } finally {
    restore();
  }
});

test("LaneCloseInputShape rejects unknown metadata keys at MCP boundary", () => {
  const schema = z.object(LaneCloseInputShape);
  const res = schema.safeParse({
    lane_id: "lane-1",
    gate_status: "passed",
    metadata: { invented_field: 1 },
  });
  expect(res.success).toBe(false);
});

test("lane_close without a reviewer returns the row and skips memory-verify authorization", async () => {
  const receivedPaths: string[] = [];
  const { daemon, restore } = makeDaemon(async (input) => {
    receivedPaths.push(new URL(String(input)).pathname);
    return Response.json({
      lane_id: "lane-noreviewer",
      ts_opened: "2026-05-12T00:00:00Z",
      ts_closed: "2026-05-12T00:00:00Z",
      task_class: "STANDARD",
      implementer_handoff: "h-impl",
      reviewer_handoff: null,
      gate_status: "passed",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: null,
      metadata_json: "{}",
    });
  });

  try {
    const out = parseToolResult(
      await laneCloseHandler(daemon)({ lane_id: "lane-noreviewer", gate_status: "passed" }),
    );
    expect(receivedPaths).toEqual(["/lanes/close"]);
    expect(out).toMatchObject({
      lane_id: "lane-noreviewer",
      gate_status: "passed",
      implementer_handoff: "h-impl",
      reviewer_handoff: null,
      memory_verify_authorization: "skipped_no_reviewer",
    });
  } finally {
    restore();
  }
});

test("lane_close authorizes memory verification on a failed close with a reviewer", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const { daemon, restore } = makeDaemon(async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (path === "/lanes/close") {
      return Response.json({
        lane_id: "lane-failed",
        ts_opened: "2026-05-12T00:00:00Z",
        ts_closed: "2026-05-12T00:00:00Z",
        task_class: "STANDARD",
        implementer_handoff: "h-impl",
        reviewer_handoff: "h-review",
        gate_status: "failed",
        recalled_memory_ids: [],
        recalled_query: null,
        override_reason: null,
        metadata_json: "{}",
      });
    }
    return Response.json({ ok: true, authorized: true, events_written: 1 });
  });

  try {
    await laneCloseHandler(daemon)({
      lane_id: "lane-failed",
      gate_status: "failed",
      reviewer_handoff_id: "h-review",
    });
    expect(calls.map((c) => c.path)).toEqual(["/lanes/close", "/memory-verify/authorize"]);
    expect(calls[1]!.body).toMatchObject({ handoff_id: "h-impl", verdict: "failed" });
  } finally {
    restore();
  }
});

test("lane_close never authorizes on a review_debt close", async () => {
  const receivedPaths: string[] = [];
  const { daemon, restore } = makeDaemon(async (input) => {
    receivedPaths.push(new URL(String(input)).pathname);
    return Response.json({
      lane_id: "lane-debt",
      ts_opened: "2026-05-12T00:00:00Z",
      ts_closed: "2026-05-12T00:00:00Z",
      task_class: "STANDARD",
      implementer_handoff: "h-impl",
      reviewer_handoff: "h-review",
      gate_status: "review_debt",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: null,
      metadata_json: "{}",
    });
  });

  try {
    await laneCloseHandler(daemon)({
      lane_id: "lane-debt",
      gate_status: "review_debt",
      reviewer_handoff_id: "h-review",
    });
    expect(receivedPaths).toEqual(["/lanes/close"]);
  } finally {
    restore();
  }
});

test("lane_close still rejects a passed close missing implementer_handoff", async () => {
  const { daemon, restore } = makeDaemon(async () =>
    Response.json({
      lane_id: "lane-malformed",
      gate_status: "passed",
      implementer_handoff: null,
      reviewer_handoff: null,
    }),
  );
  try {
    await expect(
      laneCloseHandler(daemon)({ lane_id: "lane-malformed", gate_status: "passed" }),
    ).rejects.toThrow("missing implementer_handoff");
  } finally {
    restore();
  }
});

test("lane_close round-trips a reviewer-less passed close through the live daemon", async () => {
  const live = makeLiveDaemon();
  const originalFetch = globalThis.fetch;
  // Record the handler-under-test's daemon traffic so the absence of the
  // authorize call is asserted, not assumed (the test's own setup calls go
  // through live.fetchImpl directly and bypass this recorder).
  const shimPaths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    shimPaths.push(new URL(String(input)).pathname);
    return live.fetchImpl(input, init);
  }) as typeof fetch;

  try {
    const opened = await live.fetchImpl("http://daemon/lanes/open", {
      method: "POST",
      headers: {
        authorization: `Bearer ${live.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        lane_id: "lane-live-noreviewer",
        implementer_handoff: "h-live-impl-2",
        task_class: "STANDARD",
      }),
    });
    expect(opened.status).toBe(200);

    const out = parseToolResult(
      await laneCloseHandler(live.daemon)({
        lane_id: "lane-live-noreviewer",
        gate_status: "passed",
      }),
    );

    expect(out).toMatchObject({
      lane_id: "lane-live-noreviewer",
      gate_status: "passed",
      implementer_handoff: "h-live-impl-2",
      reviewer_handoff: null,
    });
    expect(shimPaths).toEqual(["/lanes/close"]);

    const recent = await live.fetchImpl("http://daemon/lanes/recent", {
      headers: { authorization: `Bearer ${live.token}` },
    });
    expect(recent.status).toBe(200);
    const lanes = ((await recent.json()) as { lanes: Array<{ lane_id: string }> }).lanes;
    expect(lanes.find((l) => l.lane_id === "lane-live-noreviewer")).toMatchObject({
      gate_status: "passed",
      implementer_handoff: "h-live-impl-2",
      reviewer_handoff: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
    live.stop();
  }
});
