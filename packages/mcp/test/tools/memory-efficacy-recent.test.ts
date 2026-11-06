import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import {
  memoryEfficacyRecentHandler,
  MemoryEfficacyRecentInputShape,
} from "@src/tools/memory-efficacy-recent.js";

import { fakeDaemon } from "../helpers.js";

type RecentFn = DaemonClient["memoryEfficacyRecent"];

function newRecent(): RecentFn {
  return mock(() => Promise.resolve({ findings: [], recent: [] }));
}

// bun:test types report `.rejects.toThrow()` as returning `void`, but it is
// async at runtime. Avoid the chain entirely so no-confusing-void-expression
// and await-thenable have nothing to flag.
async function expectRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

test("memoryEfficacyRecentHandler forwards {} for empty input", async () => {
  const recent = newRecent();
  const handler = memoryEfficacyRecentHandler(fakeDaemon({ memoryEfficacyRecent: recent }));

  await handler({});

  expect(recent).toHaveBeenCalledTimes(1);
  expect(recent).toHaveBeenCalledWith({});
});

test("memoryEfficacyRecentHandler forwards since, limit and include_raw verbatim", async () => {
  const recent = newRecent();
  const handler = memoryEfficacyRecentHandler(fakeDaemon({ memoryEfficacyRecent: recent }));

  await handler({ since: "2026-01-01", limit: 10, include_raw: true });

  expect(recent).toHaveBeenCalledTimes(1);
  expect(recent).toHaveBeenCalledWith({ since: "2026-01-01", limit: 10, include_raw: true });
});

test("memoryEfficacyRecentHandler rejects string include_raw", async () => {
  const recent = newRecent();
  const handler = memoryEfficacyRecentHandler(fakeDaemon({ memoryEfficacyRecent: recent }));

  await expectRejection(handler({ include_raw: "yes" }));
  expect(recent).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyRecentHandler rejects unknown keys", async () => {
  const recent = newRecent();
  const handler = memoryEfficacyRecentHandler(fakeDaemon({ memoryEfficacyRecent: recent }));

  await expectRejection(handler({ bogus: 1 }));
  expect(recent).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyRecentHandler returns daemon result as JSON text envelope", async () => {
  const recent = newRecent();
  const handler = memoryEfficacyRecentHandler(fakeDaemon({ memoryEfficacyRecent: recent }));

  const res = await handler({});

  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text)).toEqual({ findings: [], recent: [] });
});

test("MemoryEfficacyRecentInputShape has exactly since, limit and include_raw keys", () => {
  expect(Object.keys(MemoryEfficacyRecentInputShape).sort()).toEqual([
    "include_raw",
    "limit",
    "since",
  ]);
});
