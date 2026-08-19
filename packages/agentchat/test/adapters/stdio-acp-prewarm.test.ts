import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it, vi } from "bun:test";

import type { McpServerStdio } from "../../src/adapters/acp-types.js";
import type { AcpWarmPool, AcpWarmPoolDeposit } from "../../src/adapters/acp-warm-pool.js";
import type { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import type { DispatchInput } from "../../src/sdk/adapter.js";

import { acpSpecHash, createAcpWarmPool, poolKeyFor } from "../../src/adapters/acp-warm-pool.js";
import { StdioAcpAdapter, type StdioAcpOptions } from "../../src/adapters/stdio-acp.js";
import { expectRejection } from "../helpers/cli-spawn-fixtures.js";
import {
  makeMockAcpClient,
  makeMockAcpHandle,
  type MockAcpHandle,
} from "../helpers/stdio-acp-fixtures.js";

/**
 * Phase 2 — prewarm() connects handshake-only (startServer + initialize +
 * deposit) and issues NO session/new or session/prompt, sharing
 * the same connection code path as a cold dispatch so the deposited connection
 * is byte-identical and immediately acquirable.
 */

interface SessionNewParamsShape {
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

describe("StdioAcpAdapter.prewarm (Phase 2)", () => {
  it("kills a spawned prewarm server when its pool deposit is rejected", async () => {
    const server = makeServer();
    const pool = {
      acquire: vi.fn().mockReturnValue(null),
      deposit: vi.fn(
        (_key: string, entry: AcpWarmPoolDeposit, opts?: { onReject?: "keep" | "kill" }) => {
          if (opts?.onReject === "kill") entry.handle.kill();
          return null;
        },
      ),
      release: vi.fn(),
      evict: vi.fn(),
      shutdown: vi.fn(),
      size: vi.fn().mockReturnValue(0),
      has: vi.fn().mockReturnValue(false),
      liveEntryCount: vi.fn().mockReturnValue(0),
      peekMissReason: vi.fn().mockReturnValue("no_entry"),
      debugKeys: vi.fn().mockReturnValue([]),
      _sweep: vi.fn(),
    } satisfies AcpWarmPool;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>((method) => {
      if (method === "initialize") return Promise.resolve({ protocolVersion: 1, authMethods: [] });
      return Promise.resolve({});
    });
    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        agentName: "codex-acp-fast",
        warmPool: true,
        repoRoot: "/repo",
      },
      {
        startServer: vi.fn().mockResolvedValue(server),
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
        pool,
      },
    );

    const result = await adapter.prewarm();

    expect(result.deposited).toBe(false);
    expect(pool.deposit).toHaveBeenCalledTimes(1);
    expect(pool.deposit.mock.calls[0]?.[2]).toEqual({ onReject: "kill" });
    expect(server.kill).toHaveBeenCalledTimes(1);
  });

  it("does not authenticate an already-authenticated agent that advertises auth methods", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const calls: { method: string }[] = [];
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>((method) => {
      calls.push({ method });
      if (method === "initialize") {
        return Promise.resolve({
          protocolVersion: 1,
          authMethods: [{ id: "env", type: "env_var", vars: [] }],
        });
      }
      if (method === "session/new") return Promise.resolve({ sessionId: "s" });
      if (method === "session/prompt") return Promise.resolve({ stopReason: "end_turn" });
      return Promise.resolve({});
    });
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const opts: StdioAcpOptions = {
      binary: "mock-acp",
      agentName: "codex-acp-fast",
      warmPool: true,
      repoRoot: "/repo",
    };
    const adapter = new StdioAcpAdapter(opts, {
      startServer,
      createClient: (): StdioAcpClient =>
        makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
      pool,
    });

    await adapter.prewarm();

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.method === "initialize")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "authenticate")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "session/new")).toHaveLength(0); // handshake-only
    expect(calls.filter((c) => c.method === "session/prompt")).toHaveLength(0);

    // Deposited an idle, acquirable entry keyed (agent, repoRoot) with matching specHash.
    const poolKey = poolKeyFor({ agent: "codex-acp-fast", cwd: "/repo" });
    const specHash = acpSpecHash({ binary: "mock-acp" });
    const entry = pool.acquire("h-test", poolKey, specHash);
    expect(entry).not.toBeNull();
    expect(entry?.specHash).toBe(specHash);
    expect(entry?.pinned).toBe(true); // pre-warmed: exempt from the idle-grace sweep
    pool.release("h-test", poolKey);
  });

  it("prewarm(signal) that is already aborted throws and never spawns a child", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const opts: StdioAcpOptions = {
      binary: "mock-acp",
      agentName: "codex-acp-fast",
      warmPool: true,
      repoRoot: "/repo",
    };
    const adapter = new StdioAcpAdapter(opts, {
      startServer,
      createClient: (): StdioAcpClient =>
        makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request: vi.fn() }),
      pool,
    });

    const ac = new AbortController();
    ac.abort(new Error("worker shutdown"));
    await expectRejection(adapter.prewarm(ac.signal));
    expect(startServer).not.toHaveBeenCalled();
  });

  it("prewarm tears down the spawned child when handshake rejects for a non-timeout error", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const server = makeServer();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>((method) => {
      if (method === "initialize") return Promise.reject(new Error("boom"));
      return Promise.resolve({});
    });
    const startServer = vi.fn().mockResolvedValue(server);
    const opts: StdioAcpOptions = {
      binary: "mock-acp",
      agentName: "codex-acp-fast",
      warmPool: true,
      repoRoot: "/repo",
    };
    const adapter = new StdioAcpAdapter(opts, {
      startServer,
      createClient: (): StdioAcpClient =>
        makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
      pool,
    });

    await expectRejection(adapter.prewarm(), "boom");

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(server.kill).toHaveBeenCalledTimes(1);
    expect(
      pool.acquire(
        "h-test",
        poolKeyFor({ agent: "codex-acp-fast", cwd: "/repo" }),
        acpSpecHash({ binary: "mock-acp" }),
      ),
    ).toBeNull();
  });

  it("authenticates a prewarmed connection only after session/new reports auth required", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const storageRoots: (string | undefined)[] = [];
    const calls: { method: string; cwd?: string }[] = [];
    let sessionNewAttempts = 0;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      (method, params) => {
        const narrowed = asSessionNewParams(params);
        calls.push({ method, cwd: narrowed.cwd });
        if (method === "initialize") {
          return Promise.resolve({
            protocolVersion: 1,
            authMethods: [{ id: "chat-gpt", type: "agent" }],
          });
        }
        if (method === "session/new") {
          sessionNewAttempts += 1;
          const servers = narrowed.mcpServers ?? [];
          const penumbra = servers.find((s) => s.name.includes("penumbra"));
          const sr = (penumbra?.env ?? []).find((e) => e.name === "PENUMBRA_STORAGE_ROOT");
          storageRoots.push(sr?.value);
          if (sessionNewAttempts === 1) {
            return Promise.reject(
              new Error("stdio-acp-client: Authentication required (code: -32000)"),
            );
          }
          return Promise.resolve({ sessionId: `s-${String(calls.length)}` });
        }
        if (method === "session/prompt") return Promise.resolve({ stopReason: "end_turn" });
        return Promise.resolve({});
      },
    );
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const mk = (): StdioAcpAdapter => {
      const opts: StdioAcpOptions = {
        binary: "mock-acp",
        agentName: "codex-acp-fast",
        warmPool: true,
        repoRoot: "/repo",
        cwd: "/repo/wt-a",
        mcpServers: [{ name: "penumbra", command: "bun", args: ["/x/penumbra-mcp.ts"], env: [] }],
        env: { PENUMBRA_STORAGE_ROOT: "/repo/wt-a/.test-storage" },
      };
      return new StdioAcpAdapter(opts, {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
        pool,
      });
    };

    await mk().prewarm();
    expect(calls.filter((c) => c.method === "authenticate")).toHaveLength(0);
    const events: DispatchEventInput[] = [];
    const dispatchInput: DispatchInput = {
      prompt: "go",
      conversation: { id: "hA", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "hA",
      eventContext: { handoffId: "hA", workerId: "w1" },
      onEvent: (event): void => {
        events.push(event);
      },
    };
    await mk().dispatch(dispatchInput);

    expect(startServer).toHaveBeenCalledTimes(1); // prewarm spawned; the dispatch reused it
    expect(events.filter((e) => e.kind === "acp.session.reuse")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "acp.server.start")).toHaveLength(0);
    const sessionNews = calls.filter((c) => c.method === "session/new");
    expect(sessionNews).toHaveLength(2); // one auth-required attempt, then exactly one retry
    expect(sessionNews.map((call) => call.cwd)).toEqual(["/repo/wt-a", "/repo/wt-a"]);
    expect(calls.filter((c) => c.method === "authenticate")).toHaveLength(1);
    expect(storageRoots).toEqual(["/repo/wt-a/.test-storage", "/repo/wt-a/.test-storage"]);
  });
});
