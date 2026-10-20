import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PenumbraHttpError } from "@src/penumbra-client.js";
import { runWorkerBoot, type WorkerBootControl } from "@src/worker-boot.js";
import { startHeartbeatLoop } from "@src/worker/heartbeat-loop.js";
import { TerminalOutbox, type TerminalReportStatus } from "@src/worker/terminal-outbox.js";

const cleanups: (() => void)[] = [];
let previousBootReconcile: string | undefined;
beforeEach(() => {
  previousBootReconcile = process.env["PENUMBRA_BOOT_RECONCILE"];
  delete process.env["PENUMBRA_BOOT_RECONCILE"];
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (previousBootReconcile === undefined) delete process.env["PENUMBRA_BOOT_RECONCILE"];
  else process.env["PENUMBRA_BOOT_RECONCILE"] = previousBootReconcile;
});

type LogFn = (meta: Record<string, unknown>, msg: string) => void;
type TestLog = Record<"debug" | "info" | "warn" | "error", ReturnType<typeof mock<LogFn>>>;
type BootArgs = Parameters<typeof runWorkerBoot>[0];
interface BootTimer {
  run: () => void | Promise<void>;
  delay: number;
  cancelled: boolean;
}
interface BootFixture {
  args: BootArgs;
  calls: string[];
  timers: BootTimer[];
  client: BootArgs["client"] & {
    registerWorker: ReturnType<typeof mock<BootArgs["client"]["registerWorker"]>>;
  };
  log: TestLog;
  outbox: TerminalOutbox;
  recover(): void;
  supersede(): void;
  advance(ms: number): void;
  seed(): Promise<TerminalReportStatus>;
}

function fixture(): BootFixture {
  const root = mkdtempSync(join(tmpdir(), "boot-outbox-reconcile-"));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const log: TestLog = {
    debug: mock<LogFn>(),
    info: mock<LogFn>(),
    warn: mock<LogFn>(),
    error: mock<LogFn>(),
  };
  const client = {
    registerWorker: mock(
      (): Promise<{ worker_token: string; worker_id: string }> =>
        Promise.resolve({ worker_token: "wt", worker_id: "W" }),
    ),
    postHeartbeat: mock((): Promise<void> => Promise.resolve()),
    reconcileLongLivedOrphans: mock(
      (): Promise<{ reconciled: number }> => Promise.resolve({ reconciled: 0 }),
    ),
    reconcileDispatchOrphans: mock(
      (
        _workerId: string,
        _opts?: { claimed_before?: string; require_claimed_before?: boolean },
      ): Promise<{ requeued: number; exhausted: number; skipped?: "unsupported_daemon" }> => {
        calls.push("reconcile");
        return Promise.resolve({ requeued: 2, exhausted: 1 });
      },
    ),
  };
  let now = Date.now();
  let failing = true;
  let terminalStatus = "completed";
  const outbox = new TerminalOutbox({
    dir: join(root, "outbox"),
    workerId: "W",
    log,
    now: (): number => now,
    schedule: (): { cancel(): void } => ({ cancel: (): void => undefined }),
    observe: (): Promise<unknown> => {
      calls.push("observe");
      return failing
        ? Promise.reject(new PenumbraHttpError("sqlite_busy", 503, {}))
        : Promise.resolve({ event_id: "E" });
    },
    postDispatchEvents: (): Promise<void> => Promise.resolve(),
    complete: (): Promise<unknown> => {
      calls.push("complete");
      return Promise.resolve({ status: terminalStatus });
    },
    markFailed: (): Promise<unknown> => Promise.resolve({ status: "failed" }),
  });
  cleanups.push(() => {
    outbox.stop();
  });
  const timers: { run: () => void | Promise<void>; delay: number; cancelled: boolean }[] = [];
  const args: BootArgs = {
    client,
    log,
    workerId: "W",
    outbox,
    now: (): number => now,
    schedule: (run: () => void | Promise<void>, delay: number): { cancel(): void } => {
      const timer = { run, delay, cancelled: false };
      timers.push(timer);
      return {
        cancel: (): void => {
          timer.cancelled = true;
        },
      };
    },
  };
  return {
    args,
    calls,
    timers,
    client,
    log,
    outbox,
    recover: (): void => {
      failing = false;
    },
    supersede: (): void => {
      failing = false;
      terminalStatus = "failed";
    },
    advance: (ms: number): void => {
      now += ms;
    },
    seed: (): Promise<TerminalReportStatus> =>
      outbox.reportTerminal({
        handoff_id: "H",
        worker_id: "W",
        outcome: "complete",
        observations: [{ event_id: "E" }],
        dispatch_end: {
          handoff_id: "H",
          worker_id: "W",
          source: "worker",
          kind: "dispatch.end",
          ts: new Date(now).toISOString(),
          meta: { status: "ok" },
        },
      }),
  };
}

