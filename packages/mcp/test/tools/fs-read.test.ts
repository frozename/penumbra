import { describe, it, expect, afterEach } from "bun:test";
import { fsReadHandler } from "../../src/tools/fs-read.js";

function fakeDaemon(impl?: Partial<{ readInWorktree: any }>): any {
  return {
    readInWorktree:
      impl?.readInWorktree ??
      (async () => ({ content: "hello", path: "hello.txt", bytes: 5, truncated: false })),
  };
}

describe("fs.read handler", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("forwards path + handoff_id to daemon and returns content", async () => {
    let received: any = null;
    const daemon = fakeDaemon({
      readInWorktree: async (id: string, args: any) => {
        received = { id, args };
        return { content: "hello world", path: "hello.txt", bytes: 11, truncated: false };
      },
    });
    const handler = fsReadHandler(daemon);
    const out = await handler({ path: "hello.txt", handoff_id: "H1" });
    expect(received.id).toBe("H1");
    expect(received.args.path).toBe("hello.txt");
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.content).toBe("hello world");
  });

  it("defaults handoff_id from PENUMBRA_HANDOFF_ID env when arg absent", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    let receivedId: string | null = null;
    const daemon = fakeDaemon({
      readInWorktree: async (id: string) => {
        receivedId = id;
        return { content: "x", path: "f.txt", bytes: 1, truncated: false };
      },
    });
    const handler = fsReadHandler(daemon);
    await handler({ path: "f.txt" });
    expect(receivedId).toBe("H_ENV");
  });

  it("returns no_handoff_context error when neither arg nor env set", async () => {
    const daemon = fakeDaemon();
    const handler = fsReadHandler(daemon);
    const out = await handler({ path: "f.txt" });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe("no_handoff_context");
  });

  it("surfaces daemon HTTP errors as isError with code preserved", async () => {
    const daemon = fakeDaemon({
      readInWorktree: async () => {
        const err: any = new Error("daemon error");
        err.status = 404;
        err.body = { error: { code: "not_found", message: "file not found" } };
        throw err;
      },
    });
    const handler = fsReadHandler(daemon);
    const out = await handler({ path: "missing.txt", handoff_id: "H1" });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe("not_found");
  });
});
