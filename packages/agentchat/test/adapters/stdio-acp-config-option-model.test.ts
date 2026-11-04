import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it, vi } from "bun:test";
import { PassThrough } from "node:stream";

import type { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import type { StdioAcpHandle } from "@src/adapters/stdio-acp-server.js";
import { StdioAcpAdapter } from "@src/adapters/stdio-acp.js";
import type { DispatchInput } from "@src/sdk/adapter.js";

/**
 * #328: stdio-acp applies options.model through ACP session/set_config_option when
 * the agent advertises a "model" config option instead of (or alongside) the
 * session/new `models` list. These cases pin the request order, the precedence
 * between the two selection mechanisms, grouped option lookup and rejection
 * handling. All requests are stubbed; the only fake ACP peer is client.request.
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

type SetConfigOptionMode = "ok" | "reject";

interface SessionNewFixture {
  models?: unknown;
  configOptions?: unknown;
}

const ADVERTISED = {
  currentModelId: "p/default",
  availableModels: [{ modelId: "p/default" }, { modelId: "p/wanted" }],
};

const MODEL_OPT = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "p/default",
  options: [
    { value: "p/default", name: "d" },
    { value: "p/wanted", name: "w" },
  ],
};

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

function makeRequest(
  calls: RecordedCall[],
  session: SessionNewFixture,
  mode: SetConfigOptionMode = "ok",
): ReturnType<typeof vi.fn> {
  return vi.fn((method: string, params?: unknown): Promise<unknown> => {
    calls.push({ method, params });
    if (method === "initialize") return Promise.resolve({ protocolVersion: 1, authMethods: [] });
    if (method === "session/new") {
      return Promise.resolve({
        sessionId: "s1",
        ...(session.models ? { models: session.models } : {}),
        ...(session.configOptions ? { configOptions: session.configOptions } : {}),
      });
    }
    if (method === "session/set_config_option") {
      return mode === "reject"
        ? Promise.reject(new Error("set_config_option refused"))
        : Promise.resolve({});
    }
    if (method === "session/set_model") return Promise.resolve({});
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
  session: SessionNewFixture,
  mode: SetConfigOptionMode = "ok",
): Promise<{ calls: RecordedCall[]; events: DispatchEventInput[] }> {
  const calls: RecordedCall[] = [];
  const events: DispatchEventInput[] = [];
  const adapter = makeAdapter(model, makeRequest(calls, session, mode), makeServer());
  await adapter.dispatch(dispatchInput("do the task", events));
  return { calls, events };
}

const methodsOf = (calls: RecordedCall[]): string[] => calls.map((c) => c.method);

const kindsOf = (events: DispatchEventInput[], kind: string): DispatchEventInput[] =>
  events.filter((e) => e.kind === kind);

describe("StdioAcpAdapter options.model via session/set_config_option (#328)", () => {
  it("sends session/set_config_option after session/new and before the prompt when a model config option lists the model", async () => {
    const { calls, events } = await runOnce("p/wanted", { configOptions: [MODEL_OPT] });
    expect(methodsOf(calls)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(calls[2]?.params).toEqual({ sessionId: "s1", configId: "model", value: "p/wanted" });
    const selected = kindsOf(events, "acp.model_selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.meta).toMatchObject({
      adapter: "stdio-acp",
      session_id: "s1",
      model: "p/wanted",
      set_model_sent: true,
      via: "session/set_config_option",
    });
    expect(kindsOf(events, "acp.model_unavailable")).toHaveLength(0);
  });

  it("sends no set_config_option when the advertised current value already matches", async () => {
    const { calls, events } = await runOnce("p/wanted", {
      configOptions: [{ ...MODEL_OPT, currentValue: "p/wanted" }],
    });
    expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/prompt"]);
    const selected = kindsOf(events, "acp.model_selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.meta).toMatchObject({ model: "p/wanted", set_model_sent: false });
  });

  it("sends session/set_config_option when the value is nested in grouped options", async () => {
    const { calls } = await runOnce("p/wanted", {
      configOptions: [
        {
          ...MODEL_OPT,
          options: [
            {
              group: "g1",
              name: "G",
              options: [
                { value: "p/default", name: "d" },
                { value: "p/wanted", name: "w" },
              ],
            },
          ],
        },
      ],
    });
    const setConfigOption = calls.filter((c) => c.method === "session/set_config_option");
    expect(setConfigOption).toHaveLength(1);
    expect(setConfigOption[0]?.params).toEqual({
      sessionId: "s1",
      configId: "model",
      value: "p/wanted",
    });
  });

  it("sends session/set_config_option instead of session/set_model when the session model list does not list the model", async () => {
    const { calls } = await runOnce("p/wanted", {
      models: { currentModelId: "p/default", availableModels: [{ modelId: "p/default" }] },
      configOptions: [MODEL_OPT],
    });
    expect(methodsOf(calls)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(calls[2]?.params).toEqual({ sessionId: "s1", configId: "model", value: "p/wanted" });
    expect(methodsOf(calls)).not.toContain("session/set_model");
  });

  it("still sends the prompt when session/set_config_option is rejected", async () => {
    const { calls, events } = await runOnce("p/wanted", { configOptions: [MODEL_OPT] }, "reject");
    expect(methodsOf(calls)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
    ]);
    const failed = kindsOf(events, "acp.model_select_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.meta).toMatchObject({
      session_id: "s1",
      model: "p/wanted",
      via: "session/set_config_option",
    });
    expect(failed[0]?.meta?.error).toBe("Error: set_config_option refused");
    expect(kindsOf(events, "acp.model_selected")).toHaveLength(0);
  });

  it("records acp.model_unavailable with advertised true when the model config option does not list the model", async () => {
    const { calls, events } = await runOnce("p/other", { configOptions: [MODEL_OPT] });
    expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/prompt"]);
    const unavailable = kindsOf(events, "acp.model_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.meta).toMatchObject({ model: "p/other", advertised: true });
  });

  it("prefers session/set_model when the session model list advertises the model", async () => {
    const { calls, events } = await runOnce("p/wanted", {
      models: ADVERTISED,
      configOptions: [MODEL_OPT],
    });
    expect(methodsOf(calls)).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    expect(calls[2]?.params).toEqual({ sessionId: "s1", modelId: "p/wanted" });
    expect(methodsOf(calls)).not.toContain("session/set_config_option");
    const selected = kindsOf(events, "acp.model_selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.meta?.via).toBe("session/set_model");
  });

  it("ignores config options whose category is not model even when a listed value matches", async () => {
    const { calls, events } = await runOnce("p/wanted", {
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "m/default",
          options: [{ value: "p/wanted", name: "w" }],
        },
      ],
    });
    expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/prompt"]);
    const unavailable = kindsOf(events, "acp.model_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.meta).toMatchObject({ model: "p/wanted", advertised: false });
  });

  it("sends nothing extra when options.model is unset even with model config options advertised", async () => {
    const { calls } = await runOnce(undefined, { configOptions: [MODEL_OPT] });
    expect(methodsOf(calls)).toEqual(["initialize", "session/new", "session/prompt"]);
  });
});
