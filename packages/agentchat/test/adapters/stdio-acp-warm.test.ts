import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";

import type {
  AcpWarmPool,
  AcpWarmPoolDeposit,
  AcpWarmPoolDepositOptions,
  AcpWarmPoolEntry,
} from "@src/adapters/acp-warm-pool.js";
import { createAcpWarmPool } from "@src/adapters/acp-warm-pool.js";
import type { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import type { StdioAcpHandle } from "@src/adapters/stdio-acp-server.js";
import { StdioAcpAdapter } from "@src/adapters/stdio-acp.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface TestHandle extends StdioAcpHandle {
  resolveExit: (value: number | null) => void;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
}

function createHandle(): TestHandle {
  const exited = deferred<number | null>();
  const handle: TestHandle = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    pid: Math.floor(Math.random() * 10_000),
    kill: vi.fn(() => {
      exited.resolve(0);
    }),
    exited: exited.promise,
    exitCode: null,
    getStderrTail: () => "",
    resolveExit: exited.resolve,
  };
  return handle;
}

interface RecordedCall {
  method: string;
  params: unknown;
}

interface ClientStub {
  onRequest: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
}

interface ClientFixture {
  calls: RecordedCall[];
  client: ClientStub;
}

// Single documented launder: StdioAcpClient is a nominal class with private
// fields, so structurally-mocked test doubles need one `as unknown as` to be
// accepted by the adapter's deps slot.
const asAcpClient = (stub: ClientStub): StdioAcpClient => stub as unknown as StdioAcpClient;

function createClient(opts: { hangFirstPrompt?: boolean } = {}): ClientFixture {
  const calls: RecordedCall[] = [];
  let updateHandler: ((params: unknown) => void) | undefined;
  let promptCount = 0;
  const firstPrompt = deferred<unknown>();
  return {
    calls,
    client: {
      onRequest: vi.fn(),
      on: vi.fn((method: string, handler: (params: unknown) => void) => {
        if (method === "session/update") updateHandler = handler;
      }),
      request: vi.fn().mockImplementation((method: string, params: unknown): Promise<unknown> => {
        calls.push({ method, params });
        if (method === "initialize") {
          return Promise.resolve({ protocolVersion: 1, authMethods: [] });
        }
        if (method === "session/new") {
          return Promise.resolve({ sessionId: "session-123" });
        }
        if (method === "session/prompt") {
          promptCount++;
          if (opts.hangFirstPrompt && promptCount === 1) return firstPrompt.promise;
          updateHandler?.({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `ok-${String(promptCount)}` },
            },
          });
          return Promise.resolve({ stopReason: "end_turn" });
        }
        return Promise.resolve({});
      }),
    },
  };
}

