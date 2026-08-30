import type { DispatchEventInput } from "@penumbra/core";
import type { McpServerStdio } from "@src/adapters/acp-types.js";
import type { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import type { DispatchInput } from "@src/sdk/adapter.js";

import { acpSpecHash, createAcpWarmPool, poolKeyFor } from "@src/adapters/acp-warm-pool.js";
import { StdioAcpAdapter, type StdioAcpOptions } from "@src/adapters/stdio-acp.js";
import { describe, expect, it, vi } from "bun:test";

import {
  makeMockAcpClient,
  makeMockAcpHandle,
  type MockAcpHandle,
} from "../helpers/stdio-acp-fixtures.js";

/**
 * Option B (warm-pool re-architecture): the pool holds a warm CONNECTION
 * (process + initialized/authenticated client), keyed on (agent, repoRoot). A
 * warm hit skips startServer + initialize + authenticate but ALWAYS issues a
 * fresh session/new at THIS dispatch's cwd, so:
 *   - reuse works across per-dispatch worktrees (different cwd, same repoRoot);
 *   - the per-dispatch identity env (handoff id, tick allowlist) is correct,
 *     because session/new re-injects it every time.
 */

interface SessionNewParamsShape {
  cwd?: string;
  mcpServers?: McpServerStdio[];
}

interface RecordedCall {
  method: string;
  cwd?: string;
  mcpServers?: McpServerStdio[];
}

function asSessionNewParams(params: unknown): SessionNewParamsShape {
  if (typeof params === "object" && params !== null) return params;
  return {};
}

function makeServer(): MockAcpHandle {
  return makeMockAcpHandle({
    pid: 4242,
    // Never settles: the pool keeps the entry alive for the whole test;
    // a resolving exited promise would race the dispatch and tear it down.
    exited: new Promise<number | null>(() => {
      /* never resolves */
    }),
  });
}

/** Records every JSON-RPC method + session/new params (cwd, mcpServers). */
function makeTrackedRequest(calls: RecordedCall[]): StdioAcpClient["request"] {
  let sessionCounter = 0;
  return vi.fn<(method: string, params?: unknown) => Promise<unknown>>((method, params) => {
    const narrowed = asSessionNewParams(params);
    calls.push({
      method,
      cwd: narrowed.cwd,
      mcpServers: narrowed.mcpServers,
    });
    if (method === "initialize") {
      return Promise.resolve({ protocolVersion: 1, authMethods: [] });
    }
    if (method === "session/new") {
      sessionCounter++;
      return Promise.resolve({ sessionId: `session-${String(sessionCounter)}` });
    }
    if (method === "session/prompt") {
      return Promise.resolve({ stopReason: "end_turn" });
    }
    return Promise.resolve({});
  });
}

function makeDispatchInput(handoffId: string, events: DispatchEventInput[]): DispatchInput {
  return {
    prompt: handoffId,
    conversation: { id: handoffId, project_id: null },
    config: {},
    signal: new AbortController().signal,
    handoff_id: handoffId,
    eventContext: { handoffId, workerId: "w1" },
    onEvent: (event): void => {
      events.push(event);
    },
  };
}

describe("StdioAcpAdapter warm-connection reuse (Option B)", () => {
  it("reuses the process across two dispatches but runs a fresh session/new each time", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const calls: RecordedCall[] = [];
    const request = makeTrackedRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const opts: StdioAcpOptions = { binary: "mock-acp", warmPool: true };
    const adapter = new StdioAcpAdapter(opts, {
      startServer,
      createClient: (): StdioAcpClient =>
        makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
      pool,
    });

    const events: DispatchEventInput[] = [];
    await adapter.dispatch(makeDispatchInput("h1", events));
    await adapter.dispatch(makeDispatchInput("h2", events));

    expect(startServer).toHaveBeenCalledTimes(1); // process reused on 2nd dispatch
    expect(calls.filter((c) => c.method === "initialize")).toHaveLength(1); // handshake once
    expect(calls.filter((c) => c.method === "session/new")).toHaveLength(2); // fresh session each
    expect(calls.filter((c) => c.method === "session/prompt")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "acp.session.reuse")).toHaveLength(1); // only 2nd
  });

  it("reuses one process across two worktrees (same repoRoot, different cwd) and sessions at each cwd", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const calls: RecordedCall[] = [];
    const request = makeTrackedRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());

    const mk = (cwd: string): StdioAcpAdapter => {
      const opts: StdioAcpOptions = {
        binary: "mock-acp",
        agentName: "codex-acp-fast",
        warmPool: true,
        repoRoot: "/repo",
        cwd,
      };
      return new StdioAcpAdapter(opts, {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
        pool,
      });
    };

    const events: DispatchEventInput[] = [];
    await mk("/repo/wt-a").dispatch(makeDispatchInput("hA", events));
    await mk("/repo/wt-b").dispatch(makeDispatchInput("hB", events));

    expect(startServer).toHaveBeenCalledTimes(1); // one warm process for both worktrees
    const sessionNews = calls.filter((c) => c.method === "session/new");
    expect(sessionNews.map((c) => c.cwd)).toEqual(["/repo/wt-a", "/repo/wt-b"]); // fresh session per cwd
  });

  it("re-injects each dispatch's handoff identity into session/new across reuse", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const identities: { handoffId: string | undefined; storageRoot: string | undefined }[] = [];
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      (method, params) => {
        if (method === "initialize") {
          return Promise.resolve({ protocolVersion: 1, authMethods: [] });
        }
        if (method === "session/new") {
          const narrowed = asSessionNewParams(params);
          const servers = narrowed.mcpServers ?? [];
          const penumbra = servers.find((s) => s.name.includes("penumbra"));
          const env = penumbra?.env ?? [];
          const envValue = (name: string): string | undefined =>
            env.find((e) => e.name === name)?.value;
          identities.push({
            handoffId: envValue("PENUMBRA_HANDOFF_ID"),
            storageRoot: envValue("PENUMBRA_STORAGE_ROOT"),
          });
          return Promise.resolve({ sessionId: `s-${String(identities.length)}` });
        }
        if (method === "session/prompt") {
          return Promise.resolve({ stopReason: "end_turn" });
        }
        return Promise.resolve({});
      },
    );
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const mk = (storageRoot: string): StdioAcpAdapter => {
      const opts: StdioAcpOptions = {
        binary: "mock-acp",
        agentName: "codex-acp-fast",
        warmPool: true,
        repoRoot: "/repo",
        mcpServers: [{ name: "penumbra", command: "bun", args: ["/x/penumbra-mcp.ts"], env: [] }],
        env: { PENUMBRA_STORAGE_ROOT: storageRoot },
      };
      return new StdioAcpAdapter(opts, {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
        pool,
      });
    };

    await mk("/repo/wt-a/.test-storage").dispatch({
      prompt: "a",
      conversation: { id: "hA", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "hA",
    });
    await mk("/repo/wt-b/.test-storage").dispatch({
      prompt: "b",
      conversation: { id: "hB", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "hB",
    });

    expect(startServer).toHaveBeenCalledTimes(1); // process reused
    // The reused process must NOT freeze wt-a's identity onto wt-b's dispatch.
    expect(identities).toEqual([
      { handoffId: "hA", storageRoot: "/repo/wt-a/.test-storage" },
      { handoffId: "hB", storageRoot: "/repo/wt-b/.test-storage" },
    ]);
  });

  it("replaces a dead pooled transport with a cold dispatch", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const staleServer = makeServer();
    let transportOpen = true;
    const staleClient = {
      isTransportOpen: () => transportOpen,
      onRequest: vi.fn(),
      on: vi.fn(),
      request: vi.fn((method: string) => {
        if (method === "session/new") {
          transportOpen = false;
          return Promise.reject(new Error("read ECONNRESET"));
        }
        return Promise.reject(new Error(`unexpected stale request: ${method}`));
      }),
    } as unknown as StdioAcpClient;
    const opts: StdioAcpOptions = {
      binary: "mock-acp",
      agentName: "codex-acp-fast",
      warmPool: true,
      repoRoot: "/repo",
    };
    const poolKey = poolKeyFor({ agent: "codex-acp-fast", cwd: "/repo" });
    pool.deposit(poolKey, {
      handle: staleServer,
      client: staleClient,
      specHash: acpSpecHash({ binary: "mock-acp" }),
    });

    const calls: RecordedCall[] = [];
    const request = makeTrackedRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const adapter = new StdioAcpAdapter(opts, {
      startServer,
      createClient: (): StdioAcpClient =>
        makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
      pool,
    });

    const result = await adapter.dispatch(makeDispatchInput("h1", []));
    expect(result).toMatchObject({
      text: "",
    });
    expect(staleServer.kill).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
  }, 1_000);
});
