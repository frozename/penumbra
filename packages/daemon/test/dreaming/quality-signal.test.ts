import { expect, it } from "bun:test";
import { computeRetireScore } from "../../src/dreaming/quality-signal.js";
import { StubJudgePool } from "../../src/dreaming/judge-pool.js";

const fakeVaguenessJudge = new StubJudgePool();

it("computeRetireScore: 3-of-4 factors agree, composite >= 0.85 → should_auto_retire=true", async () => {
  const score = await computeRetireScore(
    {
      recall_freq_penalty: 0.9,
      judge_vagueness_score: 0.9,
      neighbour_density_penalty: 0.85,
      age_factor: 0.1, // 4th factor disagrees
    },
    fakeVaguenessJudge,
  );
  expect(score.factors_agree_count).toBeGreaterThanOrEqual(3);
  expect(score.composite).toBeGreaterThanOrEqual(0.85);
  expect(score.should_auto_retire).toBe(true);
});

it("computeRetireScore: only 2 factors agree → should_auto_retire=false even if composite high", async () => {
  const score = await computeRetireScore(
    {
      recall_freq_penalty: 0.9,
      judge_vagueness_score: 0.15,
      neighbour_density_penalty: 0.9,
      age_factor: 0.1,
    },
    fakeVaguenessJudge,
  );
  expect(score.factors_agree_count).toBeLessThan(3);
  expect(score.should_auto_retire).toBe(false);
});
