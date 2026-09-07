import type { JudgePoolConfig } from "./config.js";

export interface JudgeVote {
  promote: boolean;
  confidence: number;
  rationale?: string;
  // True when the judge never produced a ballot (transport failure, throw).
  // Abstentions are excluded from the quorum numerator AND denominator.
  abstained?: boolean;
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
  judge(_args: { body: string; kind: string }): Promise<{
    confidence: number;
    verdict: "yes" | "no" | "unsure";
    rationale?: string;
  }> {
    return Promise.resolve({ confidence: 0.5, verdict: "unsure", rationale: "stub-pool" });
  }
}

export function createTestJudgePool(): JudgePool {
  return new StubJudgePool();
}

export function makeFakeJudgePool(votes: JudgeVote[]): JudgePool {
  return {
    judge(
      _args,
    ): Promise<{ confidence: number; verdict: "yes" | "no" | "unsure"; rationale?: string }> {
      const v = votes[0] ?? { promote: false, confidence: 0.5 };
      return Promise.resolve({ confidence: v.confidence, verdict: v.promote ? "yes" : "no" });
    },
    judgeAll(_args): Promise<JudgeVote[]> {
      return Promise.resolve(votes);
    },
  };
}

export function createJudgePool(_config?: JudgePoolConfig): JudgePool {
  // Phase B Task 2.2 will wire the real judge pool; stub suffices here.
  return new StubJudgePool();
}
