import { buildServices, loadSqliteVec, migrate, type Services, type T0Event } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PenumbraClient, PenumbraHttpError, isTerminalHttpStatus } from "../src/penumbra-client.js";
import { serviceTest } from "./helpers/service-gates.js";

// Test-only typed fetch shape: agentchat constructs Request objects from
// (input, init), so the mock fetch sees the same arg shape the daemon proxy uses.
type FetchImpl = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

function toRequest(input: Request | URL | string, init?: RequestInit): Request {
  if (input instanceof Request) return input;
  return new Request(input instanceof URL ? input.toString() : input, init);
}

interface CapturedRequest {
  body: unknown;
  auth: string | null;
}

interface ListedHandoffRow {
  handoff_id: string;
}

async function expectRejection(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(message).toMatch(matcher);
}

test("observe POSTs /observations with bearer token", async () => {
  let received: CapturedRequest | null = null;
  const fetchImpl: FetchImpl = async (input, init) => {
    const req = toRequest(input, init);
    received = { auth: req.headers.get("authorization"), body: await req.json() };
    return Response.json({ event_id: "e" });
  };
  const root = mkdtempSync(join(tmpdir(), "pen-client-"));
  writeFileSync(join(root, "port"), `1\n`);
  writeFileSync(join(root, "token"), "tk\n");

  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
  await client.observe({
    ts: "2026-04-25T20:00:00Z",
    source: "mcp",
    event_type: "agent-prompt",
    lane: "unknown",
    payload_json: {},
    user_id: "u",
    machine_id: "m",
  });
  expect(received).not.toBeNull();
  // Narrow once for the asserted shape — the captured value is overwritten inside fetchImpl.
  const captured = received as CapturedRequest | null;
  expect(captured?.auth).toBe("Bearer tk");
});

test("createHandoff POSTs /handoffs and returns the new id", async () => {
  const fetchImpl: FetchImpl = () =>
    Promise.resolve(Response.json({ handoff_id: "h-1", status: "pending" }));
  const root = mkdtempSync(join(tmpdir(), "pen-client-"));
  writeFileSync(join(root, "port"), `1\n`);
  writeFileSync(join(root, "token"), "tk\n");

  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
  const r = await client.createHandoff({
    from: "claude",
    to: "gemini",
    message: "go",
    conversation_id: "c-1",
    project_id: null,
    triggered_by_event_id: "e-1",
  });
  expect(r.handoff_id).toBe("h-1");
  expect(r.status).toBe("pending");
});

test("PenumbraHttpError keeps a stable message and exposes daemon details separately", async () => {
  const errorBody = {
    error: { code: "unknown_agent" },
    field_errors: [{ path: ["to"], message: "unknown agent: penumbra" }],
  };
  const fetchImpl: FetchImpl = () => Promise.resolve(Response.json(errorBody, { status: 400 }));
  const root = mkdtempSync(join(tmpdir(), "pen-client-"));
  writeFileSync(join(root, "port"), `1\n`);
  writeFileSync(join(root, "token"), "tk\n");
  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });

  let caught: unknown;
  try {
    await client.createHandoff({
      from: "reviewer",
      to: "penumbra",
      message: "go",
      conversation_id: "c-1",
      project_id: null,
      triggered_by_event_id: "e-1",
    });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(PenumbraHttpError);
  if (!(caught instanceof PenumbraHttpError)) throw new Error("expected PenumbraHttpError");
  expect(caught.status).toBe(400);
  expect(caught.body).toEqual(errorBody);
  expect(caught.code).toBe("unknown_agent");
  expect(caught.bodyText).toContain("unknown_agent");
  expect(caught.bodyText).toContain("field_errors");
  expect(caught.message).toBe("penumbra /handoffs: HTTP 400 code=unknown_agent");
  rmSync(root, { recursive: true, force: true });
});

test("PenumbraHttpError bodyText is truncated", () => {
  const err = new PenumbraHttpError("penumbra /x: HTTP 400", 400, {
    error: { code: "too_much" },
    details: "x".repeat(3_000),
  });

  expect(err.code).toBe("too_much");
  expect(err.bodyText.length).toBeLessThanOrEqual(2_048);
  expect(err.message).toBe("penumbra /x: HTTP 400 code=too_much");
});

