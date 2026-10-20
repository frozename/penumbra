import type { DispatchEventInput } from "@penumbra/core";

import { expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PenumbraClient, PenumbraHttpError } from "@src/penumbra-client.js";
import {
  TerminalOutbox,
  type TerminalOutboxDeps,
  type TerminalReport,
} from "@src/worker/terminal-outbox.js";

interface LogCapture {
  debug: ReturnType<typeof mock>;
  info: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
}

// Bun augments `typeof fetch` with a static `preconnect` that the DOM fetch
// signature lacks. Mock implementations structurally match the call signature
// but trip TS2741 on the static; a single laundering helper isolates the gap.
function asFetch(fn: unknown): typeof fetch {
  return fn as typeof fetch;
}

function makeLog(): LogCapture {
  return { debug: mock(), info: mock(), warn: mock(), error: mock() };
}

interface MockDaemon {
  observeCalls: Record<string, unknown>[];
  eventCalls: DispatchEventInput[][];
  completeCalls: string[];
  failCalls: { id: string; reason: string }[];
  /** Queue of scripted responses per surface; falls through to the default. */
  script: {
    observe: (() => Promise<unknown>)[];
    events: (() => Promise<void>)[];
    terminal: (() => Promise<unknown>)[];
  };
}

function makeMockDaemonOutbox(
  dir: string,
  log: LogCapture,
  over: Partial<TerminalOutboxDeps> = {},
  script?: Partial<MockDaemon["script"]>,
): { outbox: TerminalOutbox; daemon: MockDaemon } {
  const daemon: MockDaemon = {
    observeCalls: [],
    eventCalls: [],
    completeCalls: [],
    failCalls: [],
    script: {
      observe: script?.observe ?? [],
      events: script?.events ?? [],
      terminal: script?.terminal ?? [],
    },
  };
  const outbox = new TerminalOutbox({
    dir,
    workerId: "w-test",
    log,
    observe: (event): Promise<unknown> => {
      daemon.observeCalls.push(event);
      const next = daemon.script.observe.shift();
      if (next) return next();
      return Promise.resolve({ event_id: String(event.event_id) });
    },
    postDispatchEvents: (events): Promise<void> => {
      daemon.eventCalls.push(events);
      const next = daemon.script.events.shift();
      if (next) return next();
      return Promise.resolve();
    },
    complete: (id): Promise<unknown> => {
      daemon.completeCalls.push(id);
      const next = daemon.script.terminal.shift();
      if (next) return next();
      return Promise.resolve({ handoff_id: id, status: "completed" });
    },
    markFailed: (id, reason): Promise<unknown> => {
      daemon.failCalls.push({ id, reason });
      const next = daemon.script.terminal.shift();
      if (next) return next();
      return Promise.resolve({ handoff_id: id, status: "failed" });
    },
    ...over,
  });
  return { outbox, daemon };
}

function makeReport(over: Partial<TerminalReport> = {}): TerminalReport {
  return {
    handoff_id: "h-out",
    worker_id: "w-test",
    outcome: "complete",
    observations: [
      {
        event_id: "obs-pre-gen-1",
        event_type: "agent-response",
        payload_json: { response: "done" },
      },
    ],
    dispatch_end: {
      handoff_id: "h-out",
      worker_id: "w-test",
      source: "worker",
      kind: "dispatch.end",
      ts: "2026-10-06T14:50:00.000Z",
      meta: { status: "ok" },
    },
    ...over,
  };
}

