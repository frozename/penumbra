import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";

import type { RpcHandlers, RpcResponse } from "../src/rpc.js";

import { createRpcServer, decodeMessages } from "../src/rpc.js";

function createHarness(handlers: RpcHandlers): {
  send: (line: string) => Promise<RpcResponse>;
  notify: (method: string, params?: unknown) => object[];
} {
  const input = new PassThrough();
  const pending: object[] = [];
  const waiters: ((msg: object) => void)[] = [];

  const deliver = (msg: object): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      pending.push(msg);
    } else {
      waiter(msg);
    }
  };

  const server = createRpcServer(handlers, {
    input,
    output: {
      write: (chunk: string): boolean => {
        for (const msg of decodeMessages(chunk)) {
          deliver(msg);
        }
        return true;
      },
    },
  });
  server.start();

  const send = (line: string): Promise<RpcResponse> => {
    input.write(`${line}\n`);
    const buffered = pending.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered as RpcResponse);
    }
    return new Promise<RpcResponse>((resolve) => {
      waiters.push((msg) => {
        resolve(msg as RpcResponse);
      });
    });
  };

  const notify = (method: string, params?: unknown): object[] => {
    server.notify(method, params);
    return pending.splice(0);
  };

  return { send, notify };
}

function requestLine(id: number | string, method: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method });
}

function rejecting(reason: unknown): (params: unknown) => Promise<unknown> {
  return async (): Promise<unknown> => {
    await Promise.resolve();
    throw reason;
  };
}

describe("rpc error-code mapping", () => {
  it("maps a plain Error rejection to -32000 with its message", async () => {
    const harness = createHarness({ reject: rejecting(new Error("boom")) });
    const resp = await harness.send(requestLine(1, "reject"));
    expect(resp).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "boom" },
    });
  });

  it("preserves a finite numeric code and echoes a string request id", async () => {
    const coded = Object.assign(new Error("not_a_session"), { code: -32002 });
    const harness = createHarness({ reject: rejecting(coded) });
    const resp = await harness.send(requestLine("req-7", "reject"));
    expect(resp.id).toBe("req-7");
    expect(resp.error).toEqual({ code: -32002, message: "not_a_session" });
  });

  it("preserves a zero error code", async () => {
    const coded = Object.assign(new Error("zero"), { code: 0 });
    const harness = createHarness({ reject: rejecting(coded) });
    const resp = await harness.send(requestLine(2, "reject"));
    expect(resp.error).toEqual({ code: 0, message: "zero" });
  });

  it("maps a non-numeric code to -32000", async () => {
    const coded = Object.assign(new Error("bad"), { code: "E_FAIL" });
    const harness = createHarness({ reject: rejecting(coded) });
    const resp = await harness.send(requestLine(3, "reject"));
    expect(resp.error).toEqual({ code: -32000, message: "bad" });
  });

  it("maps NaN and infinite codes to -32000", async () => {
    const harness = createHarness({
      nan: rejecting(Object.assign(new Error("nan"), { code: NaN })),
      inf: rejecting(Object.assign(new Error("inf"), { code: Infinity })),
      ninf: rejecting(Object.assign(new Error("ninf"), { code: -Infinity })),
    });
    for (const method of ["nan", "inf", "ninf"] as const) {
      const resp = await harness.send(requestLine(method, method));
      expect(resp.error).toEqual({ code: -32000, message: method });
    }
  });

  it("maps non-Error rejections to -32000 with String(err) as the message", async () => {
    const harness = createHarness({
      str: rejecting("plain failure"),
      num: rejecting(42),
      nil: rejecting(null),
      obj: rejecting({ note: "no code" }),
    });
    const cases = [
      ["str", "plain failure"],
      ["num", "42"],
      ["nil", "null"],
      ["obj", "[object Object]"],
    ] as const;
    for (const [method, message] of cases) {
      const resp = await harness.send(requestLine(method, method));
      expect(resp.error).toEqual({ code: -32000, message });
    }
  });

  it("reads .message only from Error instances", async () => {
    const harness = createHarness({
      reject: rejecting({ message: "custom", code: 7 }),
    });
    const resp = await harness.send(requestLine(4, "reject"));
    expect(resp.error).toEqual({ code: 7, message: "[object Object]" });
  });
});

describe("line trimming", () => {
  it("decodeMessages parses JSON lines with leading and trailing whitespace", () => {
    expect(decodeMessages('  {"a":1}\t \n\t{"b":2}  ')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("decodeMessages skips whitespace-only and non-brace lines", () => {
    expect(decodeMessages('   \n  [1,2]\n{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it("dispatches a request line padded with whitespace", async () => {
    const harness = createHarness({ ping: () => Promise.resolve({ pong: true }) });
    const padded = harness.send(` \t ${requestLine(1, "ping")} \t `);
    const sentinel = harness.send(requestLine(2, "ping"));
    const first = await padded;
    expect(first.id).toBe(1);
    expect(first.result).toEqual({ pong: true });
    const second = await sentinel;
    expect(second.id).toBe(2);
  });
});

describe("notify params", () => {
  it("omits the params key when params are absent or undefined", () => {
    const harness = createHarness({});
    expect(harness.notify("session/ping")).toEqual([{ jsonrpc: "2.0", method: "session/ping" }]);
    expect(harness.notify("session/ping", undefined)).toEqual([
      { jsonrpc: "2.0", method: "session/ping" },
    ]);
    expect(harness.notify("session/ping")[0]).not.toHaveProperty("params");
  });

  it("serializes explicit null params as params: null", () => {
    const harness = createHarness({});
    const [msg] = harness.notify("session/update", null);
    expect(msg).toEqual({ jsonrpc: "2.0", method: "session/update", params: null });
    expect(msg).toHaveProperty("params", null);
  });

  it("keeps falsy but non-nullish params such as 0 and false", () => {
    const harness = createHarness({});
    expect(harness.notify("zero", 0)).toEqual([{ jsonrpc: "2.0", method: "zero", params: 0 }]);
    expect(harness.notify("flag", false)).toEqual([
      { jsonrpc: "2.0", method: "flag", params: false },
    ]);
  });
});
