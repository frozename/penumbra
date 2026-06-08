import { expect, test } from "bun:test";
import { MAX_HEARTBEAT_ATTEMPTS, nextHeartbeatRetry } from "../../src/worker/heartbeat-retry.js";

test("nextHeartbeatRetry stops after MAX_HEARTBEAT_ATTEMPTS", () => {
  expect(nextHeartbeatRetry(MAX_HEARTBEAT_ATTEMPTS).shouldRetry).toBe(false);
  expect(nextHeartbeatRetry(MAX_HEARTBEAT_ATTEMPTS - 1)).toEqual({
    shouldRetry: true,
    delayMs: 30_000,
    nextAttempt: MAX_HEARTBEAT_ATTEMPTS,
  });
});
