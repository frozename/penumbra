import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { reconcilerVerdictsHandler } from "../../src/tools/reconciler-verdicts.js";
import { fakeDaemon } from "../helpers.js";

type ReconcilerVerdictsFn = DaemonClient["reconcilerVerdicts"];

test("reconciler.verdicts handler proxies to daemon and returns JSON text", async () => {
  const reconcilerVerdicts: ReconcilerVerdictsFn = mock(() =>
    Promise.resolve({ verdicts: [{ handoff_id: "h-1" }] }),
  );

  const handler = reconcilerVerdictsHandler(fakeDaemon({ reconcilerVerdicts }));
  const out = await handler({
    since: "2026-05-07T00:00:00.000Z",
    limit: 10,
    only_unverified: true,
  });

  expect(reconcilerVerdicts).toHaveBeenCalledWith({
    since: "2026-05-07T00:00:00.000Z",
    limit: 10,
    only_unverified: true,
  });
  const block = out.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text)).toEqual({ verdicts: [{ handoff_id: "h-1" }] });
});
