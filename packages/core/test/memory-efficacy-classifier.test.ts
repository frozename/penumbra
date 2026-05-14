import { expect, test, vi } from 'bun:test';
import { buildPrompt, classifyFindings } from '../src/services/memory-efficacy-classifier.js';
import type { Finding } from '../src/services/memory-efficacy-classifier.js';
import type { SiriusChatFn } from '../src/services/sirius-chat.js';

test('buildPrompt includes the tight reason cap guidance', () => {
  const prompt = buildPrompt([
    { findingId: 'finding-1', severity: 'High', text: 'Example finding', index: 1 },
  ]);

  expect(prompt).toContain('reason": "<= 80 chars, fragment, no clauses>"');
});

test('classifyFindings sends findings in batches of five', async () => {
  const calls: number[] = [];
  const siriusChat: SiriusChatFn = vi.fn(async ({ messages }) => {
    const content = messages[0]?.content ?? '';
    const batchSize = content.split('\n').filter((line) => /^finding-\d+\./.test(line)).length;
    calls.push(batchSize);
    return JSON.stringify(
      Array.from({ length: batchSize }, (_, index) => ({
        findingId: `finding-${calls.length}-${index + 1}`,
        classification: 'not_memory_related',
        reason: 'stubbed',
      })),
    );
  });

  const findings: Finding[] = Array.from({ length: 12 }, (_, index) => ({
    findingId: `finding-${index + 1}`,
    severity: index % 2 === 0 ? 'High' : null,
    text: `Finding ${index + 1}`,
    index,
  }));

  const result = await classifyFindings(findings, {
    siriusChat,
    model: 'test-model',
  });

  expect(siriusChat).toHaveBeenCalledTimes(3);
  expect(calls).toEqual([5, 5, 2]);
  expect(result).toHaveLength(12);
});