async function boot(f: BootFixture): Promise<WorkerBootControl> {
  const control = await runWorkerBoot(f.args);
  cleanups.push(() => {
    control.stop();
  });
  return control;
}

test("a transient boot 503 reconciles exactly once after a successful heartbeat drain", async () => {
  const f = fixture();
  await f.seed();
  f.calls.length = 0;
  const control = await boot(f);
  expect(f.calls).toEqual(["observe"]);
  expect(f.client.reconcileDispatchOrphans).not.toHaveBeenCalled();
  f.recover();
  let draining = Promise.resolve();
  const beats: (() => void | Promise<void>)[] = [];
  const loop = startHeartbeatLoop({
    workerId: "W",
    log: f.log,
    emitHeartbeat: () => Promise.resolve(),
    reregisterWorker: () => Promise.resolve(),
    exit: mock(),
    onHealthy: () => {
      draining = control.drainOutbox();
    },
    schedule: (run): { cancel(): void } => {
      beats.push(run);
      return { cancel: (): void => undefined };
    },
  });
  cleanups.push(() => {
    loop.stop();
  });
  await beats[0]!();
  await draining;
  expect(f.outbox.pendingHandoffIds()).toEqual([]);
  expect(f.calls).toEqual(["observe", "observe", "complete", "reconcile"]);
  await beats[1]!();
  await draining;
  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledTimes(1);
  expect(f.timers[0]?.cancelled).toBe(true);
  expect(
    f.log.warn.mock.calls.some(([meta]) => meta["event"] === "boot_dispatch_reconcile_deferred"),
  ).toBe(true);
  expect(
    f.log.info.mock.calls.some(
      ([meta]) =>
        meta["event"] === "boot_dispatch_reconcile_resumed" &&
        meta["requeued"] === 2 &&
        meta["exhausted"] === 1,
    ),
  ).toBe(true);
});

test("an undeliverable record reconciles at the ten-minute boot bound", async () => {
  const f = fixture();
  await f.seed();
  await boot(f);
  expect(f.client.reconcileDispatchOrphans).not.toHaveBeenCalled();
  expect(f.timers).toHaveLength(1);
  expect(f.timers[0]!.delay).toBe(600_000);
  f.advance(600_000);
  await f.timers[0]!.run();
  expect(f.outbox.pendingHandoffIds()).toEqual(["H"]);
  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledTimes(1);
  await f.timers[0]!.run();
  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledTimes(1);
});

test("an empty real outbox reconciles immediately without a deferred timer", async () => {
  const f = fixture();
  const control = await boot(f);
  expect(f.calls).toEqual(["reconcile"]);
  expect(f.timers).toEqual([]);
  await control.drainOutbox();
  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledTimes(1);
});

test("the deadline includes time spent registering and draining at boot", async () => {
  const f = fixture();
  await f.seed();
  f.client.registerWorker.mockImplementation(() => {
    f.advance(30_000);
    return Promise.resolve({ worker_token: "wt", worker_id: "W" });
  });
  await boot(f);
  expect(f.timers[0]!.delay).toBe(570_000);
});

test("stopping the worker cancels deferred reconcile", async () => {
  const f = fixture();
  await f.seed();
  const control = await boot(f);
  control.stop();
  expect(f.timers[0]!.cancelled).toBe(true);
  await f.timers[0]!.run();
  f.recover();
  await control.drainOutbox();
  expect(f.client.reconcileDispatchOrphans).not.toHaveBeenCalled();
});

