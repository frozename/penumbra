import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import {
  memoryEfficacyRebuildHandler,
  MemoryEfficacyRebuildInputShape,
} from "@src/tools/memory-efficacy-rebuild.js";

import { fakeDaemon } from "../helpers.js";

type RebuildFn = DaemonClient["memoryEfficacyRebuild"];

function newRebuild(): RebuildFn {
  return mock(() => Promise.resolve({ job_id: "job-1", status: "pending" }));
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

test("memoryEfficacyRebuildHandler defaults source to maestro", async () => {
  const rebuild = newRebuild();
  const handler = memoryEfficacyRebuildHandler(fakeDaemon({ memoryEfficacyRebuild: rebuild }));

  await handler({});

  expect(rebuild).toHaveBeenCalledTimes(1);
  expect(rebuild).toHaveBeenCalledWith({ source: "maestro" });
});

test("memoryEfficacyRebuildHandler passes explicit source through", async () => {
  const rebuild = newRebuild();
  const handler = memoryEfficacyRebuildHandler(fakeDaemon({ memoryEfficacyRebuild: rebuild }));

  await handler({ source: "cli" });

  expect(rebuild).toHaveBeenCalledTimes(1);
  expect(rebuild).toHaveBeenCalledWith({ source: "cli" });
});

test("memoryEfficacyRebuildHandler keeps empty-string source (?? not ||)", async () => {
  const rebuild = newRebuild();
  const handler = memoryEfficacyRebuildHandler(fakeDaemon({ memoryEfficacyRebuild: rebuild }));

  await handler({ source: "" });

  expect(rebuild).toHaveBeenCalledTimes(1);
  expect(rebuild).toHaveBeenCalledWith({ source: "" });
});

test("memoryEfficacyRebuildHandler forwards since verbatim", async () => {
  const rebuild = newRebuild();
  const handler = memoryEfficacyRebuildHandler(fakeDaemon({ memoryEfficacyRebuild: rebuild }));

  await handler({ since: "2026-01-01" });

  expect(rebuild).toHaveBeenCalledTimes(1);
  expect(rebuild).toHaveBeenCalledWith({ since: "2026-01-01", source: "maestro" });
});

test("memoryEfficacyRebuildHandler rejects unknown keys", async () => {
  const rebuild = newRebuild();
  const handler = memoryEfficacyRebuildHandler(fakeDaemon({ memoryEfficacyRebuild: rebuild }));

  await expectRejection(handler({ since: "2026-01-01", bogus: 1 }));
  expect(rebuild).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyRebuildHandler rejects wrong types", async () => {
  const rebuild = newRebuild();
  const handler = memoryEfficacyRebuildHandler(fakeDaemon({ memoryEfficacyRebuild: rebuild }));

  await expectRejection(handler({ source: 42 }));
  expect(rebuild).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyRebuildHandler returns daemon result as JSON text envelope", async () => {
  const rebuild = newRebuild();
  const handler = memoryEfficacyRebuildHandler(fakeDaemon({ memoryEfficacyRebuild: rebuild }));

  const res = await handler({});

  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text)).toEqual({ job_id: "job-1", status: "pending" });
});

test("MemoryEfficacyRebuildInputShape has exactly since and source keys", () => {
  expect(Object.keys(MemoryEfficacyRebuildInputShape).sort()).toEqual(["since", "source"]);
});
