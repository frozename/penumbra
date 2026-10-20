import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TerminalOutbox, type TerminalReport } from "@src/worker/terminal-outbox.js";

const noop = (): void => undefined;
const log = { debug: noop, info: noop, warn: noop, error: noop };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "outbox-durability-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, "records");
}

function report(id: string): TerminalReport {
  return {
    handoff_id: id,
    worker_id: "W",
    outcome: "complete",
    observations: [{ event_id: "E", payload_json: { response: "finished" } }],
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

test("the complete record is on disk before the first send", async () => {
  const dir = directory();
  const terminalReport = report("H");
  let firstSendRecord: Record<string, unknown> | null = null;
  let observationCalls = 0;
  const outbox = new TerminalOutbox({
    dir,
    workerId: "W",
    log,
    observe: (): Promise<unknown> => {
      observationCalls++;
      const path = join(dir, "H.json");
      if (existsSync(path)) {
        firstSendRecord = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      }
      return Promise.resolve({ event_id: "E" });
    },
    postDispatchEvents: (): Promise<void> => Promise.resolve(),
    complete: (): Promise<unknown> => Promise.resolve({ status: "completed" }),
    markFailed: (): Promise<unknown> => Promise.resolve({ status: "failed" }),
    schedule: (): { cancel(): void } => ({ cancel: noop }),
  });
  cleanups.push(() => {
    outbox.stop();
  });
  expect(await outbox.reportTerminal(terminalReport)).toBe("delivered");
  expect(observationCalls).toBe(1);
  expect(firstSendRecord).not.toBeNull();
  expect(firstSendRecord).toMatchObject({
    v: 1,
    handoff_id: "H",
    worker_id: "W",
    outcome: "complete",
    observations: terminalReport.observations,
    dispatch_end: terminalReport.dispatch_end,
    steps_done: { observations: false, dispatch_end: false },
    attempts: 0,
  });
  expect(existsSync(join(dir, "H.json"))).toBe(false);
});

test("drain delivers records in created_at order regardless of filenames", async () => {
  const dir = directory();
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const [id, ageMs] of [
    ["a-newest", 1000],
    ["b-oldest", 3000],
    ["c-middle", 2000],
  ] as const) {
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        v: 1,
        ...report(id),
        observations: [],
        steps_done: { observations: true, dispatch_end: true },
        created_at: new Date(now - ageMs).toISOString(),
        attempts: 0,
        next_attempt_at: new Date(now).toISOString(),
      }),
    );
  }
  const calls: string[] = [];
  const outbox = new TerminalOutbox({
    dir,
    workerId: "W",
    log,
    now: (): number => now,
    observe: (): Promise<void> => Promise.resolve(),
    postDispatchEvents: (): Promise<void> => Promise.resolve(),
    complete: (id): Promise<unknown> => {
      calls.push(id);
      return Promise.resolve({ status: "completed" });
    },
    markFailed: (): Promise<void> => Promise.resolve(),
    schedule: (): { cancel(): void } => ({ cancel: noop }),
  });
  cleanups.push(() => {
    outbox.stop();
  });
  expect(await outbox.drain()).toEqual({ remaining: 0 });
  expect(calls).toEqual(["b-oldest", "c-middle", "a-newest"]);
});
