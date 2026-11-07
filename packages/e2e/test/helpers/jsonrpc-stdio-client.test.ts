import { describe, expect, test } from "bun:test";

import type { BunSubprocess } from "./spawn-bin.js";

import { JsonRpcStdioClient } from "./jsonrpc-stdio.js";

interface FakeProcOptions {
  endThrows?: boolean;
}

interface FakeProcFixture {
  proc: BunSubprocess;
  writes: string[];
  push(text: string): void;
  finish(): void;
  fail(err: Error): void;
  endCalls(): number;
}

function makeFakeProc(opts?: FakeProcOptions): FakeProcFixture {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const writes: string[] = [];
  let ended = false;
  let endCallCount = 0;
  const stdout = new ReadableStream<Uint8Array>({
    start(c): void {
      controller = c;
    },
  });
  const stdin = {
    write(data: unknown): number {
      if (ended) {
        throw new Error("sink already ended");
      }
      writes.push(String(data));
      return 0;
    },
    flush(): void {
      /* synchronous no-op */
    },
    end(): void {
      endCallCount += 1;
      ended = true;
      if (opts?.endThrows === true) {
        throw new Error("end failed");
      }
      controller.close();
    },
  };
  return {
    proc: { stdout, stdin } as unknown as BunSubprocess,
    writes,
    push(text: string): void {
      controller.enqueue(new TextEncoder().encode(text));
    },
    finish(): void {
      controller.close();
    },
    fail(err: Error): void {
      controller.error(err);
    },
    endCalls(): number {
      return endCallCount;
    },
  };
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected promise to reject");
}

describe("JsonRpcStdioClient", () => {
  test("request frames ids starting at 1 and incrementing per request", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    const r1 = client.request("a", { x: 1 });
    const r2 = client.request("b");
    expect(fake.writes).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"a","params":{"x":1}}\n',
      '{"jsonrpc":"2.0","id":2,"method":"b"}\n',
    ]);
    fake.push('{"jsonrpc":"2.0","id":1,"result":null}\n');
    fake.push('{"jsonrpc":"2.0","id":2,"result":null}\n');
    expect(await r1).toBeNull();
    expect(await r2).toBeNull();
    fake.finish();
  });

  test("request resolves with the result field of the matching response", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    const p = client.request("a");
    fake.push('{"jsonrpc":"2.0","id":1,"result":{"ok":true,"n":7}}\n');
    expect(await p).toEqual({ ok: true, n: 7 });
    fake.finish();
  });

  test("an error response rejects with 'JSON-RPC error: <code> <message>'", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    const p = client.request("a");
    fake.push('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}\n');
    const err = await captureRejection(p);
    expect(err.message).toBe("JSON-RPC error: -32601 Method not found");
    fake.finish();
  });

  test("a non-JSON line before a response is skipped, not fatal", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    const p = client.request("a");
    fake.push('not json at all\n{"jsonrpc":"2.0","id":1,"result":"after-noise"}\n');
    expect(await p).toBe("after-noise");
    fake.finish();
  });

  test("a response split across two stdout chunks is reassembled", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    const p1 = client.request("a");
    const p2 = client.request("b");
    fake.push('{"jsonrpc":"2.0","id":1,');
    fake.push('"result":"joined"}\n');
    fake.push('{"jsonrpc":"2.0","id":2,"result":"two"}\n');
    expect(await p2).toBe("two");
    fake.fail(new Error("stream torn down"));
    expect(await p1).toBe("joined");
  });

  test("concurrent requests resolve by id even when responses arrive out of order", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    const p1 = client.request("a");
    const p2 = client.request("b");
    fake.push('{"jsonrpc":"2.0","id":2,"result":"second"}\n');
    fake.push('{"jsonrpc":"2.0","id":1,"result":"first"}\n');
    expect(await p1).toBe("first");
    expect(await p2).toBe("second");
    fake.finish();
  });

  test("a stdout stream error rejects in-flight requests with that same error", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    const p = client.request("a");
    const boom = new Error("boom");
    fake.fail(boom);
    const err = await captureRejection(p);
    expect(err).toBe(boom);
  });

  test("after the reader dies, request throws the reader-died message without writing", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    const p = client.request("a");
    fake.fail(new Error("boom"));
    await captureRejection(p);
    const n = fake.writes.length;
    const err = await captureRejection(client.request("b"));
    expect(err.message).toBe("reader loop has died (subprocess likely crashed)");
    expect(fake.writes.length).toBe(n);
  });

  test("request after close rejects with 'client is closed'", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    await client.close();
    const err = await captureRejection(client.request("a"));
    expect(err.message).toBe("client is closed");
  });

  test("notify after close rejects with 'client is closed'", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    await client.close();
    const err = await captureRejection(client.notify("n"));
    expect(err.message).toBe("client is closed");
  });

  test("close is idempotent: a second close does not end stdin again", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    await client.close();
    await client.close();
    expect(fake.endCalls()).toBe(1);
  });

  test("close swallows a throwing stdin end()", async () => {
    const fake = makeFakeProc({ endThrows: true });
    const client = new JsonRpcStdioClient(fake.proc);
    fake.finish();
    await client.close();
    expect(fake.endCalls()).toBe(1);
  });

  test("notify frames a message with no id", async () => {
    const fake = makeFakeProc();
    const client = new JsonRpcStdioClient(fake.proc);
    await client.notify("notifications/initialized", { a: 1 });
    expect(fake.writes).toEqual([
      '{"jsonrpc":"2.0","method":"notifications/initialized","params":{"a":1}}\n',
    ]);
    fake.finish();
  });
});
