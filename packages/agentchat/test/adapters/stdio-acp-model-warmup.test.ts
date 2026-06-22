import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it, vi } from "bun:test";
import { PassThrough } from "node:stream";

import type { AcpWarmPool } from "../../src/adapters/acp-warm-pool.js";
import type { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import type { StdioAcpHandle } from "../../src/adapters/stdio-acp-server.js";
import type { DispatchInput } from "../../src/sdk/adapter.js";

import { createAcpWarmPool } from "../../src/adapters/acp-warm-pool.js";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";

/**
 * modelWarmupPrompt absorbs the per-process `/model` handshake that an
 * ANTHROPIC_MODEL env pin triggers on claude-agent-acp. On a fresh process the
 * first prompt is eaten by the `/model` injection (responds, then `end_turn`,
 * having run nothing) — so without a warmup the FIRST dispatch on every cold
 * process was recorded as no_worktree_activity. These tests pin the wiring:
 * cold dispatches send the warmup first, warm reuse skips it.
 */

interface RecordedCall {
  method: string;
  text?: string;
}

interface ServerHandleStub extends StdioAcpHandle {
  kill: () => void;
}

function makeServer(): ServerHandleStub {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    pid: 4242,
    kill: vi.fn(),
    exited: new Promise<number | null>(() => {
      /* never resolves — server hang doubles as a no-op exit watcher */
    }),
    getStderrTail: () => "",
  };
}

interface PromptParams {
  prompt?: { text?: string }[];
}

interface ClientStub {
  onRequest: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
}

// Single documented launder: StdioAcpClient is a nominal class with private
// fields, so the structurally-mocked test double needs one `as unknown as` to
// be accepted by the adapter's deps slot.
const asAcpClient = (stub: ClientStub): StdioAcpClient => stub as unknown as StdioAcpClient;

// Single documented launder for partial AcpWarmPool stubs (tests intentionally
// implement only the methods they assert on).
const asAcpPool = (stub: Partial<AcpWarmPool>): AcpWarmPool => stub as unknown as AcpWarmPool;

