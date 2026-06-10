import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import { describe, expect, spyOn, test } from "bun:test";
import {
  detectCapacityError,
  spawnCliAdapter,
  spawnCliAdapterStream,
} from "../../src/adapters/cli-spawn.js";

test("spawnCliAdapter pipes prompt to stdin and returns stdout", async () => {
  const out = await spawnCliAdapter({
    command: "cat",
    args: [],
    prompt: "hello\nworld\n",
    signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe("hello\nworld");
});

test("spawnCliAdapter passes prompt via argv when configured", async () => {
  const out = await spawnCliAdapter({
    command: "sh",
    args: ["-c", 'echo "$1"', "--"],
    prompt: "hello via argv",
    signal: new AbortController().signal,
    pass_via: "argv",
  });
  expect(out.text.trim()).toBe("hello via argv");
});

test("spawnCliAdapter throws on non-zero exit", async () => {
  const calls: any[] = [];
  await expect(
    spawnCliAdapter({
      command: "sh",
      args: [
        "-c",
        'echo "gemini: RetryableQuotaError: No capacity available for model gemini-3.1-pro-preview" 1>&2; exit 7',
      ],
      prompt: "",
      signal: new AbortController().signal,
      onCapacityError: (err) => calls.push(err),
    }),
  ).rejects.toThrow(/exit code 7/);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ provider: "google", model: "gemini-3.1-pro-preview" });
});

test("spawnCliAdapter removes inherited env vars listed in unset_env", async () => {
  process.env.AGENTCHAT_TEST_VAR = "should-be-gone";
  try {
    const withVar = await spawnCliAdapter({
      command: "sh",
      args: ["-c", 'printf %s "${AGENTCHAT_TEST_VAR-MISSING}"'],
      prompt: "",
      signal: new AbortController().signal,
    });
    expect(withVar.text).toBe("should-be-gone");

    const withoutVar = await spawnCliAdapter({
      command: "sh",
      args: ["-c", 'printf %s "${AGENTCHAT_TEST_VAR-MISSING}"'],
      prompt: "",
      signal: new AbortController().signal,
      unset_env: ["AGENTCHAT_TEST_VAR"],
    });
    expect(withoutVar.text).toBe("MISSING");
  } finally {
    delete process.env.AGENTCHAT_TEST_VAR;
  }
});

test("spawnCliAdapter strips lines matching strip_patterns regexes from output", async () => {
  const out = await spawnCliAdapter({
    command: "sh",
    args: ["-c", 'printf "hook: SessionStart\\nMODEL_REPLY_OK\\nhook: Stop\\n"'],
    prompt: "",
    signal: new AbortController().signal,
    strip_patterns: ["^hook: .*$"],
  });
  expect(out.text.trim()).toBe("MODEL_REPLY_OK");
});

test("spawnCliAdapter without strip_patterns leaves output untouched", async () => {
  const out = await spawnCliAdapter({
    command: "sh",
    args: ["-c", 'printf "line one\\nline two\\n"'],
    prompt: "",
    signal: new AbortController().signal,
  });
  expect(out.text).toBe("line one\nline two\n");
});

test("parses <thinking>…</thinking> blocks from stdout when emit_stdout_thoughts is true", async () => {
  const calls: any[] = [];
  const thoughtCapture = {
    recordThought: (input: any) => calls.push(input),
  };

  const out = await spawnCliAdapter({
    command: "sh",
    args: [
      "-c",
      'printf "<thinking> first pass </thinking>\\nVISIBLE\\n<thinking>second pass</thinking>\\n<thinking>   </thinking>\\n"',
    ],
    prompt: "",
    signal: new AbortController().signal,
    emit_stdout_thoughts: true,
    thoughtCapture,
    eventContext: { handoffId: "h-think", workerId: "w-cli", agentName: "gemini-cli" },
  } as any);

  expect(out.text).toBe(
    "<thinking> first pass </thinking>\nVISIBLE\n<thinking>second pass</thinking>\n<thinking>   </thinking>\n",
  );
  expect(calls).toEqual([
    { handoffId: "h-think", adapter: "cli-spawn", agentName: "gemini-cli", text: "first pass" },
    { handoffId: "h-think", adapter: "cli-spawn", agentName: "gemini-cli", text: "second pass" },
  ]);
});

