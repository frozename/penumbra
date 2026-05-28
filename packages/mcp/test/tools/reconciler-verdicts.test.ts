import { expect, mock, test } from "bun:test";
import { reconcilerVerdictsHandler } from "../../src/tools/reconciler-verdicts.js";

test("reconciler.verdicts handler proxies to daemon and returns JSON text", async () => {
  const daemon = {
    reconcilerVerdicts: mock(async () => ({ verdicts: [{ handoff_id: "h-1" }] })),
  } as any;

  const handler = reconcilerVerdictsHandler(daemon);
  const out = await handler({
    since: "2026-05-07T00:00:00.000Z",
    limit: 10,
    only_unverified: true,
  });

  expect(daemon.reconcilerVerdicts).toHaveBeenCalledWith({
    since: "2026-05-07T00:00:00.000Z",
    limit: 10,
    only_unverified: true,
  });
  expect(out.content[0]?.type).toBe("text");
  expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({ verdicts: [{ handoff_id: "h-1" }] });
});
