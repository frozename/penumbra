import { describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";

import {
  buildCliSpawnOpts,
  buildOpencodeCliSpawnOpts,
  cleanGeminiCliOutput,
  makeCliSpawnAdapter,
  makeOpencodeCliAdapter,
} from "@src/adapters/cli-spawn-adapters.js";
import type { DispatchEvent, DispatchInput } from "@src/sdk/adapter.js";
import type { NotificationEvent } from "@src/worker/capture-port.js";

import { expectRejection, makeThoughtCaptureStub } from "../helpers/cli-spawn-fixtures.js";
import { makeMockCapturePort } from "../helpers/stdio-acp-fixtures.js";

// `security find-generic-password -w` blocks on an ACL prompt under a
// non-GUI session, so the keychain shell-out is stubbed at the module seam.
// Pinning the OPENCODE_API_KEY value is out of scope for these tests.
void mock.module("@src/adapters/secret.js", () => ({
  resolveAdapterApiKey: (): string => "stubbed-key",
}));

function makeInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    prompt: "x",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<DispatchEvent>): Promise<DispatchEvent[]> {
  const events: DispatchEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
  }
  return events;
}

const RETRY_LINE = "Export retry time 500ms exceeds remaining timeout 100ms, not retrying further.";

describe("cleanGeminiCliOutput", () => {
  test("removes the MCP-issues sentence even mid-line", () => {
    expect(cleanGeminiCliOutput("a MCP issues detected. Run /mcp list for status. b")).toBe("a  b");
  });

  test("drops a line that is exactly the export-retry sentence", () => {
    expect(cleanGeminiCliOutput(`keep\n${RETRY_LINE}\nend`)).toBe("keep\nend");
  });

  test("keeps a line with the export-retry sentence behind a prefix (^ anchor)", () => {
    const prefixed = "x Export retry time 5ms exceeds remaining timeout 1ms, not retrying further.";
    expect(cleanGeminiCliOutput(prefixed)).toBe(prefixed);
  });

  test("leaves ordinary multi-line text unchanged", () => {
    const text = "first line\nsecond line\nthird";
    expect(cleanGeminiCliOutput(text)).toBe(text);
  });
});

describe("buildCliSpawnOpts", () => {
  test("falls back to defaultArgs when opts.args is undefined", () => {
    const opts = buildCliSpawnOpts(
      "claude-cli",
      {},
      ["code", "--no-tty"],
      "claude",
      null,
      makeInput(),
    );
    expect(opts.args).toEqual(["code", "--no-tty"]);
  });

  test("explicit opts.args wins over defaultArgs, including an empty array", () => {
    const opts = buildCliSpawnOpts(
      "codex-cli",
      { args: [] },
      ["code", "--no-tty"],
      "codex",
      null,
      makeInput(),
    );
    expect(opts.args).toEqual([]);
  });

  test("the command argument becomes SpawnOpts.command, not opts.command", () => {
    const opts = buildCliSpawnOpts(
      "codex-cli",
      { command: "ignored-from-opts" },
      [],
      "from-arg",
      null,
      makeInput(),
    );
    expect(opts.command).toBe("from-arg");
  });

  test("a null thoughtCapture becomes undefined", () => {
    const opts = buildCliSpawnOpts("codex-cli", {}, [], "codex", null, makeInput());
    expect(opts.thoughtCapture).toBeUndefined();
  });

  test("a thoughtCapture stub is passed through by identity", () => {
    const stub = makeThoughtCaptureStub((): void => undefined);
    const opts = buildCliSpawnOpts("codex-cli", {}, [], "codex", stub, makeInput());
    expect(opts.thoughtCapture).toBe(stub);
  });

  test("copies cwd, pass_via, env, unset_env, strip_patterns and emit_stdout_thoughts", () => {
    const env = { FOO: "bar" };
    const unset_env = ["NOPE"];
    const strip_patterns = ["^hook: "];
    const opts = buildCliSpawnOpts(
      "codex-cli",
      {
        cwd: "/tmp/nowhere",
        pass_via: "argv",
        env,
        unset_env,
        strip_patterns,
        emit_stdout_thoughts: true,
      },
      [],
      "codex",
      null,
      makeInput(),
    );
    expect(opts.cwd).toBe("/tmp/nowhere");
    expect(opts.pass_via).toBe("argv");
    expect(opts.env).toBe(env);
    expect(opts.unset_env).toBe(unset_env);
    expect(opts.strip_patterns).toBe(strip_patterns);
    expect(opts.emit_stdout_thoughts).toBe(true);
  });

  test("onCapacityError emits exactly one capacity_error event to the capture port", () => {
    const emitted: NotificationEvent[] = [];
    const capturePort = makeMockCapturePort({
      emit: (ev: NotificationEvent): void => {
        emitted.push(ev);
      },
    });
    const opts = buildCliSpawnOpts("gemini-cli", { capturePort }, [], "gemini", null, makeInput());
    opts.onCapacityError?.({ provider: "google", model: "m1", raw: "r" });
    expect(emitted).toEqual([
      { kind: "capacity_error", provider: "google", model: "m1", raw: "r" },
    ]);
  });

  test("onCapacityError without a capturePort does not throw", () => {
    const opts = buildCliSpawnOpts("gemini-cli", {}, [], "gemini", null, makeInput());
    expect(() => {
      opts.onCapacityError?.({ provider: "google", model: "m1", raw: "r" });
    }).not.toThrow();
  });
});

