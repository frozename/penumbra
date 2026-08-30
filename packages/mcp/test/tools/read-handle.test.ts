import { HandleStore } from "@src/handle-store.js";
import { buildServer } from "@src/server.js";
import { readHandleHandler } from "@src/tools/read-handle.js";
import { describe, expect, it } from "bun:test";

import { fakeDaemon } from "../helpers.js";

interface ReadHandleEnvelope {
  isError?: boolean;
  content: { type: "text"; text: string }[];
}

interface RegisteredToolsServer {
  _registeredTools: Record<string, unknown>;
}

describe("read_handle tool", () => {
  it("returns stored content verbatim for a valid handle", async () => {
    const store = new HandleStore();
    const id = store.put(JSON.stringify({ value: 42 }));
    const handler = readHandleHandler(store);
    const out = (await handler({ handle_id: id })) as ReadHandleEnvelope;
    expect(out.isError).toBeUndefined();
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block.type).toBe("text");
    expect(block.text).toBe(JSON.stringify({ value: 42 }));
    store.close();
  });

  it("returns an isError envelope for an unknown/expired handle", async () => {
    const store = new HandleStore();
    const handler = readHandleHandler(store);
    const out = (await handler({ handle_id: "bad-id" })) as ReadHandleEnvelope;
    expect(out.isError).toBe(true);
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    const payload = JSON.parse(block.text) as { error: { code: string } };
    expect(payload.error.code).toBe("handle_not_found");
    store.close();
  });

  it("registers read_handle on buildServer boundary path", async () => {
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const server = (await buildServer({
      daemon: fakeDaemon(),
    })) as unknown as RegisteredToolsServer;
    expect(server._registeredTools["read_handle"]).toBeDefined();
  });
});
