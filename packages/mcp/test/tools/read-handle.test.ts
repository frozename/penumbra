import { describe, it, expect } from "bun:test";
import { HandleStore } from "../../src/handle-store.js";
import { buildServer } from "../../src/server.js";
import { readHandleHandler } from "../../src/tools/read-handle.js";

describe("read_handle tool", () => {
  it("returns stored content verbatim for a valid handle", async () => {
    const store = new HandleStore();
    const id = store.put(JSON.stringify({ value: 42 }));
    const handler = readHandleHandler(store);
    const out: any = await handler({ handle_id: id });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toBe(JSON.stringify({ value: 42 }));
    store.close();
  });

  it("returns an isError envelope for an unknown/expired handle", async () => {
    const store = new HandleStore();
    const handler = readHandleHandler(store);
    const out: any = await handler({ handle_id: "bad-id" });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text).error.code).toBe("handle_not_found");
    store.close();
  });

  it("registers read_handle on buildServer boundary path", async () => {
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const server = (await buildServer({ daemon: {} as any })) as any;
    expect(server._registeredTools.read_handle).toBeDefined();
  });
});
