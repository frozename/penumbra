import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it, vi } from "bun:test";
import { PassThrough } from "node:stream";

import { createAcpWarmPool } from "@src/adapters/acp-warm-pool.js";
import type { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import type { StdioAcpHandle } from "@src/adapters/stdio-acp-server.js";
import { StdioAcpAdapter } from "@src/adapters/stdio-acp.js";
import type { DispatchInput } from "@src/sdk/adapter.js";

/**
 * #328: stdio-acp applies options.model through ACP session/set_model when the
 * agent advertises that model id in its session/new `models`. These cases pin
 * the request order, the no-op cases and the failure handling. All requests are
 * stubbed; the only timer case uses fake timers and waits on a recorded call.
 */

interface RecordedCall {
  method: string;
  params: unknown;
}

interface ServerHandleStub extends StdioAcpHandle {
  kill: () => void;
}

interface ClientStub {
  onRequest: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
}

type SetModelMode = "hang" | "ok" | "reject";

const ADVERTISED = {
  currentModelId: "p/default",
  availableModels: [{ modelId: "p/default" }, { modelId: "p/wanted" }],
};

const MODEL_KINDS = new Set([
  "acp.model_select_failed",
  "acp.model_selected",
  "acp.model_unavailable",
]);

// Single documented launder: StdioAcpClient is a nominal class with private
// fields, so the structural test double needs one `as unknown as`.
const asAcpClient = (stub: ClientStub): StdioAcpClient => stub as unknown as StdioAcpClient;

function makeServer(): ServerHandleStub {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    pid: 4242,
    kill: vi.fn(),
    exited: new Promise<number | null>(() => {
      /* never resolves: the server stays up for the whole dispatch */
    }),
    getStderrTail: (): string => "",
  };
}

function setModelResponse(mode: SetModelMode): Promise<unknown> {
  if (mode === "reject") return Promise.reject(new Error("set_model refused"));
  if (mode === "hang") {
    return new Promise<unknown>(() => {
      /* never settles: the boot deadline fires instead */
    });
  }
  return Promise.resolve({});
}

function makeRequest(
  calls: RecordedCall[],
  models: unknown,
  mode: SetModelMode = "ok",
): ReturnType<typeof vi.fn> {
  return vi.fn((method: string, params?: unknown): Promise<unknown> => {
    calls.push({ method, params });
    if (method === "initialize") return Promise.resolve({ protocolVersion: 1, authMethods: [] });
    if (method === "session/new") {
      return Promise.resolve(
        models === undefined ? { sessionId: "s1" } : { sessionId: "s1", models },
      );
    }
    if (method === "session/set_model") return setModelResponse(mode);
    if (method === "session/prompt") return Promise.resolve({ stopReason: "end_turn" });
    return Promise.resolve({});
  });
}

const dispatchInput = (prompt: string, events: DispatchEventInput[]): DispatchInput => ({
  prompt,
  conversation: { id: "c1", project_id: null },
  config: {},
  signal: new AbortController().signal,
  handoff_id: prompt,
  eventContext: { handoffId: prompt, workerId: "w1" },
  onEvent: (e): void => {
    events.push(e);
  },
});

function makeAdapter(
  model: string | undefined,
  request: ReturnType<typeof vi.fn>,
  server: ServerHandleStub,
): StdioAcpAdapter {
  return new StdioAcpAdapter(
    { binary: "mock-acp", model, bootTimeoutMs: 5_000 },
    {
      startServer: vi.fn().mockResolvedValue(server),
      createClient: (): StdioAcpClient => asAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
    },
  );
}

async function runOnce(
  model: string | undefined,
  models: unknown,
  mode: SetModelMode = "ok",
): Promise<{ calls: RecordedCall[]; events: DispatchEventInput[] }> {
  const calls: RecordedCall[] = [];
  const events: DispatchEventInput[] = [];
  const adapter = makeAdapter(model, makeRequest(calls, models, mode), makeServer());
  await adapter.dispatch(dispatchInput("do the task", events));
  return { calls, events };
}

const methodsOf = (calls: RecordedCall[]): string[] => calls.map((c) => c.method);

const kindsOf = (events: DispatchEventInput[], kind: string): DispatchEventInput[] =>
  events.filter((e) => e.kind === kind);

