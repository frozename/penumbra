import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CapacityError,
  detectCapacityError,
  detectQuotaExhaustion,
  QuotaExhaustedError,
  spawnCliAdapter,
  spawnCliAdapterStream,
} from "@src/adapters/cli-spawn.js";
import type { DispatchEvent } from "@src/sdk/adapter.js";
import type { RecordThoughtInput } from "@src/worker/thought-capture.js";

import {
  expectRejection,
  makeMockChildProcess,
  makeThoughtCaptureStub,
} from "../helpers/cli-spawn-fixtures.js";

const noopLogger = {
  debug: (): void => {
    /* intentional no-op for tests */
  },
};

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
  const calls: CapacityError[] = [];
  await expectRejection(
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
    /exit code 7/,
  );
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
  const calls: RecordThoughtInput[] = [];
  const thoughtCapture = makeThoughtCaptureStub((input) => calls.push(input));

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
  });

  expect(out.text).toBe(
    "<thinking> first pass </thinking>\nVISIBLE\n<thinking>second pass</thinking>\n<thinking>   </thinking>\n",
  );
  expect(calls).toEqual([
    { handoffId: "h-think", adapter: "cli-spawn", agentName: "gemini-cli", text: "first pass" },
    { handoffId: "h-think", adapter: "cli-spawn", agentName: "gemini-cli", text: "second pass" },
  ]);
});

test("does not parse <thinking> blocks when emit_stdout_thoughts is false (default)", async () => {
  const calls: RecordThoughtInput[] = [];
  const thoughtCapture = makeThoughtCaptureStub((input) => calls.push(input));

  const out = await spawnCliAdapter({
    command: "sh",
    args: ["-c", 'printf "<thinking> first pass </thinking>\\nVISIBLE\\n"'],
    prompt: "",
    signal: new AbortController().signal,
    thoughtCapture,
    eventContext: { handoffId: "h-think-off", workerId: "w-cli", agentName: "gemini-cli" },
  });

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
  await expectRejection(p);
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
  await expectRejection(p);
});

test("spawnCliAdapter throws when the child exits due to signal", async () => {
  await expectRejection(
    spawnCliAdapter({
      command: "sh",
      args: ["-c", "kill -TERM $$"],
      prompt: "",
      signal: new AbortController().signal,
      pass_via: "argv",
    }),
    /signal SIGTERM/,
  );
});

test("spawnCliAdapter emits lifecycle events only when eventContext is present", async () => {
  const withoutContext: DispatchEventInput[] = [];
  await spawnCliAdapter({
    command: "sh",
    args: ["-c", "echo ok"],
    prompt: "",
    signal: new AbortController().signal,
    onEvent: (event) => withoutContext.push(event),
  });
  expect(withoutContext).toHaveLength(0);

  const events: DispatchEventInput[] = [];
  await spawnCliAdapter({
    command: "sh",
    args: ["-c", "echo ok"],
    prompt: "",
    signal: new AbortController().signal,
    eventContext: { handoffId: "h-cli", workerId: "w-cli" },
    onEvent: (event) => events.push(event),
  });
  expect(events.map((event) => event.kind)).toEqual(["proc.spawn", "proc.exited.resolved"]);
  expect(events[0]).toMatchObject({ handoff_id: "h-cli", worker_id: "w-cli", source: "worker" });
});

test("spawnCliAdapter emits proc.kill.sent on abort", async () => {
  const events: DispatchEventInput[] = [];
  const ac = new AbortController();
  const p = spawnCliAdapter({
    command: "sleep",
    args: ["5"],
    prompt: "",
    signal: ac.signal,
    eventContext: { handoffId: "h-kill", workerId: "w-cli" },
    onEvent: (event) => events.push(event),
  });

  ac.abort();
  await expectRejection(p);
  expect(
    events.some((event) => event.kind === "proc.kill.sent" && event.meta?.signal === "SIGTERM"),
  ).toBe(true);
});

