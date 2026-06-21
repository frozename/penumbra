import { afterEach, describe, expect, it } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { DaemonHttpError } from "../../src/daemon-client.js";
import { fsWriteHandler } from "../../src/tools/fs-write.js";

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

describe("fs.write handler", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("forwards path + content + handoff_id to daemon and returns result", async () => {
    let receivedId: string | null = null;
    let receivedPath: string | null = null;
    let receivedContent: string | null = null;
    const daemon = fakeDaemon((id, args) => {
      receivedId = id;
      receivedPath = args.path;
      receivedContent = args.content;
      return Promise.resolve({ path: "hello.txt", bytes_written: 11, created: true });
    });
    const handler = fsWriteHandler(daemon);
    const out = await handler({ path: "hello.txt", content: "hello world", handoff_id: "H1" });
    expect(receivedId).toBe("H1");
    expect(receivedPath).toBe("hello.txt");
    expect(receivedContent).toBe("hello world");
    const text = parseText(out) as { bytes_written: number; created: boolean };
    expect(text.bytes_written).toBe(11);
    expect(text.created).toBe(true);
  });

  it("defaults handoff_id from PENUMBRA_HANDOFF_ID env when arg absent", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    let receivedId: string | null = null;
    const daemon = fakeDaemon((id) => {
      receivedId = id;
      return Promise.resolve({ path: "f.txt", bytes_written: 2, created: true });
    });
    const handler = fsWriteHandler(daemon);
    await handler({ path: "f.txt", content: "hi" });
    expect(receivedId).toBe("H_ENV");
  });

  it("returns no_handoff_context error when neither arg nor env set", async () => {
    const handler = fsWriteHandler(fakeDaemon());
    const out = await handler({ path: "f.txt", content: "hi" });
    expect(isError(out)).toBe(true);
    const text = parseText(out) as { error: { code: string } };
    expect(text.error.code).toBe("no_handoff_context");
  });

  it("surfaces daemon HTTP errors as isError with code preserved", async () => {
    const daemon = fakeDaemon(() =>
      Promise.reject(
        new DaemonHttpError("daemon error", 400, {
          error: { code: "outside_worktree", message: "path escapes worktree" },
        }),
      ),
    );
    const handler = fsWriteHandler(daemon);
    const out = await handler({ path: "../evil.txt", content: "bad", handoff_id: "H1" });
    expect(isError(out)).toBe(true);
    const text = parseText(out) as { error: { code: string } };
    expect(text.error.code).toBe("outside_worktree");
  });
});