describe("StdioAcpAdapter warm pool reuse", () => {
  test("continues a cold dispatch on the spawned server when the warm-pool deposit is rejected", async () => {
    const lifecycle: DispatchEventInput[] = [];
    const handle = createHandle();
    const client = createClient();
    const startServer = vi.fn().mockResolvedValue(handle);
    const pool = {
      acquire: vi.fn().mockReturnValue(null),
      deposit: vi.fn(
        (_key: string, entry: AcpWarmPoolDeposit, opts?: AcpWarmPoolDepositOptions) => {
          if (opts?.onReject !== "keep") entry.handle.kill();
          return null;
        },
      ),
      release: vi.fn(),
      evict: vi.fn(),
      shutdown: vi.fn(),
      size: vi.fn().mockReturnValue(4),
      has: vi.fn().mockReturnValue(false),
      liveEntryCount: vi.fn().mockReturnValue(0),
      peekMissReason: vi.fn().mockReturnValue("no_entry"),
      debugKeys: vi.fn().mockReturnValue([]),
      _sweep: vi.fn(),
    } satisfies AcpWarmPool;
    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        cwd: "/repo",
        model: "codex-acp-fast",
        warmPool: true,
        agentName: "codex-acp-fast",
      },
      {
        startServer,
        createClient: (): StdioAcpClient => {
          const request = vi.fn().mockImplementation((method: string, params: unknown) => {
            if (method === "session/new" && handle.kill.mock.calls.length > 0) {
              throw new Error("server killed before session/new");
            }
            return client.client.request(method, params) as Promise<unknown>;
          });
          return asAcpClient({ ...client.client, request });
        },
        pool,
        totalPoolEntryCount: (): number => 9,
      },
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let result: Awaited<ReturnType<StdioAcpAdapter["dispatch"]>> | undefined;
    try {
      result = await adapter.dispatch({
        prompt: "hello",
        conversation: { id: "c1", project_id: null },
        config: {},
        signal: new AbortController().signal,
        handoff_id: "h-rejected",
        eventContext: { handoffId: "h-rejected", workerId: "w1" },
        onEvent: (event: DispatchEventInput): void => {
          lifecycle.push(event);
        },
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    expect(result.text).toBe("ok-1");
    expect(pool.deposit).toHaveBeenCalledTimes(1);
    expect(pool.deposit.mock.calls[0]?.[2]).toMatchObject({ onReject: "keep" });
    expect(pool.release).not.toHaveBeenCalled();
    expect(pool.evict).not.toHaveBeenCalled();
    expect(handle.kill).toHaveBeenCalledTimes(1);
    expect(client.calls.map((call) => call.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    const rejectedEvents = lifecycle.filter(
      (event) => event.kind === "acp.warm_pool.deposit_rejected",
    );
    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0]?.meta).toMatchObject({
      pool_key: "codex-acp-fast\0/repo",
      total_entries: 9,
      agent_entries: 4,
      cap: 4,
      reason: "rejected",
    });
  });

  test("emits a lifecycle event when a dispatch deposit evicts another agent's prewarm entry", async () => {
    const lifecycle: DispatchEventInput[] = [];
    const handle = createHandle();
    const client = createClient();
    const startServer = vi.fn().mockResolvedValue(handle);
    const pool = {
      acquire: vi.fn().mockReturnValue(null),
      deposit: vi.fn(
        (_key: string, entry: AcpWarmPoolDeposit, opts?: AcpWarmPoolDepositOptions) => {
          opts?.onPrewarmEvicted?.({
            evictedAgent: "other-agent",
            evictedRepoRoot: "/repo-a",
            depositorAgent: "codex-acp-fast",
            idleMs: 1234,
          });
          return {
            ...entry,
            refs: new Set<string>(),
            spawnedAt: 0,
            lastReleaseAt: 0,
          };
        },
      ),
      release: vi.fn(),
      evict: vi.fn(),
      shutdown: vi.fn(),
      size: vi.fn().mockReturnValue(1),
      has: vi.fn().mockReturnValue(false),
      liveEntryCount: vi.fn().mockReturnValue(0),
      peekMissReason: vi.fn().mockReturnValue("no_entry"),
      debugKeys: vi.fn().mockReturnValue([]),
      _sweep: vi.fn(),
    } satisfies AcpWarmPool;
    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        cwd: "/repo-b",
        model: "codex-acp-fast",
        warmPool: true,
        agentName: "codex-acp-fast",
      },
      {
        startServer,
        createClient: (): StdioAcpClient => asAcpClient(client.client),
        pool,
      },
    );

    await adapter.dispatch({
      prompt: "hello",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "h-evict-prewarm",
      eventContext: { handoffId: "h-evict-prewarm", workerId: "w1" },
      onEvent: (event: DispatchEventInput): void => {
        lifecycle.push(event);
      },
    });

    const evictedEvents = lifecycle.filter(
      (event) => event.kind === "acp.warm_pool.prewarm_evicted",
    );
    expect(evictedEvents).toHaveLength(1);
    expect(evictedEvents[0]?.meta).toEqual({
      evicted_agent: "other-agent",
      evicted_repo_root: "/repo-a",
      depositor_agent: "codex-acp-fast",
      idle_ms: 1234,
    });
  });

  test("reuses a warm connection for sequential dispatches and issues a fresh session per dispatch", async () => {
    const lifecycle: DispatchEventInput[] = [];
    const pool = createAcpWarmPool();
    const handle = createHandle();
    const client = createClient();
    const startServer = vi.fn().mockResolvedValue(handle);
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", cwd: "/repo", model: "codex-acp-fast", warmPool: true },
      {
        startServer,
        createClient: (): StdioAcpClient => asAcpClient(client.client),
        pool,
      },
    );
    const baseInput = {
      prompt: "hello",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      eventContext: { handoffId: "h1", workerId: "w1" },
      onEvent: (event: DispatchEventInput): void => {
        lifecycle.push(event);
      },
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
    // Option B: the warm hit reuses the process (one startServer) but issues a
    // FRESH session/new on every dispatch — so the per-dispatch identity env is
    // re-injected and the session is pinned to this dispatch's cwd.
    expect(client.calls.filter((call) => call.method === "session/new")).toHaveLength(2);
    expect(client.calls.filter((call) => call.method === "session/prompt")).toHaveLength(2);
    expect(lifecycle.filter((event) => event.kind === "acp.server.start")).toHaveLength(1);
    expect(lifecycle.filter((event) => event.kind === "acp.session.reuse")).toHaveLength(1);
    const promptCalls = client.calls.filter((call) => call.method === "session/prompt");
    const firstParams = promptCalls[0]?.params as
      | { _meta?: { penumbraHandoffId?: string } }
      | undefined;
    const secondParams = promptCalls[1]?.params as
      | { _meta?: { penumbraHandoffId?: string } }
      | undefined;
    expect(firstParams?._meta?.penumbraHandoffId).toBe("h1");
    expect(secondParams?._meta?.penumbraHandoffId).toBe("h2");
    expect(handle.kill).not.toHaveBeenCalled();
  });

  test("evicts a dead warm entry and cold-starts a replacement", async () => {
    const pool = createAcpWarmPool();
    const deadHandle = createHandle();
    deadHandle.exitCode = 1;
    pool.deposit("codex-acp-fast\0/repo", {
      handle: deadHandle,
      client: asAcpClient(createClient().client),
      sessionId: "dead-session",
      specHash: JSON.stringify({ binary: "mock-acp", args: [], model: "codex-acp-fast" }),
    });
    const freshHandle = createHandle();
    const freshClient = createClient();
    const startServer = vi.fn().mockResolvedValue(freshHandle);
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", cwd: "/repo", model: "codex-acp-fast", warmPool: true },
      {
        startServer,
        createClient: (): StdioAcpClient => asAcpClient(freshClient.client),
        pool,
      },
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
    const warmEntry: AcpWarmPoolEntry | null = pool.deposit("codex-acp-fast\0/repo", {
      handle: warmHandle,
      client: asAcpClient(warmClient.client),
      sessionId: "warm-session",
      specHash: JSON.stringify({ binary: "mock-acp", args: [], model: "codex-acp-fast" }),
    });
    expect(warmEntry).not.toBeNull();
    const coldHandle = createHandle();
    const coldClient = createClient();
    const startServer = vi.fn().mockResolvedValue(coldHandle);
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", cwd: "/repo", model: "codex-acp-fast", warmPool: true },
      {
        startServer,
        createClient: (): StdioAcpClient => asAcpClient(coldClient.client),
        pool,
      },
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