test("terminal HTTP status classification distinguishes contained from retryable statuses", () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    expect(isTerminalHttpStatus(status)).toBe(true);
  }
  for (const status of [408, 429, 500, 503]) {
    expect(isTerminalHttpStatus(status)).toBe(false);
  }
});

test("captureAgentPerformanceFromDispatch sends final response summary fields", async () => {
  let received: unknown = null;
  const fetchImpl: FetchImpl = async (input, init) => {
    const req = toRequest(input, init);
    const url = new URL(req.url).pathname;
    if (url === "/worker/register") {
      return Response.json({ worker_token: "wt-final", worker_id: "W-A" });
    }
    received = await req.json();
    return Response.json({
      performance: {
        outcome: "completed_with_output",
        notes: null,
        metadata_json: "{}",
        task_type: "review_adversarial",
      },
    });
  };
  const root = mkdtempSync(join(tmpdir(), "pen-client-"));
  writeFileSync(join(root, "port"), `1\n`);
  writeFileSync(join(root, "token"), "tk\n");

  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
  await client.registerWorker({ worker_id: "W-A" });
  await client.captureAgentPerformanceFromDispatch({
    handoff_id: "h-final",
    reason: "completed",
    final_response_chars: 22,
    has_meaningful_output: false,
  });

  expect(received).toEqual(
    expect.objectContaining({
      handoff_id: "h-final",
      reason: "completed",
      final_response_chars: 22,
      has_meaningful_output: false,
    }),
  );
  rmSync(root, { recursive: true, force: true });
});

interface LocalDaemon {
  client: PenumbraClient;
  services: Services;
  stop: () => void;
  storageRoot: string;
  fetchImpl: typeof fetch;
}