test("does not parse <thinking> blocks when emit_stdout_thoughts is false (default)", async () => {
  const calls: any[] = [];
  const thoughtCapture = {
    recordThought: (input: any) => calls.push(input),
  };

  const out = await spawnCliAdapter({
    command: "sh",
    args: ["-c", 'printf "<thinking> first pass </thinking>\\nVISIBLE\\n"'],
    prompt: "",
    signal: new AbortController().signal,
    thoughtCapture,
    eventContext: { handoffId: "h-think-off", workerId: "w-cli", agentName: "gemini-cli" },
  } as any);

  expect(out.text).toBe("<thinking> first pass </thinking>\nVISIBLE\n");
  expect(calls).toHaveLength(0);
});

test("spawnCliAdapter aborts on signal", async () => {
  const ac = new AbortController();
  const p = spawnCliAdapter({
    command: "sleep",
    args: ["5"],
    prompt: "",
    signal: ac.signal,
  });
  ac.abort();
  await expect(p).rejects.toThrow();
});

test("spawnCliAdapter escalates from SIGTERM to SIGKILL after the cancel grace", async () => {
  const ac = new AbortController();
  const p = spawnCliAdapter({
    command: "sh",
    args: ["-c", 'trap "" TERM; while :; do sleep 1; done'],
    prompt: "",
    signal: ac.signal,
    env: { PENUMBRA_CANCEL_GRACE_S: "0.05" },
  });
  ac.abort();
  await expect(p).rejects.toThrow();
});

test("spawnCliAdapter throws when the child exits due to signal", async () => {
  await expect(
    spawnCliAdapter({
      command: "sh",
      args: ["-c", "kill -TERM $$"],
      prompt: "",
      signal: new AbortController().signal,
      pass_via: "argv",
    }),
  ).rejects.toThrow(/signal SIGTERM/);
});

test("spawnCliAdapter emits lifecycle events only when eventContext is present", async () => {
  const withoutContext: any[] = [];
  await spawnCliAdapter({
    command: "sh",
    args: ["-c", "echo ok"],
    prompt: "",
    signal: new AbortController().signal,
    onEvent: (event: any) => withoutContext.push(event),
  } as any);
  expect(withoutContext).toHaveLength(0);

  const events: any[] = [];
  await spawnCliAdapter({
    command: "sh",
    args: ["-c", "echo ok"],
    prompt: "",
    signal: new AbortController().signal,
    eventContext: { handoffId: "h-cli", workerId: "w-cli" },
    onEvent: (event: any) => events.push(event),
  } as any);
  expect(events.map((event) => event.kind)).toEqual(["proc.spawn", "proc.exited.resolved"]);
  expect(events[0]).toMatchObject({ handoff_id: "h-cli", worker_id: "w-cli", source: "worker" });
});

test("spawnCliAdapter emits proc.kill.sent on abort", async () => {
  const events: any[] = [];
  const ac = new AbortController();
  const p = spawnCliAdapter({
    command: "sleep",
    args: ["5"],
    prompt: "",
    signal: ac.signal,
    eventContext: { handoffId: "h-kill", workerId: "w-cli" },
    onEvent: (event: any) => events.push(event),
  } as any);

  ac.abort();
  await expect(p).rejects.toThrow();
  expect(
    events.some((event) => event.kind === "proc.kill.sent" && event.meta?.signal === "SIGTERM"),
  ).toBe(true);
});

test("spawnCliAdapterStream emits proc.exited.resolved on watchdog timeout before throwing", async () => {
  const events: any[] = [];
  const stream = spawnCliAdapterStream({
    command: "sleep",
    args: ["60"],
    prompt: "",
    signal: new AbortController().signal,
    env: { PENUMBRA_DISPATCH_TIMEOUT_S: "0.1" },
    eventContext: { handoffId: "h-watchdog-stream", workerId: "w-cli" },
    onEvent: (event: any) => events.push(event),
  } as any);

  const seen: any[] = [];
  let thrown: unknown;
  try {
    for await (const ev of stream) {
      seen.push(ev);
    }
  } catch (err) {
    thrown = err;
  }

  expect(seen.some((event) => event.type === "done")).toBe(false);
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/dispatch exceeded 100ms \(watchdog\)/);
  expect(
    events.some(
      (event) =>
        event.kind === "proc.exited.resolved" &&
        event.meta?.signal === "SIGKILL" &&
        event.meta?.reason === "watchdog",
    ),
  ).toBe(true);
});

