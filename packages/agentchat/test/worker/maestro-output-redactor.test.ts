import { expect, test } from 'bun:test';
import { MaestroOutputRedactor } from '../../src/worker/maestro-output-redactor.js';

test('orchestrator combines static and dynamic rules', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const { decision, content, hits } = m.checkContent(
    'forwarding rm -rf /Volumes/WorkSSD to the agent',
  );
  expect(decision).toBe('blocked');
  expect(content).toContain('[REDACTED:rm-rf]');
  expect(hits.find((h) => h.rule_id === 'destructive_shell_rmrf')?.count).toBe(1);
});

test('orchestrator returns clean for benign content', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const { decision, content, hits } = m.checkContent('benign discussion of plans');
  expect(decision).toBe('clean');
  expect(content).toBe('benign discussion of plans');
  expect(hits).toEqual([]);
});

test('orchestrator bypass returns clean even on dangerous content', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: true,
  });
  const { decision, content, hits, bypassed } = m.checkContent('rm -rf /Volumes/WorkSSD');
  expect(decision).toBe('bypassed');
  expect(content).toBe('rm -rf /Volumes/WorkSSD');
  expect(bypassed).toBe(true);
  expect(hits.find((h) => h.rule_id === 'destructive_shell_rmrf')?.count).toBe(1);
});

test('orchestrator silently rewrites when only soft-rules match', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
    extraRules: [
      { id: 'soft_rule', pattern: /banana/g, replacement: '[REDACTED:soft]' },
    ],
  });
  const { decision, content } = m.checkContent('I like banana');
  expect(decision).toBe('rewritten');
  expect(content).toBe('I like [REDACTED:soft]');
});

test('checkContent stays under 1 ms on a 4 KB response', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const text = 'lorem ipsum '.repeat(330) + 'rm -rf /Volumes/WorkSSD trailing';
  expect(text.length).toBeGreaterThan(3500);
  m.checkContent(text);
  const start = performance.now();
  for (let i = 0; i < 100; i++) m.checkContent(text);
  const ms = (performance.now() - start) / 100;
  expect(ms).toBeLessThan(1);
});

test('checkAnyValue blocks fail-closed hits and preserves original value', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const value = { nested: ['safe', { cmd: 'rm -rf /Volumes/WorkSSD' }] };
  const walked = m.checkAnyValue(value);
  expect(walked.decision).toBe('blocked');
  expect(walked.value).toBe(value);
  expect(walked.hits.find((h) => h.rule_id === 'destructive_shell_rmrf')?.count).toBe(1);
});

test('checkAnyValue bypass preserves original value and records hits', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: true,
  });
  const value = { nested: { key: 'rm -rf /Volumes/WorkSSD' } };
  const walked = m.checkAnyValue(value);
  expect(walked.decision).toBe('bypassed');
  expect(walked.bypassed).toBe(true);
  expect(walked.value).toBe(value);
  expect(walked.hits.find((h) => h.rule_id === 'destructive_shell_rmrf')?.count).toBe(1);
});
