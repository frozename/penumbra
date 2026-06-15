import { describe, expect, it, vi } from "bun:test";
import { PassThrough } from "node:stream";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";
import { createAcpWarmPool } from "../../src/adapters/acp-warm-pool.js";

/**
 * modelWarmupPrompt absorbs the per-process `/model` handshake that an
 * ANTHROPIC_MODEL env pin triggers on claude-agent-acp. On a fresh process the
 * first prompt is eaten by the `/model` injection (responds, then `end_turn`,
 * having run nothing) — so without a warmup the FIRST dispatch on every cold
 * process was recorded as no_worktree_activity. These tests pin the wiring:
 * cold dispatches send the warmup first, warm reuse skips it.
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

/** Request spy recording method + (for prompts) the text sent. */
function makeRequest(calls: { method: string; text?: string }[]) {
  return vi.fn(async (method: string, params?: any) => {
    calls.push({ method, text: params?.prompt?.[0]?.text });
    if (method === "initialize") return { protocolVersion: 1, authMethods: [] };
    if (method === "session/new") return { sessionId: `session-${calls.length}` };
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  });
}

const dispatchInput = (prompt: string, events: any[]) => ({
  prompt,
  signal: new AbortController().signal,
  handoff_id: prompt,
  eventContext: { handoffId: prompt, workerId: "w1" },
  onEvent: (e: any) => events.push(e),
});

describe("StdioAcpAdapter model-warmup prompt", () => {
  it("sends the warmup prompt before the task on a cold (fresh) dispatch", async () => {
    const calls: { method: string; text?: string }[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", modelWarmupPrompt: "Reply READY." } as any,
      {
        startServer,
        createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
      } as any,
    );

    const events: any[] = [];
    await adapter.dispatch(dispatchInput("do the task", events) as any);

    const prompts = calls.filter((c) => c.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.text).toBe("Reply READY."); // warmup first — absorbs /model
    expect(prompts[1]?.text).toBe("do the task"); // real task on a settled session
    expect(events.filter((e) => e.kind === "acp.model_warmup")).toHaveLength(1);
  });

  it("does NOT send a warmup when modelWarmupPrompt is unset (unchanged behavior)", async () => {
    const calls: { method: string; text?: string }[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp" } as any,
      {
        startServer,
        createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
      } as any,
    );

    const events: any[] = [];
    await adapter.dispatch(dispatchInput("do the task", events) as any);

    const prompts = calls.filter((c) => c.method === "session/prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toBe("do the task");
    expect(events.filter((e) => e.kind === "acp.model_warmup")).toHaveLength(0);
  });

  it("does NOT send a warmup for an empty modelWarmupPrompt string", async () => {
    const calls: { method: string; text?: string }[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", modelWarmupPrompt: "" } as any,
      {
        startServer,
        createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
      } as any,
    );

    const events: any[] = [];
    await adapter.dispatch(dispatchInput("do the task", events) as any);

    expect(calls.filter((c) => c.method === "session/prompt")).toHaveLength(1);
  });

  it("skips the warmup on warm-connection reuse — only the first dispatch absorbs /model", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const calls: { method: string; text?: string }[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const mk = () =>
      new StdioAcpAdapter(
        { binary: "mock-acp", warmPool: true, modelWarmupPrompt: "Reply READY." } as any,
        {
          startServer,
          createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
          pool,
        } as any,
      );

    const events: any[] = [];
    await mk().dispatch(dispatchInput("h1", events) as any); // cold → warmup + task
    await mk().dispatch(dispatchInput("h2", events) as any); // warm reuse → task only

    const promptTexts = calls.filter((c) => c.method === "session/prompt").map((c) => c.text);
    expect(promptTexts).toEqual(["Reply READY.", "h1", "h2"]);
    expect(startServer).toHaveBeenCalledTimes(1); // process reused
    expect(events.filter((e) => e.kind === "acp.model_warmup")).toHaveLength(1); // only the cold one
  });

  it("evicts (never releases) a connection whose warmup timed out, so it is not pooled", async () => {
    vi.useFakeTimers();
    try {
      // Mock pool with evict/release spies (mirrors createWarmPoolHarness in
      // stdio-acp.test.ts). deposit returns an idle entry the cold path refs.
      const pool = {
        acquire: vi.fn().mockReturnValue(null), // no warm hit → cold spawn
        deposit: vi.fn().mockReturnValue({ refs: new Set(), sessionId: "session-1" }),
        release: vi.fn(),
        evict: vi.fn(),
        peekMissReason: vi.fn(),
        debugKeys: vi.fn().mockReturnValue([]),
      };
      // The warmup (first session/prompt) hangs forever; the caller's 120s
      // timeout fires it. The real task (second prompt) resolves cleanly.
      let promptCount = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "initialize") return { protocolVersion: 1, authMethods: [] };
        if (method === "session/new") return { sessionId: "session-1" };
        if (method === "session/prompt") {
          promptCount += 1;
          if (promptCount === 1) return new Promise(() => {}); // warmup hangs
          return { stopReason: "end_turn" }; // real task
        }
        return {};
      });
      const adapter = new StdioAcpAdapter(
        { binary: "mock-acp", warmPool: true, modelWarmupPrompt: "Reply READY." } as any,
        {
          startServer: vi.fn().mockResolvedValue(makeServer()),
          createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
          pool,
        } as any,
      );

      const events: any[] = [];
      const dispatchPromise = adapter.dispatch(dispatchInput("do the task", events) as any);

      // Settle init/session-new/deposit + warmup send, then fire the 120s timeout.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      vi.advanceTimersByTime(120_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await dispatchPromise;

      expect(events.filter((e) => e.kind === "acp.model_warmup.failed")).toHaveLength(1);
      expect(events.filter((e) => e.kind === "acp.model_warmup")).toHaveLength(0);
      // Poisoned connection: torn down, never returned to the pool.
      expect(pool.evict).toHaveBeenCalledTimes(1);
      expect(pool.release).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases (does NOT evict) after a clean warmup error — only a timeout poisons the connection", async () => {
    // The asymmetry the fix deliberately preserves: a warmup that REJECTS
    // cleanly (vs hangs) resolves its request, leaving the connection reusable.
    // errorThrown stays false (the catch swallows it into model_warmup.failed)
    // and warmupTimedOut stays false, so the connection is released, not evicted.
    const pool = {
      acquire: vi.fn().mockReturnValue(null),
      deposit: vi.fn().mockReturnValue({ refs: new Set(), sessionId: "session-1" }),
      release: vi.fn(),
      evict: vi.fn(),
      peekMissReason: vi.fn(),
      debugKeys: vi.fn().mockReturnValue([]),
    };
    let promptCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "initialize") return { protocolVersion: 1, authMethods: [] };
      if (method === "session/new") return { sessionId: "session-1" };
      if (method === "session/prompt") {
        promptCount += 1;
        if (promptCount === 1) throw new Error("warmup boom"); // clean reject, not a hang
        return { stopReason: "end_turn" }; // real task succeeds
      }
      return {};
    });
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", warmPool: true, modelWarmupPrompt: "Reply READY." } as any,
      {
        startServer: vi.fn().mockResolvedValue(makeServer()),
        createClient: () => ({ onRequest: vi.fn(), on: vi.fn(), request }) as any,
        pool,
      } as any,
    );

    const events: any[] = [];
    await adapter.dispatch(dispatchInput("do the task", events) as any);

    expect(events.filter((e) => e.kind === "acp.model_warmup.failed")).toHaveLength(1);
    expect(pool.release).toHaveBeenCalledTimes(1);
    expect(pool.evict).not.toHaveBeenCalled();
  });
});