test("spawnCliAdapterStream kills a live child when stdout iteration throws mid-stream", async () => {
  let killed = false;
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
    const proc = new EventEmitter() as any;
    proc.pid = 1234;
    proc.exitCode = null;
    proc.signalCode = null;
    proc.stdin = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = (signal: string) => {
      killed = true;
      proc.signalCode = signal as NodeJS.Signals;
      queueMicrotask(() => {
        proc.stderr.end();
        proc.emit("exit", null, signal);
      });
      return true;
    };
    proc.stdout = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("partial");
        throw new Error("stdout broke");
      },
    };
    return proc;
  });

  let thrown: unknown;
  const events: any[] = [];
  try {
    for await (const ev of spawnCliAdapterStream({
      command: "mock-cli",
      args: [],
      prompt: "",
      signal: new AbortController().signal,
      onEvent: (event: any) => events.push(event),
      log: { debug: () => {} },
    } as any)) {
      void ev;
    }
  } catch (err) {
    thrown = err;
  } finally {
    spawnSpy.mockRestore();
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("stdout broke");
  expect(killed).toBe(true);
});

test("spawnCliAdapter emits proc.exited.resolved on watchdog timeout before throwing", async () => {
  const events: any[] = [];
  await expect(
    spawnCliAdapter({
      command: "sleep",
      args: ["60"],
      prompt: "",
      signal: new AbortController().signal,
      env: { PENUMBRA_DISPATCH_TIMEOUT_S: "0.1" },
      eventContext: { handoffId: "h-watchdog", workerId: "w-cli" },
      onEvent: (event: any) => events.push(event),
    } as any),
  ).rejects.toThrow(/dispatch exceeded 100ms \(watchdog\)/);

  expect(
    events.some(
      (event) =>
        event.kind === "proc.exited.resolved" &&
        event.meta?.signal === "SIGKILL" &&
        event.meta?.reason === "watchdog",
    ),
  ).toBe(true);
});

test("spawnCliAdapterStream throws before spawn when signal is already aborted", async () => {
  const events: any[] = [];
  const ctrl = new AbortController();
  ctrl.abort();

  await expect(
    (async () => {
      const stream = spawnCliAdapterStream({
        command: "sleep",
        args: ["60"],
        prompt: "",
        signal: ctrl.signal,
        eventContext: { handoffId: "h-preabort-stream", workerId: "w-cli" },
        onEvent: (event: any) => events.push(event),
      } as any);
      for await (const _ of stream) {
        void _;
      }
    })(),
  ).rejects.toThrow(/signal aborted before spawn/);

  expect(events).toHaveLength(0);
});

test("spawnCliAdapter throws before spawn when signal is already aborted", async () => {
  const events: any[] = [];
  const ctrl = new AbortController();
  ctrl.abort();

  await expect(
    spawnCliAdapter({
      command: "sleep",
      args: ["60"],
      prompt: "",
      signal: ctrl.signal,
      eventContext: { handoffId: "h-preabort", workerId: "w-cli" },
      onEvent: (event: any) => events.push(event),
    } as any),
  ).rejects.toThrow(/signal aborted before spawn/);

  expect(events).toHaveLength(0);
});

describe("detectCapacityError", () => {
  test("extracts provider+model from gemini stderr", () => {
    const stderr =
      "gemini: RetryableQuotaError: No capacity available for model gemini-3.1-pro-preview\n";
    expect(detectCapacityError(stderr)).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      raw: "No capacity available for model gemini-3.1-pro-preview",
    });
  });

  test("returns null when no capacity error is present", () => {
    expect(detectCapacityError("some normal error\n")).toBeNull();
    expect(detectCapacityError("")).toBeNull();
  });
});

describe("spawnCliAdapter onCapacityError callback", () => {
  test("fires onCapacityError when stderr matches a capacity pattern", async () => {
    const calls: any[] = [];
    const result = await spawnCliAdapter({
      command: "sh",
      args: [
        "-c",
        'echo "gemini: RetryableQuotaError: No capacity available for model gemini-3.1-pro-preview" 1>&2; echo OK',
      ],
      prompt: "",
      signal: new AbortController().signal,
      onCapacityError: (err) => calls.push(err),
    });
    expect(result.text.trim()).toBe("OK");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "google", model: "gemini-3.1-pro-preview" });
  });

  test("does NOT fire onCapacityError when stderr is clean", async () => {
    const calls: any[] = [];
    await spawnCliAdapter({
      command: "sh",
      args: ["-c", "echo OK"],
      prompt: "",
      signal: new AbortController().signal,
      onCapacityError: (err) => calls.push(err),
    });
    expect(calls).toHaveLength(0);
  });
});
