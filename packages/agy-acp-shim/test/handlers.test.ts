import { describe, expect, it } from "bun:test";

import type { AgyHandle, SpawnAgyFn } from "../src/handlers.js";

import { makeHandlers } from "../src/handlers.js";

const noop = (): void => undefined;

interface MockSpawnOpts {
  binary: string;
  args: string[];
  onLine: (line: string) => void;
  prompt?: string;
  signal?: AbortSignal;
}

function mockSpawnAgy(lines: string[], exitCode = 0): SpawnAgyFn {
  return (opts: MockSpawnOpts): AgyHandle => {
    expect(typeof opts.prompt).toBe("string");
    const exited = new Promise<number>((res) => {
      void Promise.resolve().then(() => {
        for (const l of lines) opts.onLine(l);
        res(exitCode);
      });
    });
    return { exited, kill: noop };
  };
}

function mockSlowSpawnAgy(onKill: () => void): SpawnAgyFn {
  return (_opts: MockSpawnOpts): AgyHandle => {
    let killed = false;
    const exited = new Promise<number>((res) => {
      const timeout = setTimeout(() => {
        res(0);
      }, 60_000);
      const checkKill = setInterval(() => {
        if (!killed) return;
        clearInterval(checkKill);
        clearTimeout(timeout);
        res(130);
      }, 10);
    });
    return {
      exited,
      kill: (): void => {
        killed = true;
        onKill();
      },
    };
  };
}

const failingSpawn: SpawnAgyFn = () => {
  throw new Error("spawnAgy should not be called");
};

describe("initialize", () => {
  it("returns protocolVersion and empty capabilities", async () => {
    const handlers = makeHandlers({ spawnAgy: failingSpawn, notify: noop });
    const result = await handlers.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "penumbra", version: "1.0.0" },
    });
    expect(result.protocolVersion).toBe(1);
    expect(result.capabilities?.terminal).toBeFalsy();
    expect(result.capabilities?.fs).toBeFalsy();
  });
});

describe("session/new", () => {
  it("returns a non-empty session ID string", async () => {
    const handlers = makeHandlers({ spawnAgy: failingSpawn, notify: noop });
    const result = await handlers.handleSessionNew({});
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it("returns a different ID on each call", async () => {
    const handlers = makeHandlers({ spawnAgy: failingSpawn, notify: noop });
    const a = await handlers.handleSessionNew({});
    const b = await handlers.handleSessionNew({});
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe("session/prompt (mocked agy)", () => {
  it("emits canonical session/update notifications for each agy output line", async () => {
    const notifications: { method: string; params: unknown }[] = [];
    const handlers = makeHandlers({
      spawnAgy: mockSpawnAgy(["hello", "world"]),
      notify: (method, params) => notifications.push({ method, params }),
    });

    const result = await handlers.handleSessionPrompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "hi" }],
    });

    const deltas = notifications.filter((n) => n.method === "session/update");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[0]?.params).toEqual({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello\n" },
      },
    });
    expect(result).toEqual({ stopReason: "end_turn" });
  });

  it("returns stopReason 'failed' when agy exits with a non-zero code", async () => {
    const handlers = makeHandlers({
      spawnAgy: mockSpawnAgy(["boom"], 1),
      notify: noop,
    });

    const result = await handlers.handleSessionPrompt({
      sessionId: "s-crash",
      prompt: [{ type: "text", text: "hi" }],
    });

    expect(result).toEqual({ stopReason: "failed" });
  });

  it("emits a done notification after agy exits", async () => {
    const notifications: { method: string; params: unknown }[] = [];
    const handlers = makeHandlers({
      spawnAgy: mockSpawnAgy(["pong"]),
      notify: (method, params) => notifications.push({ method, params }),
    });

    const result = await handlers.handleSessionPrompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "ping" }],
    });

    expect(notifications.some((n) => n.method === "done")).toBe(true);
    expect(result).toEqual({ stopReason: "end_turn" });
  });
});

describe("session/cancel", () => {
  it("kills the in-flight agy subprocess", async () => {
    let killed = false;
    const handlers = makeHandlers({
      spawnAgy: mockSlowSpawnAgy(() => {
        killed = true;
      }),
      notify: noop,
    });

    const promptPromise = handlers.handleSessionPrompt({
      sessionId: "s2",
      prompt: [{ type: "text", text: "sleep" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handlers.handleSessionCancel({ sessionId: "s2" });
    await promptPromise.catch(noop);

    expect(killed).toBe(true);
  });

  it("returns stopReason 'cancelled' for a cancelled prompt instead of 'end_turn'", async () => {
    const handlers = makeHandlers({
      spawnAgy: mockSlowSpawnAgy(noop),
      notify: noop,
    });

    const promptPromise = handlers.handleSessionPrompt({
      sessionId: "s-cancel",
      prompt: [{ type: "text", text: "sleep" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handlers.handleSessionCancel({ sessionId: "s-cancel" });
    const result = await promptPromise;

    expect(result).toEqual({ stopReason: "cancelled" });
  });

  it("rejects with an error if no active prompt exists for sessionId", async () => {
    const handlers = makeHandlers({
      spawnAgy: mockSpawnAgy([]),
      notify: noop,
    });

    let threw = false;
    try {
      await handlers.handleSessionCancel({ sessionId: "ghost" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