describe("StdioAcpAdapter options.model selection (#328)", () => {
  it("sends session/set_model after session/new and before the prompt when the agent advertises the model", async () => {
    const { calls, events } = await runOnce("p/wanted", ADVERTISED);
    expect(methodsOf(calls)).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    expect(calls[2]?.params).toEqual({ sessionId: "s1", modelId: "p/wanted" });
    const selected = kindsOf(events, "acp.model_selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.meta).toMatchObject({
      adapter: "stdio-acp",
      session_id: "s1",
      model: "p/wanted",
      set_model_sent: true,
    });
    expect(kindsOf(events, "acp.model_unavailable")).toHaveLength(0);
  });

  it("sends no session/set_model when the advertised current model already matches", async () => {
    const { calls, events } = await runOnce("p/wanted", {
      currentModelId: "p/wanted",
      availableModels: [{ modelId: "p/wanted" }],
    });
    expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/prompt"]);
    const selected = kindsOf(events, "acp.model_selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.meta).toMatchObject({ model: "p/wanted", set_model_sent: false });
  });

  it("records acp.model_unavailable without set_model when the agent advertises no models", async () => {
    const { calls, events } = await runOnce("p/wanted", undefined);
    expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/prompt"]);
    const unavailable = kindsOf(events, "acp.model_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.meta).toMatchObject({
      adapter: "stdio-acp",
      session_id: "s1",
      model: "p/wanted",
      advertised: false,
    });
    expect(kindsOf(events, "acp.model_selected")).toHaveLength(0);
  });

  it("records acp.model_unavailable with advertised true when the model is not listed", async () => {
    const { calls, events } = await runOnce("p/other", ADVERTISED);
    expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/prompt"]);
    const unavailable = kindsOf(events, "acp.model_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.meta).toMatchObject({ model: "p/other", advertised: true });
  });

  it("treats a malformed models field as not advertised", async () => {
    const { calls, events } = await runOnce("p/wanted", {
      currentModelId: "p/default",
      availableModels: "p/wanted",
    });
    expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/prompt"]);
    const unavailable = kindsOf(events, "acp.model_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.meta).toMatchObject({ advertised: false });
  });

  it("sends nothing extra and records no model event when options.model is unset", async () => {
    const { calls, events } = await runOnce(undefined, ADVERTISED);
    expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(events.filter((e) => MODEL_KINDS.has(e.kind))).toEqual([]);
  });

  it("still sends the prompt when session/set_model is rejected", async () => {
    const { calls, events } = await runOnce("p/wanted", ADVERTISED, "reject");
    expect(methodsOf(calls)).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    const failed = kindsOf(events, "acp.model_select_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.meta).toMatchObject({ session_id: "s1", model: "p/wanted" });
    expect(failed[0]?.meta?.error).toBe("Error: set_model refused");
    expect(kindsOf(events, "acp.model_selected")).toHaveLength(0);
  });

  it("selects the model again on each session of a warm-reused connection", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const calls: RecordedCall[] = [];
    const request = makeRequest(calls, ADVERTISED);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const mk = (): StdioAcpAdapter =>
      new StdioAcpAdapter(
        { binary: "mock-acp", model: "p/wanted", warmPool: true },
        {
          startServer,
          createClient: (): StdioAcpClient =>
            asAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
          pool,
        },
      );

    const events: DispatchEventInput[] = [];
    await mk().dispatch(dispatchInput("h1", events));
    await mk().dispatch(dispatchInput("h2", events));

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(methodsOf(calls)).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    expect(kindsOf(events, "acp.session.reuse")).toHaveLength(1);
    expect(kindsOf(events, "acp.model_selected")).toHaveLength(2);
  });

  it("fails the dispatch without a prompt when session/set_model outlives the boot deadline", async () => {
    vi.useFakeTimers();
    try {
      const calls: RecordedCall[] = [];
      const events: DispatchEventInput[] = [];
      const server = makeServer();
      const adapter = makeAdapter("p/wanted", makeRequest(calls, ADVERTISED, "hang"), server);
      const outcome = adapter.dispatch(dispatchInput("do the task", events)).then(
        (): string => "resolved",
        (err: unknown): string => String(err),
      );
      // Bounded wait on a condition: the set_model request (and its deadline timer) exists.
      for (let i = 0; i < 200 && !methodsOf(calls).includes("session/set_model"); i++) {
        await Promise.resolve();
      }
      expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/set_model"]);
      vi.advanceTimersByTime(5_000);
      expect(await outcome).toContain("boot timed out");
      expect(server.kill).toHaveBeenCalled();
      expect(methodsOf(calls)).not.toContain("session/prompt");
      expect(kindsOf(events, "acp.model_select_failed")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
