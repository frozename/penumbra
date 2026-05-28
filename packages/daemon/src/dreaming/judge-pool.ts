import type { JudgePoolConfig } from "./config.js";

export interface JudgeVote {
  promote: boolean;
  confidence: number;
  rationale?: string;
}

export interface JudgePool {
  judge(args: { body: string; kind: "promote_t1" | "link" | "retire" | "rewrite" }): Promise<{
    confidence: number;
    verdict: "yes" | "no" | "unsure";
    rationale?: string;
  }>;
  judgeAll?(args: {
    body: string;
    kind: "promote_t1" | "link" | "retire" | "rewrite";
  }): Promise<JudgeVote[]>;
}

export class StubJudgePool implements JudgePool {
  async judge(_args: { body: string; kind: string }): Promise<{
    confidence: number;
    verdict: "yes" | "no" | "unsure";
    rationale?: string;
  }> {
    return { confidence: 0.5, verdict: "unsure", rationale: "stub-pool" };
  }
}

export function createTestJudgePool(): JudgePool {
  return new StubJudgePool();
}

export function makeFakeJudgePool(votes: JudgeVote[]): JudgePool {
  return {
    async judge(_args) {
      const v = votes[0] ?? { promote: false, confidence: 0.5 };
      return { confidence: v.confidence, verdict: v.promote ? "yes" : "no" };
    },
    async judgeAll(_args) {
      return votes;
    },
  };
}

export function createJudgePool(_config?: JudgePoolConfig): JudgePool {
  // Phase B Task 2.2 will wire the real judge pool; stub suffices here.
  return new StubJudgePool();
}