test("spawnCliAdapter kills child and surfaces output-cap warning when stdout exceeds cap", async () => {
  const events: DispatchEventInput[] = [];
  const warnings: string[] = [];
  const err = await expectRejection(
    spawnCliAdapter({
      command: "node",
      args: [
        "-e",
        "const chunk = 'x'.repeat(1024 * 1024); for (let i = 0; i < 25; i++) process.stdout.write(chunk);",
      ],
      prompt: "",
      signal: new AbortController().signal,
      eventContext: { handoffId: "h-cap", workerId: "w-cli" },
      onEvent: (event) => events.push(event),
      log: {
        debug: (_fields: Record<string, unknown>, message: string): void => {
          warnings.push(message);
        },
      },
    }),
    /output cap exceeded/i,
  );
  expect(err).toBeInstanceOf(Error);
  expect(warnings.some((message) => message.includes("output cap exceeded"))).toBe(true);
  expect(
    events.some(
      (event) =>
        event.kind === "proc.kill.sent" &&
        event.meta?.reason === "output_capacity" &&
        event.meta.stream === "stdout",
    ),
  ).toBe(true);
});

test("spawnCliAdapterStream kills child and surfaces truncated tail after output-cap overflow", async () => {
  const events: DispatchEventInput[] = [];
  const stream = spawnCliAdapterStream({
    command: "node",
    args: [
      "-e",
      "const chunk = 'x'.repeat(1024 * 1024); for (let i = 0; i < 25; i++) process.stdout.write(chunk);",
    ],
    prompt: "",
    signal: new AbortController().signal,
    pass_via: "argv",
    eventContext: { handoffId: "h-cap-stream", workerId: "w-cli" },
    onEvent: (event) => events.push(event),
  });

  const seen: DispatchEvent[] = [];
  let thrown: unknown;
  try {
    for await (const event of stream) {
      seen.push(event);
    }
  } catch (err) {
    thrown = err;
  }

  const done = seen.find((event) => event.type === "done");
  expect(done).toBeDefined();
  expect(typeof done).toBe("object");
  expect(done!.result.text.length).toBeLessThanOrEqual(16_777_216);
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/output cap exceeded/i);
  expect(
    events.some(
      (event) => event.kind === "proc.kill.sent" && event.meta?.reason === "output_capacity",
    ),
  ).toBe(true);
});

test("spawnCliAdapterStream emits proc.exited.resolved on watchdog timeout before throwing", async () => {
  const events: DispatchEventInput[] = [];
  const stream = spawnCliAdapterStream({
    command: "sleep",
    args: ["60"],
    prompt: "",
    signal: new AbortController().signal,
    env: { PENUMBRA_DISPATCH_TIMEOUT_S: "0.1" },
    eventContext: { handoffId: "h-watchdog-stream", workerId: "w-cli" },
    onEvent: (event) => events.push(event),
  });

  const seen: DispatchEvent[] = [];
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
        event.meta.reason === "watchdog",
    ),
  ).toBe(true);
});

