import { describe, it, expect, afterEach } from "bun:test";
import { fsWriteHandler } from "../../src/tools/fs-write.js";

function fakeDaemon(impl?: Partial<{ writeInWorktree: any }>): any {
  return {
    writeInWorktree:
      impl?.writeInWorktree ??
      (async () => ({ path: "file.txt", bytes_written: 5, created: true })),
  };
}

describe("fs.write handler", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("forwards path + content + handoff_id to daemon and returns result", async () => {
    let received: any = null;
    const daemon = fakeDaemon({
      writeInWorktree: async (id: string, args: any) => {
        received = { id, args };
        return { path: "hello.txt", bytes_written: 11, created: true };
      },
    });
    const handler = fsWriteHandler(daemon);
    const out = await handler({ path: "hello.txt", content: "hello world", handoff_id: "H1" });
    expect(received.id).toBe("H1");
    expect(received.args.path).toBe("hello.txt");
    expect(received.args.content).toBe("hello world");
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.bytes_written).toBe(11);
    expect(text.created).toBe(true);
  });

  it("defaults handoff_id from PENUMBRA_HANDOFF_ID env when arg absent", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    let receivedId: string | null = null;
    const daemon = fakeDaemon({
      writeInWorktree: async (id: string) => {
        receivedId = id;
        return { path: "f.txt", bytes_written: 2, created: true };
      },
    });
    const handler = fsWriteHandler(daemon);
    await handler({ path: "f.txt", content: "hi" });
    expect(receivedId).toBe("H_ENV");
  });

  it("returns no_handoff_context error when neither arg nor env set", async () => {
    const daemon = fakeDaemon();
    const handler = fsWriteHandler(daemon);
    const out = await handler({ path: "f.txt", content: "hi" });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe("no_handoff_context");
  });

  it("surfaces daemon HTTP errors as isError with code preserved", async () => {
    const daemon = fakeDaemon({
      writeInWorktree: async () => {
        const err: any = new Error("daemon error");
        err.status = 400;
        err.body = { error: { code: "outside_worktree", message: "path escapes worktree" } };
        throw err;
      },
    });
    const handler = fsWriteHandler(daemon);
    const out = await handler({ path: "../evil.txt", content: "bad", handoff_id: "H1" });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe("outside_worktree");
  });
});