describe("makeCliSpawnAdapter", () => {
  test("throws when command is missing", () => {
    expect(() => makeCliSpawnAdapter("codex-cli", {}, [], (t) => t, null)).toThrow(
      "codex-cli: command is required",
    );
  });

  test("adapter.kind equals the kind passed in", () => {
    const adapter = makeCliSpawnAdapter("gemini-cli", { command: "echo" }, [], (t) => t, null);
    expect(adapter.kind).toBe("gemini-cli");
  });

  test("dispatch applies the transform to the spawned stdout", async () => {
    const adapter = makeCliSpawnAdapter(
      "codex-cli",
      { command: "sh", args: ["-c", "printf hello"] },
      [],
      (t) => t.toUpperCase(),
      null,
    );
    const out = await adapter.dispatch(makeInput());
    expect(out.text).toBe("HELLO");
  });

  test("dispatchStream yields raw lowercase deltas and a transformed done text", async () => {
    const adapter = makeCliSpawnAdapter(
      "codex-cli",
      { command: "sh", args: ["-c", "printf hello"] },
      [],
      (t) => t.toUpperCase(),
      null,
    );
    const events = await collect(adapter.dispatchStream!(makeInput()));
    const deltas = events.filter(
      (e): e is Extract<DispatchEvent, { type: "delta" }> => e.type === "delta",
    );
    expect(deltas.length).toBeGreaterThan(0);
    const joined = deltas.map((d) => d.text).join("");
    expect(joined).toBe("hello");
    expect(joined).toBe(joined.toLowerCase());
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.result.text).toBe("HELLO");
  });
});

