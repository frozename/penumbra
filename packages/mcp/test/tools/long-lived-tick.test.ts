import type { DaemonClient } from "@src/daemon-client.js";

import { longLivedTickHandler } from "@src/tools/long-lived-tick-mcp.js";
import { expect, mock, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

test("long_lived_tick proxies to daemon.longLivedTick", async () => {
  const longLivedTick = mock<DaemonClient["longLivedTick"]>(() =>
    Promise.resolve({ outcome: { ok: true } }),
  );
  const daemon = fakeDaemon({ longLivedTick });

  const result = await longLivedTickHandler(daemon)({ id: "home-mgmt" });

  expect(longLivedTick).toHaveBeenCalledWith("home-mgmt");
  expect(result.content[0].text).toContain('"outcome"');
  expect(result.content[0].text).toContain('"ok": true');
});
