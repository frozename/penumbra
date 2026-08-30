import { afterEach, describe, expect, it } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { HandleStore } from "@src/handle-store.js";
import { isEnvelopeResult } from "@src/responses/envelope.js";
import { fsReadHandler } from "@src/tools/fs-read.js";
import { readHandleHandler } from "@src/tools/read-handle.js";

type ReadDaemon = Pick<DaemonClient, "readInWorktree">;
type ReadImpl = DaemonClient["readInWorktree"];
type ReadResult = Awaited<ReturnType<ReadImpl>>;

function fakeDaemon(impl?: ReadImpl): ReadDaemon {
  return {
    readInWorktree:
      impl ??
      ((): Promise<ReadResult> =>
        Promise.resolve({ content: "hello", path: "hello.txt", bytes: 5, truncated: false })),
  };
}

describe("fs.read handler - envelope opt-in", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const result: ReadResult = { content: "hello", path: "hello.txt", bytes: 5, truncated: false };
    const handler = fsReadHandler(fakeDaemon(() => Promise.resolve(result)));
    const out = await handler({ path: "hello.txt", handoff_id: "H1", envelope: true });

    expect(isEnvelopeResult(out)).toBe(true);
    if (!isEnvelopeResult(out)) throw new Error("expected envelope");
    expect(out._meta.token_budget?.limit).toBe(8000);
  });

  it("keeps compact raw payload when envelope is omitted", async () => {
    const result: ReadResult = { content: "hello", path: "hello.txt", bytes: 5, truncated: false };
    const handler = fsReadHandler(fakeDaemon(() => Promise.resolve(result)));
    const out = await handler({ path: "hello.txt", handoff_id: "H1" });

    expect(isEnvelopeResult(out)).toBe(false);
    if (isEnvelopeResult(out)) throw new Error("expected raw");
    const first = out.content[0];
    if (!first) throw new Error("missing content[0]");
    expect(first.text).toBe(JSON.stringify(result));
  });

  it("spills truncated envelope payload to a handle with a valid visible preview", async () => {
    const result: ReadResult = {
      content: "x".repeat(40_000),
      path: "huge.txt",
      bytes: 40_000,
      truncated: false,
    };
    const rawJson = JSON.stringify(result);
    const store = new HandleStore();
    try {
      const handler = fsReadHandler(
        fakeDaemon(() => Promise.resolve(result)),
        { handleStore: store },
      );
      const out = await handler({ path: "huge.txt", handoff_id: "H1", envelope: true });

      expect(isEnvelopeResult(out)).toBe(true);
      if (!isEnvelopeResult(out)) throw new Error("expected envelope");
      expect(out._meta.token_budget?.truncated).toBe(true);
      expect(typeof out._meta.handle_id).toBe("string");
      const handleId = out._meta.handle_id;
      if (typeof handleId !== "string") throw new Error("expected handle_id string");
      expect(handleId.length).toBeGreaterThan(0);
      expect(out._meta.result_bytes).toBe(Buffer.byteLength(rawJson, "utf8"));

      const first = out.content[0];
      if (!first?.text) throw new Error("missing content[0].text");
      const preview: unknown = JSON.parse(first.text);
      expect(preview).toEqual({
        truncated: true,
        preview: expect.any(String) as unknown,
      });

      const read = readHandleHandler(store);
      const full = await read({ handle_id: handleId });
      expect(full.isError).toBeUndefined();
      const fullFirst = full.content[0];
      if (!fullFirst) throw new Error("missing content[0]");
      expect(fullFirst.text).toBe(rawJson);
    } finally {
      store.close();
    }
  });

  it("keeps no_handoff_context error shape even when envelope=true", async () => {
    const handler = fsReadHandler(fakeDaemon());
    const out = await handler({ path: "f.txt", envelope: true });

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
