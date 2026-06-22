import { describe, expect, it } from "bun:test";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UsageReader, UsageReaderResult } from "../../src/usage-readers/index.js";

import {
  resolveUsageCursorPath,
  startUsagePoller,
  usageCursorTempPath,
} from "../../src/usage-readers/poller.js";

interface PollerEvent {
  event_id: string;
}

const noop = (): void => undefined;
const noopLog = { info: noop, error: noop };

class StubReader implements UsageReader {
  readonly id: string;
  reads = 0;
  constructor(
    id: string,
    private readonly next: UsageReaderResult,
  ) {
    this.id = id;
  }

  read(_prev: unknown): Promise<UsageReaderResult> {
    this.reads++;
    return Promise.resolve(this.next);
  }
}

const usageWindow: UsageReaderResult = {
  cursor: { offset: 1 },
  usage_deltas: [
    {
      provider: "codex",
      model: "gpt-5.4",
      tokens_input: 10,
      tokens_output: 20,
      cost_usd: 0.01,
      window_start: "2026-06-03T10:00:00.000Z",
      window_end: "2026-06-03T10:01:00.000Z",
    },
  ],
  rate_limit_snapshots: [],
};

describe("usage poller concurrent persistence", () => {
  it("documents the legacy shared .tmp suffix race", () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-race-"));
    const cursorPath = join(dir, "cursors.json");
    const sharedTmp = `${cursorPath}.tmp`;

    writeFileSync(sharedTmp, '{"writer":"a"}\n');
    writeFileSync(sharedTmp, '{"writer":"b"}\n');
    renameSync(sharedTmp, cursorPath);

    expect(() => {
      renameSync(sharedTmp, cursorPath);
    }).toThrow(/ENOENT/);
  });

  it("uses process-unique temp paths so interleaved renames do not consume each other", () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-race-"));
    const cursorPath = join(dir, "cursors.json");
    const tmpA = usageCursorTempPath(cursorPath, 1001);
    const tmpB = usageCursorTempPath(cursorPath, 1002);

    expect(tmpA).not.toBe(tmpB);
    expect(tmpA).not.toBe(`${cursorPath}.tmp`);

    writeFileSync(tmpA, '{"writer":"a"}\n');
    writeFileSync(tmpB, '{"writer":"b"}\n');
    renameSync(tmpA, cursorPath);

    expect(() => {
      renameSync(tmpB, cursorPath);
    }).not.toThrow();
  });

  it("uses per-worker cursor files by default and preserves the legacy path when disabled", () => {
    const root = "/tmp/penumbra-storage";

    expect(
      resolveUsageCursorPath({
        storageRoot: root,
        workerId: "worker-a",
        env: {},
      }),
    ).toBe(join(root, "local-state-cursors.worker-a.json"));
    expect(
      resolveUsageCursorPath({
        storageRoot: root,
        workerId: "worker-a",
        env: { PENUMBRA_PER_WORKER_USAGE_CURSOR: "0" },
      }),
    ).toBe(join(root, "local-state-cursors.json"));
  });

  it("gives identical upstream usage windows a stable event id for downstream dedup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poller-dedup-"));
    const seen = new Set<string>();
    const accepted: PollerEvent[] = [];
    const emit = (event: PollerEvent): Promise<{ event_id: string }> => {
      expect(event.event_id).toMatch(/^usage-poller-/);
      if (seen.has(event.event_id)) {
        throw new Error(`duplicate event ${event.event_id}`);
      }
      seen.add(event.event_id);
      accepted.push(event);
      return Promise.resolve({ event_id: event.event_id });
    };
    const pollerA = startUsagePoller({
      readers: [new StubReader("codex", usageWindow)],
      intervalMs: 30_000,
      cursorPath: join(dir, "local-state-cursors.worker-a.json"),
      emit,
      log: noopLog,
    });
    const pollerB = startUsagePoller({
      readers: [new StubReader("codex", usageWindow)],
      intervalMs: 30_000,
      cursorPath: join(dir, "local-state-cursors.worker-b.json"),
      emit,
      log: noopLog,
    });

    await pollerA.runOnce();
    await pollerB.runOnce();
    pollerA.stop();
    pollerB.stop();

    expect(accepted).toHaveLength(1);
    expect(seen.size).toBe(1);
  });
});
