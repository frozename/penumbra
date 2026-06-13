import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";

function pair() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (d) => written.push(d.toString()));
  return { stdin, stdout, written };
}

function send(stream: PassThrough, msg: unknown) {
  stream.write(JSON.stringify(msg) + "\n");
}

async function flush() {
  await new Promise((r) => setTimeout(r, 10));
}

function parseWritten(written: string[], index = 0): any {
  const line = written[index];
  if (line === undefined) throw new Error(`expected written line at index ${index}`);
  return JSON.parse(line.trim());
}

describe("StdioAcpClient onRequest", () => {
  it("routes incoming request to handler and sends back response with same id", async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    client.onRequest("fs/read_text_file", async (params) => {
      expect(params.path).toBe("/tmp/x.txt");
      return { content: "hello" };
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

    client.onRequest("fs/read_text_file", async () => {
      throw new Error("outside worktree");
    });

    send(stdout, { jsonrpc: "2.0", method: "fs/read_text_file", params: {}, id: 7 });
    await flush();

    const reply = parseWritten(written);
    expect(reply.id).toBe(7);
    expect(reply.error).toBeDefined();
    expect(reply.error.message).toMatch(/outside worktree/);
    expect(reply.result).toBeUndefined();
  });

  it("preserves numeric error codes when the handler provides one", async () => {
    const { stdin, stdout, written } = pair();
    const client = new StdioAcpClient({ stdin, stdout });

    client.onRequest("fs/write_text_file", async () => {
      const err = new Error("denied");
      (err as any).code = -32004;
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

    let received: any = null;
    client.on("session/update", (params) => {
      received = params;
    });

    send(stdout, { jsonrpc: "2.0", method: "session/update", params: { foo: 1 } });
    await flush();

    expect(received).toEqual({ foo: 1 });
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

    const result = await promise;
    expect(result).toEqual({ protocolVersion: 1 });
  });
});