test("spawnCliAdapterStream kills a live child when stdout iteration throws mid-stream", async () => {
  let killed = false;
  // Single documented cast: spawn() has an overloaded signature whose return type
  // depends on the stdio tuple. The mock returns a ChildProcessWithoutNullStreams
  // shape but the overload union cannot be matched structurally, so cast the
  // mock implementation through `typeof childProcess.spawn` once at the call site.
  const spawnImpl = (): ReturnType<typeof childProcess.spawn> =>
    makeMockChildProcess({
      onKill: (signal, proc) => {
        killed = true;
        proc.signalCode = signal;
        queueMicrotask(() => {
          proc.stderr.end();
          proc.emit("exit", null, signal);
        });
        return true;
      },
      stdout: {
        [Symbol.asyncIterator]: () => {
          let yielded = false;
          return {
            next: (): Promise<IteratorResult<Buffer>> => {
              if (!yielded) {
                yielded = true;
                return Promise.resolve({ value: Buffer.from("partial"), done: false });
              }
              return Promise.reject(new Error("stdout broke"));
            },
          };
        },
      },
    });
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
    spawnImpl as typeof childProcess.spawn,
  );

  let thrown: unknown;
  const events: DispatchEventInput[] = [];
  try {
    for await (const ev of spawnCliAdapterStream({
      command: "mock-cli",
      args: [],
      prompt: "",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      log: noopLogger,
    })) {
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
  const events: DispatchEventInput[] = [];
  await expectRejection(
    spawnCliAdapter({
      command: "sleep",
      args: ["60"],
      prompt: "",
      signal: new AbortController().signal,
      env: { PENUMBRA_DISPATCH_TIMEOUT_S: "0.1" },
      eventContext: { handoffId: "h-watchdog", workerId: "w-cli" },
      onEvent: (event) => events.push(event),
    }),
    /dispatch exceeded 100ms \(watchdog\)/,
  );

  expect(
    events.some(
      (event) =>
        event.kind === "proc.exited.resolved" &&
        event.meta?.signal === "SIGKILL" &&
        event.meta.reason === "watchdog",
    ),
  ).toBe(true);
});

test("spawnCliAdapterStream throws before spawn when signal is already aborted", async () => {
  const events: DispatchEventInput[] = [];
  const ctrl = new AbortController();
  ctrl.abort();

  await expectRejection(
    (async (): Promise<void> => {
      const stream = spawnCliAdapterStream({
        command: "sleep",
        args: ["60"],
        prompt: "",
        signal: ctrl.signal,
        eventContext: { handoffId: "h-preabort-stream", workerId: "w-cli" },
        onEvent: (event) => events.push(event),
      });
      for await (const _ of stream) {
        void _;
      }
    })(),
    /signal aborted before spawn/,
  );

  expect(events).toHaveLength(0);
});

test("spawnCliAdapter throws before spawn when signal is already aborted", async () => {
  const events: DispatchEventInput[] = [];
  const ctrl = new AbortController();
  ctrl.abort();

  await expectRejection(
    spawnCliAdapter({
      command: "sleep",
      args: ["60"],
      prompt: "",
      signal: ctrl.signal,
      eventContext: { handoffId: "h-preabort", workerId: "w-cli" },
      onEvent: (event) => events.push(event),
    }),
    /signal aborted before spawn/,
  );

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

const AGY_QUOTA_LINE =
  'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true}';
const AGY_QUOTA_STDERR = `error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 140h52m55s.\n${AGY_QUOTA_LINE}\n`;
const AGY_RESET_MS = (140 * 3600 + 52 * 60 + 55) * 1000;

describe("detectQuotaExhaustion (#298)", () => {
  const NOW = new Date("2026-10-25T22:13:40.000Z");

  test("parses the agy quota stderr into provider and an absolute reset", () => {
    expect(detectQuotaExhaustion(AGY_QUOTA_STDERR, NOW)).toEqual({
      provider: "google",
      model: null,
      resetsAt: "2026-10-31T19:06:35.000Z",
      raw: AGY_QUOTA_LINE,
    });
  });

  test("detects the quota inside a full adapter error message", () => {
    const text = `/Users/x/.local/bin/agy: exit code 3 — ${AGY_QUOTA_STDERR}`;
    const quota = detectQuotaExhaustion(text, NOW);
    expect(quota?.resetsAt).toBe("2026-10-31T19:06:35.000Z");
    expect(quota?.provider).toBe("google");
  });

  test("error_code 429 alone counts and a missing reset gives null", () => {
    expect(
      detectQuotaExhaustion('AGY_ERROR: {"status":"UNAVAILABLE","error_code":429}', NOW),
    ).toEqual({
      provider: "google",
      model: null,
      resetsAt: null,
      raw: 'AGY_ERROR: {"status":"UNAVAILABLE","error_code":429}',
    });
  });

  test("an unparseable or absurd reset gives resetsAt null without throwing", () => {
    for (const text of [
      `${AGY_QUOTA_LINE}\nResets in soon.`,
      `${AGY_QUOTA_LINE}\nResets in 99999999999999999999h.`,
    ]) {
      const quota = detectQuotaExhaustion(text, NOW);
      expect(quota).not.toBeNull();
      expect(quota?.resetsAt).toBeNull();
    }
  });

  test("returns null for capacity text, unrelated errors and non-quota AGY_ERROR", () => {
    expect(
      detectQuotaExhaustion(
        "gemini: RetryableQuotaError: No capacity available for model gemini-3.1-pro-preview\n",
        NOW,
      ),
    ).toBeNull();
    expect(detectQuotaExhaustion("some normal error\n", NOW)).toBeNull();
    expect(detectQuotaExhaustion("", NOW)).toBeNull();
    expect(
      detectQuotaExhaustion('AGY_ERROR: {"status":"INTERNAL","error_code":500}', NOW),
    ).toBeNull();
    expect(
      detectQuotaExhaustion("error: Individual quota reached. Resets in 1h0m0s.\n", NOW),
    ).toBeNull();
  });
});

describe("quota exit throws QuotaExhaustedError (#298)", () => {
  test("spawnCliAdapter throws QuotaExhaustedError with a reset from now", async () => {
    const before = Date.now();
    const err = await expectRejection(
      spawnCliAdapter({
        command: "sh",
        args: ["-c", 'printf "%s" "$1" 1>&2; exit 3', "--", AGY_QUOTA_STDERR],
        prompt: "",
        signal: new AbortController().signal,
      }),
      /exit code 3/,
    );
    const after = Date.now();

    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect(err.message).toContain("Resets in 140h52m55s.");
    const quota = (err as QuotaExhaustedError).quota;
    expect(quota.provider).toBe("google");
    const resetMs = Date.parse(quota.resetsAt ?? "");
    expect(resetMs).toBeGreaterThanOrEqual(before + AGY_RESET_MS);
    expect(resetMs).toBeLessThanOrEqual(after + AGY_RESET_MS);
  });

  test("spawnCliAdapterStream throws QuotaExhaustedError on the same exit", async () => {
    let thrown: unknown;
    const events: DispatchEventInput[] = [];
    try {
      for await (const ev of spawnCliAdapterStream({
        command: "sh",
        args: ["-c", 'printf "%s" "$1" 1>&2; exit 3', "--", AGY_QUOTA_STDERR],
        prompt: "",
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
      })) {
        void ev;
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(QuotaExhaustedError);
    expect((thrown as QuotaExhaustedError).quota.provider).toBe("google");
  });

  test("a non-quota exit stays a plain Error", async () => {
    const err = await expectRejection(
      spawnCliAdapter({
        command: "sh",
        args: ["-c", "echo boom 1>&2; exit 3"],
        prompt: "",
        signal: new AbortController().signal,
      }),
      /exit code 3/,
    );
    expect(err instanceof QuotaExhaustedError).toBe(false);
  });
});

describe("spawnCliAdapter onCapacityError callback", () => {
  test("fires onCapacityError when stderr matches a capacity pattern", async () => {
    const calls: CapacityError[] = [];
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
    const calls: CapacityError[] = [];
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

describe("spawnCliAdapter permission_profile sandbox", () => {
  test.skipIf(process.platform === "darwin")(
    "fails closed without sandbox-exec instead of running unsandboxed",
    async () => {
      await expectRejection(
        spawnCliAdapter({
          command: "cat",
          args: [],
          prompt: "x",
          signal: new AbortController().signal,
          permission_profile: "review_readonly",
        }),
        /sandbox-exec unavailable/,
      );
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "denies writes under the dispatch cwd via sandbox-exec",
    async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "penumbra-cli-sb-")));
      await expectRejection(
        spawnCliAdapter({
          command: "sh",
          args: ["-c", 'touch "$1"', "--", join(cwd, "denied.txt")],
          prompt: "",
          signal: new AbortController().signal,
          cwd,
          permission_profile: "review_readonly",
        }),
        /exit code/,
      );
      expect(existsSync(join(cwd, "denied.txt"))).toBe(false);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "still runs read-only commands under permission_profile",
    async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "penumbra-cli-sb-")));
      const out = await spawnCliAdapter({
        command: "sh",
        args: ["-c", "echo sb-ok"],
        prompt: "",
        signal: new AbortController().signal,
        cwd,
        permission_profile: "review_readonly",
      });
      expect(out.text.trim()).toBe("sb-ok");
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "denies writes under every sandbox_deny_roots entry, not just cwd",
    async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "penumbra-cli-sb-")));
      const callerRoot = realpathSync(mkdtempSync(join(tmpdir(), "penumbra-cli-caller-")));
      try {
        await expectRejection(
          spawnCliAdapter({
            command: "sh",
            args: ["-c", 'touch "$1"', "--", join(callerRoot, "denied.txt")],
            prompt: "",
            signal: new AbortController().signal,
            cwd,
            permission_profile: "review_readonly",
            sandbox_deny_roots: [callerRoot],
          }),
          /exit code/,
        );
        expect(existsSync(join(callerRoot, "denied.txt"))).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(callerRoot, { recursive: true, force: true });
      }
    },
  );
});
