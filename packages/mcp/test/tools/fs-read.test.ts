import type { DaemonClient } from "@src/daemon-client.js";

import { DaemonHttpError } from "@src/daemon-client.js";
import { fsReadHandler } from "@src/tools/fs-read.js";
import { afterEach, describe, expect, it } from "bun:test";

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

interface TextOutput {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function parseText(out: unknown): unknown {
  const typed = out as TextOutput;
  const first = typed.content[0];
  if (!first) throw new Error("missing content[0]");
  return JSON.parse(first.text);
}

function isError(out: unknown): boolean {
  return (out as TextOutput).isError === true;
}

describe("fs.read handler", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("forwards path + handoff_id to daemon and returns content", async () => {
    let receivedId: string | null = null;
    let receivedPath: string | null = null;
    const daemon = fakeDaemon((id, args) => {
      receivedId = id;
      receivedPath = args.path;
      return Promise.resolve({
        content: "hello world",
        path: "hello.txt",
        bytes: 11,
        truncated: false,
      });
    });
    const handler = fsReadHandler(daemon);
    const out = await handler({ path: "hello.txt", handoff_id: "H1" });
    expect(receivedId).toBe("H1");
    expect(receivedPath).toBe("hello.txt");
    const text = parseText(out) as { content: string };
    expect(text.content).toBe("hello world");
  });

  it("defaults handoff_id from PENUMBRA_HANDOFF_ID env when arg absent", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    let receivedId: string | null = null;
    const daemon = fakeDaemon((id) => {
      receivedId = id;
      return Promise.resolve({ content: "x", path: "f.txt", bytes: 1, truncated: false });
    });
    const handler = fsReadHandler(daemon);
    await handler({ path: "f.txt" });
    expect(receivedId).toBe("H_ENV");
  });

  it("returns no_handoff_context error when neither arg nor env set", async () => {
    const handler = fsReadHandler(fakeDaemon());
    const out = await handler({ path: "f.txt" });
    expect(isError(out)).toBe(true);
    const text = parseText(out) as { error: { code: string } };
    expect(text.error.code).toBe("no_handoff_context");
  });

  it("surfaces daemon HTTP errors as isError with code preserved", async () => {
    const daemon = fakeDaemon(() =>
      Promise.reject(
        new DaemonHttpError("daemon error", 404, {
          error: { code: "not_found", message: "file not found" },
        }),
      ),
    );
    const handler = fsReadHandler(daemon);
    const out = await handler({ path: "missing.txt", handoff_id: "H1" });
    expect(isError(out)).toBe(true);
    const text = parseText(out) as { error: { code: string } };
    expect(text.error.code).toBe("not_found");
  });
});
