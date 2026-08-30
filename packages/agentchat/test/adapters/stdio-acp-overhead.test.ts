import type { DispatchEventInput } from "@penumbra/core";
import type { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import type { StartStdioAcpServerOptions, StdioAcpHandle } from "@src/adapters/stdio-acp-server.js";
import type { DispatchEvent } from "@src/sdk/adapter.js";

import { StdioAcpAdapter } from "@src/adapters/stdio-acp.js";
import { describe, expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";

import { assertDoneEvent } from "../helpers/cli-spawn-fixtures.js";
import { makeMockAcpClient } from "../helpers/stdio-acp-fixtures.js";

/** Pull a numeric `framework_overhead_ms` out of an unknown meta payload. */
function frameworkOverheadMs(meta: Record<string, unknown> | undefined): number {
  const value = meta?.framework_overhead_ms;
  if (typeof value !== "number") {
    throw new Error("expected framework_overhead_ms to be a number");
  }
  return value;
}

describe("StdioAcpAdapter framework overhead telemetry", () => {
  test("emits framework_overhead_ms on session start and done meta", async () => {
    const lifecycle: DispatchEventInput[] = [];
    const kill = vi.fn<() => void>();
    const startServer = vi.fn(
      (_opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> =>
        Promise.resolve({
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          pid: 123,
          kill,
          exited: Promise.resolve(0),
          getStderrTail: (): string => "",
        }),
    );
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>((method) => {
      if (method === "initialize") {
        return Promise.resolve({ protocolVersion: 1, authMethods: [] });
      }
      if (method === "session/new") {
        return Promise.resolve({ sessionId: "session-123" });
      }
      if (method === "session/prompt") {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ stopReason: "end_turn" });
          }, 60);
        });
      }
      return Promise.resolve({});
    });
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp" },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
      },
    );

    const events: DispatchEvent[] = [];
    for await (const event of adapter.dispatchStream({
      prompt: "hello",
      signal: new AbortController().signal,
      conversation: { id: "conv-1", project_id: null },
      config: {},
      eventContext: { handoffId: "h1", workerId: "w1" },
      onEvent: (event): void => {
        lifecycle.push(event);
      },
    })) {
      events.push(event);
    }

    const sessionStart = lifecycle.find((event) => event.kind === "acp.session.start");
    const sessionOverhead = frameworkOverheadMs(sessionStart?.meta);
    expect(sessionOverhead).toBeGreaterThanOrEqual(0);

    const done = assertDoneEvent(events.find((event) => event.type === "done"));
    const doneOverhead = frameworkOverheadMs(done.result.meta);
    expect(doneOverhead).toBe(sessionOverhead);
    expect(doneOverhead).toBeLessThan(50);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
