/**
 * Re-expressed parity for the spawnCliAdapterStream half of the legacy
 * adapters/cli-spawn-stream.test.ts suite: stream ordering, abort, exit and
 * strip-pattern semantics driven against the packed supervisor through the
 * local cli-spawn shim.
 *
 * Not re-expressed: the 4 "adapter dispatchStream wiring" tests — they drive
 * vendor adapter classes (ClaudeCliAdapter/CodexCliAdapter/GeminiCliAdapter)
 * which are not part of the extracted package.
 */
import { describe, expect, test } from "bun:test";

import { spawnCliAdapterStream } from "../src/shim/cli-spawn.js";
import type { DispatchEvent, DispatchEventInput } from "../src/shim/types.js";
import { assertDoneEvent } from "../fixtures/cli-spawn-fixtures.js";

async function collect(stream: AsyncIterable<DispatchEvent>): Promise<DispatchEvent[]> {
  const events: DispatchEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
  }
  return events;
}

describe("spawnCliAdapterStream (re-expressed)", () => {
  test("yields delta events in order then a done event with full text", async () => {
    const stream = spawnCliAdapterStream({
      command: "sh",
      args: ["-c", 'printf "A"; sleep 0.05; printf "B"; sleep 0.05; printf "C"'],
      prompt: "",
      signal: new AbortController().signal,
      pass_via: "argv",
    });
    const events = await collect(stream);
    const done = assertDoneEvent(events.at(-1));
    expect(done.result.text).toBe("ABC");
    const deltas = events.filter(
      (e): e is Extract<DispatchEvent, { type: "delta" }> => e.type === "delta",
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((d) => d.text).join("")).toBe("ABC");
  });

  test("on abort mid-stream yields done with partial text and does not throw", async () => {
    const ac = new AbortController();
    const lifecycleEvents: DispatchEventInput[] = [];
    const stream = spawnCliAdapterStream({
      command: "sh",
      args: ["-c", 'printf "part1"; sleep 10; printf "part2"'],
      prompt: "",
      signal: ac.signal,
      pass_via: "argv",
      env: { PENUMBRA_CANCEL_GRACE_S: "0.1" },
      eventContext: { handoffId: "h-stream-abort", workerId: "w-stream" },
      onEvent: (event) => lifecycleEvents.push(event),
    });

    const events: DispatchEvent[] = [];
    let threw = false;
    try {
      for await (const ev of stream) {
        events.push(ev);
        if (ev.type === "delta") ac.abort();
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    const done = assertDoneEvent(events.find((e) => e.type === "done"));
    expect(done.result.text).toBe("part1");
    expect(
      lifecycleEvents.some(
        (event) => event.kind === "proc.kill.sent" && event.meta?.signal === "SIGTERM",
      ),
    ).toBe(true);
    expect(lifecycleEvents.some((event) => event.kind === "proc.exited.resolved")).toBe(true);
  });

  test("on abort before any output does not wait for descendant processes that keep stdio open", async () => {
    const ac = new AbortController();
    const lifecycleEvents: DispatchEventInput[] = [];
    const stream = spawnCliAdapterStream({
      command: "node",
      args: [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'process.on("SIGTERM", () => {});',
          'spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 2000)"], { stdio: ["ignore", "inherit", "inherit"] });',
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      prompt: "",
      signal: ac.signal,
      pass_via: "argv",
      env: { PENUMBRA_CANCEL_GRACE_S: "0.05" },
      eventContext: { handoffId: "h-stream-no-output", workerId: "w-stream" },
      onEvent: (event) => lifecycleEvents.push(event),
    });

    setTimeout(() => {
      ac.abort();
    }, 25);

    const consume = (async (): Promise<DispatchEvent[]> => {
      const events: DispatchEvent[] = [];
      for await (const ev of stream) {
        events.push(ev);
      }
      return events;
    })();

    const raced = await Promise.race<
      { kind: "events"; value: DispatchEvent[] } | { kind: "timeout" }
    >([
      consume.then((value) => ({ kind: "events", value }) as const),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({ kind: "timeout" });
        }, 300);
      }),
    ]);

    expect(raced.kind).toBe("events");
    if (raced.kind !== "events") throw new Error("unreachable");
    const done = assertDoneEvent(raced.value.find((e) => e.type === "done"));
    expect(done.result.text).toBe("");
    expect(lifecycleEvents.some((event) => event.kind === "proc.exited.resolved")).toBe(true);
  });

  test("on exit 0 with empty stdout and non-empty stderr throws error instead of yielding successful done", async () => {
    const stream = spawnCliAdapterStream({
      command: "sh",
      args: ["-c", 'echo "some error info" 1>&2; exit 0'],
      prompt: "",
      signal: new AbortController().signal,
      pass_via: "argv",
    });

    const events: DispatchEvent[] = [];
    let thrownErr: unknown;
    try {
      for await (const ev of stream) {
        events.push(ev);
      }
    } catch (err) {
      thrownErr = err;
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toBeUndefined();
    expect(thrownErr).toBeInstanceOf(Error);
    expect((thrownErr as Error).message).toMatch(/empty output — some error info/);
  });

  test("on non-zero exit yields done with collected text then throws", async () => {
    const stream = spawnCliAdapterStream({
      command: "sh",
      args: ["-c", 'printf "x"; exit 2'],
      prompt: "",
      signal: new AbortController().signal,
      pass_via: "argv",
    });

    const events: DispatchEvent[] = [];
    let thrownErr: unknown;
    try {
      for await (const ev of stream) {
        events.push(ev);
      }
    } catch (err) {
      thrownErr = err;
    }

    const done = assertDoneEvent(events.find((e) => e.type === "done"));
    expect(done.result.text).toBe("x");
    expect(thrownErr).toBeInstanceOf(Error);
    expect((thrownErr as Error).message).toMatch(/exit code 2/);
  });

  test("on signal exit does not yield done and throws signal error", async () => {
    const stream = spawnCliAdapterStream({
      command: "sh",
      args: ["-c", "kill -TERM $$"],
      prompt: "",
      signal: new AbortController().signal,
      pass_via: "argv",
    });

    const events: DispatchEvent[] = [];
    let thrownErr: unknown;
    try {
      for await (const ev of stream) {
        events.push(ev);
      }
    } catch (err) {
      thrownErr = err;
    }

    expect(events.find((e) => e.type === "done")).toBeUndefined();
    expect(thrownErr).toBeInstanceOf(Error);
    expect((thrownErr as Error).message).toMatch(/signal SIGTERM/);
  });

  test("fires onCapacityError callback for matching stderr", async () => {
    const calls: { provider: string; model: string | null }[] = [];
    const stream = spawnCliAdapterStream({
      command: "sh",
      args: ["-c", 'echo "No capacity available for model gemini-3.1-pro-preview" 1>&2; echo OK'],
      prompt: "",
      signal: new AbortController().signal,
      pass_via: "argv",
      onCapacityError: (err) => calls.push(err),
    });

    const events = await collect(stream);
    assertDoneEvent(events.at(-1));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "google", model: "gemini-3.1-pro-preview" });
  });

  test("passes prompt via stdin when pass_via is unset", async () => {
    const stream = spawnCliAdapterStream({
      command: "cat",
      args: [],
      prompt: "hello from stdin",
      signal: new AbortController().signal,
    });

    const events = await collect(stream);
    const done = assertDoneEvent(events.at(-1));
    expect(done.result.text).toBe("hello from stdin");
  });

  test("applies strip_patterns to the final done text", async () => {
    const stream = spawnCliAdapterStream({
      command: "sh",
      args: ["-c", 'printf "hook: Start\\nresult\\nhook: End\\n"'],
      prompt: "",
      signal: new AbortController().signal,
      pass_via: "argv",
      strip_patterns: ["^hook: "],
    });

    const events = await collect(stream);
    const done = assertDoneEvent(events.at(-1));
    expect(done.result.text.trim()).toBe("result");
  });

  test("delta text does not have strip_patterns applied (raw chunks emitted as-is)", async () => {
    const stream = spawnCliAdapterStream({
      command: "sh",
      args: ["-c", 'printf "keep\\n"'],
      prompt: "",
      signal: new AbortController().signal,
      pass_via: "argv",
      strip_patterns: ["^hook: "],
    });

    const events = await collect(stream);
    const deltas = events.filter(
      (e): e is Extract<DispatchEvent, { type: "delta" }> => e.type === "delta",
    );
    expect(deltas.map((d) => d.text).join("")).toBe("keep\n");
  });
});
