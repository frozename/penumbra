import { expect, test } from 'bun:test';
import { renderCard } from '../src/report/render-card.ts';

test('renderCard includes the core report sections', () => {
  const md = renderCard({
    modelId: 'gemma-4-e4b',
    source: 'eval-2026-05-05',
    hwMatrix: [
      { node: 'local', ub: 512, throughput_tps: 21.5 },
      { node: 'local', ub: 256, throughput_tps: 19.25 },
    ],
    subBenches: [
      {
        name: 'throughput',
        ub: 512,
        throughput_tps: 21.5,
        tool_call_score: 0.9,
        context_8k_score: 0.8,
        context_16k_score: 0.75,
        json_score: 0.95,
        composite_score: 0.84,
      },
    ],
  });

  expect(md).toContain('# gemma-4-e4b');
  expect(md).toContain('## Identity');
  expect(md).toContain('## Hardware Matrix');
  expect(md).toContain('| node | ub | throughput_tps |');
  expect(md).toContain('## throughput');
  expect(md).toContain('21.5');
  expect(md).toContain('## Tuning Sweep');
  expect(md).toContain('## Verdict');
});
