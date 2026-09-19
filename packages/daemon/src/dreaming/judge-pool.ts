import type { JudgePoolConfig } from "./config.js";

export interface JudgeVote {
  promote: boolean;
  confidence: number;
  rationale?: string;
  // True when the judge never produced a ballot (transport failure, throw).
  // Abstentions are excluded from the quorum numerator AND denominator.
  abstained?: boolean;
  // Name of the seat that cast (or failed to cast) this ballot. Absent for
  // pools that do not attribute ballots (stub and test pools).
  seat?: string;
  // Class of the failure behind an abstention (for example "http_502").
  // Never an error message: messages can carry upstream response text.
  error_class?: string;
}

// Persisted per-ballot shape in dream_actions.payload_json.votes. seat and
// error_class are optional on purpose: rows written before per-ballot
// attribution carry neither, and every reader must accept them.
export interface SerializedJudgeVote {
  seat?: string;
  promote: boolean;
  confidence: number;
  abstained?: boolean;
  error_class?: string;
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
