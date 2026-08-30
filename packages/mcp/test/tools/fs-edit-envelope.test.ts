import type { DaemonClient } from "@src/daemon-client.js";

import { HandleStore } from "@src/handle-store.js";
import { isEnvelopeResult } from "@src/responses/envelope.js";
import { fsEditHandler } from "@src/tools/fs-edit.js";
import { readHandleHandler } from "@src/tools/read-handle.js";
import { afterEach, describe, expect, it } from "bun:test";

type EditDaemon = Pick<DaemonClient, "editInWorktree">;
type EditImpl = DaemonClient["editInWorktree"];
type EditResult = Awaited<ReturnType<EditImpl>>;

function fakeDaemon(impl?: EditImpl): EditDaemon {
  return {
    editInWorktree:
      impl ?? ((): Promise<EditResult> => Promise.resolve({ path: "file.txt", replacements: 1 })),
  };
}

describe("fs.edit handler - envelope opt-in", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const result: EditResult = { path: "file.txt", replacements: 1 };
    const handler = fsEditHandler(fakeDaemon(() => Promise.resolve(result)));
    const out = await handler({
      path: "file.txt",
      old_string: "old",
      new_string: "new",
      handoff_id: "H1",
      envelope: true,
    });

    expect(isEnvelopeResult(out)).toBe(true);
    if (!isEnvelopeResult(out)) throw new Error("expected envelope");
    expect(out._meta.token_budget?.limit).toBe(8000);
  });

  it("keeps compact raw payload when envelope is omitted", async () => {
    const result: EditResult = { path: "file.txt", replacements: 1 };
    const handler = fsEditHandler(fakeDaemon(() => Promise.resolve(result)));
    const out = await handler({
      path: "file.txt",
      old_string: "old",
      new_string: "new",
      handoff_id: "H1",
    });

    expect(isEnvelopeResult(out)).toBe(false);
    if (isEnvelopeResult(out)) throw new Error("expected raw");
    const first = out.content[0];
    if (!first) throw new Error("missing content[0]");
    expect(first.text).toBe(JSON.stringify(result));
  });

  it("spills truncated envelope payload to a handle with a valid visible preview", async () => {
    // Pack the oversize payload into the typed `path: string` field so the
    // result remains an in-spec EditResult rather than a synthetic shape.
    const result: EditResult = {
      path: "x".repeat(40_000),
      replacements: 1,
    };
    const rawJson = JSON.stringify(result);
    const store = new HandleStore();
    try {
      const handler = fsEditHandler(
        fakeDaemon(() => Promise.resolve(result)),
        { handleStore: store },
      );
      const out = await handler({
        path: "file.txt",
        old_string: "old",
        new_string: "new",
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
    const handler = fsEditHandler(fakeDaemon());
    const out = await handler({
      path: "f.txt",
      old_string: "old",
      new_string: "new",
      envelope: true,
    });

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
