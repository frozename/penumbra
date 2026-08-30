import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UsageReader } from "@src/usage-readers/index.js";
import { startUsagePoller } from "@src/usage-readers/poller.js";

const noop = (): void => undefined;
const noopLog = { info: noop, error: noop };

function counterReader(
  id: string,
  machineGlobal: boolean,
): { reader: UsageReader; calls: () => number } {
  let calls = 0;
  const reader: UsageReader = {
    id,
    machineGlobal,
    read: () => {
      calls += 1;
      return Promise.resolve({ cursor: {}, usage_deltas: [], rate_limit_snapshots: [] });
    },
  };
  return { reader, calls: () => calls };
}

function recordingReader(
  id: string,
  machineGlobal: boolean,
): { reader: UsageReader; lastPrev: () => unknown } {
  let lastPrev: unknown = "UNCALLED";
  const reader: UsageReader = {
    id,
    machineGlobal,
    read: (prev) => {
      lastPrev = prev;
      return Promise.resolve({ cursor: prev ?? {}, usage_deltas: [], rate_limit_snapshots: [] });
    },
  };
  return { reader, lastPrev: () => lastPrev };
}

describe("usage poller machine-lock gating", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "poller-lock-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("non-holder skips machineGlobal readers but still runs per-worker readers", async () => {
    const mg = counterReader("mg", true);
    const pw = counterReader("pw", false);
    const poller = startUsagePoller({
      readers: [mg.reader, pw.reader],
      cursorPath: join(dir, "cursors.json"),
      emit: () => Promise.resolve({ event_id: "x" }),
      log: noopLog,
      acquireMachineLock: () => false,
    });
    await poller.runOnce();
    poller.stop();
    expect(mg.calls()).toBe(0);
    expect(pw.calls()).toBe(1);
  });

  test("holder runs every reader", async () => {
    const mg = counterReader("mg", true);
    const pw = counterReader("pw", false);
    const poller = startUsagePoller({
      readers: [mg.reader, pw.reader],
      cursorPath: join(dir, "cursors.json"),
      emit: () => Promise.resolve({ event_id: "x" }),
      log: noopLog,
      acquireMachineLock: () => true,
    });
    await poller.runOnce();
    poller.stop();
    expect(mg.calls()).toBe(1);
    expect(pw.calls()).toBe(1);
  });

  test("no acquireMachineLock configured runs every reader (legacy single-process)", async () => {
    const mg = counterReader("mg", true);
    const poller = startUsagePoller({
      readers: [mg.reader],
      cursorPath: join(dir, "cursors.json"),
      emit: () => Promise.resolve({ event_id: "x" }),
      log: noopLog,
    });
    await poller.runOnce();
    poller.stop();
    expect(mg.calls()).toBe(1);
  });

  test("becoming holder reloads cursors from the shared file (resume, not re-read)", async () => {
    const cursorPath = join(dir, "cursors.json");
    writeFileSync(cursorPath, JSON.stringify({ mg: "A" }));
    const mg = recordingReader("mg", true);
    let holds = false;
    const poller = startUsagePoller({
      readers: [mg.reader],
      cursorPath,
      emit: () => Promise.resolve({ event_id: "x" }),
      log: noopLog,
      acquireMachineLock: () => holds,
    });
    await poller.runOnce(); // non-holder: machineGlobal reader skipped
    expect(mg.lastPrev()).toBe("UNCALLED");
    // a previous holder advanced the shared cursor while this worker was idle
    writeFileSync(cursorPath, JSON.stringify({ mg: "B" }));
    holds = true;
    await poller.runOnce(); // take over → reload cursors → reader resumes from "B"
    poller.stop();
    expect(mg.lastPrev()).toBe("B");
  });
});
