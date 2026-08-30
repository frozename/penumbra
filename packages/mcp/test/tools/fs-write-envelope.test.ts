import type { DaemonClient } from "@src/daemon-client.js";

import { HandleStore } from "@src/handle-store.js";
import { isEnvelopeResult } from "@src/responses/envelope.js";
import { fsWriteHandler } from "@src/tools/fs-write.js";
import { readHandleHandler } from "@src/tools/read-handle.js";
import { afterEach, describe, expect, it } from "bun:test";

type WriteDaemon = Pick<DaemonClient, "writeInWorktree">;
type WriteImpl = DaemonClient["writeInWorktree"];
type WriteResult = Awaited<ReturnType<WriteImpl>>;

function fakeDaemon(impl?: WriteImpl): WriteDaemon {
  return {
    writeInWorktree:
      impl ??
      ((): Promise<WriteResult> =>
        Promise.resolve({ path: "file.txt", bytes_written: 5, created: true })),
  };
}

describe("fs.write handler - envelope opt-in", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const result: WriteResult = { path: "file.txt", bytes_written: 5, created: true };
    const handler = fsWriteHandler(fakeDaemon(() => Promise.resolve(result)));
    const out = await handler({
      path: "file.txt",
      content: "hello",
      handoff_id: "H1",
      envelope: true,
    });

    expect(isEnvelopeResult(out)).toBe(true);
    if (!isEnvelopeResult(out)) throw new Error("expected envelope");
    expect(out._meta.token_budget?.limit).toBe(8000);
  });

  it("keeps compact raw payload when envelope is omitted", async () => {
    const result: WriteResult = { path: "file.txt", bytes_written: 5, created: true };
    const handler = fsWriteHandler(fakeDaemon(() => Promise.resolve(result)));
    const out = await handler({ path: "file.txt", content: "hello", handoff_id: "H1" });

    expect(isEnvelopeResult(out)).toBe(false);
    if (isEnvelopeResult(out)) throw new Error("expected raw");
    const first = out.content[0];
    if (!first) throw new Error("missing content[0]");
    expect(first.text).toBe(JSON.stringify(result));
  });

  it("spills truncated envelope payload to a handle with a valid visible preview", async () => {
    // Pack the oversize payload into the typed `path: string` field so the
    // result stays a real WriteResult instead of a synthetic shape.
    const result: WriteResult = {
      path: "x".repeat(40_000),
      bytes_written: 40_000,
      created: true,
    };
    const rawJson = JSON.stringify(result);
    const store = new HandleStore();
    try {
      const handler = fsWriteHandler(
        fakeDaemon(() => Promise.resolve(result)),
        { handleStore: store },
      );
      const out = await handler({
        path: "file.txt",
        content: "hello",
        handoff_id: "H1",
        envelope: true,
      });

      expect(isEnvelopeResult(out)).toBe(true);
      if (!isEnvelopeResult(out)) throw new Error("expected envelope");
      expect(out._meta.token_budget?.truncated).toBe(true);
      expect(typeof out._meta.handle_id).toBe("string");
      const first = out.content[0];
      if (!first?.text) throw new Error("missing content[0].text");
      expect(JSON.parse(first.text)).toEqual({
        truncated: true,
        preview: expect.any(String) as unknown,
      });
      expect(out._meta.result_bytes).toBe(Buffer.byteLength(rawJson, "utf8"));

      const handleId = out._meta.handle_id;
      if (typeof handleId !== "string") throw new Error("expected handle_id string");
      const full = await readHandleHandler(store)({ handle_id: handleId });
      const fullFirst = full.content[0];
      if (!fullFirst) throw new Error("missing content[0]");
      expect(fullFirst.text).toBe(rawJson);
    } finally {
      store.close();
    }
  });

  it("keeps no_handoff_context error shape even when envelope=true", async () => {
    const handler = fsWriteHandler(fakeDaemon());
    const out = await handler({ path: "f.txt", content: "hi", envelope: true });

    expect(isEnvelopeResult(out)).toBe(false);
    expect(out).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "no_handoff_context",
              message:
                "pass handoff_id explicitly or run inside a dispatch (PENUMBRA_HANDOFF_ID env var unset)",
            },
          }),
        },
      ],
      isError: true,
    });
  });
});