function withDaemon(): LocalDaemon {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-cli-"));
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: dir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: () => `id-${String(++n)}`,
  });
  services.agentRegistry = ["planner", "executor", "a", "b", "claude-mem"];
  services.watchdog.hasActiveWorker = (): boolean => true;
  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return await handler(req);
  }) as typeof fetch;
  writeFileSync(join(dir, "port"), "1");
  writeFileSync(join(dir, "token"), "tok");
  return {
    client: new PenumbraClient({ storageRoot: dir, fetch: fetchImpl }),
    services,
    storageRoot: dir,
    fetchImpl,
    stop(): void {
      try {
        services.supervisor.stopAll();
      } catch {
        // best-effort: shutdown errors during test teardown are non-fatal
      }
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

serviceTest("PenumbraClient.startChain calls /chains/start", async () => {
  const { client, services, stop } = withDaemon();
  try {
    const res = await client.startChain({
      initial_agent: "planner",
      message: "hi",
      max_hops: 5,
      trust_mode: "all",
    });
    expect(typeof res.conversation_id).toBe("string");
    expect(typeof res.handoff_id).toBe("string");
    const row = services.db
      .query<{ status: string }, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
      .get(res.handoff_id);
    expect(row?.status).toBe("approved");
  } finally {
    stop();
  }
});

serviceTest(
  "PenumbraClient.claimHandoff returns 200 on success and rejects on conflict",
  async () => {
    const { client, stop, storageRoot, fetchImpl } = withDaemon();
    try {
      await client.registerWorker({ worker_id: "w1" });
      const worker2 = new PenumbraClient({ storageRoot, fetch: fetchImpl });
      await worker2.registerWorker({ worker_id: "w2" });
      const start = await client.startChain({ initial_agent: "planner", message: "hi" });
      const claim = await client.claimHandoff(start.handoff_id, "w1");
      expect(claim.status).toBe("dispatched");
      await expectRejection(worker2.claimHandoff(start.handoff_id, "w2"), /409|conflict/i);
    } finally {
      stop();
    }
  },
);

serviceTest("PenumbraClient.completeHandoff flips dispatched → completed", async () => {
  const { client, services, stop } = withDaemon();
  try {
    await client.registerWorker({ worker_id: "w1" });
    const start = await client.startChain({ initial_agent: "planner", message: "hi" });
    await client.claimHandoff(start.handoff_id, "w1");
    const res = await client.completeHandoff(start.handoff_id);
    expect(res.status).toBe("completed");
    const row = services.db
      .query<{ status: string }, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`)
      .get(start.handoff_id);
    expect(row?.status).toBe("completed");
  } finally {
    stop();
  }
});

serviceTest("PenumbraClient.markFailed flips dispatched → failed", async () => {
  const { client, services, stop } = withDaemon();
  try {
    await client.registerWorker({ worker_id: "w1" });
    const start = await client.startChain({ initial_agent: "planner", message: "hi" });
    await client.claimHandoff(start.handoff_id, "w1");
    const res = await client.markFailed(start.handoff_id, "adapter blew up");
    expect(res.status).toBe("failed");
    const row = services.db
      .query<
        { status: string; resolution_reason: string | null },
        [string]
      >(`SELECT status, resolution_reason FROM handoffs WHERE handoff_id=?`)
      .get(start.handoff_id);
    expect(row?.status).toBe("failed");
    expect(row?.resolution_reason).toBe("adapter blew up");
  } finally {
    stop();
  }
});

serviceTest("PenumbraClient.postDispatchEvents posts best-effort event batches", async () => {
  const { client, services, stop } = withDaemon();
  try {
    await client.postDispatchEvents([
      {
        handoff_id: "h-events",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-05-01T00:00:00.000Z",
      },
    ]);
    expect(services.dispatchEventLog.listByHandoff("h-events")).toHaveLength(1);
  } finally {
    stop();
  }
});

test("PenumbraClient.postDispatchEvents threads AbortSignal to fetch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pen-client-signal-"));
  writeFileSync(join(root, "port"), "1\n");
  writeFileSync(join(root, "token"), "tk\n");
  try {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl: FetchImpl = (_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.resolve(Response.json({}));
    };

    const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
    const externalController = new AbortController();
    await client.postDispatchEvents(
      [
        {
          handoff_id: "h-sig",
          source: "worker",
          kind: "dispatch.start",
          ts: "2026-05-01T00:00:00.000Z",
        },
      ],
      externalController.signal,
    );

    expect(capturedSignal).toBe(externalController.signal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

serviceTest(
  "PenumbraClient.listHandoffs(status=approved,dispatched) returns matching rows",
  async () => {
    const { client, stop } = withDaemon();
    try {
      await client.registerWorker({ worker_id: "w1" });
      const a = await client.startChain({ initial_agent: "planner", message: "hi 1" });
      const b = await client.startChain({ initial_agent: "planner", message: "hi 2" });
      await client.claimHandoff(a.handoff_id, "w1");
      const r = await client.listHandoffs({ statuses: ["approved", "dispatched"] });
      const ids = (r.handoffs as ListedHandoffRow[]).map((h) => h.handoff_id).sort();
      expect(ids).toEqual([a.handoff_id, b.handoff_id].sort());
    } finally {
      stop();
    }
  },
);

test("PenumbraClient.listHandoffs encodes global project scope as project_scope=global", async () => {
  const root = mkdtempSync(join(tmpdir(), "pen-client-list-null-"));
  writeFileSync(join(root, "port"), "1");
  writeFileSync(join(root, "token"), "tk\n");
  try {
    let capturedUrl = "";
    const fetchImpl: FetchImpl = (input) => {
      const req = toRequest(input);
      capturedUrl = req.url;
      return Promise.resolve(Response.json({ handoffs: [] }));
    };

    const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
    await client.listHandoffs({ statuses: ["approved"], project_scope: "global" });

    const url = new URL(capturedUrl);
    expect(url.pathname).toBe("/handoffs");
    expect(url.searchParams.get("status")).toBe("approved");
    expect(url.searchParams.get("project_scope")).toBe("global");
    expect(url.searchParams.has("project_id")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PenumbraClient.listHandoffs preserves encoding for project_id string", async () => {
  const root = mkdtempSync(join(tmpdir(), "pen-client-list-enc-"));
  writeFileSync(join(root, "port"), "1");
  writeFileSync(join(root, "token"), "tk\n");
  try {
    let capturedUrl = "";
    const fetchImpl: FetchImpl = (input) => {
      const req = toRequest(input);
      capturedUrl = req.url;
      return Promise.resolve(Response.json({ handoffs: [] }));
    };

    const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
    await client.listHandoffs({ statuses: ["approved"], project_id: "proj/alpha one" });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("status")).toBe("approved");
    expect(url.searchParams.get("project_id")).toBe("proj/alpha one");
    expect(url.search).toContain("proj%2Falpha");
    expect(url.search).toMatch(/(%20|\+)one/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

serviceTest("PenumbraClient.subscribeHandoffEvents yields each approved handoff", async () => {
  const { client, stop } = withDaemon();
  try {
    const it = client.subscribeHandoffEvents();
    const iterator = it[Symbol.asyncIterator]();
    // `iterator.next()` types its return as `IteratorResult<T, any>`, so cast
    // through the void-return shape to keep `event.value` strictly typed.
    type HandoffSseEvent = { handoff_id?: string };
    type HandoffNextResult = IteratorResult<HandoffSseEvent, void>;
    const first = iterator.next() as unknown as Promise<HandoffNextResult>;
    const start = await client.startChain({ initial_agent: "planner", message: "hi" });
    const timeout: HandoffNextResult = { value: undefined, done: true };
    const event = await Promise.race<HandoffNextResult>([
      first,
      new Promise<HandoffNextResult>((r) => {
        setTimeout(() => {
          r(timeout);
        }, 1000);
      }),
    ]);
    expect(event.value).toBeDefined();
    const handoffEvent = event.value;
    if (handoffEvent === undefined) {
      throw new Error("subscribeHandoffEvents yielded no event before timeout");
    }
    expect(handoffEvent.handoff_id).toBe(start.handoff_id);
    await iterator.return?.();
  } finally {
    stop();
  }
});

serviceTest("PenumbraClient prefers an explicit storageRoot over autodiscovery", async () => {
  const { stop, storageRoot, fetchImpl } = withDaemon();
  try {
    const oldEnv = process.env.PENUMBRA_STORAGE_ROOT;
    process.env.PENUMBRA_STORAGE_ROOT = "/bogus/path/that/does/not/exist";
    const client = new PenumbraClient({ storageRoot, fetch: fetchImpl });
    const res = await client.observe({
      ts: "2026-04-25T20:00:00Z",
      source: "mcp",
      event_type: "agent-prompt",
      lane: "unknown",
      payload_json: {},
      user_id: "u",
      machine_id: "m",
    });
    expect(res.event_id).toBeDefined();
    if (oldEnv === undefined) {
      delete process.env.PENUMBRA_STORAGE_ROOT;
    } else {
      process.env.PENUMBRA_STORAGE_ROOT = oldEnv;
    }
  } finally {
    stop();
  }
});

serviceTest(
  "PenumbraClient auto-discovers a running daemon when ~/.penumbra is empty",
  async () => {
    const { stop, storageRoot, fetchImpl } = withDaemon();
    try {
      const oldEnv = process.env.PENUMBRA_STORAGE_ROOT;
      process.env.PENUMBRA_STORAGE_ROOT = storageRoot;
      const client = new PenumbraClient({ fetch: fetchImpl });
      const res = await client.observe({
        ts: "2026-04-25T20:00:00Z",
        source: "mcp",
        event_type: "agent-prompt",
        lane: "unknown",
        payload_json: {},
        user_id: "u",
        machine_id: "m",
      });
      expect(res.event_id).toBeDefined();
      if (oldEnv === undefined) {
        delete process.env.PENUMBRA_STORAGE_ROOT;
      } else {
        process.env.PENUMBRA_STORAGE_ROOT = oldEnv;
      }
    } finally {
      stop();
    }
  },
);

test("PenumbraClient.resolve() throws clear error when explicit storageRoot is bogus", async () => {
  const client = new PenumbraClient({ storageRoot: "/path/that/does/not/exist" });
  await expectRejection(
    client.observe({
      ts: "2026-04-25T20:00:00Z",
      source: "mcp",
      event_type: "agent-prompt",
      lane: "unknown",
      payload_json: {},
      user_id: "u",
      machine_id: "m",
    }),
    /penumbra not running at \/path\/that\/does\/not\/exist \(missing port\/token\)/,
  );
});

serviceTest("PenumbraClient.getHandoffStatus reads reliability status", async () => {
  const { client, services, stop } = withDaemon();
  try {
    await client.registerWorker({ worker_id: "w1" });
    const start = await client.startChain({ initial_agent: "planner", message: "hi" });
    await client.claimHandoff(start.handoff_id, "w1");
    services.dispatchEventLog.record({
      handoff_id: start.handoff_id,
      source: "worker",
      kind: "dispatch.start",
      ts: "2026-05-01T00:00:01.000Z",
    });

    const status = await client.getHandoffStatus(start.handoff_id);

    expect(status.handoff_id).toBe(start.handoff_id);
    expect(status.status).toBe("dispatched");
    expect(status.reliability.status).toBeDefined();
  } finally {
    stop();
  }
});

serviceTest("PenumbraClient.getChainResponses reads final responses", async () => {
  const { client, services, stop } = withDaemon();
  try {
    const event: T0Event = {
      ts: "2026-05-01T00:00:00.000Z",
      ingest_ts: "2026-05-01T00:00:00.000Z",
      event_id: "ev-client-responses",
      source: "agentchat",
      source_detail: null,
      event_type: "agent-response",
      lane: "cli-subscription",
      session_id: "conv-client-responses",
      project_id: null,
      user_id: "agent-a",
      machine_id: "local",
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: null,
      payload_json: { response: "HELLO" },
      payload_summary: "HELLO",
      origin: null,
    };
    services.t0Writer.write(event);

    const responses = await client.getChainResponses("conv-client-responses", "all");

    expect(responses.responses).toHaveLength(1);
    const first = responses.responses[0];
    expect(first?.agent).toBe("agent-a");
    expect(first?.text).toBe("HELLO");
  } finally {
    stop();
  }
});

test("PenumbraClient dispatch and worktree read methods call daemon routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pen-client-read-"));
  writeFileSync(join(root, "port"), "1\n");
  writeFileSync(join(root, "token"), "tk\n");
  try {
    const seen: string[] = [];
    const fetchImpl: FetchImpl = (input, init) => {
      const req = toRequest(input, init);
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.url.includes("/dispatch/events"))
        return Promise.resolve(Response.json({ events: [{ kind: "dispatch.start" }] }));
      if (req.url.includes("/dispatch/audit"))
        return Promise.resolve(
          Response.json({ report: { status: "complete", trustworthy: true } }),
        );
      if (req.url.includes("/worktrees/"))
        return Promise.resolve(
          Response.json({
            worktree: { path: "/tmp/wt" },
            diff_against_main: "",
            branch_log: "",
          }),
        );
      return Promise.resolve(Response.json({}));
    };
    const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });

    await client.getDispatchTimeline("h-1");
    await client.dispatchAudit("h-1");
    await client.inspectWorktree("h-1");
    await client.grepInWorktree("h-1", {
      pattern: "ACP_WRITE_OK",
      path: "acp-promotion-smoke.txt",
      output_mode: "content",
      max_results: 1,
    });

    expect(seen).toEqual([
      "GET /dispatch/events?handoff_id=h-1",
      "GET /dispatch/audit?handoff_id=h-1",
      "GET /worktrees/h-1",
      "POST /worktrees/h-1/grep",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PenumbraClient.chainWait terminal status", () => {
  function makeChainWaitFetch(terminalRows: { status: string }[]): FetchImpl {
    return (input, init) => {
      const req = toRequest(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/handoffs") {
        const status = url.searchParams.get("status") ?? "";
        const requested = status.split(",");
        const isActive = requested.some((s) =>
          ["pending", "approved", "redirected", "dispatched"].includes(s),
        );
        if (isActive) return Promise.resolve(Response.json({ handoffs: [] }));
        return Promise.resolve(Response.json({ handoffs: terminalRows }));
      }
      return Promise.resolve(Response.json({}));
    };
  }

  test("reports failed when a work hop failed even if a completed row is last by creation order", async () => {
    const root = mkdtempSync(join(tmpdir(), "pen-chainwait-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "tk\n");
    try {
      const client = new PenumbraClient({
        storageRoot: root,
        // creation-ordered rows: failed first, then completed.
        // Old at(-1) logic would report "completed"; resolution-order truth is "failed".
        fetch: makeChainWaitFetch([{ status: "failed" }, { status: "completed" }]) as typeof fetch,
      });
      const result = await client.chainWait({ conversation_id: "c-1", timeout_ms: 1_000 });
      expect(result.status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports completed when at least one row is completed and no row failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "pen-chainwait-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "tk\n");
    try {
      const client = new PenumbraClient({
        storageRoot: root,
        fetch: makeChainWaitFetch([
          { status: "completed" },
          { status: "completed" },
        ]) as typeof fetch,
      });
      const result = await client.chainWait({ conversation_id: "c-2", timeout_ms: 1_000 });
      expect(result.status).toBe("completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports failed when no terminal row is completed", async () => {
    const root = mkdtempSync(join(tmpdir(), "pen-chainwait-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "tk\n");
    try {
      const client = new PenumbraClient({
        storageRoot: root,
        fetch: makeChainWaitFetch([{ status: "rejected" }, { status: "expired" }]) as typeof fetch,
      });
      const result = await client.chainWait({ conversation_id: "c-3", timeout_ms: 1_000 });
      expect(result.status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("PenumbraClient permission methods", () => {
  test("createPermission posts the body and returns the response", async () => {
    const root = mkdtempSync(join(tmpdir(), "pen-perm-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "tk\n");
    try {
      let capturedUrl = "";
      let capturedMethod = "";
      const fetchImpl: FetchImpl = (input, init) => {
        const req = toRequest(input, init);
        capturedUrl = req.url;
        capturedMethod = req.method;
        return Promise.resolve(
          Response.json({ permission_id: "p-1", status: "pending", ttl_at: "t" }),
        );
      };
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
      const out = await client.createPermission({
        permission_id: "p-1",
        parent_handoff_id: "h-1",
        conversation_id: "c",
        agent_name: "a",
        tool_name: "t",
        raw_input: {},
        ttl_seconds: 60,
      });
      expect(out).toEqual({ permission_id: "p-1", status: "pending", ttl_at: "t" });
      expect(capturedUrl).toBe("http://127.0.0.1:1/permissions");
      expect(capturedMethod).toBe("POST");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("getPermission fetches and returns the row", async () => {
    const root = mkdtempSync(join(tmpdir(), "pen-perm-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "tk\n");
    try {
      let capturedUrl = "";
      const fetchImpl: FetchImpl = (input, init) => {
        const req = toRequest(input, init);
        capturedUrl = req.url;
        return Promise.resolve(
          Response.json({
            permission: {
              permission_id: "p-1",
              status: "pending",
              parent_handoff_id: "h-1",
              conversation_id: "c",
              agent_name: "a",
              tool_name: "t",
              raw_input_json: "{}",
              remember_scope: null,
              decision_reason: null,
              decided_by: null,
              ttl_at: "t",
              created_at: "t",
              decided_at: null,
            },
          }),
        );
      };
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
      const out = await client.getPermission("p-1");
      expect(out.permission.permission_id).toBe("p-1");
      expect(capturedUrl).toBe("http://127.0.0.1:1/permissions/p-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("decidePermission posts decide body", async () => {
    const root = mkdtempSync(join(tmpdir(), "pen-perm-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "tk\n");
    try {
      let capturedUrl = "";
      let capturedMethod = "";
      const fetchImpl: FetchImpl = (input, init) => {
        const req = toRequest(input, init);
        capturedUrl = req.url;
        capturedMethod = req.method;
        return Promise.resolve(
          Response.json({ permission_id: "p-1", status: "approved", decided_at: "t" }),
        );
      };
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
      const out = await client.decidePermission("p-1", {
        decision: "approve",
        remember: "this_dispatch",
      });
      expect(out.status).toBe("approved");
      expect(capturedUrl).toBe("http://127.0.0.1:1/permissions/p-1/decide");
      expect(capturedMethod).toBe("POST");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("listPermissions composes status + conversation_id + parent_handoff_id query params", async () => {
    const root = mkdtempSync(join(tmpdir(), "pen-perm-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "tk\n");
    try {
      let capturedUrl = "";
      const fetchImpl: FetchImpl = (input, init) => {
        const req = toRequest(input, init);
        capturedUrl = req.url;
        return Promise.resolve(Response.json({ permissions: [] }));
      };
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
      await client.listPermissions({
        status: "pending,approved",
        conversation_id: "c-1",
        parent_handoff_id: "h-1",
      });
      expect(capturedUrl).toContain("/permissions?");
      expect(capturedUrl).toContain("status=pending%2Capproved");
      expect(capturedUrl).toContain("conversation_id=c-1");
      expect(capturedUrl).toContain("parent_handoff_id=h-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("listPermissions with no opts hits /permissions without a query string", async () => {
    const root = mkdtempSync(join(tmpdir(), "pen-perm-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "tk\n");
    try {
      let capturedUrl = "";
      const fetchImpl: FetchImpl = (input, init) => {
        const req = toRequest(input, init);
        capturedUrl = req.url;
        return Promise.resolve(Response.json({ permissions: [] }));
      };
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl as typeof fetch });
      await client.listPermissions();
      expect(capturedUrl).toBe("http://127.0.0.1:1/permissions");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