describe("buildOpencodeCliSpawnOpts", () => {
  test("defaults pass_via to argv", async () => {
    const opts = await buildOpencodeCliSpawnOpts({}, "opencode", ["run"], null, makeInput());
    expect(opts.pass_via).toBe("argv");
  });

  test("keeps an explicit stdin pass_via", async () => {
    const opts = await buildOpencodeCliSpawnOpts(
      { pass_via: "stdin" },
      "opencode",
      ["run"],
      null,
      makeInput(),
    );
    expect(opts.pass_via).toBe("stdin");
  });

  test("merges opts.env entries and always defines OPENCODE_API_KEY as a string", async () => {
    const opts = await buildOpencodeCliSpawnOpts(
      { env: { FOO: "bar" } },
      "opencode",
      ["run"],
      null,
      makeInput(),
    );
    expect(opts.env?.FOO).toBe("bar");
    expect(typeof opts.env?.OPENCODE_API_KEY).toBe("string");
  });

  test("opts.env.OPENCODE_API_KEY is overridden by the keychain lookup", async () => {
    const opts = await buildOpencodeCliSpawnOpts(
      { env: { OPENCODE_API_KEY: "from-opts" } },
      "opencode",
      ["run"],
      null,
      makeInput(),
    );
    expect(opts.env?.OPENCODE_API_KEY).not.toBe("from-opts");
  });

  test("undefined and empty mcpServers produce no XDG_CONFIG_HOME and no cleanup", async () => {
    for (const mcpServers of [undefined, []]) {
      const opts = await buildOpencodeCliSpawnOpts(
        { mcpServers },
        "opencode",
        ["run"],
        null,
        makeInput(),
      );
      expect(opts.env?.XDG_CONFIG_HOME).toBeUndefined();
      expect(opts.cleanup).toBeUndefined();
    }
  });

  test("one stdio mcpServer creates the XDG config dir and cleanup removes it", async () => {
    const opts = await buildOpencodeCliSpawnOpts(
      { mcpServers: [{ name: "p", command: "true", args: [], env: [] }] },
      "opencode",
      ["run"],
      null,
      makeInput(),
    );
    const xdg = opts.env?.XDG_CONFIG_HOME;
    try {
      expect(typeof xdg).toBe("string");
      expect(existsSync(xdg!)).toBe(true);
      expect(typeof opts.cleanup).toBe("function");
    } finally {
      await opts.cleanup?.();
    }
    expect(existsSync(xdg!)).toBe(false);
  });
});

describe("makeOpencodeCliAdapter", () => {
  test("throws when model is missing", () => {
    expect(() => makeOpencodeCliAdapter({}, null)).toThrow("opencode-cli: model is required");
  });

  test("adapter.kind is opencode-cli", () => {
    const adapter = makeOpencodeCliAdapter({ model: "m", command: "echo" }, null);
    expect(adapter.kind).toBe("opencode-cli");
  });

  test("bare model gets the opencode/ prefix, default args and argv prompt append", async () => {
    const adapter = makeOpencodeCliAdapter({ model: "gpt-5", command: "echo" }, null);
    const out = await adapter.dispatch(makeInput());
    expect(out.text.trim()).toBe("run --model opencode/gpt-5 x");
  });

  test("a model containing a slash is kept verbatim", async () => {
    const adapter = makeOpencodeCliAdapter({ model: "anthropic/claude", command: "echo" }, null);
    const out = await adapter.dispatch(makeInput());
    expect(out.text.trim()).toBe("run --model anthropic/claude x");
  });

  test("explicit args replace the defaults", async () => {
    const adapter = makeOpencodeCliAdapter({ model: "m", command: "echo", args: ["hi"] }, null);
    const out = await adapter.dispatch(makeInput());
    expect(out.text.trim()).toBe("hi x");
  });

  test("exit 0 with empty stdout and stderr content rejects with the opencode-cli error", async () => {
    const adapter = makeOpencodeCliAdapter(
      { model: "m", command: "sh", args: ["-c", "echo boom 1>&2"] },
      null,
    );
    await expectRejection(adapter.dispatch(makeInput()), /^opencode-cli error: boom/);
  });

  test("the opencode-cli error message truncates stderr to 500 chars", async () => {
    const adapter = makeOpencodeCliAdapter(
      { model: "m", command: "sh", args: ["-c", "printf '%0700d' 0 1>&2"] },
      null,
    );
    const err = await expectRejection(adapter.dispatch(makeInput()));
    expect(err.message).toBe(`opencode-cli error: ${"0".repeat(500)}`);
  });

  test("empty stdout and empty stderr resolve with empty text", async () => {
    const adapter = makeOpencodeCliAdapter(
      { model: "m", command: "sh", args: ["-c", "true"] },
      null,
    );
    const out = await adapter.dispatch(makeInput());
    expect(out.text).toBe("");
  });
});