test("supervisor-managed workers never schedule deferred reconcile", async () => {
  const f = fixture();
  await f.seed();
  process.env["PENUMBRA_BOOT_RECONCILE"] = "0";
  const control = await boot(f);
  expect(f.timers).toEqual([]);
  f.recover();
  await control.drainOutbox();
  expect(f.client.reconcileDispatchOrphans).not.toHaveBeenCalled();
});

test("a pending finished-turn report lands before orphan reconcile", async () => {
  const f = fixture();
  await f.seed();
  f.calls.length = 0;
  f.recover();
  await boot(f);
  expect(f.calls).toEqual(["observe", "complete", "reconcile"]);
  expect(f.outbox.pendingHandoffIds()).toEqual([]);
  expect(f.timers).toEqual([]);
});

test.each(["superseded", "aged"])("a %s record releases deferred reconcile", async (mode) => {
  const f = fixture();
  await f.seed();
  const control = await boot(f);
  if (mode === "aged") f.advance(7 * 60 * 60 * 1000);
  else {
    f.supersede();
  }
  await control.drainOutbox();
  expect(f.outbox.pendingHandoffIds()).toEqual([]);
  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledTimes(1);
});

const BOOT_MS = 1_775_493_600_000; // 2026-10-06T12:00:00.000Z

test("boot reconcile (non-deferred) passes the boot instant as claimed_before", async () => {
  const f = fixture();
  f.args.now = (): number => BOOT_MS;

  await boot(f);

  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledTimes(1);
  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledWith("W", {
    claimed_before: new Date(BOOT_MS).toISOString(),
    require_claimed_before: false,
  });
});

test("deferred reconcile passes the boot instant captured at boot, not at drain time", async () => {
  const f = fixture();
  // runWorkerBoot keeps the function it was given, so advance the clock it
  // reads rather than swapping the function: a bound recomputed at drain time
  // would then see the later instant and the assertion below would fail.
  let nowMs = BOOT_MS;
  f.args.now = (): number => nowMs;

  await f.seed();
  const control = await boot(f);
  expect(f.client.reconcileDispatchOrphans).not.toHaveBeenCalled();

  nowMs = BOOT_MS + 123_000;
  f.recover();
  await control.drainOutbox();

  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledTimes(1);
  // The bound is the boot instant — claims between boot and drain belong to this
  // incarnation and must stay out of the reconcile set.
  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledWith("W", {
    claimed_before: new Date(BOOT_MS).toISOString(),
    require_claimed_before: true,
  });
});

test("deferred reconcile on an old daemon (unsupported marker) logs and does not retry", async () => {
  const f = fixture();
  f.client.reconcileDispatchOrphans = mock(
    (): Promise<{ requeued: number; exhausted: number; skipped?: "unsupported_daemon" }> =>
      Promise.resolve({ requeued: 0, exhausted: 0, skipped: "unsupported_daemon" }),
  );

  await f.seed();
  const control = await boot(f);
  f.recover();
  await control.drainOutbox();

  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledTimes(1);
  expect(
    f.log.warn.mock.calls.some(([meta]) => meta["event"] === "boot_dispatch_reconcile_unsupported"),
  ).toBe(true);
});

test("deferred reconcile refused by the daemon (400 on the new field) logs and never retries unfiltered", async () => {
  const f = fixture();
  f.client.reconcileDispatchOrphans = mock(
    (): Promise<{ requeued: number; exhausted: number }> =>
      Promise.reject(
        new PenumbraHttpError("POST /worker/reconcile-orphans: HTTP 400", 400, {
          error: { code: "validation_error" },
        }),
      ),
  );

  await f.seed();
  const control = await boot(f);
  f.recover();
  await control.drainOutbox();

  expect(f.client.reconcileDispatchOrphans).toHaveBeenCalledTimes(1);
  expect(
    f.log.warn.mock.calls.some(([meta]) => meta["event"] === "boot_dispatch_reconcile_unsupported"),
  ).toBe(true);
});
