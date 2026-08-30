import type { DaemonClient } from "@src/daemon-client.js";

import { reconcilerSweepOrphanPrsHandler } from "@src/tools/reconciler-sweep-orphan-prs.js";
import { expect, mock, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type ReconcilerSweepOrphanPrsFn = DaemonClient["reconcilerSweepOrphanPrs"];

test("reconciler.sweep_orphan_prs handler proxies to daemon and returns JSON text", async () => {
  const reconcilerSweepOrphanPrs: ReconcilerSweepOrphanPrsFn = mock(() =>
    Promise.resolve({
      scanned: 42,
      superseded: 20,
      stale: 22,
      errored: 0,
      actions: [],
    }),
  );

  const handler = reconcilerSweepOrphanPrsHandler(fakeDaemon({ reconcilerSweepOrphanPrs }));
  const res = await handler({ dry_run: true, max_close: 10 });

  expect(reconcilerSweepOrphanPrs).toHaveBeenCalledWith({ dry_run: true, max_close: 10 });
  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(JSON.parse(block.text)).toEqual({
    scanned: 42,
    superseded: 20,
    stale: 22,
    errored: 0,
    actions: [],
  });
});
