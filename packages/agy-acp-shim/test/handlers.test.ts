import { describe, expect, it } from "bun:test";
import { makeHandlers } from "../src/handlers.js";
import type { AgyHandle } from "../src/handlers.js";

function mockSpawnAgy(lines: string[]) {
  return (opts: { onLine: (l: string) => void; prompt?: string }): AgyHandle => {
    expect(typeof opts.prompt).toBe("string");
    const exited = new Promise<number>((res) => {
      Promise.resolve().then(() => {
        for (const l of lines) opts.onLine(l);
        res(0);
      });
    });
    return { exited, kill: () => {} };
  };
}

function mockSlowSpawnAgy(onKill: () => void) {
  return (_opts: { onLine: (l: string) => void; prompt?: string }): AgyHandle => {
    let killed = false;
    const exited = new Promise<number>((res) => {
      const timeout = setTimeout(() => res(0), 60_000);
      const checkKill = setInterval(() => {
        if (!killed) return;
        clearInterval(checkKill);
        clearTimeout(timeout);
        res(130);
      }, 10);
    });
    return {
      exited,
      kill: () => {
        killed = true;
        onKill();
      },
    };
  };
}

describe("initialize", () => {
  it("returns protocolVersion and empty capabilities", async () => {
    const { handleInitialize } = makeHandlers({ spawnAgy: null as any, notify: () => {} });
    const result = await handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "penumbra", version: "1.0.0" },
    });
    expect(result.protocolVersion).toBe(1);
    // no tool capabilities advertised
    expect(result.capabilities?.terminal).toBeFalsy();
    expect(result.capabilities?.fs).toBeFalsy();
  });
});

describe("session/new", () => {
  it("returns a non-empty session ID string", async () => {
    const { handleSessionNew } = makeHandlers({ spawnAgy: null as any, notify: () => {} });
    const result = await handleSessionNew({});
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it("returns a different ID on each call", async () => {
    const { handleSessionNew } = makeHandlers({ spawnAgy: null as any, notify: () => {} });
    const a = await handleSessionNew({});
    const b = await handleSessionNew({});
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe("session/prompt (mocked agy)", () => {
  it("emits canonical session/update notifications for each agy output line", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { handleSessionPrompt } = makeHandlers({
      spawnAgy: mockSpawnAgy(["hello", "world"]) as any,
      notify: (method, params) => notifications.push({ method, params }),
    });

    const result = await handleSessionPrompt({
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

  it("emits a done notification after agy exits", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { handleSessionPrompt } = makeHandlers({
      spawnAgy: mockSpawnAgy(["pong"]) as any,
      notify: (method, params) => notifications.push({ method, params }),
    });

    const result = await handleSessionPrompt({
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
    const { handleSessionPrompt, handleSessionCancel } = makeHandlers({
      spawnAgy: mockSlowSpawnAgy(() => {
        killed = true;
      }) as any,
      notify: () => {},
    });

    const promptPromise = handleSessionPrompt({
      sessionId: "s2",
      prompt: [{ type: "text", text: "sleep" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handleSessionCancel({ sessionId: "s2" });
    await promptPromise.catch(() => {});

    expect(killed).toBe(true);
  });

  it("rejects with an error if no active prompt exists for sessionId", async () => {
    const { handleSessionCancel } = makeHandlers({
      spawnAgy: mockSpawnAgy([]) as any,
      notify: () => {},
    });

    await expect(handleSessionCancel({ sessionId: "ghost" })).rejects.toThrow();
  });
});
