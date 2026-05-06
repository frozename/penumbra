export interface SubBenchScores {
  throughput_tps: number;
  tool_call_score: number;
  context_8k_score: number;
  context_16k_score?: number;
  json_score: number;
}

export function composite(s: SubBenchScores): number {
  const normalized_throughput = Math.min(1, s.throughput_tps / 30);
  const context_16k_score = s.context_16k_score ?? s.context_8k_score;
  return (
    0.3 * normalized_throughput +
    0.3 * s.tool_call_score +
    0.2 * s.context_8k_score +
    0.1 * context_16k_score +
    0.1 * s.json_score
  );
}
