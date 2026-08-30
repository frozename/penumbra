import { beforeAll, describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";

import type { RpcResponse } from "../src/rpc.js";

import { createRpcServer, decodeMessages, encodeMessageContentLength } from "../src/rpc.js";

describe("encodeMessageContentLength", () => {
  it("prefixes the JSON body with its UTF-8 byte length", () => {
    const encoded = encodeMessageContentLength({ jsonrpc: "2.0", id: 1, method: "ping" });
    const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    expect(encoded).toBe(
      `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\r\n\r\n${body}`,
    );
  });

  it("counts bytes, not code points, for multi-byte content", () => {
    const body = JSON.stringify({ text: "héllo" });
    const encoded = encodeMessageContentLength({ text: "héllo" });
    expect(
      encoded.startsWith(`Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\r\n\r\n`),
    ).toBe(true);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(body.length);
  });
});

describe("decodeMessages malformed input", () => {
  it("skips malformed JSON lines but keeps valid ones", () => {
    const buf = '{"jsonrpc":"2.0","id":1}\n{not json}\n{"jsonrpc":"2.0","id":2}\n';
    expect(decodeMessages(buf)).toHaveLength(2);
  });

  it("skips lines that do not start with a brace", () => {
    expect(decodeMessages('Content-Length: 12\nnoise\n{"id":3}\n')).toEqual([{ id: 3 }]);
  });
});

describe("createRpcServer", () => {
  const written: string[] = [];
  const input = new PassThrough();
  let server: ReturnType<typeof createRpcServer>;

  beforeAll(() => {
    server = createRpcServer(
      {
        echo: (params) => Promise.resolve({ echoed: params }),
        boom: () => Promise.reject(new Error("handler exploded")),
        boomWithCode: () => Promise.reject(Object.assign(new Error("coded"), { code: -32050 })),
      },
      {
        input,
        output: {
          write: (chunk: string) => written.push(chunk),
        },
      },
    );
    server.start();
  });

  function feedLine(line: string): void {
    input.write(`${line}\n`);
  }

  async function nextResponse(): Promise<RpcResponse> {
    for (let i = 0; i < 50 && written.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const decoded = decodeMessages(written.join(""));
    written.length = 0;
    expect(decoded).toHaveLength(1);
    return decoded[0] as RpcResponse;
  }

  it("notify writes a params-less notification when params are omitted", () => {
    server.notify("session/ping");
    const [msg] = decodeMessages(written.join(""));
    written.length = 0;
    expect(msg).toEqual({ jsonrpc: "2.0", method: "session/ping" });
  });

  it("notify includes params when provided", () => {
    server.notify("session/update", { chunk: "hi" });
    const [msg] = decodeMessages(written.join(""));
    written.length = 0;
    expect(msg).toEqual({ jsonrpc: "2.0", method: "session/update", params: { chunk: "hi" } });
  });

  it("dispatches a request to its handler and responds with the result", async () => {
    feedLine('{"jsonrpc":"2.0","id":7,"method":"echo","params":{"a":1}}');
    const resp = await nextResponse();
    expect(resp).toEqual({ jsonrpc: "2.0", id: 7, result: { echoed: { a: 1 } } });
  });

  it("defaults params to {} when omitted", async () => {
    feedLine('{"jsonrpc":"2.0","id":8,"method":"echo"}');
    const resp = await nextResponse();
    expect(resp.result).toEqual({ echoed: {} });
  });

  it("responds -32700 with a null id to malformed JSON", async () => {
    feedLine('{"jsonrpc":"2.0", broken');
    const resp = await nextResponse();
    expect(resp.id).toBeNull();
    expect(resp.error).toEqual({ code: -32700, message: "Parse error" });
  });

  it("responds -32601 for an unknown method", async () => {
    feedLine('{"jsonrpc":"2.0","id":9,"method":"nope"}');
    const resp = await nextResponse();
    expect(resp.error).toEqual({ code: -32601, message: "Method not found: nope" });
  });

  it("maps a plain handler error to code -32000", async () => {
    feedLine('{"jsonrpc":"2.0","id":10,"method":"boom"}');
    const resp = await nextResponse();
    expect(resp.error).toEqual({ code: -32000, message: "handler exploded" });
  });

  it("preserves a numeric error code from the handler", async () => {
    feedLine('{"jsonrpc":"2.0","id":11,"method":"boomWithCode"}');
    const resp = await nextResponse();
    expect(resp.error).toEqual({ code: -32050, message: "coded" });
  });

  it("ignores non-JSON input lines", async () => {
    feedLine("Content-Length: 42");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(written).toHaveLength(0);
  });
});
