import { describe, expect, it } from "bun:test";

import type { AgyHandle, Handlers, SpawnAgyFn } from "../src/handlers.js";
import type { ContentBlock } from "../src/types.js";

import { makeHandlers } from "../src/handlers.js";

interface SpawnCall {
  binary: string;
  args: string[];
  onLine: (line: string) => void;
}

interface Notification {
  method: string;
  params: unknown;
}

interface HandleRecord {
  handle: AgyHandle;
  exit: (code: number) => void;
  killCount: () => number;
}

interface Fleet {
  spawn: SpawnAgyFn;
  calls: SpawnCall[];
  records: HandleRecord[];
  notifications: Notification[];
}

const noop = (): void => undefined;

function textPrompt(...texts: string[]): ContentBlock[] {
  return texts.map((text) => ({ type: "text" as const, text }));
}

function mustIndex<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected ${what} at index ${String(index)}, got none`);
  }
  return item;
}

function makeHandleRecord(): HandleRecord {
  let exitFn: ((code: number) => void) | undefined;
  let settled = false;
  let kills = 0;
  const exited = new Promise<number>((resolve) => {
    exitFn = resolve;
  });
  const settleOnce = (code: number): void => {
    if (settled) return;
    settled = true;
    if (exitFn === undefined) {
      throw new Error("exit resolver was never initialised");
    }
    exitFn(code);
  };
  return {
    handle: {
      exited,
      kill: (): void => {
        kills += 1;
      },
    },
    exit: settleOnce,
    killCount: () => kills,
  };
}

function makeFleet(): Fleet {
  const calls: SpawnCall[] = [];
  const records: HandleRecord[] = [];
  const notifications: Notification[] = [];
  const spawn: SpawnAgyFn = (opts): AgyHandle => {
    calls.push({ binary: opts.binary, args: opts.args, onLine: opts.onLine });
    const record = makeHandleRecord();
    records.push(record);
    return record.handle;
  };
  return { spawn, calls, records, notifications };
}

function fleetHandlers(fleet: Fleet): Handlers {
  return makeHandlers({
    spawnAgy: fleet.spawn,
    notify: (method, params) => {
      fleet.notifications.push({ method, params });
    },
  });
}

function printToken(args: readonly string[]): string {
  const token = args.find((arg) => arg.startsWith("--print="));
  if (token === undefined) {
    throw new Error(`expected an attached --print= token in ${JSON.stringify(args)}`);
  }
  return token;
}

function cancelSafely(handlers: Handlers, sessionId: string): Promise<unknown> {
  try {
    return handlers.handleSessionCancel({ sessionId });
  } catch (err: unknown) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err: unknown) {
    if (err instanceof Error) return err;
    throw new Error(`expected an Error rejection, got ${String(err)}`);
  }
  throw new Error("expected rejection but the promise resolved");
}

function errorCodeOf(err: Error): number {
  if ("code" in err && typeof err.code === "number") {
    return err.code;
  }
  throw new Error(`expected a numeric code on error "${err.message}"`);
}

describe("agy argv contract", () => {
  it("case 1: builds the exact argv with --sandbox and the --conversation pair", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const promptPromise = handlers.handleSessionPrompt({
      sessionId: "conv-7",
      prompt: textPrompt("hello"),
    });

    const call = mustIndex(fleet.calls, 0, "spawn call");
    expect(typeof call.binary).toBe("string");
    expect(call.binary.length).toBeGreaterThan(0);
    expect(call.args).toEqual([
      "--dangerously-skip-permissions",
      "--sandbox",
      "--print-timeout",
      "10m",
      "--conversation",
      "conv-7",
      "--print=hello",
    ]);

    mustIndex(fleet.records, 0, "handle record").exit(0);
    expect(await promptPromise).toEqual({ stopReason: "end_turn" });
  });

  it("case 2: joins multiple prompt blocks with newlines into the attached --print value", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const promptPromise = handlers.handleSessionPrompt({
      sessionId: "s2",
      prompt: textPrompt("alpha", "beta", "gamma"),
    });

    const call = mustIndex(fleet.calls, 0, "spawn call");
    expect(printToken(call.args)).toBe("--print=alpha\nbeta\ngamma");
    expect(call.args).not.toContain("--print");

    mustIndex(fleet.records, 0, "handle record").exit(0);
    await promptPromise;
  });

  it("case 3: relays each stdout line as a session/update chunk with a trailing newline, then a done notify", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const promptPromise = handlers.handleSessionPrompt({
      sessionId: "s3",
      prompt: textPrompt("go"),
    });

    const call = mustIndex(fleet.calls, 0, "spawn call");
    call.onLine("first");
    call.onLine("");
    mustIndex(fleet.records, 0, "handle record").exit(0);

    expect(await promptPromise).toEqual({ stopReason: "end_turn" });
    expect(fleet.notifications).toEqual([
      {
        method: "session/update",
        params: {
          sessionId: "s3",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "first\n" },
          },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "s3",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "\n" },
          },
        },
      },
      { method: "done", params: {} },
    ]);
  });

  it("case 4: a non-zero exit yields stopReason failed and still notifies done", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const promptPromise = handlers.handleSessionPrompt({
      sessionId: "s4",
      prompt: textPrompt("boom"),
    });
    mustIndex(fleet.records, 0, "handle record").exit(7);

    expect(await promptPromise).toEqual({ stopReason: "failed" });
    expect(fleet.notifications.some((n) => n.method === "done")).toBe(true);
  });
});

describe("session/cancel error contract", () => {
  it("case 5: cancelling an unknown session rejects with error code -32002", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const err = await rejectionOf(cancelSafely(handlers, "ghost"));
    expect(err.message).toBe("not_a_session");
    expect(errorCodeOf(err)).toBe(-32002);
  });

  it("case 6: cancel kills the in-flight handle and removes it from tracking so a second cancel rejects", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const promptPromise = handlers.handleSessionPrompt({
      sessionId: "s6",
      prompt: textPrompt("slow"),
    });
    const record = mustIndex(fleet.records, 0, "handle record");

    expect(await cancelSafely(handlers, "s6")).toEqual({});
    expect(record.killCount()).toBe(1);

    const err = await rejectionOf(cancelSafely(handlers, "s6"));
    expect(errorCodeOf(err)).toBe(-32002);

    record.exit(0);
    expect(await promptPromise).toEqual({ stopReason: "cancelled" });
  });

  it("case 7: a cancelled prompt reports cancelled even when the process exits non-zero", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const promptPromise = handlers.handleSessionPrompt({
      sessionId: "s7",
      prompt: textPrompt("sleep"),
    });
    await cancelSafely(handlers, "s7");
    mustIndex(fleet.records, 0, "handle record").exit(130);

    expect(await promptPromise).toEqual({ stopReason: "cancelled" });
  });
});

describe("in-flight session rules", () => {
  it("case 8: a fresh prompt clears a stale cancelled flag left by a still-pending cancelled prompt", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const firstPromise = handlers.handleSessionPrompt({
      sessionId: "s8",
      prompt: textPrompt("first"),
    });
    await cancelSafely(handlers, "s8");

    const secondPromise = handlers.handleSessionPrompt({
      sessionId: "s8",
      prompt: textPrompt("second"),
    });
    mustIndex(fleet.records, 1, "handle record").exit(0);
    expect(await secondPromise).toEqual({ stopReason: "end_turn" });

    mustIndex(fleet.records, 0, "handle record").exit(0);
    await firstPromise;
  });

  it("case 9: a completed prompt removes its in-flight entry so a later cancel rejects", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const okPromise = handlers.handleSessionPrompt({
      sessionId: "s9-ok",
      prompt: textPrompt("ok"),
    });
    mustIndex(fleet.records, 0, "handle record").exit(0);
    expect(await okPromise).toEqual({ stopReason: "end_turn" });

    const errAfterOk = await rejectionOf(cancelSafely(handlers, "s9-ok"));
    expect(errorCodeOf(errAfterOk)).toBe(-32002);

    const failedPromise = handlers.handleSessionPrompt({
      sessionId: "s9-failed",
      prompt: textPrompt("fail"),
    });
    mustIndex(fleet.records, 1, "handle record").exit(5);
    expect(await failedPromise).toEqual({ stopReason: "failed" });

    const errAfterFailed = await rejectionOf(cancelSafely(handlers, "s9-failed"));
    expect(errorCodeOf(errAfterFailed)).toBe(-32002);
  });

  it("case 10: a finished prompt never evicts a newer in-flight handle for the same session", async () => {
    const fleet = makeFleet();
    const handlers = fleetHandlers(fleet);

    const firstPromise = handlers.handleSessionPrompt({
      sessionId: "s10",
      prompt: textPrompt("first"),
    });
    const secondPromise = handlers.handleSessionPrompt({
      sessionId: "s10",
      prompt: textPrompt("second"),
    });

    mustIndex(fleet.records, 0, "handle record").exit(0);
    expect(await firstPromise).toEqual({ stopReason: "end_turn" });

    expect(await cancelSafely(handlers, "s10")).toEqual({});
    expect(mustIndex(fleet.records, 1, "handle record").killCount()).toBe(1);

    mustIndex(fleet.records, 1, "handle record").exit(0);
    expect(await secondPromise).toEqual({ stopReason: "cancelled" });
  });
});
