import type { DaemonClient } from "@src/daemon-client.js";

import { DaemonHttpError } from "@src/daemon-client.js";
import { fsGlobHandler } from "@src/tools/fs-glob.js";
import { afterEach, describe, expect, it } from "bun:test";

type GlobDaemon = Pick<DaemonClient, "globInWorktree">;
type GlobImpl = DaemonClient["globInWorktree"];
type GlobResult = Awaited<ReturnType<GlobImpl>>;

function fakeDaemon(impl?: GlobImpl): GlobDaemon {
  return {
    globInWorktree:
      impl ?? ((): Promise<GlobResult> => Promise.resolve({ results: [], truncated: false })),
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

describe("fs.glob handler", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("forwards pattern + path + handoff_id to daemon", async () => {
    let receivedId: string | null = null;
    let receivedPattern: string | null = null;
    const daemon = fakeDaemon((id, args) => {
      receivedId = id;
      receivedPattern = args.pattern;
      return Promise.resolve({ results: ["x"], truncated: false });
    });
    const handler = fsGlobHandler(daemon);
    const out = await handler({ pattern: "*.ts", handoff_id: "H1" });
    expect(receivedId).toBe("H1");
    expect(receivedPattern).toBe("*.ts");
    const text = parseText(out) as { results: string[] };
    expect(text.results).toEqual(["x"]);
  });

  it("defaults handoff_id from PENUMBRA_HANDOFF_ID env when arg absent", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    let receivedId: string | null = null;
    const daemon = fakeDaemon((id) => {
      receivedId = id;
      return Promise.resolve({ results: [], truncated: false });
    });
    const handler = fsGlobHandler(daemon);
    await handler({ pattern: "*.ts" });
    expect(receivedId).toBe("H_ENV");
  });

  it("returns no_handoff_context error when neither arg nor env set", async () => {
    const handler = fsGlobHandler(fakeDaemon());
    const out = await handler({ pattern: "*.ts" });
    expect(isError(out)).toBe(true);
    const text = parseText(out) as { error: { code: string } };
    expect(text.error.code).toBe("no_handoff_context");
  });

  it("surfaces daemon HTTP errors as isError with code preserved", async () => {
    const daemon = fakeDaemon(() =>
      Promise.reject(
        new DaemonHttpError("daemon error", 404, {
          error: { code: "not_found", message: "worktree not found" },
        }),
      ),
    );
    const handler = fsGlobHandler(daemon);
    const out = await handler({ pattern: "*.ts", handoff_id: "X" });
    expect(isError(out)).toBe(true);
    const text = parseText(out) as { error: { code: string } };
    expect(text.error.code).toBe("not_found");
  });
});
