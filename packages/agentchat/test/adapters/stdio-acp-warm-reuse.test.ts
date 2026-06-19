import { describe, expect, it, vi } from "bun:test";
import { PassThrough } from "node:stream";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";
import { createAcpWarmPool } from "../../src/adapters/acp-warm-pool.js";

/**
 * Option B (warm-pool re-architecture): the pool holds a warm CONNECTION
 * (process + initialized/authenticated client), keyed on (agent, repoRoot). A
 * warm hit skips startServer + initialize + authenticate but ALWAYS issues a
 * fresh session/new at THIS dispatch's cwd, so:
 *   - reuse works across per-dispatch worktrees (different cwd, same repoRoot);
 *   - the per-dispatch identity env (handoff id, tick allowlist) is correct,
 *     because session/new re-injects it every time.
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

/** A request spy that records method + the cwd passed to session/new. */
function makeRequest(calls: { method: string; cwd?: string }[]) {
  return vi.fn(async (method: string, params?: any) => {
    calls.push({ method, cwd: params?.cwd });
    if (method === "initialize") return { protocolVersion: 1, authMethods: [] };
    if (method === "session/new") return { sessionId: `session-${calls.length}` };
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  });
}

const dispatchInput = (prompt: string, events: any[]) => ({
  prompt,
  signal: new AbortController().signal,
  eventContext: { handoffId: prompt, workerId: "w1" },
  onEvent: (e: any) => events.push(e),
});

describe("StdioAcpAdapter warm-connection reuse (Option B)", () => {
  it("reuses the process across two dispatches but runs a fresh session/new each time", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const calls: { method: string; cwd?: string }[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", warmPool: true } as any,
      {
        startServer,
        createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
        pool,
      } as any,
    );

    const events: any[] = [];
    await adapter.dispatch(dispatchInput("h1", events) as any);
    await adapter.dispatch(dispatchInput("h2", events) as any);

    expect(startServer).toHaveBeenCalledTimes(1); // process reused on 2nd dispatch
    expect(calls.filter((c) => c.method === "initialize")).toHaveLength(1); // handshake once
    expect(calls.filter((c) => c.method === "session/new")).toHaveLength(2); // fresh session each
    expect(calls.filter((c) => c.method === "session/prompt")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "acp.session.reuse")).toHaveLength(1); // only 2nd
  });

  it("reuses one process across two worktrees (same repoRoot, different cwd) and sessions at each cwd", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const calls: { method: string; cwd?: string }[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());

    const mk = (cwd: string) =>
      new StdioAcpAdapter(
        {
          binary: "mock-acp",
          agentName: "codex-acp-fast",
          warmPool: true,
          repoRoot: "/repo",
          cwd,
        } as any,
        {
          startServer,
          createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
          pool,
        } as any,
      );

    const events: any[] = [];
    await mk("/repo/wt-a").dispatch(dispatchInput("hA", events) as any);
    await mk("/repo/wt-b").dispatch(dispatchInput("hB", events) as any);

    expect(startServer).toHaveBeenCalledTimes(1); // one warm process for both worktrees
    const sessionNews = calls.filter((c) => c.method === "session/new");
    expect(sessionNews.map((c) => c.cwd)).toEqual(["/repo/wt-a", "/repo/wt-b"]); // fresh session per cwd
  });

  it("re-injects each dispatch's handoff identity into session/new across reuse", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const identities: Array<{ handoffId: string | undefined; storageRoot: string | undefined }> =
      [];
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === "initialize") return { protocolVersion: 1, authMethods: [] };
      if (method === "session/new") {
        const penumbra = (params?.mcpServers ?? []).find((s: any) =>
          /penumbra/.test(s?.name ?? ""),
        );
        const env = Array.isArray(penumbra?.env) ? penumbra.env : [];
        const envValue = (name: string) => env.find((e: any) => e?.name === name)?.value;
        identities.push({
          handoffId: envValue("PENUMBRA_HANDOFF_ID"),
          storageRoot: envValue("PENUMBRA_STORAGE_ROOT"),
        });
        return { sessionId: `s-${identities.length}` };
      }
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    });
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const mk = (storageRoot: string) =>
      new StdioAcpAdapter(
        {
          binary: "mock-acp",
          agentName: "codex-acp-fast",
          warmPool: true,
          repoRoot: "/repo",
          mcpServers: [{ name: "penumbra", command: "bun", args: ["/x/penumbra-mcp.ts"] }],
          env: { PENUMBRA_STORAGE_ROOT: storageRoot },
        } as any,
        {
          startServer,
          createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
          pool,
        } as any,
      );

    await mk("/repo/wt-a/.test-storage").dispatch({
      prompt: "a",
      signal: new AbortController().signal,
      handoff_id: "hA",
    } as any);
    await mk("/repo/wt-b/.test-storage").dispatch({
      prompt: "b",
      signal: new AbortController().signal,
      handoff_id: "hB",
    } as any);

    expect(startServer).toHaveBeenCalledTimes(1); // process reused
    // The reused process must NOT freeze wt-a's identity onto wt-b's dispatch.
    expect(identities).toEqual([
      { handoffId: "hA", storageRoot: "/repo/wt-a/.test-storage" },
      { handoffId: "hB", storageRoot: "/repo/wt-b/.test-storage" },
    ]);
  });
});
