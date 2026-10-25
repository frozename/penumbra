import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import {
  DAEMON_RELOAD_CONFIG_DESCRIPTION,
  daemonReloadConfigHandler,
  DaemonReloadConfigInputShape,
} from "@src/tools/daemon-reload-config.js";

import { fakeDaemon } from "../helpers.js";

type ReloadConfigFn = DaemonClient["reloadConfig"];

test("DaemonReloadConfigInputShape is empty", () => {
  expect(DaemonReloadConfigInputShape).toEqual({});
});

test("daemon reload tool description documents daemon-only reload scope", () => {
  expect(DAEMON_RELOAD_CONFIG_DESCRIPTION).toContain("Hot-reload daemon-side state");
  expect(DAEMON_RELOAD_CONFIG_DESCRIPTION).toContain("agentchat validation registry");
  expect(DAEMON_RELOAD_CONFIG_DESCRIPTION).toContain("worker control bus");
  expect(DAEMON_RELOAD_CONFIG_DESCRIPTION).toContain("provider_quotas");
});

test("daemonReloadConfigHandler calls daemon.reloadConfig and formats output", async () => {
  const reloadConfig: ReloadConfigFn = mock(() =>
    Promise.resolve({
      ok: true,
      agent_count: 5,
      worker_extras: {
        started: [],
        restarted: [],
        stopped: [],
        skipped: [],
        errors: [],
      },
      reloaded_at: "2026-04-26T00:00:00.000Z",
    }),
  );

  const handler = daemonReloadConfigHandler(fakeDaemon({ reloadConfig }));
  const res = await handler({});

  expect(reloadConfig).toHaveBeenCalledTimes(1);
  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text)).toEqual({
    ok: true,
    agent_count: 5,
    worker_extras: {
      started: [],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    },
    reloaded_at: "2026-04-26T00:00:00.000Z",
  });
});
