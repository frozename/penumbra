import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";
import { acpSpecHash, createAcpWarmPool, poolKeyFor } from "../../src/adapters/acp-warm-pool.js";

/**
 * Phase 2 — prewarm() connects handshake-only (startServer + initialize +
 * authenticate + deposit) and issues NO session/new or session/prompt, sharing
 * the same connection code path as a cold dispatch so the deposited connection
 * is byte-identical and immediately acquirable.
 */

function makeServer() {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    pid: 4242,
    kill: vi.fn(),
    exited: new Promise<number | null>(() => {}),
    getStderrTail: () => "",
  };
}

describe("StdioAcpAdapter.prewarm (Phase 2)", () => {
  it("connects handshake-only (initialize+authenticate once, no session) and deposits an acquirable entry", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const calls: { method: string }[] = [];
    const request = vi.fn(async (method: string) => {
      calls.push({ method });
      if (method === "initialize")
        return { protocolVersion: 1, authMethods: [{ id: "env", type: "env_var", vars: [] }] };
      if (method === "session/new") return { sessionId: "s" };
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    });
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", agentName: "codex-acp-fast", warmPool: true, repoRoot: "/repo" } as any,
      {
        startServer,
        createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
        pool,
      } as any,
    );

    await adapter.prewarm();

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.method === "initialize")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "authenticate")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "session/new")).toHaveLength(0); // handshake-only
    expect(calls.filter((c) => c.method === "session/prompt")).toHaveLength(0);

    // Deposited an idle, acquirable entry keyed (agent, repoRoot) with matching specHash.
    const poolKey = poolKeyFor({ agent: "codex-acp-fast", cwd: "/repo" });
    const specHash = acpSpecHash({ binary: "mock-acp" });
    const entry = pool.acquire("h-test", poolKey, specHash);
    expect(entry).not.toBeNull();
    expect(entry?.specHash).toBe(specHash);
    pool.release("h-test", poolKey);
  });

  it("a dispatch after prewarm is a reuse hit: no second startServer, fresh session/new at the dispatch cwd, storage root re-injected", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const storageRoots: (string | undefined)[] = [];
    const calls: { method: string; cwd?: string }[] = [];
    const request = vi.fn(async (method: string, params?: any) => {
      calls.push({ method, cwd: params?.cwd });
      if (method === "initialize") return { protocolVersion: 1, authMethods: [] };
      if (method === "session/new") {
        const penumbra = (params?.mcpServers ?? []).find((s: any) =>
          /penumbra/.test(s?.name ?? ""),
        );
        const sr = (penumbra?.env ?? []).find((e: any) => e?.name === "PENUMBRA_STORAGE_ROOT");
        storageRoots.push(sr?.value);
        return { sessionId: `s-${calls.length}` };
      }
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    });
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const mk = () =>
      new StdioAcpAdapter(
        {
          binary: "mock-acp",
          agentName: "codex-acp-fast",
          warmPool: true,
          repoRoot: "/repo",
          cwd: "/repo/wt-a",
          mcpServers: [{ name: "penumbra", command: "bun", args: ["/x/penumbra-mcp.ts"] }],
          env: { PENUMBRA_STORAGE_ROOT: "/repo/wt-a/.test-storage" },
        } as any,
        {
          startServer,
          createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
          pool,
        } as any,
      );

    await mk().prewarm();
    const events: any[] = [];
    await mk().dispatch({
      prompt: "go",
      signal: new AbortController().signal,
      handoff_id: "hA",
      eventContext: { handoffId: "hA", workerId: "w1" },
      onEvent: (e: any) => events.push(e),
    } as any);

    expect(startServer).toHaveBeenCalledTimes(1); // prewarm spawned; the dispatch reused it
    expect(events.filter((e) => e.kind === "acp.session.reuse")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "acp.server.start")).toHaveLength(0);
    const sessionNews = calls.filter((c) => c.method === "session/new");
    expect(sessionNews).toHaveLength(1); // exactly one fresh session, on the dispatch
    expect(sessionNews[0]!.cwd).toBe("/repo/wt-a");
    expect(storageRoots).toEqual(["/repo/wt-a/.test-storage"]); // re-injected per dispatch
  });
});
