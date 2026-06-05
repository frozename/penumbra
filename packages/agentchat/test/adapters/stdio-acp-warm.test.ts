import { describe, expect, test, vi } from "vitest";
import { PassThrough } from "node:stream";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";
import { createAcpWarmPool } from "../../src/adapters/acp-warm-pool.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createHandle() {
  const exited = deferred<number | null>();
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    pid: Math.floor(Math.random() * 10_000),
    kill: vi.fn(() => exited.resolve(0)),
    exited: exited.promise,
    resolveExit: exited.resolve,
    getStderrTail: () => "",
  };
}

function createClient(opts: { hangFirstPrompt?: boolean } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  let updateHandler: ((params: any) => void) | undefined;
  let promptCount = 0;
  const firstPrompt = deferred<any>();
  return {
    calls,
    client: {
      onRequest: vi.fn(),
      on: vi.fn((method: string, handler: (params: any) => void) => {
        if (method === "session/update") updateHandler = handler;
      }),
      request: vi.fn().mockImplementation(async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "initialize") return { protocolVersion: 1, authMethods: [] };
        if (method === "session/new") return { sessionId: "session-123" };
        if (method === "session/prompt") {
          promptCount++;
          if (opts.hangFirstPrompt && promptCount === 1) return firstPrompt.promise;
          updateHandler?.({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `ok-${promptCount}` },
            },
          });
          return { stopReason: "end_turn" };
        }
        return {};
      }),
    },
  };
}

describe("StdioAcpAdapter warm pool reuse", () => {
  test("reuses a warm session for sequential dispatches and reinjects handoff id per prompt", async () => {
    const lifecycle: any[] = [];
    const pool = createAcpWarmPool();
    const handle = createHandle();
    const client = createClient();
    const startServer = vi.fn().mockResolvedValue(handle);
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", cwd: "/repo", model: "codex-acp-fast", warmPool: true },
      {
        startServer,
        createClient: () => client.client as any,
        pool,
      },
    );
    const baseInput = {
      prompt: "hello",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      eventContext: { handoffId: "h1", workerId: "w1" },
      onEvent: (event: any) => lifecycle.push(event),
    };

    const first = await adapter.dispatch({ ...baseInput, handoff_id: "h1" });
    const second = await adapter.dispatch({
      ...baseInput,
      handoff_id: "h2",
      eventContext: { handoffId: "h2", workerId: "w1" },
    });

    expect(first.text).toBe("ok-1");
    expect(second.text).toBe("ok-2");
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(client.calls.filter((call) => call.method === "session/new")).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === "session/prompt")).toHaveLength(2);
    expect(lifecycle.filter((event) => event.kind === "acp.server.start")).toHaveLength(1);
    expect(lifecycle.filter((event) => event.kind === "acp.session.reuse")).toHaveLength(1);
    const promptCalls = client.calls.filter((call) => call.method === "session/prompt");
    expect(promptCalls[0]?.params?._meta?.penumbraHandoffId).toBe("h1");
    expect(promptCalls[1]?.params?._meta?.penumbraHandoffId).toBe("h2");
    expect(handle.kill).not.toHaveBeenCalled();
  });

  test("evicts a dead warm entry and cold-starts a replacement", async () => {
    const pool = createAcpWarmPool();
    const deadHandle = createHandle();
    (deadHandle as any).exitCode = 1;
    pool.deposit("codex-acp-fast\0/repo", {
      handle: deadHandle as any,
      client: createClient().client as any,
      sessionId: "dead-session",
      specHash: JSON.stringify({ binary: "mock-acp", args: [], model: "codex-acp-fast" }),
    });
    const freshHandle = createHandle();
    const freshClient = createClient();
    const startServer = vi.fn().mockResolvedValue(freshHandle);
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", cwd: "/repo", model: "codex-acp-fast", warmPool: true },
      { startServer, createClient: () => freshClient.client as any, pool },
    );

    const result = await adapter.dispatch({
      prompt: "hello",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "h-fresh",
    });

    expect(result.text).toBe("ok-1");
    expect(deadHandle.kill).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(freshHandle.kill).not.toHaveBeenCalled();
  });

  test("warm prompt exit evicts and retries once on a cold session", async () => {
    const pool = createAcpWarmPool();
    const warmHandle = createHandle();
    const warmClient = createClient({ hangFirstPrompt: true });
    const warmEntry = pool.deposit("codex-acp-fast\0/repo", {
      handle: warmHandle as any,
      client: warmClient.client as any,
      sessionId: "warm-session",
      specHash: JSON.stringify({ binary: "mock-acp", args: [], model: "codex-acp-fast" }),
    });
    expect(warmEntry).not.toBeNull();
    const coldHandle = createHandle();
    const coldClient = createClient();
    const startServer = vi.fn().mockResolvedValue(coldHandle);
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", cwd: "/repo", model: "codex-acp-fast", warmPool: true },
      { startServer, createClient: () => coldClient.client as any, pool },
    );

    const dispatch = adapter.dispatch({
      prompt: "hello",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "h-retry",
    });
    await Promise.resolve();
    warmHandle.resolveExit(1);

    const result = await dispatch;
    expect(result.text).toBe("ok-1");
    expect(warmHandle.kill).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
  });
});
