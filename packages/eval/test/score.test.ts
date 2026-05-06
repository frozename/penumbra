import { expect, test } from 'bun:test';
import { composite } from '../src/score/compose.ts';

test('composite returns 0 for all-zero sub-bench scores', () => {
  expect(
    composite({
      throughput_tps: 0,
      tool_call_score: 0,
      context_8k_score: 0,
      context_16k_score: 0,
      json_score: 0,
    }),
  ).toBe(0);
});

test('composite returns 1 for all-perfect sub-bench scores', () => {
  expect(
    composite({
      throughput_tps: 30,
      tool_call_score: 1,
      context_8k_score: 1,
      context_16k_score: 1,
      json_score: 1,
    }),
  ).toBe(1);
});

test('composite lets throughput dominate via normalization', () => {
  expect(
    composite({
      throughput_tps: 60,
      tool_call_score: 0,
      context_8k_score: 0,
      context_16k_score: 0,
      json_score: 0,
    }),
  ).toBe(0.3);
});

test('composite falls back to context-8k when context-16k is missing', () => {
  expect(
    composite({
      throughput_tps: 0,
      tool_call_score: 0,
      context_8k_score: 0.5,
      json_score: 0,
    }),
  ).toBeCloseTo(0.15);
});
