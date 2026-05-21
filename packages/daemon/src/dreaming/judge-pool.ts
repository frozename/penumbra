export interface JudgePool {
  judge(args: {
    body: string;
    kind: 'promote_t1' | 'link' | 'retire' | 'rewrite';
  }): Promise<{
    confidence: number;
    verdict: 'yes' | 'no' | 'unsure';
    rationale?: string;
  }>;
}

export class StubJudgePool implements JudgePool {
  async judge(_args: { body: string; kind: string }): Promise<{
    confidence: number;
    verdict: 'yes' | 'no' | 'unsure';
    rationale?: string;
  }> {
    return { confidence: 0.5, verdict: 'unsure', rationale: 'stub-pool' };
  }
}

export function createTestJudgePool(): JudgePool {
  return new StubJudgePool();
}
