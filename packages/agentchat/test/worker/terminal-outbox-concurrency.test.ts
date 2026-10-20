import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PenumbraHttpError } from "@src/penumbra-client.js";
import { TerminalOutbox, type TerminalReport } from "@src/worker/terminal-outbox.js";

const noop = (): void => undefined;
const log = { debug: noop, info: noop, warn: noop, error: noop };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function gate(): { promise: Promise<void>; release(): void } {
  let release = noop;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "outbox-concurrency-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function report(id: string, outcome: "complete" | "fail" = "complete"): TerminalReport {
  return {
    handoff_id: id,
    worker_id: "W",
    outcome,
    reason: "failed turn",
    observations: [],
    dispatch_end: {
      handoff_id: id,
      worker_id: "W",
      source: "worker",
      kind: "dispatch.end",
      ts: new Date().toISOString(),
      meta: { status: "ok" },
    },
  };
}

function seed(dir: string, id: string, outcome: "complete" | "fail", ageMs: number): void {
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      v: 1,
      ...report(id, outcome),
      steps_done: { observations: true, dispatch_end: true },
      created_at: new Date(Date.now() - ageMs).toISOString(),
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
    }),
  );
}

test.each(["complete", "fail"] as const)(
  "overlapping drains post %s once per record without resurrection",
  async (outcome) => {
    const dir = directory();
    seed(dir, "R1", outcome, 2000);
    seed(dir, "R2", outcome, 1000);
    const started = gate();
    const slow = gate();
    const calls: string[] = [];
    const terminal = async (id: string): Promise<unknown> => {
      calls.push(id);
      if (id === "R1") {
        started.release();
        await slow.promise;
      }
      if (calls.filter((call) => call === id).length > 1) {
        throw new PenumbraHttpError("sqlite_busy", 503, {});
      }
      return { status: outcome === "complete" ? "completed" : "failed" };
    };
    const outbox = new TerminalOutbox({
      dir,
      workerId: "W",
      log,
      observe: (): Promise<void> => Promise.resolve(),
      postDispatchEvents: (): Promise<void> => Promise.resolve(),
      complete: terminal,
      markFailed: terminal,
      schedule: (): { cancel(): void } => ({ cancel: noop }),
    });
    cleanups.push(() => {
      outbox.stop();
    });
    const first = outbox.drain();
    await started.promise;
    const second = outbox.drain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsWhileFirstIsSlow = [...calls];
    slow.release();
    const results = await Promise.all([first, second]);
    expect(callsWhileFirstIsSlow).toEqual(["R1"]);
    expect(first).toBe(second);
    expect(calls).toEqual(["R1", "R2"]);
    expect(results).toEqual([{ remaining: 0 }, { remaining: 0 }]);
    expect(readdirSync(dir)).toEqual([]);
    await outbox.drain();
    expect(calls).toEqual(["R1", "R2"]);
  },
);

test("a drain skips a snapshot record already replaced and delivered inline", async () => {
  const dir = directory();
  seed(dir, "R1", "complete", 2000);
  seed(dir, "R2", "complete", 1000);
  const started = gate();
  const slow = gate();
  const calls: string[] = [];
  const outbox = new TerminalOutbox({
    dir,
    workerId: "W",
    log,
    observe: (): Promise<void> => Promise.resolve(),
    postDispatchEvents: (): Promise<void> => Promise.resolve(),
    markFailed: (): Promise<void> => Promise.resolve(),
    complete: async (id): Promise<unknown> => {
      calls.push(id);
      if (id === "R1") {
        started.release();
        await slow.promise;
      }
      if (calls.filter((call) => call === id).length > 1) {
        throw new PenumbraHttpError("sqlite_busy", 503, {});
      }
      return { status: "completed" };
    },
    schedule: (): { cancel(): void } => ({ cancel: noop }),
  });
  cleanups.push(() => {
    outbox.stop();
  });
  const draining = outbox.drain();
  await started.promise;
  await outbox.reportTerminal(report("R2"));
  slow.release();
  await draining;
  expect(readdirSync(dir)).toEqual([]);
  expect(calls).toEqual(["R1", "R2"]);
});

test("retrying an untracked record never overwrites its replacement on disk", async () => {
  const dir = directory();
  seed(dir, "R1", "complete", 2000);
  const started = gate();
  const slow = gate();
  const outbox = new TerminalOutbox({
    dir,
    workerId: "W",
    log,
    observe: (): Promise<void> => Promise.resolve(),
    postDispatchEvents: (): Promise<void> => Promise.resolve(),
    markFailed: (): Promise<void> => Promise.resolve(),
    complete: async (): Promise<unknown> => {
      started.release();
      await slow.promise;
      throw new PenumbraHttpError("sqlite_busy", 503, {});
    },
    schedule: (): { cancel(): void } => ({ cancel: noop }),
  });
  cleanups.push(() => {
    outbox.stop();
  });
  const draining = outbox.drain();
  await started.promise;
  const replacing = outbox.reportTerminal(report("R1", "fail"));
  slow.release();
  await Promise.all([draining, replacing]);
  const persisted = JSON.parse(readFileSync(join(dir, "R1.json"), "utf8")) as {
    outcome: string;
    attempts: number;
  };
  expect(persisted.outcome).toBe("fail");
  expect(persisted.attempts).toBe(0);
  expect(outbox.pendingHandoffIds()).toEqual(["R1"]);
});
