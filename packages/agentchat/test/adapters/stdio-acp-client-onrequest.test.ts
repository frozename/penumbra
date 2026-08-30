import { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";

interface JsonRpcReply {
  jsonrpc?: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
}

interface Pair {
  stdin: PassThrough;
  stdout: PassThrough;
  written: string[];
}

function pair(): Pair {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (d: Buffer) => written.push(d.toString("utf8")));
  return { stdin, stdout, written };
}

function send(stream: PassThrough, msg: unknown): void {
  stream.write(JSON.stringify(msg) + "\n");
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

function parseWritten(written: string[], index = 0): JsonRpcReply {
  const line = written[index];
  if (line === undefined) throw new Error(`expected written line at index ${String(index)}`);
  return JSON.parse(line.trim()) as JsonRpcReply;
}

describe("StdioAcpClient onRequest", () => {
  it("routes incoming request to handler and sends back response with same id", async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    client.onRequest("fs/read_text_file", (params: unknown) => {
      const p = params as { path?: unknown };
      expect(p.path).toBe("/tmp/x.txt");
      return Promise.resolve({ content: "hello" });
    });

    send(stdout, {
      jsonrpc: "2.0",
      method: "fs/read_text_file",
      params: { path: "/tmp/x.txt" },
      id: 42,
    });
    await flush();

    expect(written.length).toBe(1);
    const reply = parseWritten(written);
    expect(reply.id).toBe(42);
    expect(reply.result).toEqual({ content: "hello" });
    expect(reply.error).toBeUndefined();
  });

  it("reports thrown errors as JSON-RPC error responses", async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    client.onRequest("fs/read_text_file", () => {
      throw new Error("outside worktree");
    });

    send(stdout, { jsonrpc: "2.0", method: "fs/read_text_file", params: {}, id: 7 });
    await flush();

    const reply = parseWritten(written);
    expect(reply.id).toBe(7);
    expect(reply.error).toBeDefined();
    expect(reply.error?.message).toMatch(/outside worktree/);
    expect(reply.result).toBeUndefined();
  });

  it("preserves numeric error codes when the handler provides one", async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    client.onRequest("fs/write_text_file", () => {
      const err: Error & { code?: number } = new Error("denied");
      err.code = -32004;
      throw err;
    });

    send(stdout, { jsonrpc: "2.0", method: "fs/write_text_file", params: {}, id: 8 });
    await flush();

    const reply = parseWritten(written);
    expect(reply.id).toBe(8);
    expect(reply.error?.code).toBe(-32004);
    expect(reply.error?.message).toBe("denied");
  });

  it("responds with method-not-found error when no handler is registered", async () => {
    const { stdin, stdout, written } = pair();
    new StdioAcpClient({ stdin, stdout });

    send(stdout, { jsonrpc: "2.0", method: "unknown/method", params: {}, id: 99 });
    await flush();

    const reply = parseWritten(written);
    expect(reply.id).toBe(99);
    expect(reply.error?.code).toBe(-32601);
    expect(reply.error?.message).toMatch(/method not found|unknown\/method/i);
  });

  it("continues to route notifications (no id) to on() handlers", async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    const received: { value: unknown } = { value: null };
    client.on("session/update", (params: unknown) => {
      received.value = params;
    });

    send(stdout, { jsonrpc: "2.0", method: "session/update", params: { foo: 1 } });
    await flush();

    expect(received.value).toEqual({ foo: 1 });
    expect(written.length).toBe(0);
  });

  it("continues to deliver responses to outgoing requests", async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    const promise = client.request("initialize", { protocolVersion: 1 });
    await flush();
    const sent = parseWritten(written);
    expect(sent.method).toBe("initialize");
    const id = sent.id;

    send(stdout, { jsonrpc: "2.0", result: { protocolVersion: 1 }, id });
    await flush();

    const result: unknown = await promise;
    expect(result).toEqual({ protocolVersion: 1 });
  });
});
