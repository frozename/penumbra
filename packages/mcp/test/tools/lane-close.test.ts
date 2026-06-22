import { buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { createDaemonFetchHandler } from "../../../daemon/src/serve.js";
import { DaemonClient } from "../../src/daemon-client.js";
import { laneCloseHandler, LaneCloseInputShape } from "../../src/tools/lane-close.js";
import { bodyAsString, type FetchHarness, installFetchMock, requestUrl } from "../helpers.js";

interface MockToolResult {
  content: { type: string; text: string }[];
}

function parseToolResult(out: unknown): unknown {
  const content = (out as MockToolResult).content;
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text);
}

interface LiveDaemonHarness {
  daemon: DaemonClient;
  services: ReturnType<typeof buildServices>;
  token: string;
  fetchImpl: (input: Request | URL | string, init?: RequestInit) => Promise<Response>;
  stop: () => void;
}

function makeLiveDaemon(): LiveDaemonHarness {
  try {
    if (process.platform === "darwin") {
      Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
    }
  } catch {
    // Custom SQLite override is best-effort; bun:sqlite's bundled lib is fine if homebrew is absent.
  }

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
    fetchImpl: async (input, init): Promise<Response> =>
      await handler(new Request(requestUrl(input), init)),
    stop: (): void => {
      try {
        services.supervisor.stopAll();
      } catch {
        // Supervisor may already be torn down; ignore so cleanup completes.
      }
      try {
        db.close();
      } catch {
        // Database close races with in-flight statements during teardown; ignore.
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function expectRejection(promise: Promise<unknown>, needle: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain(needle);
    return;
  }
  throw new Error(`expected promise to reject containing ${JSON.stringify(needle)}`);
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
  const { daemon, restore } = installFetchMock((input, init): Promise<Response> => {
    receivedMethod = init?.method;
    const receivedPath = new URL(requestUrl(input)).pathname;
    receivedPaths.push(receivedPath);
    receivedAuth = init?.headers
      ? (new Headers(init.headers).get("authorization") ?? undefined)
      : undefined;
    receivedBodies.push(JSON.parse(bodyAsString(init?.body)));
    if (receivedPath === "/lanes/close") {
      return Promise.resolve(
        Response.json({
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
        }),
      );
    }
    return Promise.resolve(Response.json({ ok: true, authorized: true, events_written: 1 }));
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
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const { daemon, restore } = installFetchMock((input, init): Promise<Response> => {
    const path = new URL(requestUrl(input)).pathname;
    const body = JSON.parse(bodyAsString(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (path === "/lanes/close") {
      return Promise.resolve(
        Response.json({
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
        }),
      );
    }
    if (path === "/memory-verify/authorize") {
      return Promise.resolve(Response.json({ ok: true, authorized: true, events_written: 2 }));
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
  const { daemon, restore } = installFetchMock(
    (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "validation_failed" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
  );
  try {
    await expectRejection(
      laneCloseHandler(daemon)({ lane_id: "lane-1234", gate_status: "failed" }),
      "daemon /lanes/close: HTTP 400",
    );
  } finally {
    restore();
  }
});

interface LaneCloseRequestBody {
  lane_id: string;
  metadata?: { high_findings?: number; round_count?: number; notes?: string };
}

test("lane_close forwards metadata to daemon POST body", async () => {
  let capturedBody: LaneCloseRequestBody | undefined;
  let callCount = 0;
  const { daemon, restore } = installFetchMock((_input, init): Promise<Response> => {
    callCount += 1;
    capturedBody = JSON.parse(bodyAsString(init?.body)) as LaneCloseRequestBody;
    return Promise.resolve(
      Response.json({
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
      }),
    );
  });

  try {
    await laneCloseHandler(daemon)({
      lane_id: "lane-meta",
      gate_status: "skipped",
      metadata: { high_findings: 3, round_count: 2, notes: "clean pass" },
    });
    expect(callCount).toBe(1);
    expect(capturedBody?.lane_id).toBe("lane-meta");
    expect(capturedBody?.metadata).toEqual({
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
    const seedHandoff = (handoff_id: string, to: string): void => {
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
    };
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
  let capturedBody: Record<string, unknown> | undefined;
  let callCount = 0;
  const { daemon, restore } = installFetchMock((_input, init): Promise<Response> => {
    callCount += 1;
    capturedBody = JSON.parse(bodyAsString(init?.body)) as Record<string, unknown>;
    return Promise.resolve(
      Response.json({
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
      }),
    );
  });

  try {
    await laneCloseHandler(daemon)({ lane_id: "lane-nometa", gate_status: "skipped" });
    expect(callCount).toBe(1);
    expect(
      capturedBody !== undefined && Object.prototype.hasOwnProperty.call(capturedBody, "metadata"),
    ).toBe(false);
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
  const { daemon, restore } = installFetchMock((input): Promise<Response> => {
    receivedPaths.push(new URL(requestUrl(input)).pathname);
    return Promise.resolve(
      Response.json({
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
      }),
    );
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
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const { daemon, restore } = installFetchMock((input, init): Promise<Response> => {
    const path = new URL(requestUrl(input)).pathname;
    calls.push({ path, body: JSON.parse(bodyAsString(init?.body)) as Record<string, unknown> });
    if (path === "/lanes/close") {
      return Promise.resolve(
        Response.json({
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
        }),
      );
    }
    return Promise.resolve(Response.json({ ok: true, authorized: true, events_written: 1 }));
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
  const { daemon, restore } = installFetchMock((input): Promise<Response> => {
    receivedPaths.push(new URL(requestUrl(input)).pathname);
    return Promise.resolve(
      Response.json({
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
      }),
    );
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
  const { daemon, restore } = installFetchMock(
    (): Promise<Response> =>
      Promise.resolve(
        Response.json({
          lane_id: "lane-malformed",
          gate_status: "passed",
          implementer_handoff: null,
          reviewer_handoff: null,
        }),
      ),
  );
  try {
    await expectRejection(
      laneCloseHandler(daemon)({ lane_id: "lane-malformed", gate_status: "passed" }),
      "missing implementer_handoff",
    );
  } finally {
    restore();
  }
});

test("lane_close still returns the persisted close response when memory-verify authorize fails", async () => {
  const receivedPaths: string[] = [];
  const { daemon, restore }: FetchHarness = installFetchMock((input): Promise<Response> => {
    const path = new URL(requestUrl(input)).pathname;
    receivedPaths.push(path);
    if (path === "/lanes/close") {
      return Promise.resolve(
        Response.json({
          lane_id: "lane-authfail",
          ts_opened: "2026-05-12T00:00:00Z",
          ts_closed: "2026-05-12T00:00:00Z",
          task_class: "STANDARD",
          implementer_handoff: "h-impl",
          reviewer_handoff: "h-review",
          gate_status: "passed",
          recalled_memory_ids: [],
          recalled_query: null,
          override_reason: null,
          metadata_json: "{}",
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: "internal" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  try {
    const out = parseToolResult(
      await laneCloseHandler(daemon)({
        lane_id: "lane-authfail",
        gate_status: "passed",
        reviewer_handoff_id: "h-review",
      }),
    );
    expect(receivedPaths).toEqual(["/lanes/close", "/memory-verify/authorize"]);
    expect(out).toMatchObject({
      lane_id: "lane-authfail",
      gate_status: "passed",
      implementer_handoff: "h-impl",
      reviewer_handoff: "h-review",
      memory_verify_authorization: "authorize_failed",
    });
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
  globalThis.fetch = async (input, init): Promise<Response> => {
    shimPaths.push(new URL(requestUrl(input)).pathname);
    return await live.fetchImpl(input, init);
  };

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
    const lanes = ((await recent.json()) as { lanes: { lane_id: string }[] }).lanes;
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
