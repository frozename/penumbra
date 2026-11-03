import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { longLivedTickHandler } from "@src/tools/long-lived-tick-mcp.js";

import { fakeDaemon } from "../helpers.js";

test("long_lived_tick proxies to daemon.longLivedTick", async () => {
  const longLivedTick = mock<DaemonClient["longLivedTick"]>(() =>
    Promise.resolve({ outcome: { ok: true } }),
  );
  const daemon = fakeDaemon({ longLivedTick });

  const result = await longLivedTickHandler(daemon)({ id: "home-mgmt" });

  expect(longLivedTick).toHaveBeenCalledWith("home-mgmt");
  const block = result.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.text).toContain('"outcome"');
  expect(block.text).toContain('"ok": true');
});