/** Request spy recording method + (for prompts) the text sent. */
function makeRequest(calls: RecordedCall[]): ReturnType<typeof vi.fn> {
  return vi.fn((method: string, params?: PromptParams): Promise<unknown> => {
    calls.push({ method, text: params?.prompt?.[0]?.text });
    if (method === "initialize") return Promise.resolve({ protocolVersion: 1, authMethods: [] });
    if (method === "session/new") {
      return Promise.resolve({ sessionId: `session-${String(calls.length)}` });
    }
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
  onEvent: (e) => events.push(e),
});

describe("StdioAcpAdapter model-warmup prompt", () => {
  it("sends the warmup prompt before the task on a cold (fresh) dispatch", async () => {
    const calls: RecordedCall[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", modelWarmupPrompt: "Reply READY." },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          asAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
      },
    );

    const events: DispatchEventInput[] = [];
    await adapter.dispatch(dispatchInput("do the task", events));

    const prompts = calls.filter((c) => c.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.text).toBe("Reply READY."); // warmup first — absorbs /model
    expect(prompts[1]?.text).toBe("do the task"); // real task on a settled session
    expect(events.filter((e) => e.kind === "acp.model_warmup")).toHaveLength(1);
  });

  it("does NOT send a warmup when modelWarmupPrompt is unset (unchanged behavior)", async () => {
    const calls: RecordedCall[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp" },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          asAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
      },
    );

    const events: DispatchEventInput[] = [];
    await adapter.dispatch(dispatchInput("do the task", events));

    const prompts = calls.filter((c) => c.method === "session/prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toBe("do the task");
    expect(events.filter((e) => e.kind === "acp.model_warmup")).toHaveLength(0);
  });

  it("does NOT send a warmup for an empty modelWarmupPrompt string", async () => {
    const calls: RecordedCall[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", modelWarmupPrompt: "" },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          asAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
      },
    );

    const events: DispatchEventInput[] = [];
    await adapter.dispatch(dispatchInput("do the task", events));

    expect(calls.filter((c) => c.method === "session/prompt")).toHaveLength(1);
  });

  it("skips the warmup on warm-connection reuse — only the first dispatch absorbs /model", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const calls: RecordedCall[] = [];
    const request = makeRequest(calls);
    const startServer = vi.fn().mockResolvedValue(makeServer());
    const mk = (): StdioAcpAdapter =>
      new StdioAcpAdapter(
        { binary: "mock-acp", warmPool: true, modelWarmupPrompt: "Reply READY." },
        {
          startServer,
          createClient: (): StdioAcpClient =>
            asAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
          pool,
        },
      );

    const events: DispatchEventInput[] = [];
    await mk().dispatch(dispatchInput("h1", events)); // cold → warmup + task
    await mk().dispatch(dispatchInput("h2", events)); // warm reuse → task only

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
      const poolStub = {
        acquire: vi.fn().mockReturnValue(null), // no warm hit → cold spawn
        deposit: vi.fn().mockReturnValue({ refs: new Set(), sessionId: "session-1" }),
        release: vi.fn(),
        evict: vi.fn(),
        peekMissReason: vi.fn(),
        debugKeys: vi.fn().mockReturnValue([]),
      };
      const pool = asAcpPool(poolStub);
      // The warmup (first session/prompt) hangs forever; the caller's 120s
      // timeout fires it. The real task (second prompt) resolves cleanly.
      let promptCount = 0;
      const request = vi.fn((method: string): Promise<unknown> => {
        if (method === "initialize") {
          return Promise.resolve({ protocolVersion: 1, authMethods: [] });
        }
        if (method === "session/new") return Promise.resolve({ sessionId: "session-1" });
        if (method === "session/prompt") {
          promptCount += 1;
          if (promptCount === 1) {
            return new Promise<unknown>(() => {
              /* warmup hangs forever — the 120s timeout fires it */
            });
          }
          return Promise.resolve({ stopReason: "end_turn" }); // real task
        }
        return Promise.resolve({});
      });
      const adapter = new StdioAcpAdapter(
        { binary: "mock-acp", warmPool: true, modelWarmupPrompt: "Reply READY." },
        {
          startServer: vi.fn().mockResolvedValue(makeServer()),
          createClient: (): StdioAcpClient =>
            asAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
          pool,
        },
      );

      const events: DispatchEventInput[] = [];
      const dispatchPromise = adapter.dispatch(dispatchInput("do the task", events));

      // Settle init/session-new/deposit + warmup send, then fire the 120s timeout.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      vi.advanceTimersByTime(120_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await dispatchPromise;

      expect(events.filter((e) => e.kind === "acp.model_warmup.failed")).toHaveLength(1);
      expect(events.filter((e) => e.kind === "acp.model_warmup")).toHaveLength(0);
      // Poisoned connection: torn down, never returned to the pool.
      expect(poolStub.evict).toHaveBeenCalledTimes(1);
      expect(poolStub.release).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases (does NOT evict) after a clean warmup error — only a timeout poisons the connection", async () => {
    // The asymmetry the fix deliberately preserves: a warmup that REJECTS
    // cleanly (vs hangs) resolves its request, leaving the connection reusable.
    // errorThrown stays false (the catch swallows it into model_warmup.failed)
    // and warmupTimedOut stays false, so the connection is released, not evicted.
    const poolStub = {
      acquire: vi.fn().mockReturnValue(null),
      deposit: vi.fn().mockReturnValue({ refs: new Set(), sessionId: "session-1" }),
      release: vi.fn(),
      evict: vi.fn(),
      peekMissReason: vi.fn(),
      debugKeys: vi.fn().mockReturnValue([]),
    };
    const pool = asAcpPool(poolStub);
    let promptCount = 0;
    const request = vi.fn((method: string): Promise<unknown> => {
      if (method === "initialize") return Promise.resolve({ protocolVersion: 1, authMethods: [] });
      if (method === "session/new") return Promise.resolve({ sessionId: "session-1" });
      if (method === "session/prompt") {
        promptCount += 1;
        if (promptCount === 1) return Promise.reject(new Error("warmup boom")); // clean reject, not a hang
        return Promise.resolve({ stopReason: "end_turn" }); // real task succeeds
      }
      return Promise.resolve({});
    });
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", warmPool: true, modelWarmupPrompt: "Reply READY." },
      {
        startServer: vi.fn().mockResolvedValue(makeServer()),
        createClient: (): StdioAcpClient =>
          asAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
        pool,
      },
    );

    const events: DispatchEventInput[] = [];
    await adapter.dispatch(dispatchInput("do the task", events));

    expect(events.filter((e) => e.kind === "acp.model_warmup.failed")).toHaveLength(1);
    expect(poolStub.release).toHaveBeenCalledTimes(1);
    expect(poolStub.evict).not.toHaveBeenCalled();
  });
});
