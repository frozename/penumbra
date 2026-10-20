import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkerBoot, type WorkerBootControl } from "@src/worker-boot.js";
import { TerminalOutbox } from "@src/worker/terminal-outbox.js";

import { type InProcessDaemonHarness, startInProcessDaemon } from "../helpers/in-process-daemon.js";

const BOOT_MS = Date.parse("2026-10-06T12:00:00.000Z");
const CLAIMED_BEFORE = new Date(BOOT_MS).toISOString();
const WORKER = "W-boot";
const LIVE = "H-LIVE";
const OLD = "H-OLD";

interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  meta: Record<string, unknown>;
  msg: string;
}

const logs: LogLine[] = [];
const log = {
  debug: (meta: Record<string, unknown>, msg: string): void => {
    logs.push({ level: "debug", meta, msg });
  },
  info: (meta: Record<string, unknown>, msg: string): void => {
    logs.push({ level: "info", meta, msg });
  },
  warn: (meta: Record<string, unknown>, msg: string): void => {
    logs.push({ level: "warn", meta, msg });
  },
  error: (meta: Record<string, unknown>, msg: string): void => {
    logs.push({ level: "error", meta, msg });
  },
};

let harness: InProcessDaemonHarness | undefined;
let control: WorkerBootControl | undefined;
let outbox: TerminalOutbox | undefined;
let outboxDir: string | undefined;
let daemonDown = true;
let previousBootReconcile: string | undefined;
const timers: { run: () => Promise<void>; delay: number; cancelled: boolean }[] = [];

beforeEach(() => {
  previousBootReconcile = process.env["PENUMBRA_BOOT_RECONCILE"];
  delete process.env["PENUMBRA_BOOT_RECONCILE"];
  logs.length = 0;
  timers.length = 0;
  daemonDown = true;
});

afterEach(async () => {
  control?.stop();
  outbox?.stop();
  if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
  outboxDir = undefined;
  if (harness) await harness.stop();
  harness = undefined;
  if (previousBootReconcile === undefined) delete process.env["PENUMBRA_BOOT_RECONCILE"];
  else process.env["PENUMBRA_BOOT_RECONCILE"] = previousBootReconcile;
});

function insertDispatched(id: string, lastDispatchStartedAt: string): void {
  if (!harness) throw new Error("harness not started");
  harness.services.db
    .prepare(
      `INSERT INTO handoffs (
        handoff_id, status, worker_id, dispatch_attempts, max_dispatch_attempts,
        last_dispatch_started_at, chain_task_type, ts, conversation_id,
        from_agent, to_agent, message
      ) VALUES (?, 'dispatched', ?, 1, 3, ?, 'STANDARD', '2026-05-20T00:00:00Z', 'conv-1', 'from', 'to', 'hi')`,
    )
    .run(id, WORKER, lastDispatchStartedAt);
  harness.services.dispatchEventLog.record({
    handoff_id: id,
    worker_id: WORKER,
    source: "worker",
    kind: "dispatch.start",
    ts: lastDispatchStartedAt,
  });
}

function rowStatus(id: string): { status: string; worker_id: string | null } {
  if (!harness) throw new Error("harness not started");
  const row = harness.services.db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id = ?")
    .get(id);
  if (!row) throw new Error(`handoff ${id} missing`);
  return row;
}

function reconcileRequests(): {
  body: Record<string, unknown>;
  status: number;
  response: unknown;
}[] {
  if (!harness) throw new Error("harness not started");
  return harness.requests
    .filter((r) => r.url === "/worker/reconcile-orphans")
    .map((r) => ({
      body: r.body as Record<string, unknown>,
      status: r.status,
      response: r.response,
    }));
}

function buildOutbox(): TerminalOutbox {
  if (!harness) throw new Error("harness not started");
  outboxDir = mkdtempSync(join(tmpdir(), "boot-reconcile-outbox-"));
  const client = harness.client;
  const box = new TerminalOutbox({
    dir: outboxDir,
    workerId: WORKER,
    log,
    observe: (event, init): Promise<unknown> => client.observe(event, init),
    postDispatchEvents: (events, signal): Promise<void> =>
      daemonDown
        ? Promise.reject(new Error("daemon unreachable"))
        : client.postDispatchEventsStrict(events, signal),
    complete: (id, init): Promise<unknown> => client.completeHandoff(id, WORKER, init),
    markFailed: (id, reason, init): Promise<unknown> => client.markFailed(id, reason, WORKER, init),
    schedule: (): { cancel(): void } => ({ cancel: (): void => undefined }),
  });
  outbox = box;
  return box;
}

