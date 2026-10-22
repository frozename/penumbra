import { afterEach, expect, test } from "bun:test";

import {
  DEFAULT_WORKER_HEARTBEAT_STALE_MS,
  workerHeartbeatStaleMs,
} from "@src/worker-heartbeat-stale.js";

const KEY = "PENUMBRA_WORKER_HEARTBEAT_STALE_MS";
const previous = process.env[KEY];

afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, KEY);
  else process.env[KEY] = previous;
});

test.each([
  ["unset", undefined],
  ["empty", ""],
  ["zero", "0"],
  ["negative", "-5000"],
  ["non-numeric", "soon"],
  ["infinite", "Infinity"],
])("workerHeartbeatStaleMs falls back to the default when the env value is %s", (_label, raw) => {
  if (raw === undefined) Reflect.deleteProperty(process.env, KEY);
  else process.env[KEY] = raw;

  expect(workerHeartbeatStaleMs()).toBe(DEFAULT_WORKER_HEARTBEAT_STALE_MS);
});

test("workerHeartbeatStaleMs honours a positive env value", () => {
  process.env[KEY] = "1500";

  expect(workerHeartbeatStaleMs()).toBe(1500);
});
