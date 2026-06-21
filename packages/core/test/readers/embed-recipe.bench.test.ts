import { expect, test } from "bun:test";

import {
  evaluateCandidatesFromFixtures,
  loadDecision,
  loadFixtures,
} from "./embed-recipe-bench.js";

test("chosen t2 embed recipe clears weak-lift and regression guardrails", async () => {
  const fixtures = await loadFixtures("synthetic.json");
  const decision = await loadDecision();
  const scorecard = await evaluateCandidatesFromFixtures(fixtures, [
    decision.candidateKey,
    "minilm_body_only",
  ]);
  const chosen = scorecard.find((row) => row.key === decision.candidateKey);
  const baseline = scorecard.find((row) => row.key === "minilm_body_only");

  expect(chosen).toBeDefined();
  expect(baseline).toBeDefined();
  expect(chosen!.weakLift).toBeGreaterThan(0);
  expect((chosen!.weakEntered ?? 0) - (baseline!.weakEntered ?? 0)).toBeGreaterThan(0);
  expect(chosen!.regressionCount).toBeLessThanOrEqual(1);
}, 240000);
