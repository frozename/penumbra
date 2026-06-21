import { describe, expect, it } from "bun:test";

import { decodeMessages, encodeMessage } from "../src/rpc.js";

describe("rpc framing", () => {
  it("encodes a JSON-RPC object and decodes it back", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "initialize", params: {} };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessages(encoded);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ method: "initialize", id: 1 });
  });

  it("decodes multiple messages from a single concatenated buffer", () => {
    const msgs = [
      { jsonrpc: "2.0" as const, id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0" as const, id: 2, method: "session/new", params: {} },
    ];
    const buf = msgs.map(encodeMessage).join("");
    const decoded = decodeMessages(buf);
    expect(decoded).toHaveLength(2);
  });

  it("ignores blank lines", () => {
    const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n\n";
    expect(decodeMessages(encoded)).toHaveLength(1);
  });
});
