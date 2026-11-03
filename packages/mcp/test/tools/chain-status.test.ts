import { expect, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { chainStatusHandler } from "@src/tools/chain-status.js";

import { fakeDaemon } from "../helpers.js";

type GetHandoffStatusFn = DaemonClient["getHandoffStatus"];

test("chainStatusHandler forwards handoff_id and returns the daemon response as JSON text", async () => {
  const calls: string[] = [];
  const getHandoffStatus: GetHandoffStatusFn = (id: string) => {
    calls.push(id);
    return Promise.resolve({
      handoff_id: id,
      status: "completed",
      error_summary: null,
      worker_id: "worker-c",
      branch_name: "feat/x-2",
      started_at: "2026-04-28T00:00:00Z",
      resolved_at: "2026-04-28T00:00:05Z",
      latency_seconds: 5,
      reliability: {
        status: "complete",
        trustworthy: true,
        recommended_action: "accept",
        summary: "dispatch lifecycle and result evidence are complete",
      },
    });
  };
  const daemon = fakeDaemon({ getHandoffStatus });
  const handler = chainStatusHandler(daemon);
  const res = await handler({ handoff_id: "h-test" });
  expect(calls).toEqual(["h-test"]);
  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  const text = block.text;
  if (typeof text !== "string") throw new Error("expected text content");
  expect(text).toMatch(/^[◌◐●◑] chain_status {2}/);
  expect(text).toContain('"status": "completed"');
  expect(text).toContain('"branch_name": "feat/x-2"');
  expect(text).toContain('"reliability": {');
  expect(text).toContain('"recommended_action": "accept"');
});
