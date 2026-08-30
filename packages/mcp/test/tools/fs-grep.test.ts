import { afterEach, describe, expect, it } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import { fsGrepHandler } from "@src/tools/fs-grep.js";

type GrepDaemon = Pick<DaemonClient, "grepInWorktree">;
type GrepImpl = DaemonClient["grepInWorktree"];
type GrepResult = Awaited<ReturnType<GrepImpl>>;

interface CapturedGrepArgs {
  pattern: string;
  glob: string | null;
  output_mode: "content" | "files_with_matches";
  case_insensitive: boolean;
}

function fakeDaemon(impl?: GrepImpl): GrepDaemon {
  return {
    grepInWorktree:
      impl ?? ((): Promise<GrepResult> => Promise.resolve({ results: [], truncated: false })),
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

describe("fs.grep handler", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("forwards all relevant fields to daemon", async () => {
    let receivedId: string | null = null;
    let receivedArgs: CapturedGrepArgs | null = null;
    const daemon = fakeDaemon((id, args) => {
      receivedId = id;
      receivedArgs = {
        pattern: args.pattern,
        glob: args.glob ?? null,
        output_mode: args.output_mode ?? "content",
        case_insensitive: args.case_insensitive === true,
      };
      return Promise.resolve({ results: [], truncated: false });
    });
    const handler = fsGrepHandler(daemon);
    await handler({
      pattern: "TODO",
      glob: "*.ts",
      output_mode: "content",
      case_insensitive: true,
      handoff_id: "H1",
    });
    expect(receivedId).toBe("H1");
    expect(receivedArgs).toMatchObject({
      pattern: "TODO",
      glob: "*.ts",
      output_mode: "content",
      case_insensitive: true,
    });
  });

  it("defaults handoff_id from env", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    let receivedId: string | null = null;
    const daemon = fakeDaemon((id) => {
      receivedId = id;
      return Promise.resolve({ results: [], truncated: false });
    });
    const handler = fsGrepHandler(daemon);
    await handler({ pattern: "TODO" });
    expect(receivedId).toBe("H_ENV");
  });

  it("returns no_handoff_context error when neither arg nor env set", async () => {
    const handler = fsGrepHandler(fakeDaemon());
    const out = await handler({ pattern: "TODO" });
    expect(isError(out)).toBe(true);
    const text = parseText(out) as { error: { code: string } };
    expect(text.error.code).toBe("no_handoff_context");
  });

  it("surfaces daemon engine_unavailable", async () => {
    const daemon = fakeDaemon(() =>
      Promise.reject(
        new DaemonHttpError("daemon error", 500, {
          error: { code: "engine_unavailable", message: "rg missing" },
        }),
      ),
    );
    const handler = fsGrepHandler(daemon);
    const out = await handler({ pattern: "TODO", handoff_id: "X" });
    expect(isError(out)).toBe(true);
    const text = parseText(out) as { error: { code: string } };
    expect(text.error.code).toBe("engine_unavailable");
  });
});