function makeDir(): { root: string; dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pen-outbox-test-"));
  const dir = join(root, "worker-outbox", "w-test");
  return {
    root,
    dir,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function listRecordFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function seedRecordFile(dir: string, record: unknown): string {
  mkdirSync(dir, { recursive: true });
  const name = "seeded.json";
  writeFileSync(join(dir, name), JSON.stringify(record));
  return name;
}

test("reportTerminal delivers inline on a healthy daemon and deletes the record", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    const { outbox, daemon } = makeMockDaemonOutbox(dir, log);

    const status = await outbox.reportTerminal(makeReport());

    expect(status).toBe("delivered");
    expect(daemon.observeCalls).toHaveLength(1);
    expect(daemon.eventCalls).toHaveLength(1);
    expect(daemon.eventCalls[0]![0]!.kind).toBe("dispatch.end");
    expect(daemon.completeCalls).toEqual(["h-out"]);
    expect(listRecordFiles(dir)).toEqual([]);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("delivery order is observations -> dispatch.end -> terminal call", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const order: string[] = [];
    const log = makeLog();
    const { outbox } = makeMockDaemonOutbox(dir, log, {
      observe: (event) => {
        order.push(`observe:${String(event.event_type)}`);
        return Promise.resolve({ event_id: String(event.event_id) });
      },
      postDispatchEvents: (events) => {
        order.push(`events:${events.map((e) => e.kind).join(",")}`);
        return Promise.resolve();
      },
      complete: (id) => {
        order.push(`complete:${id}`);
        return Promise.resolve({ status: "completed" });
      },
    });

    await outbox.reportTerminal(
      makeReport({
        observations: [
          { event_id: "o1", event_type: "agent-response-blocked" },
          { event_id: "o2", event_type: "agent-response" },
        ],
      }),
    );

    expect(order).toEqual([
      "observe:agent-response-blocked",
      "observe:agent-response",
      "events:dispatch.end",
      "complete:h-out",
    ]);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("fake daemon: N mixed transient failures then recovery delivers the report exactly once", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "shared-tok\n");

    const fetchedBodies: { url: string; body: Record<string, unknown> }[] = [];
    let observeFailures = 0;
    const fetchImpl = mock().mockImplementation((url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      fetchedBodies.push({ url, body });
      if (url.endsWith("/worker/register")) {
        return Promise.resolve(
          new Response(JSON.stringify({ worker_token: "wt", worker_id: "w-test" }), {
            status: 200,
          }),
        );
      }
      if (url.endsWith("/observations")) {
        observeFailures++;
        switch (observeFailures) {
          case 1:
            return Promise.reject(new TypeError("The socket connection was closed unexpectedly"));
          case 2:
            // Hang until the outbox's per-attempt signal fires.
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  reject(new DOMException("timed out", "TimeoutError"));
                },
                { once: true },
              );
            });
          case 3:
            return Promise.resolve(
              new Response(JSON.stringify({ error: "overloaded" }), { status: 503 }),
            );
          case 4:
            return Promise.resolve(
              new Response(JSON.stringify({ error: "slow down" }), { status: 429 }),
            );
          default:
            return Promise.resolve(
              new Response(JSON.stringify({ event_id: String(body.event_id) }), { status: 200 }),
            );
        }
      }
      if (url.endsWith("/dispatch/events")) {
        return Promise.resolve(new Response(JSON.stringify({ accepted: 1 }), { status: 200 }));
      }
      if (url.endsWith("/complete")) {
        return Promise.resolve(
          new Response(JSON.stringify({ handoff_id: "h-out", status: "completed" }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    const client = new PenumbraClient({ storageRoot: root, fetch: asFetch(fetchImpl) });
    await client.registerWorker({ worker_id: "w-test" });
    const log = makeLog();
    const outbox = new TerminalOutbox({
      dir,
      workerId: "w-test",
      log,
      stepTimeoutMs: 25,
      observe: (event, init): Promise<{ event_id: string }> => client.observe(event, init),
      postDispatchEvents: (events, signal): Promise<void> =>
        client.postDispatchEventsStrict(events, signal),
      complete: (id, init): Promise<{ handoff_id: string; status: string }> =>
        client.completeHandoff(id, "w-test", init),
      markFailed: (id, reason, init): Promise<{ handoff_id: string; status: string }> =>
        client.markFailed(id, reason, "w-test", init),
    });

    const report = makeReport();

    // Attempt 1: TypeError. Attempt 2: hang -> per-attempt timeout.
    // Attempt 3: 503. Attempt 4: 429. Attempt 5: port file removed.
    const first = await outbox.reportTerminal(report);
    expect(first).toBe("pending");
    for (let i = 0; i < 3; i++) {
      const res = await outbox.drain();
      expect(res.remaining).toBe(1);
    }
    // Fifth failure mode: 'penumbra not running' (port file removed).
    rmSync(join(root, "port"));
    const res5 = await outbox.drain();
    expect(res5.remaining).toBe(1);
    writeFileSync(join(root, "port"), "1\n");

    // Daemon recovers.
    const res6 = await outbox.drain();
    expect(res6.remaining).toBe(0);

    // The agent-response envelope carried the SAME pre-generated event_id on
    // every attempt — the daemon dedups replays on event_id.
    const observeBodies = fetchedBodies
      .filter((c) => c.url.endsWith("/observations"))
      .map((c) => c.body);
    // 5 fetches: 4 transient failures + 1 success. The port-file-deleted attempt
    // throws in resolve() before fetch is ever called.
    expect(observeBodies.length).toBe(5);
    expect(new Set(observeBodies.map((b) => b.event_id))).toEqual(new Set(["obs-pre-gen-1"]));
    // dispatch.end and complete were each posted exactly once, after recovery.
    const eventPosts = fetchedBodies.filter((c) => c.url.endsWith("/dispatch/events"));
    expect(eventPosts).toHaveLength(1);
    const completePosts = fetchedBodies.filter((c) => c.url.endsWith("/complete"));
    expect(completePosts).toHaveLength(1);
    expect(listRecordFiles(dir)).toEqual([]);
    // At least one warn per failed attempt and no error logs.
    expect(log.warn.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(log.error).not.toHaveBeenCalled();
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("crash and replay: a new instance drains a persisted record", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    const daemonA = makeMockDaemonOutbox(dir, log, {
      observe: () => Promise.reject(new TypeError("socket closed")),
    });
    const status = await daemonA.outbox.reportTerminal(makeReport());
    expect(status).toBe("pending");
    expect(listRecordFiles(dir)).toHaveLength(1);
    daemonA.outbox.stop();
    // Instance A is gone. Instance B on the same dir replays the record.
    const logB = makeLog();
    const { outbox: outboxB, daemon: daemonB } = makeMockDaemonOutbox(dir, logB);
    const res = await outboxB.drain();
    expect(res.remaining).toBe(0);
    expect(daemonB.observeCalls).toHaveLength(1);
    expect(daemonB.eventCalls).toHaveLength(1);
    expect(daemonB.completeCalls).toEqual(["h-out"]);
    expect(listRecordFiles(dir)).toEqual([]);
    outboxB.stop();
  } finally {
    cleanup();
  }
});

test("replay does not resend steps already persisted as done", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    seedRecordFile(dir, {
      v: 1,
      handoff_id: "h-done-steps",
      worker_id: "w-test",
      outcome: "fail",
      reason: "adapter blew up",
      observations: [],
      dispatch_end: {
        handoff_id: "h-done-steps",
        worker_id: "w-test",
        source: "worker",
        kind: "dispatch.end",
        ts: "2026-10-06T14:50:00.000Z",
        meta: { status: "error" },
      },
      steps_done: { observations: true, dispatch_end: true },
      created_at: new Date().toISOString(),
      attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });
    const log = makeLog();
    const { outbox, daemon } = makeMockDaemonOutbox(dir, log);

    const res = await outbox.drain();

    expect(res.remaining).toBe(0);
    // observations and dispatch.end were already delivered pre-crash.
    expect(daemon.observeCalls).toHaveLength(0);
    expect(daemon.eventCalls).toHaveLength(0);
    expect(daemon.failCalls).toEqual([{ id: "h-done-steps", reason: "adapter blew up" }]);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("a corrupt record file is quarantined, not looped on", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "garbage.json"), "{ not json");
    const log = makeLog();
    const { outbox } = makeMockDaemonOutbox(dir, log);

    const res = await outbox.drain();

    expect(res.remaining).toBe(0);
    expect(existsSync(join(dir, "garbage.json.bad"))).toBe(true);
    expect(existsSync(join(dir, "garbage.json"))).toBe(false);
    expect(log.warn.mock.calls.length).toBeGreaterThanOrEqual(1);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("409 agreeing with the intended outcome deletes the record quietly", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    const { outbox } = makeMockDaemonOutbox(dir, log, {
      complete: () =>
        Promise.reject(new PenumbraHttpError("conflict", 409, { current_status: "completed" })),
    });

    const status = await outbox.reportTerminal(makeReport());

    expect(status).toBe("delivered");
    expect(listRecordFiles(dir)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("409 disagreeing with the intended outcome warns 'terminal report superseded'", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    const { outbox } = makeMockDaemonOutbox(dir, log, {
      complete: () =>
        Promise.reject(new PenumbraHttpError("conflict", 409, { current_status: "failed" })),
    });

    const status = await outbox.reportTerminal(makeReport());

    expect(status).toBe("superseded");
    expect(listRecordFiles(dir)).toEqual([]);
    const warnArgs = log.warn.mock.calls.map((c) => String(c[1]));
    expect(warnArgs).toContain("terminal report superseded");
    const meta = log.warn.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(meta.some((m) => m.current_status === "failed")).toBe(true);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("404 and 403 on the terminal call delete the record", async () => {
  for (const status of [404, 403]) {
    const { root, dir, cleanup } = makeDir();
    try {
      const log = makeLog();
      const { outbox } = makeMockDaemonOutbox(dir, log, {
        complete: () =>
          Promise.reject(new PenumbraHttpError("terminal", status, { error: "nope" })),
      });

      const result = await outbox.reportTerminal(makeReport());

      expect(result).toBe("superseded");
      expect(listRecordFiles(dir)).toEqual([]);
      outbox.stop();
    } finally {
      cleanup();
    }
  }
});

test("401 on the terminal call keeps the record (heartbeat re-registers)", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    const { outbox } = makeMockDaemonOutbox(dir, log, {
      complete: () =>
        Promise.reject(new PenumbraHttpError("unauthorized", 401, { error: "expired" })),
    });

    const status = await outbox.reportTerminal(makeReport());

    expect(status).toBe("pending");
    expect(listRecordFiles(dir)).toHaveLength(1);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("a 400 on dispatch.end drops that step but complete is still posted", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    const eventCalls: DispatchEventInput[][] = [];
    const { outbox, daemon } = makeMockDaemonOutbox(dir, log, {
      postDispatchEvents: (events) => {
        eventCalls.push(events);
        return Promise.reject(
          new PenumbraHttpError("invalid_payload", 400, {
            error: "invalid_payload",
            issues: [],
          }),
        );
      },
    });

    const status = await outbox.reportTerminal(makeReport());

    expect(status).toBe("delivered");
    expect(eventCalls).toHaveLength(1);
    expect(daemon.completeCalls).toEqual(["h-out"]);
    expect(listRecordFiles(dir)).toEqual([]);
    const meta = log.warn.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(meta.some((m) => m.kind === "dispatch.end")).toBe(true);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("a 400 on one observation drops that envelope and continues with the rest", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    let observeN = 0;
    const { outbox, daemon } = makeMockDaemonOutbox(dir, log, {
      observe: (event) => {
        daemon.observeCalls.push(event);
        observeN++;
        if (observeN === 1) {
          return Promise.reject(new PenumbraHttpError("bad", 400, { error: "bad" }));
        }
        return Promise.resolve({ event_id: String(event.event_id) });
      },
    });

    const status = await outbox.reportTerminal(
      makeReport({
        observations: [
          { event_id: "o-bad", event_type: "agent-response-blocked" },
          { event_id: "o-good", event_type: "agent-response" },
        ],
      }),
    );

    expect(status).toBe("delivered");
    // The good envelope still delivered — a terminal-400 envelope can never
    // block the terminal call or its siblings.
    expect(daemon.observeCalls.map((e) => e.event_id)).toEqual(["o-bad", "o-good"]);
    expect(daemon.completeCalls).toEqual(["h-out"]);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("complete on a cancel-requested row (200 {status:'failed'}) is superseded, not error", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    const { outbox } = makeMockDaemonOutbox(dir, log, {
      complete: (id) => Promise.resolve({ handoff_id: id, status: "failed" }),
    });

    const status = await outbox.reportTerminal(makeReport());

    expect(status).toBe("superseded");
    expect(listRecordFiles(dir)).toEqual([]);
    const warnArgs = log.warn.mock.calls.map((c) => String(c[1]));
    expect(warnArgs).toContain("terminal report superseded");
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("markFailed on an expired row (200) delivers; outcome 'fail' posts the fail call", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    // The default mock markFailed returns {status:'failed'} — mirroring the
    // daemon's 200 rewrite of an expired row.
    const { outbox, daemon } = makeMockDaemonOutbox(dir, log);

    const status = await outbox.reportTerminal(
      makeReport({ outcome: "fail", reason: "adapter blew up" }),
    );

    expect(status).toBe("delivered");
    expect(daemon.completeCalls).toHaveLength(0);
    expect(daemon.failCalls).toEqual([{ id: "h-out", reason: "adapter blew up" }]);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("per-handoff single-flight: a concurrent drain does not re-deliver an in-flight record", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    let releaseGate: () => void = (): void => undefined;
    const gate = new Promise<undefined>((resolve) => {
      releaseGate = (): void => {
        resolve(undefined);
      };
    });
    let observeCalls = 0;
    const log = makeLog();
    const { outbox } = makeMockDaemonOutbox(dir, log, {
      observe: (): Promise<{ event_id: string }> => {
        observeCalls++;
        return gate.then(() => ({ event_id: "e" }));
      },
    });

    const inline = outbox.reportTerminal(makeReport());
    await new Promise((r) => setTimeout(r, 10));
    const midDrain = await outbox.drain();
    expect(observeCalls).toBe(1);
    expect(midDrain.remaining).toBe(1);
    releaseGate();
    const status = await inline;
    expect(status).toBe("delivered");
    const res = await outbox.drain();
    expect(res.remaining).toBe(0);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("a record older than max age is dropped with an error log", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const ancient = Date.parse("2026-10-06T00:00:00.000Z");
    const now = ancient + 7 * 60 * 60 * 1000; // 7h later
    seedRecordFile(dir, {
      v: 1,
      handoff_id: "h-ancient",
      worker_id: "w-test",
      outcome: "complete",
      observations: [],
      dispatch_end: {
        handoff_id: "h-ancient",
        worker_id: "w-test",
        source: "worker",
        kind: "dispatch.end",
        ts: new Date(ancient).toISOString(),
        meta: { status: "ok" },
      },
      steps_done: { observations: true, dispatch_end: true },
      created_at: new Date(ancient).toISOString(),
      attempts: 10,
      next_attempt_at: new Date(ancient + 60_000).toISOString(),
    });
    const log = makeLog();
    const { outbox, daemon } = makeMockDaemonOutbox(dir, log, { now: () => now });

    const res = await outbox.drain();

    expect(res.remaining).toBe(0);
    expect(daemon.completeCalls).toHaveLength(0);
    expect(listRecordFiles(dir)).toEqual([]);
    expect(log.error.mock.calls.length).toBeGreaterThanOrEqual(1);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("retry backoff doubles from 1s and is capped at 60s", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const now = Date.parse("2026-10-06T15:00:00.000Z");
    const scheduled: number[] = [];
    const log = makeLog();
    const { outbox } = makeMockDaemonOutbox(dir, log, {
      now: () => now,
      schedule: (_run, ms): { cancel: () => void } => {
        scheduled.push(ms);
        return {
          cancel: (): void => undefined,
        };
      },
      observe: (): Promise<never> => Promise.reject(new TypeError("down")),
    });

    // One inline attempt (attempt 1 -> +1s) then seven drains.
    await outbox.reportTerminal(makeReport());
    for (let i = 0; i < 7; i++) {
      await outbox.drain();
    }
    const record = JSON.parse(readFileSync(join(dir, listRecordFiles(dir)[0]!), "utf-8")) as {
      attempts: number;
      next_attempt_at: string;
    };
    expect(record.attempts).toBe(8);
    // attempts 1..8 -> wake delays 1,2,4,8,16,32,60,60 (capped)
    expect(scheduled).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    outbox.stop();
  } finally {
    cleanup();
  }
});

test("the inline finalize attempt is bounded by the inline budget", async () => {
  const { root, dir, cleanup } = makeDir();
  try {
    const log = makeLog();
    const { outbox } = makeMockDaemonOutbox(dir, log, {
      stepTimeoutMs: 30,
      inlineBudgetMs: 60,
      observe: (_event, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("timed out", "TimeoutError"));
            },
            { once: true },
          );
        });
      },
    });

    const start = Date.now();
    const status = await outbox.reportTerminal(makeReport());

    expect(status).toBe("pending");
    expect(Date.now() - start).toBeLessThan(500);
    expect(listRecordFiles(dir)).toHaveLength(1);
    outbox.stop();
  } finally {
    cleanup();
  }
});