function seedLiveTerminalReport(box: TerminalOutbox): Promise<unknown> {
  return box.reportTerminal({
    handoff_id: LIVE,
    worker_id: WORKER,
    outcome: "complete",
    observations: [],
    dispatch_end: {
      handoff_id: LIVE,
      worker_id: WORKER,
      source: "worker",
      kind: "dispatch.end",
      ts: new Date(BOOT_MS + 3_600_001).toISOString(),
      meta: { status: "ok" },
    },
  });
}

async function boot(): Promise<WorkerBootControl> {
  if (!harness) throw new Error("harness not started");
  const c = await runWorkerBoot({
    client: harness.client,
    log,
    workerId: WORKER,
    outbox,
    now: () => BOOT_MS,
    schedule: (run: () => Promise<void>, delay: number): { cancel(): void } => {
      const timer = { run, delay, cancelled: false };
      timers.push(timer);
      return {
        cancel: (): void => {
          timer.cancelled = true;
        },
      };
    },
  });
  control = c;
  return c;
}

test("deferred orphan reconcile is bounded by the boot instant; a live dispatch survives and its replayed report completes it", async () => {
  harness = await startInProcessDaemon({ orphanRecovery: true });
  // OLD: claimed by this worker's previous incarnation, before the boot instant.
  insertDispatched(OLD, new Date(BOOT_MS - 3_600_000).toISOString());
  // LIVE: claimed by this incarnation after boot.
  insertDispatched(LIVE, new Date(BOOT_MS + 3_600_000).toISOString());

  const box = buildOutbox();
  await seedLiveTerminalReport(box);
  await boot();

  // Outbox still holds the finished-turn report: the boot reconcile is skipped
  // and the deferred reconcile has not fired yet.
  expect(reconcileRequests()).toHaveLength(0);
  expect(timers).toHaveLength(1);

  // The deferred reconcile runs (outbox still busy; the 10-minute bound fires).
  await timers[0]!.run();

  const calls = reconcileRequests();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.status).toBe(200);

  // OLD is requeued; LIVE — claimed at/after the boot instant — is untouched.
  expect(rowStatus(OLD)).toEqual({ status: "approved", worker_id: null });
  expect(rowStatus(LIVE)).toEqual({ status: "dispatched", worker_id: WORKER });
  expect(calls[0]!.body.claimed_before).toBe(CLAIMED_BEFORE);

  // The daemon comes back; the finished report lands and completes the row.
  daemonDown = false;
  await control!.drainOutbox();
  expect(box.pendingHandoffIds()).toEqual([]);
  expect(rowStatus(LIVE)).toEqual({ status: "completed", worker_id: WORKER });
});

test("on a daemon without claimed_before support the deferred reconcile is skipped entirely", async () => {
  harness = await startInProcessDaemon({
    orphanRecovery: true,
    emulateDaemonWithoutClaimedBefore: true,
  });
  insertDispatched(OLD, new Date(BOOT_MS - 3_600_000).toISOString());
  insertDispatched(LIVE, new Date(BOOT_MS + 3_600_000).toISOString());

  const box = buildOutbox();
  await seedLiveTerminalReport(box);
  await boot();
  await timers[0]!.run();

  // The reconcile call must never leave the process: on an old daemon it would
  // run unfiltered and requeue the live dispatch out from under this worker.
  expect(reconcileRequests()).toHaveLength(0);
  expect(rowStatus(LIVE)).toEqual({ status: "dispatched", worker_id: WORKER });
  // The pre-boot orphan is left for the stale sweeper rather than risked.
  expect(rowStatus(OLD)).toEqual({ status: "dispatched", worker_id: WORKER });
  expect(
    logs.some(
      (l) => l.level === "warn" && l.meta["event"] === "boot_dispatch_reconcile_unsupported",
    ),
  ).toBe(true);

  daemonDown = false;
  await control!.drainOutbox();
  expect(rowStatus(LIVE)).toEqual({ status: "completed", worker_id: WORKER });
});

test("the non-deferred boot reconcile also sends claimed_before", async () => {
  harness = await startInProcessDaemon({ orphanRecovery: true });
  insertDispatched(OLD, new Date(BOOT_MS - 3_600_000).toISOString());
  insertDispatched(LIVE, new Date(BOOT_MS + 3_600_000).toISOString());

  // No outbox: the boot reconcile runs inline.
  const c = await runWorkerBoot({
    client: harness.client,
    log,
    workerId: WORKER,
    now: () => BOOT_MS,
  });
  control = c;

  const calls = reconcileRequests();
  expect(calls).toHaveLength(1);
  expect(rowStatus(OLD)).toEqual({ status: "approved", worker_id: null });
  expect(rowStatus(LIVE)).toEqual({ status: "dispatched", worker_id: WORKER });
  expect(calls[0]!.body.claimed_before).toBe(CLAIMED_BEFORE);
});
