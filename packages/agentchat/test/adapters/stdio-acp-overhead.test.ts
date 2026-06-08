import { describe, expect, test, vi } from "vitest";
import { PassThrough } from "node:stream";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";

describe("StdioAcpAdapter framework overhead telemetry", () => {
  test("emits framework_overhead_ms on session start and done meta", async () => {
    const lifecycle: any[] = [];
    const kill = vi.fn();
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp" },
      {
        startServer: vi.fn().mockResolvedValue({
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          pid: 123,
          kill,
          exited: Promise.resolve(0),
        }),
        createClient: () => ({
          onRequest: vi.fn(),
          on: vi.fn(),
          request: vi.fn().mockImplementation(async (method: string) => {
            if (method === "initialize") return { protocolVersion: 1, authMethods: [] };
            if (method === "session/new") return { sessionId: "session-123" };
            if (method === "session/prompt") {
              await new Promise((r) => setTimeout(r, 60));
              return { stopReason: "end_turn" };
            }
            return {};
          }),
        }),
      },
    );

    const events = [];
    for await (const event of adapter.dispatchStream({
      prompt: "hello",
      signal: new AbortController().signal,
      eventContext: { handoffId: "h1", workerId: "w1" },
      onEvent: async (event) => {
        lifecycle.push(event);
      },
    })) {
      events.push(event);
    }

    const sessionStart = lifecycle.find((event) => event.kind === "acp.session.start");
    expect(sessionStart?.meta?.framework_overhead_ms).toBeGreaterThanOrEqual(0);

    const done = events.find((event) => event.type === "done");
    expect(done?.result.meta?.framework_overhead_ms).toBe(
      sessionStart?.meta?.framework_overhead_ms,
    );
    expect(done?.result.meta?.framework_overhead_ms).toBeLessThan(50);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
