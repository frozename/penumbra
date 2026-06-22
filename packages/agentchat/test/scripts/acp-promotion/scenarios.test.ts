import { describe, expect, test } from "bun:test";

import type { AcpPromotionScenario } from "../../../scripts/acp-promotion/types.js";

import {
  PROMOTION_SCENARIOS,
  validatePromotionScenarios,
} from "../../../scripts/acp-promotion/scenarios.js";

describe("ACP promotion scenarios", () => {
  test("default manifest includes the required scenario ids", () => {
    expect(PROMOTION_SCENARIOS.map((s) => s.id)).toEqual([
      "ping_exact",
      "read_repo_file",
      "write_worktree_file",
      "terminal_verify",
      "review_no_edit",
      "intentional_failure",
    ]);
  });

  test("manifest validation rejects duplicate ids", () => {
    const duplicate = [PROMOTION_SCENARIOS[0], PROMOTION_SCENARIOS[0]] as AcpPromotionScenario[];
    expect(() => {
      validatePromotionScenarios(duplicate);
    }).toThrow(/duplicate scenario id: ping_exact/);
  });

  test("required scenarios all have bounded timeout and pass criteria", () => {
    for (const scenario of PROMOTION_SCENARIOS) {
      expect(scenario.requiredForPromotion).toBe(true);
      expect(scenario.timeoutMs).toBeGreaterThan(0);
      expect(scenario.expectedResponse).toBeDefined();
    }
  });
});
