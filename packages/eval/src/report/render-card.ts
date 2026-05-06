export interface HwMatrixRow {
  node: string;
  ub: number;
  throughput_tps: number;
}

export interface SubBenchCardRow {
  name: string;
  ub: number;
  throughput_tps: number;
  tool_call_score: number;
  context_8k_score: number;
  context_16k_score?: number | null;
  json_score: number;
  composite_score: number;
}

export function renderCard(opts: {
  modelId: string;
  source: string;
  hwMatrix: HwMatrixRow[];
  subBenches: SubBenchCardRow[];
}): string {
  const lines: string[] = [`# ${opts.modelId}`, '', '## Identity', `- source: ${opts.source}`, `- model_id: ${opts.modelId}`, ''];
  lines.push('## Hardware Matrix', '', '| node | ub | throughput_tps |', '| --- | ---: | ---: |');
  for (const row of opts.hwMatrix) {
    lines.push(`| ${row.node} | ${row.ub} | ${row.throughput_tps} |`);
  }
  lines.push('');
  for (const bench of opts.subBenches) {
    lines.push(`## ${bench.name}`, '', `- ub: ${bench.ub}`, `- throughput_tps: ${bench.throughput_tps}`, `- tool_call_score: ${bench.tool_call_score}`, `- context_8k_score: ${bench.context_8k_score}`, `- context_16k_score: ${bench.context_16k_score ?? bench.context_8k_score}`, `- json_score: ${bench.json_score}`, `- composite_score: ${bench.composite_score}`, '');
  }
  lines.push('## Tuning Sweep', '- sweep data not yet expanded', '', '## Verdict', '- verdict pending benchmark aggregation', '');
  return lines.join('\n');
}
