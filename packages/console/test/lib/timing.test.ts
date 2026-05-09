import { describe, expect, test } from "bun:test";
import { COOL_POLL_MS, HEARTBEAT_MS } from "../../src/lib/timing";

describe("timing constants", () => {
  test("HEARTBEAT_MS is a positive number", () => {
    expect(typeof HEARTBEAT_MS).toBe("number");
    expect(HEARTBEAT_MS).toBeGreaterThan(0);
  });

  test("COOL_POLL_MS is a positive number", () => {
    expect(typeof COOL_POLL_MS).toBe("number");
    expect(COOL_POLL_MS).toBeGreaterThan(0);
  });
});
