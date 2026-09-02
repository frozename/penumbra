import { expect, test } from "bun:test";

import {
  evaluateCandidatesFromFixtures,
  loadDecision,
  loadFixtures,
} from "../test/readers/embed-recipe-bench.js";

// On-demand runs still hit bun#32569 exit 133 after a clean pass until that
// upstream teardown bug is fixed; bench:embed-recipe uses bun-test-gate for it.
const RUN = process.env.PENUMBRA_RUN_EMBED_BENCH === "1";

(RUN ? test : test.skip)(
  "chosen t2 embed recipe clears weak-lift and regression guardrails",
  async () => {
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
  },
  240000,
);
