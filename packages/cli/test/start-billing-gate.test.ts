import { describe, expect, test } from "bun:test";

import { BilledHandSeatViolation, isBilledHandSeatViolation } from "@penumbra/config";
import { handleAgentchatConfigLoadError } from "../src/commands/start.js";

describe("handleAgentchatConfigLoadError", () => {
  test("rethrows billed hand-seat violations", () => {
    const error = new BilledHandSeatViolation("agents.yaml: boom");
    expect(() => handleAgentchatConfigLoadError(error)).toThrow(BilledHandSeatViolation);
    expect(isBilledHandSeatViolation(error)).toBe(true);
  });

  test("preserves generic config errors as non-fatal", () => {
    const error = new Error("agents.yaml: ordinary config issue");
    expect(handleAgentchatConfigLoadError(error)).toBe(false);
  });
});
